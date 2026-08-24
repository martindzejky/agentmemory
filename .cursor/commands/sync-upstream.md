# Sync with upstream

Merge the latest upstream changes into this fork.

Upstream is `rohitg00/agentmemory` on branch `main`. This fork lives on `master`.
Read `README.md` for what this fork changes and why, and `AGENTS.md` for architecture and consistency rules.
`.github/workflows/upstream-check.yml` holds the upstream URL and is the weekly check that flags when we fall behind.

## Read this first: the fork has diverged

Early syncs were mostly additive and a mechanical merge was usually safe. That is no longer true. The fork now carries behavior changes that sit **on the same lines upstream keeps editing**, and losing one does not look like a conflict — it looks like a clean merge that silently restores upstream's version.

This has already happened. Upstream `696cf7a` added a zero-result early return to `mem::graph-extract` directly above this fork's Pass G watermark stamp. The merge was clean, nothing failed, and the effect was that graph extraction stopped advancing its cursor and re-extracted the same growing batch on every session stop — which inflated the graph until searches enumerating it OOM-killed the deployment. Details in `docs/investigations/2026-08-24-latency-and-oom.md`.

So: a clean merge is not evidence of a correct merge. Assume upstream will reintroduce something we removed on purpose, and go looking for it.

## Load-bearing patches

Check each of these survived before opening the PR. They are the ones where upstream's version is actively harmful, not merely different.

| Patch | Where | How to tell it survived |
| --- | --- | --- |
| Graph stream gated off in hybrid search | `src/state/hybrid-search.ts` | `isGraphSearchEnabled()` still wraps both `graphRetrieval` calls. Upstream calls them unconditionally, which restores the 60 MB-per-search enumeration. |
| Graph results carry a resolved `sessionId` | `src/state/hybrid-search.ts`, `src/state/search-index.ts` | `sessionIdFor` still exists and is applied to graph hits. Without it every graph result is silently discarded. |
| Bounded graph traversal | `src/functions/graph-retrieval.ts` | Adjacency is built once per call (`buildTraversalContext`), seeds are capped, traversal has a budget. Upstream rebuilds adjacency per seed. |
| Graph watermark advances on an empty batch | `src/functions/graph.ts` | The zero-result branch calls `stampWatermark()`. This is the one upstream already broke once. |
| Deadlines on the hook path | `src/functions/enrich.ts`, `src/functions/file-index.ts` | `getEnrichBudgetMs()` still bounds the enrich branches and the file-context session scan. |
| Embedding off the observe critical path | `src/functions/observe.ts` | Uses `enqueueVectorIndexAdd`, not an awaited `vectorIndexAddGuarded`. Upstream awaits it inside the session lock. |
| Background LLM jobs share a concurrency gate | `src/functions/compress.ts`, `src/functions/summarize.ts`, `src/functions/graph.ts` | `withBackgroundLlmGate` still wraps compress, summarize, and the graph-extract LLM pass. Upstream fires one provider call per event. |
| Graph readers use the snapshot, not a live list | `src/functions/graph.ts`, `src/functions/graph-retrieval.ts`, `src/mcp/server.ts` | Query / startNodeId / retrieval / MCP graph stats must not `kv.list` `KV.graphNodes` or `KV.graphEdges`. After reset those tables are orphans. |
| Timeouts on state reads | `src/state/kv.ts` | `get` and `list` still go through `this.guard(...)`, and `set` / `update` / `delete` still do not. Guarding writes looks like an oversight and is not: a timeout is not a cancellation, so a guarded write can reject while the engine still commits, and `mem::observe`'s rollback would then race the late commit. |
| Container-aware health | `src/health/monitor.ts`, `src/health/thresholds.ts` | `readContainerMemory()` is still read and thresholded. Upstream only measures the Node heap. |
| Cursor-shaped ingest (Passes A–J) | see `README.md` "Current fork progress" | Each pass in that list still holds. Upstream assumes Claude Code session boundaries. |

**The test suite is the real guard.** `test/graph-search-bounds.test.ts`, `test/graph-extract-watermark.test.ts`, `test/hook-path-budgets.test.ts`, `test/request-bounds.test.ts`, `test/background-llm-gate.test.ts` and `test/graph-readers-snapshot.test.ts` exist to fail when one of these patches is lost. If a merge makes one of them fail, the default assumption is that upstream overwrote a fork patch. **Do not "fix" the test to match upstream's new behavior** — restore the patch, or stop and ask if you believe the patch has genuinely become obsolete.

## Steps

1. Work on a new branch off `master`. Never merge straight into `master`.
2. Add the upstream remote if it is missing, then fetch it.
   `git remote add upstream https://github.com/rohitg00/agentmemory.git`
   `git fetch --no-tags upstream main`
3. Merge `upstream/main` into the branch with a merge commit.
4. Resolve each conflict so both sides survive. Take upstream's version for anything this fork never touched. When both sides changed the same code, reapply our patch on top of upstream's new version instead of restoring our old file.
5. Walk the **Load-bearing patches** table above, one row at a time. Do this even when the merge reported no conflicts.
6. Read every upstream commit that touched a file in that table, not just the merge result. `git log --oneline <old-upstream>..upstream/main -- <path>` then read the diffs. A patch can be defeated by a change a few lines away, with no conflict marker.
7. Confirm our patches still exist. `git diff upstream/main -- <path>` shows what this fork adds for a file, and `README.md` lists the behavior that must hold.
8. Keep the diff against upstream as small as it was before the merge. No drive-by refactors, no formatting churn.
9. Verify with `npm run build`, `npm run skills:check`, and `npm test`. Fix what breaks — but see the note above about not fixing the guard tests.
10. Push the branch and open a PR into `master`. Say in the description which load-bearing patches you re-verified and how.

## When to stop and ask

Stop and consult the user instead of guessing when:

- a conflict has no obvious resolution, for example upstream rewrote the code one of our patches depends on
- upstream removed or renamed something our patches build on
- keeping upstream's change would drop fork behavior described in `README.md`
- tests fail and the cause is not clear from the merge
- a load-bearing patch looks obsolete because upstream now solves the same problem its own way

That last one is a judgement call, not a merge decision. Upstream fixing something properly is the outcome we want, and carrying a redundant patch forever is its own cost — but "upstream changed this code" is not the same as "upstream fixed this". Show the upstream implementation, say why you think it subsumes our patch, and let the user decide.

Say what conflicted and what you propose. Do not invent a compromise on your own.
