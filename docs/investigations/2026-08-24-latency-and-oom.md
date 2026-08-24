# Investigation: production OOM crashes, HTTP 499s, and multi-second endpoints

Date: 2026-08-24. Target: the `memory` Railway service running this fork at `v0.9.29`.

Running log. Each finding is written as observation → evidence → hypothesis →
experiment → result → conclusion, so the reasoning survives the investigation.

## Summary of conclusions

One defect explains the large majority of the reported symptoms:

**Every hybrid search enumerates the entire graph node and edge tables from the
iii state store, and the results are then thrown away.**

At the production graph size (32,127 nodes / 61,577 edges) that is 60.8 MB of
JSON per search, 2.1–2.6 s of pure KV time, and **+573 MB of iii-engine RSS that
is never released**. `/enrich` runs a search on every file-touching tool call, so
this happens continuously during normal Cursor usage, from every agent and
subagent at once. The client gives up at 2.5 s (HTTP 499) but nothing cancels the
work, so a hook burst multiplies it.

Ranked root causes:

| # | Root cause | Confidence | Evidence |
|---|-----------|-----------|----------|
| 1 | Unbounded `kv.list` of `mem:graph:nodes` + `mem:graph:edges` on every search (2–4 full scans per query) | **Confirmed** | E1, E2, E3, E6, E10 |
| 2 | Graph stream results are 100% discarded (`sessionId: ""` never hydrates), so cause 1 is pure waste | **Confirmed** | E7 |
| 3 | `searchByEntities` rebuilds the full adjacency map per seed node — O(seeds x edges) | **Confirmed** | E7 (62 s for one call) |
| 4 | No cancellation anywhere: aborted client requests run to completion | **Confirmed** | E8 |
| 5 | `/observe` awaits an embedding round-trip inside a per-session lock | **Confirmed** | E4, code |
| 6 | `mem::file-context` loads every observation of the 15 most recent sessions per `/enrich` | **Confirmed** | code |
| 7 | Health reporting cannot see the failure: it reports only the Node worker's heap ratio, not container memory | **Confirmed** | E5 |

Not root causes (investigated, cleared): the MCP gateway (correctly reports a
backend that is genuinely slow), the `allowScripts` npm warnings (optional deps
are not installed in the Railway image at all), OpenTelemetry (bounded buffers
except the log exporter, which only grows while disconnected), iii-sdk version
(unchanged since February).

## Architecture and request flow

```
Cursor tool call
  └─ agentfiles hook (one Node subprocess per event, no client-side serialization)
       ├─ POST /agentmemory/observe   (awaited, AbortSignal.timeout(2500))
       └─ POST /agentmemory/enrich    (awaited, AbortSignal.timeout(2500))   ── in parallel
            │
            ▼
       Railway edge proxy
            │
            ▼
       container: tini → entrypoint.sh → agentmemory CLI
            ├─ child process: iii-engine 0.11.2  (HTTP :3111, WS :49134, SQLite state store)
            └─ same process: Node worker, 281 registered iii functions
                 │  every KV access is an RPC over the WebSocket to the engine
                 ▼
            mem::enrich
              ├─ ensureSession                      (awaited)
              ├─ mem::file-context                  (awaited) → lists sessions, loads ALL obs of 15 sessions
              ├─ mem::search                        (awaited) → HybridSearch
              │    ├─ BM25            in-memory
              │    ├─ vector          in-memory + 1 embedding round-trip
              │    └─ graph           ── kv.list(graphNodes) + kv.list(graphEdges)  x2 ── 60.8 MB
              └─ kv.list(memories)                  (awaited)
```

ChatGPT enters the same backend through the MCP gateway (`memory_recall`,
`memory_smart_search`, `memory_save` → one upstream POST each, 10 s abort).
Cursor's `npx @agentmemory/mcp` is a third path into the same functions.

Hooks are fully concurrent: one subprocess per Cursor event, `Promise.all` for
observe+enrich inside `postToolUse`, and every subagent generates its own
stream. Nothing in the server bounds that concurrency.

## Timeout map

Actual values from source, not inferred from timing.

| Layer | Value | Source |
|-------|-------|--------|
| agentfiles hook HTTP request | **2500 ms** | `hooks/agentmemory/shared.mjs:14` `REQUEST_TIMEOUT_MS` |
| agentfiles enrich/context request | **2500 ms** | `hooks/agentmemory/shared.mjs:15` `CONTEXT_TIMEOUT_MS` |
| Cursor host hook budget | **3 s** | `agentfiles/hooks.json` `timeout: 3`, `failClosed: false` |
| agentfiles git project discovery | 500 ms | `shared.mjs:128` `spawnSync` |
| upstream bundled hooks (not used by Cursor) | 800–120000 ms | `src/hooks/*.ts` |
| MCP standalone livez probe | 2000 ms | `src/mcp/rest-proxy.ts:2` |
| MCP standalone tool call | 15000 ms | `src/mcp/rest-proxy.ts:3` |
| MCP gateway → backend | **10000 ms** | `agentmemory-mcp-gateway/src/agentmemory.ts:10` `UPSTREAM_TIMEOUT_MS` |
| MCP gateway shutdown | 10000 ms | `gateway/src/server.ts:6` |
| iii-http per-request | **180000 ms** | `deploy/railway/entrypoint.sh:32`, `iii-config.yaml:6` `default_timeout` |
| iii-sdk invocation (agentmemory override) | **180000 ms** | `src/index.ts:210` `invocationTimeoutMs` |
| iii-sdk invocation (SDK default) | 30000 ms | `node_modules/iii-sdk/dist/utils-DvwOdG2_.mjs:48` |
| LLM / embedding outbound fetch | 60000 ms | `src/providers/_fetch.ts:65` `AGENTMEMORY_LLM_TIMEOUT_MS` |
| KV get/set/list | **none** | `src/state/kv.ts` — no timeout, inherits the 180 s invocation ceiling |
| Railway healthcheck | 30 s, `/agentmemory/livez` | `deploy/railway/railway.json:9-10` |
| Engine watchdog | 60000 ms | `src/health/engine-watchdog.ts` `AGENTMEMORY_ENGINE_WATCHDOG_MS` |
| Graceful shutdown | worker 5 s, engine 3 s | `src/cli.ts:2817-2835` |

**The ~2.4 s 499s are the 2500 ms hook abort.** The client timer starts before
DNS/TCP/TLS; measured connection setup to the Railway edge from this VM is
~100 ms (`livez` total 114 ms, of which the server spends ~5 ms). Railway's
logged duration starts when it receives the request, so 2500 − ~100 = **~2400 ms
server-side**, matching the observed 2.39–2.41 s exactly. No 2400 ms constant
exists anywhere in agentfiles, current or historical.

There is **no cancellation primitive at all** below the client: `iii-sdk`'s
`InternalHttpRequest` has no `signal`/`aborted` field
(`node_modules/iii-sdk/dist/utils-Cx5sef26.d.mts:934-941`), and the SDK protocol
has no cancel message (`MessageType` enum, `index.mjs:194-207`).

## Evidence log

### E1 — production graph size

`GET /agentmemory/graph/stats` (snapshot-backed, cheap):

```
totalNodes 32127
totalEdges 61577
concept 14659 · decision 5468 · file 4548 · pattern 2347 · error 2331 · function 1840
related_to 26876 · uses 13973 · modifies 7588 · depends_on 4051 · fixes 3881 · causes 3534
```

### E2 — the read path enumerates both tables, twice per query

`src/functions/graph-retrieval.ts:49-50` (`searchByEntities`) and `:122-123`
(`expandFromChunks`) each begin with:

```ts
const allNodes = (await this.kv.list<GraphNode>(KV.graphNodes)).filter((n) => !n.stale);
const allEdges = (await this.kv.list<GraphEdge>(KV.graphEdges)).filter((e) => !e.stale);
```

`HybridSearch.tripleStreamSearch` calls `searchByEntities` whenever the query
yields entities (`hybrid-search.ts:109-119`) and `expandFromChunks` whenever the
vector stream returned anything (`:121-130`). So 2 full scans minimum, 4 when
entities are present, per search.

`kv.list` is an RPC to the engine that materializes the whole scope as one JSON
array (`src/state/kv.ts`, iii-state `store_method: file_based`). It has no
timeout and no pagination.

Upstream already knows this pattern is fatal — on the *write* path. From
`src/functions/graph.ts:555` and `:1029`: `kv.list(KV.graphNodes)` at 75K nodes
"exceeds the iii heartbeat budget and the worker dies", which is why #814/#816
introduced `graphSnapshot`, `graphNameIndex`, `graphEdgeKey` and
`graphNodeDegree`. The read path was never migrated, and upstream `696cf7a` then
routed the primary recall surface through it.

### E3 — cost per search, measured at production scale

Local instance, engine 0.11.2, same iii-config, seeded to exactly 32,127 nodes /
61,577 edges (`.tmp-repro/seed.ts`), localhost, no other load, no LLM:

```
round 1: one search-equivalent = 2617ms (nodes 543/363ms x32127 rows 9.8MB, edges 799/691ms x61577 rows 20.7MB) -> payload/search=60.8MB
round 2: one search-equivalent = 2099ms
round 3: one search-equivalent = 2103ms
5 concurrent search-equivalents: 4067ms
```

**60.8 MB of JSON and ~2.1 s of KV time per search**, before BM25, embeddings,
hydration, or network.

### E4 — end-to-end latency, reproduced

Local, production-sized graph, only 2,400 observations (production has far
more), zero network latency, zero LLM:

```
search#1 200 3.64s   search#2 200 3.09s   search#3 200 3.11s
enrich#1 200 3.27s   enrich#2 200 3.35s   enrich#3 200 3.45s
```

Production, freshly restarted and otherwise idle:

```
/agentmemory/livez        200  0.11s   (≈ pure network)
/agentmemory/search       200  3.39s
/agentmemory/search       200  5.07s
```

`/enrich` cannot finish inside the hook's 2500 ms budget. Every enrich becomes a
499. That is the reported symptom, reproduced.

### E5 — where the memory actually goes

The iii-engine is a separate child process holding the SQLite state store.
`/agentmemory/health` reports only the *Node worker's* `process.memoryUsage()`,
so the engine is invisible in production.

Fresh engine with the seeded DB, then repeated search-equivalents:

```
engine pid=16855 baseline rss=228MB
after  1 search-equivalent (4 kv.list): engine rss= 801MB  (+573MB)
after  2                                engine rss= 880MB
after  6                                engine rss=1010MB
after  8                                engine rss=1056MB
after 10                                engine rss=1120MB
idle +10s  engine rss=1120MB
idle +20s  engine rss=1121MB
idle +30s  engine rss=1121MB        ← never returns to baseline
```

The Node worker side shows the same shape: RSS 367 MB against 50 MB heap used
and 91 MB external — ~225 MB is allocator retention, not reachable JS objects.
Production matches: RSS 1014 MB with heapUsed 83 MB at 6 minutes of uptime.

Production health poll during a burst of subagent traffic:

```
up=362.8s rss=1014.4MB heapUsed= 82.7MB heapTotal=196.6MB ext= 77.1MB status=healthy
up=422.8s rss=1197.9MB heapUsed=538.3MB heapTotal=669.4MB ext=186.4MB status=degraded  alerts=['memory_warn_80%_rss1142mb']
up=482.8s rss=1211.7MB heapUsed=556.7MB heapTotal=669.6MB ext=189.9MB status=degraded  alerts=['memory_warn_83%_rss1156mb']
```

Note what the alert actually measures: 538/669 = 80 %, i.e. **heap utilisation
ratio**, not container memory. RSS is printed but never compared to a limit, and
the engine child process is not measured at all. This is why the crash produces
no log line — nothing in the service is watching the number that OOMs.

### E6 — the failure is load-triggered, and was reproduced accidentally

While this investigation ran, six parallel subagents in this VM generated normal
Cursor hook traffic against production (`AGENTMEMORY_INJECT_CONTEXT=true` is set
in the cloud environment, so every `postToolUse` fired `/observe` + `/enrich`).
The production service OOM-crashed **three times in thirty minutes**.

That is an unintentional but clean load test: concurrent hook traffic → concurrent
`/enrich` → concurrent 60 MB graph enumerations → OOM. Mitigated for the rest of
the session by short-circuiting `fetchEnrichContext` in this VM's installed hook
copy only (VM-local, nothing committed).

### E7 — the graph stream returns nothing usable, and can take a minute

`GraphRetrieval` hardcodes `sessionId: ""` on every result
(`graph-retrieval.ts:92`, `:105`, `:145`). `HybridSearch.enrichResults` hydrates
with `kv.get(KV.observations(r.sessionId), r.obsId)` (`hybrid-search.ts:312`),
which for `sessionId: ""` reads scope `mem:obs:` and always misses.

Direct probe against the seeded corpus (`.tmp-repro/probe-graph-usefulness.ts`):

```
query: "railway-deploy" Railway
extracted entities: [ 'railway-deploy', 'Railway' ]
searchByEntities -> 20 results in 62345ms
distinct sessionIds on graph results: [ '' ]
hydration with the sessionId the graph returned:     0 hydrated, 20 dropped
hydration with the real sessionId parsed from obsId: 20/20 hydrated
```

Two conclusions. First, **62 seconds for one call**: `dijkstraTraversal` is
invoked per matching seed node and rebuilds the adjacency map over all 61,577
edges each time (`graph-retrieval.ts:66-72`, `:250-258`), so cost is
O(seeds x edges) with no cap on seeds. Second, **every graph result is
discarded** — the rows exist and hydrate fine with the correct sessionId, so the
graph stream contributes nothing except the occasional score nudge for an obsId
BM25 or vector already found. This matches upstream issue #937.

So the 60.8 MB and 2.1–62 s per query buy zero recall.

### E8 — work continues after the client disconnects

Fresh engine, one `/search` aborted by the client at 0.5 s (what a hook does at
2.5 s):

```
engine baseline: 240MB
curl --max-time 0.5 → code=000 (aborted)
  +3s after client gave up: engine rss=452MB
  +6s                       engine rss=452MB
  ...
 +18s                       engine rss=452MB
```

The client was gone at 0.5 s, yet the engine grew +212 MB afterwards and kept it.
The scans ran to completion for a caller that no longer existed. The hypothesised
feedback loop is therefore **real**: abort → work continues → next hook arrives →
concurrency and memory climb → more requests cross the timeout.

### E9 — secondary contributors (confirmed from code)

- `/observe` awaits `vectorIndexAddGuarded` → an embedding round-trip, inside
  `withKeyedLock("obs:" + sessionId)` (`src/functions/observe.ts:354-359`,
  `:150`). One slow embedding serialises every subsequent observe for that
  session, and both sit on the 2.5 s hook budget.
- `mem::file-context` takes the 15 most recent other sessions and loads *all*
  observations of each (`src/functions/file-index.ts:47-67`). With
  `MAX_OBS_PER_SESSION=2000` that is up to 30,000 observations per `/enrich`.
- `mem::enrich` also does a full `kv.list(KV.memories)` per call
  (`src/functions/enrich.ts:90-110`).
- No global cap on concurrent LLM calls, embeddings, or searches. `mem::compress`
  averages **4456 ms** over 6,728 production calls; `mem::summarize` **6909 ms**.
- Graph extraction runs unconditionally and its watermark can stop advancing when
  extraction yields zero results (early return at `src/functions/graph.ts:766`
  sits above this fork's watermark stamp at `:800`), so the same session's
  observations are re-extracted on every stop. That is what grew the graph to
  32K/61K in the first place.

### E10 — production, with and without enrich traffic

`/agentmemory/health` polled every 30s for 70 minutes across the investigation
(139 samples, 1 restart). Peak, during the subagent burst described in E6:

```
worker rss 1469 MB, heapUsed 668 MB, cpu 98%, status critical
alerts ['cpu_critical_98%', 'memory_warn_88%_rss1401mb']
```

After `fetchEnrichContext` was short-circuited in this VM's hook copy, so this
agent stopped issuing `/enrich`, the same deployment went flat:

```
up=750s rss=259.1MB heap=48.3MB healthy []
up=780s rss=259.1MB heap=47.9MB healthy []
...
up=900s rss=259.1MB heap=48.0MB healthy []
```

Fifteen minutes, no growth at all, on the unmodified production build. The
variable is enrich traffic, not time or the corpus. Note also what the alert
said at 1401 MB: `memory_warn_88%`, where 88% is `heapUsed / heapTotal`. Nothing
was watching the container.

### E11 — cleared hypotheses

- **MCP gateway**: single attempt, no retry, correct 10 s abort
  (`gateway/src/agentmemory.ts:10,167`), one upstream request per tool call. It
  reports a slow backend; it does not cause slowness.
- **npm `allowScripts` warnings**: `@huggingface/transformers` is an
  *optional* dependency and the Railway image installs with `--omit=optional`
  (`deploy/railway/Dockerfile:44`), so onnxruntime-node/sharp are not in the
  production image at all. No runtime path touches them unless
  `EMBEDDING_PROVIDER=local`.
- **OpenTelemetry**: span/metric export buffers are capped at 100 and the shared
  connection at 1000 frames (`iii-sdk/dist/utils-DvwOdG2_.mjs:451,527,305`). The
  log exporter's `pendingExports` is uncapped (`:601-616`) but only accumulates
  while disconnected. `sampling_ratio: 0.1` is already the mitigation for the
  known log-feedback loop. Not a primary contributor.
- **iii-sdk version**: unchanged since 2026-02-25; `iii-config.yaml` unchanged
  since May. Not part of the recent regression.
- **Duplicate workers after reconnect**: the SDK replays registrations on the
  *same* instance only (`iii-sdk/dist/index.mjs:578-601`) and re-registering an
  id in-process throws (`:290`). Duplication needs a second OS process, which
  `src/cli.ts:1282-1297` refuses. Production `/health` shows one worker, 281
  functions.

## Regression analysis

The fork branched from upstream at `2973e4e`. The recent merge is `ba49d75`
(merge `41b319c`, PR #20), bringing `2973e4e..2d38daf`. Last known good is
`82f2800`. Version numbers are useless for bisecting: `package.json` and
`src/version.ts` read `0.9.29` at every commit across that range.

Upstream `696cf7a` is the epicentre. It routed `mem::search` — the primary recall
surface, and therefore `/enrich` on every tool call — through the full
BM25+vector+graph fusion (`src/functions/search.ts:485`, wired at
`src/index.ts:399`), pointing the hot path at the one enumeration upstream had
already documented as fatal. It also made graph extraction unconditional
(`src/index.ts:282`), which is what filled the tables that the read path now
scans. The zero-result early return it added (`graph.ts:766`) landed above this
fork's watermark stamp (`:800`), so extraction stopped advancing its cursor and
kept re-processing the same observations.

Before that merge, `mem::search` was keyword-first and the graph tables were
small. The same code on a small graph is cheap, which is why this only became
obvious after the merge — the cost scales with a table that nothing prunes.

## Fixes

Implemented in this branch:

1. **Never enumerate the graph tables on the search path.** The graph stream is
   gated behind `AGENTMEMORY_GRAPH_SEARCH` (default off) because it provably
   returns zero usable results at any cost. When explicitly enabled it is now
   bounded: adjacency built once per call instead of once per seed, a seed cap,
   and a wall-clock budget.
2. **Make graph results usable** by resolving the missing `sessionId` from the
   BM25 index's in-memory `obsId → sessionId` map, so re-enabling the stream is
   meaningful rather than decorative.
3. **Deadlines instead of unbounded work.** A `Deadline` primitive plus KV
   operation timeouts, threaded through enrich/search, so a request that has
   already blown its client's budget stops instead of running to completion.
   Counters expose how often that happens.
4. **`/observe` off the critical path**: the embedding moves to a bounded
   background queue, so the write is durable but the response is not blocked on
   a network round-trip inside the session lock.
5. **Bounded fan-out** in `mem::file-context` and `mem::enrich`.
6. **Bounded concurrency** for expensive operations via a shared semaphore, so a
   hook burst queues instead of multiplying peak memory.
7. **Observability that can see this class of failure**: cgroup container memory
   (engine + worker, the number that actually OOMs) with threshold warnings,
   per-operation timings, in-flight and queued counters, deadline-exceeded
   counters, and slow-operation warnings — all low-volume.
8. **Graph extraction watermark** advances on zero-result extractions again.

## Results

Same build, same local instance, same production-shaped corpus (32,127 graph
nodes / 61,577 edges, 1,064 sessions), same load: 6 concurrent simulated Cursor
tool calls, each firing `/observe` and `/enrich` in parallel with the real
2500 ms client abort. Reproduce with `npm run bench:hook-burst`.

The only difference between the two columns is `AGENTMEMORY_GRAPH_SEARCH`:

| | graph stream on | graph stream off (new default) |
|---|---|---|
| `/enrich` p50 | 1.827 s | **0.161 s** |
| `/enrich` p95 | 1.988 s | 0.754 s |
| `/observe` p50 | 1.051 s | **0.054 s** |
| `/observe` p95 | 1.423 s | 0.088 s |
| engine RSS over the run | 263 → 1264 MB (**+1001 MB**) | 304 → 304 MB (**+0 MB**) |
| worker RSS over the run | 107 → 613 MB | 109 → 324 MB |
| wall clock for 20 tool calls | 13 s | 2 s |

Note the `/observe` row: observe performs no search at all, yet its latency rose
by 30x with the graph stream on. That is the shared event loop — one enumeration
blocks every other request in the worker, which is why observes were timing out
alongside enriches in production.

Soak, four consecutive bursts (480 requests total, graph stream off):

```
soak 1/4 enrich p50=0.161s observe p50=0.054s  engine 304->304MB  worker 109->324MB
soak 2/4 enrich p50=0.131s observe p50=0.069s  engine 304->304MB  worker 324->350MB
soak 3/4 enrich p50=0.181s observe p50=0.182s  engine 304->304MB  worker 350->387MB
soak 4/4 enrich p50=0.200s observe p50=0.203s  engine 304->304MB  worker 387->422MB
```

Zero client aborts across all 480 requests, no latency drift between the first
and last burst, and engine RSS completely flat. Worker RSS climbs to a plateau
under load and falls back afterwards (442 MB at peak, 269 MB once idle) — the
climb is the local embedding model and the in-memory indexes, and production uses
a remote embedding provider. Compare with the pre-fix engine, which went from
240 MB to 1120 MB and stayed there.

The new `kvLists` accounting also caught a bug in the file-context cache added
here: a per-session invalidation was clearing the shared session list, so the
list was being re-enumerated 129 times across 180 enrich calls. After the fix,
3 times across 240 calls, and per-session observation enumerations dropped from
15 per enrich to 2.5.

## Not fixed, and worth knowing

- **Graph recall is off, not repaired.** The stream is bounded and its results
  now carry a usable sessionId, but re-enabling it still enumerates both graph
  tables per query. Making it genuinely cheap needs an adjacency and name-token
  index maintained on the write path (upstream already built `graphNameIndex`,
  `graphEdgeKey` and `graphNodeDegree` for the write path in #814/#816; the read
  path needs the equivalent) plus a one-off backfill for existing rows.
- **The graph tables are never pruned.** 32,127 nodes and 61,577 edges remain on
  disk. `POST /agentmemory/graph/reset` wipes graph state without touching
  observations, and with the watermark fixed in place the graph would rebuild
  incrementally at a sane size. Worth doing, but it is a data decision for the
  operator, not something to bundle into this change.
- **Real cancellation is impossible today.** iii's HTTP trigger exposes no abort
  signal and the SDK protocol has no cancel message, so deadlines are the
  ceiling: they stop a request from starting more work, they cannot interrupt an
  in-flight KV round-trip. Upstream would have to add cancellation to the engine
  protocol for anything stronger.
- **`mem::compress` averages 4456 ms** across 6,728 production calls and
  `mem::summarize` 6909 ms. Both are off the request path, but neither has a
  concurrency cap, so a burst of auto-compress work still competes for the same
  event loop. Worth a bounded worker pool next.
