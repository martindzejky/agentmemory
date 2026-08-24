/**
 * Hook-burst harness — reproduces the load shape that OOM-killed the production
 * `memory` service, and measures whether it still does.
 *
 * Cursor drives agentmemory through agentfiles hooks: one subprocess per event,
 * `postToolUse` firing `/observe` and `/enrich` in parallel, every agent and
 * subagent generating its own stream, and every request abandoned by the client
 * after 2500 ms (`hooks/agentmemory/shared.mjs` REQUEST_TIMEOUT_MS). That is a
 * different shape from `load-100k.ts`: the interesting variables are the corpus
 * *shape* (a large knowledge graph) and client abandonment, not raw throughput.
 *
 * Two phases:
 *
 *   seed  — writes a production-shaped corpus straight into the iii state store
 *           (graph nodes/edges, sessions, compressed observations). It goes
 *           through `state::set` rather than `/observe` so the shape can be
 *           reproduced without an LLM provider or an embedding bill.
 *   burst — fires concurrent observe+enrich pairs with the real 2500 ms abort
 *           and reports latency, client-abort rate, and process RSS.
 *
 * The regression it guards: with the graph stream enabled, each search
 * enumerated all graph nodes and edges (60.8 MB of JSON at 32K/61K), which put
 * `/enrich` over the hook budget and grew iii-engine RSS by ~573 MB per search
 * without ever releasing it. See docs/investigations/2026-08-24-latency-and-oom.md.
 *
 * Both phases WRITE. The target is deliberately not taken from
 * `AGENTMEMORY_URL`: that variable usually points at a real deployment, and
 * inheriting it silently is how you end up seeding a synthetic graph and fake
 * tool observations into somebody's live memory. Point this at a throwaway
 * instance, and if you really mean to aim it somewhere non-local you have to say
 * so with BURST_ALLOW_REMOTE=1.
 *
 * Env knobs:
 *   BURST_URL               daemon base URL (default http://127.0.0.1:3111)
 *   BURST_SECRET            bearer token, when the daemon requires auth
 *   BURST_ENGINE_URL        engine websocket for the seed phase (default ws://127.0.0.1:49134)
 *   BURST_ALLOW_REMOTE      "1" to permit a non-loopback target
 *   BURST_NODES/BURST_EDGES graph size to seed (default 32127 / 61577, production shape)
 *   BURST_SESSIONS          sessions to seed (default 40)
 *   BURST_OBS               observations per seeded session (default 60)
 *   BURST_CONCURRENCY       parallel simulated tool calls (default 6)
 *   BURST_ROUNDS            burst rounds (default 10)
 *   BURST_HOOK_TIMEOUT_MS   client abort, matching agentfiles (default 2500)
 *
 * Usage:
 *   npm run bench:hook-burst -- seed
 *   npm run bench:hook-burst -- burst
 *   npm run bench:hook-burst -- burst --soak 4
 */

import { registerWorker } from "iii-sdk";
import { execSync } from "node:child_process";

const BASE = process.env["BURST_URL"] ?? "http://127.0.0.1:3111";
const SECRET = process.env["BURST_SECRET"] ?? "";
const ENGINE = process.env["BURST_ENGINE_URL"] ?? "ws://127.0.0.1:49134";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Refuses to write to anything that is not obviously a throwaway instance.
function assertSafeTarget(target: string): void {
  if (process.env["BURST_ALLOW_REMOTE"] === "1") return;
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    throw new Error(`hook-burst: cannot parse target "${target}"`);
  }
  if (LOOPBACK.has(host)) return;
  throw new Error(
    `hook-burst: refusing to write to "${target}" — this harness seeds a synthetic ` +
      `graph and fake tool observations. Point BURST_URL / BURST_ENGINE_URL at a ` +
      `throwaway instance, or set BURST_ALLOW_REMOTE=1 if you really mean it.`,
  );
}

const NODES = Number(process.env["BURST_NODES"] ?? 32127);
const EDGES = Number(process.env["BURST_EDGES"] ?? 61577);
const SESSIONS = Number(process.env["BURST_SESSIONS"] ?? 40);
const OBS_PER_SESSION = Number(process.env["BURST_OBS"] ?? 60);
const CONCURRENCY = Number(process.env["BURST_CONCURRENCY"] ?? 6);
const ROUNDS = Number(process.env["BURST_ROUNDS"] ?? 10);
const HOOK_TIMEOUT_MS = Number(process.env["BURST_HOOK_TIMEOUT_MS"] ?? 2500);

const NODE_TYPES = ["concept", "decision", "error", "file", "function", "library", "pattern"];
const EDGE_TYPES = ["related_to", "uses", "modifies", "depends_on", "fixes", "causes"];
const WORDS = [
  "railway", "deploy", "timeout", "svelte", "component", "memory", "graph",
  "search", "session", "hook", "observe", "enrich", "compress", "vector",
  "index", "sqlite", "worker", "engine", "cursor", "gateway", "oauth",
];

const pick = <T>(arr: T[], i: number): T => arr[i % arr.length];

function rssMb(pattern: string): number {
  try {
    // Excluding the shell wrapper matters: a tmux/bash launcher matches the same
    // pattern and reports a few MB, which silently hides the real growth.
    const pid = execSync(
      `ps -eo pid,args | grep '${pattern}' | grep -v grep | grep -v 'bash -lc' | grep -v 'sh -c' | awk '{print $1}' | head -1`,
    )
      .toString()
      .trim();
    if (!pid) return 0;
    return Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024;
  } catch {
    return 0;
  }
}

async function seed(): Promise<void> {
  assertSafeTarget(ENGINE.replace(/^ws/, "http"));
  const sdk = registerWorker(ENGINE, {
    workerName: "hook-burst-seed",
    invocationTimeoutMs: 180_000,
  });
  await new Promise((r) => setTimeout(r, 1500));

  const set = (scope: string, key: string, value: unknown) =>
    sdk.trigger({ function_id: "state::set", payload: { scope, key, value } });

  const setMany = async (
    scope: string,
    rows: Array<{ key: string; value: unknown }>,
    concurrency = 64,
  ) => {
    let next = 0;
    const started = Date.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < rows.length) {
          const row = rows[next++];
          await set(scope, row.key, row.value);
        }
      }),
    );
    const rate = rows.length / Math.max(1, (Date.now() - started) / 1000);
    console.log(`  ${scope}: ${rows.length} rows (${rate.toFixed(0)}/s)`);
  };

  const obsIds: string[] = [];
  const sessionIds: string[] = [];
  for (let s = 0; s < SESSIONS; s++) {
    const sessionId = `burst-session-${s}`;
    sessionIds.push(sessionId);
    for (let o = 0; o < OBS_PER_SESSION; o++) obsIds.push(`${sessionId}:obs-${o}`);
  }

  console.log(`seeding ${NODES} graph nodes, ${EDGES} graph edges`);
  await setMany(
    "mem:graph:nodes",
    Array.from({ length: NODES }, (_, i) => ({
      key: `node-${i}`,
      value: {
        id: `node-${i}`,
        type: pick(NODE_TYPES, i),
        name: `${pick(WORDS, i)}-${pick(WORDS, i * 7 + 3)}-${i}`,
        properties: {
          source: `src/functions/${pick(WORDS, i * 3)}.ts`,
          detail: `${pick(WORDS, i + 1)} ${pick(WORDS, i + 2)} ${pick(WORDS, i + 5)}`,
        },
        sourceObservationIds: [
          obsIds[i % obsIds.length],
          obsIds[(i * 13 + 7) % obsIds.length],
        ],
        createdAt: new Date(Date.now() - i * 60_000).toISOString(),
      },
    })),
  );
  await setMany(
    "mem:graph:edges",
    Array.from({ length: EDGES }, (_, i) => ({
      key: `edge-${i}`,
      value: {
        id: `edge-${i}`,
        type: pick(EDGE_TYPES, i),
        sourceNodeId: `node-${i % NODES}`,
        targetNodeId: `node-${(i * 31 + 17) % NODES}`,
        weight: 0.3 + (i % 7) / 10,
        sourceObservationIds: [obsIds[i % obsIds.length]],
        createdAt: new Date(Date.now() - i * 30_000).toISOString(),
        isLatest: true,
        context: {
          reasoning: `${pick(WORDS, i)} relates to ${pick(WORDS, i + 4)}`,
        },
      },
    })),
  );

  console.log(`seeding ${SESSIONS} sessions x ${OBS_PER_SESSION} observations`);
  for (const sessionId of sessionIds) {
    await set("mem:sessions", sessionId, {
      id: sessionId,
      project: "burst-project",
      cwd: "/tmp/burst-project",
      agentId: "cursor",
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
      updatedAt: new Date().toISOString(),
      observationCount: OBS_PER_SESSION,
      status: "active",
    });
    await setMany(
      `mem:obs:${sessionId}`,
      Array.from({ length: OBS_PER_SESSION }, (_, o) => ({
        key: `${sessionId}:obs-${o}`,
        value: {
          id: `${sessionId}:obs-${o}`,
          sessionId,
          timestamp: new Date(Date.now() - o * 60_000).toISOString(),
          type: o % 4 === 0 ? "file_edit" : "file_read",
          title: `${pick(WORDS, o)} ${pick(WORDS, o + 2)} in ${pick(WORDS, o + 5)}`,
          facts: [`touched ${pick(WORDS, o)}`],
          narrative: `The agent worked on ${pick(WORDS, o)} and ${pick(WORDS, o + 3)} while investigating ${pick(WORDS, o + 6)} inside src/functions/${pick(WORDS, o)}.ts.`,
          concepts: [pick(WORDS, o), pick(WORDS, o + 4)],
          files: [`src/functions/${pick(WORDS, o)}.ts`, `src/state/${pick(WORDS, o + 2)}.ts`],
          importance: 3 + (o % 5),
          derivedBy: "synthetic",
        },
      })),
      32,
    );
  }

  console.log("seed complete — restart the worker so it indexes the new corpus");
  await sdk.shutdown();
}

interface Sample {
  endpoint: string;
  ms: number;
  status: number | "aborted";
}

async function call(endpoint: string, body: unknown): Promise<Sample> {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(SECRET ? { authorization: `Bearer ${SECRET}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    });
    return { endpoint, ms: performance.now() - started, status: res.status };
  } catch {
    // What a hook does: give up, log nothing, let the server keep working.
    return { endpoint, ms: performance.now() - started, status: "aborted" };
  }
}

function report(label: string, samples: Sample[]): void {
  const byEndpoint = new Map<string, Sample[]>();
  for (const s of samples) {
    const list = byEndpoint.get(s.endpoint) ?? [];
    list.push(s);
    byEndpoint.set(s.endpoint, list);
  }
  for (const [endpoint, list] of [...byEndpoint].sort()) {
    const sorted = list.map((s) => s.ms).sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const aborted = list.filter((s) => s.status === "aborted").length;
    console.log(
      `${label} ${endpoint.padEnd(26)} n=${String(list.length).padStart(4)} ` +
        `p50=${(at(0.5) / 1000).toFixed(3)}s p95=${(at(0.95) / 1000).toFixed(3)}s ` +
        `max=${(sorted[sorted.length - 1] / 1000).toFixed(3)}s ` +
        `client_aborted=${aborted} (${((100 * aborted) / list.length).toFixed(0)}%)`,
    );
  }
}

async function burst(soakRounds: number): Promise<void> {
  assertSafeTarget(BASE);
  console.log(
    `target: ${BASE}`,
  );
  console.log(
    `burst: concurrency=${CONCURRENCY} rounds=${ROUNDS} soak=${soakRounds} hook_abort=${HOOK_TIMEOUT_MS}ms`,
  );

  for (let soak = 1; soak <= soakRounds; soak++) {
    const before = { engine: rssMb("[i]ii --config"), worker: rssMb("[d]ist/index.mjs") };
    const samples: Sample[] = [];
    const startedAt = Date.now();

    for (let round = 1; round <= ROUNDS; round++) {
      const batch: Array<Promise<Sample[]>> = [];
      for (let c = 1; c <= CONCURRENCY; c++) {
        const sessionId = `burst-live-${c}`;
        const file = "src/functions/search.ts";
        // One Cursor tool call: postToolUse fires both, in parallel.
        batch.push(
          Promise.all([
            call("/agentmemory/observe", {
              hookType: "post_tool_use",
              sessionId,
              project: "burst-project",
              cwd: "/tmp/burst-project",
              timestamp: new Date().toISOString(),
              eventId: `burst-${soak}-${round}-${c}`,
              data: {
                tool_name: "Read",
                tool_input: file,
                tool_output: `contents of ${file} mentioning railway timeout and svelte component`,
              },
            }),
            call("/agentmemory/enrich", {
              sessionId,
              project: "burst-project",
              cwd: "/tmp/burst-project",
              files: [file],
              terms: ["Railway", "timeout"],
            }),
          ]),
        );
      }
      for (const pair of await Promise.all(batch)) samples.push(...pair);
    }

    const after = { engine: rssMb("[i]ii --config"), worker: rssMb("[d]ist/index.mjs") };
    const label = soakRounds > 1 ? `soak ${soak}/${soakRounds}` : "burst";
    report(label, samples);
    console.log(
      `${label} rss engine ${before.engine.toFixed(0)}->${after.engine.toFixed(0)}MB ` +
        `worker ${before.worker.toFixed(0)}->${after.worker.toFixed(0)}MB ` +
        `(${((Date.now() - startedAt) / 1000).toFixed(1)}s wall)`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.find((a) => !a.startsWith("-")) ?? "burst";
  const soakIndex = args.indexOf("--soak");
  const soakRounds = soakIndex >= 0 ? Number(args[soakIndex + 1] ?? 1) : 1;

  if (mode === "seed") {
    await seed();
    process.exit(0);
  }
  if (mode === "burst") {
    await burst(soakRounds);
    process.exit(0);
  }
  console.error(`unknown mode "${mode}" — expected "seed" or "burst"`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
