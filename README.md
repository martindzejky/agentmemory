# agentmemory (Cursor fork)

Fork of [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory).

For install, architecture, MCP tools, REST API, and the rest of the product, read the [upstream README](https://github.com/rohitg00/agentmemory/blob/main/README.md).

## Why this fork

Upstream AgentMemory assumes Claude Code. Sessions start and end. Tool calls are the main observation type. Content gets deduped at ingest. Processing often waits for the session to finish.

Cursor does not work that way, and Cursor Cloud is worse. Conversations stay open. End hooks flake. If you force Cursor into the Claude model on the client, you invent fake tool observations, cache prompts, and fake session boundaries. Fix the server instead.

This fork treats Cursor as a real host. Host adapters stay thin. They map native events into one shared envelope and send them. The server keeps the raw event log, accepts late events on old conversations, and consolidates asynchronously.

## Goals

- **Stay compatible with upstream.** Prefer small, additive changes. No breaking changes or big rewrites. The point of this fork is Cursor compatibility and first-class Cursor support while adhering to upstream as much as possible.
- **Cursor is a real host.** Stop adapting Cursor to look like Claude Code.
- **Keep an immutable raw event log.** Store `user_prompt`, `assistant_response`, `tool_call`, `tool_result`, `subagent`, and `compaction` as their own event types. Do not rewrite conversation messages as tool observations. Summaries and memories are derived views. They must never overwrite the source, so you can rerun summarization later.
- **Idempotency uses client event IDs.** Optional but recommended client-generated IDs. Retrying the same ID is a no-op. Two different IDs with the same content both stay. Content/time-window ingest dedup is gone. Semantic dedup belongs on derived memories.
- **Conversations are open-ended streams.** A conversation or session ID helps grouping when you have one. Ingest must not require `sessionStart`, `sessionEnd`, or a session ID. There is no useful `active` or `completed` state. People come back later.
- **Drive processing with watermarks.** Track progress with fields like `lastEventAt`, `lastSummarizedEventId`, `lastReflectedEventId`, and `summaryRevision`. Summarization, reflection, graph extraction, consolidation, crystallization, and skill extraction all run incrementally. None of them wait for a completed session.
- **Trigger work from signals, not session end.** Run at turn boundaries, after idle time, after event or token thresholds, on an explicit flush, and from a periodic recovery sweep. Do not call an LLM on every observation. If Cursor Cloud skips a hook, memory formation must still catch up later.
- **`/session/end` is a deprecated noop.** Keep the route for old clients. It must not close the conversation, stamp completed, fan out processing, or reject later events. If the UI needs an archive flag, that is a user action, not an ingest state.
- **Keep host adapters thin.** They translate hook payloads into the shared envelope. They do not paper over server gaps with prompt caches or fake tool events. Skip agent thoughts by default. Keep prompts, final responses, decisions, and useful tool outcomes.

## Current fork progress

- **Session start is optional.** `/observe`, `/summarize`, and `/enrich` lazy-create a session when `sessionId` + `project` + `cwd` arrive without a prior `/session/start`. Request `agentId` is honored on that create (e.g. `"cursor"`); `/session/start` still works for clients that call it.
- **Pass B — `/session/end` deprecated noop.** Sessions are not closed by ingest lifecycle (`api::session::end` / `event::session::ended` do not stamp `completed` / `endedAt` or fan out stopped work). Start remains optional (Pass A).
- **Pass C — idle catch-up sweep.** A bounded `mem::idle-sweep` timer processes sessions that have pending observations and either (a) went idle, or (b) accumulated ≥N new observations since last sweep (so all-day Cursor chats are not stuck because `/observe` keeps refreshing `updatedAt`). It reuses `event::session::stopped` with `skipConsolidation`. Failed attempts stamp `idleProcessedAt` for cooldown without advancing the count marker. Turn-boundary `POST /summarize` stays primary; eviction recovery is unchanged. Knobs: `AGENTMEMORY_IDLE_SWEEP_*`, `AGENTMEMORY_IDLE_THRESHOLD_MS`.
- **Pass D — client event ID idempotency.** `/observe` accepts optional `eventId`. When present, retries of the same `sessionId`+`eventId` return `{ deduplicated: true }` and do not write again. When absent, the observation is always written (content/time-window ingest dedup is gone). `eventId` is optional so existing hooks keep working; clients that care about retries should send one. Idempotency is best-effort within a 5-minute in-process window (lost on restart, after TTL, or across replicas) — not a durable guarantee.
