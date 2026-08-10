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
- **Idempotency uses client event IDs.** Each event gets a stable client-generated ID. Retrying the same ID is a no-op. Two different IDs with the same content both stay. Drop ingest dedup by session, content, or short time windows. Semantic dedup belongs on derived memories.
- **Conversations are open-ended streams.** A conversation or session ID helps grouping when you have one. Ingest must not require `sessionStart`, `sessionEnd`, or a session ID. There is no useful `active` or `completed` state. People come back later.
- **Drive processing with watermarks.** Track progress with fields like `lastEventAt`, `lastSummarizedEventId`, `lastReflectedEventId`, and `summaryRevision`. Summarization, reflection, graph extraction, consolidation, crystallization, and skill extraction all run incrementally. None of them wait for a completed session.
- **Trigger work from signals, not session end.** Run at turn boundaries, after idle time, after event or token thresholds, on an explicit flush, and from a periodic recovery sweep. Do not call an LLM on every observation. If Cursor Cloud skips a hook, memory formation must still catch up later.
- **`/session/end` only flushes.** Keep it as a deprecated, stateless flush for old clients. It must not close the conversation or reject later events. If the UI needs an archive flag, that is a user action, not an ingest state.
- **Keep host adapters thin.** They translate hook payloads into the shared envelope. They do not paper over server gaps with prompt caches or fake tool events. Skip agent thoughts by default. Keep prompts, final responses, decisions, and useful tool outcomes.
