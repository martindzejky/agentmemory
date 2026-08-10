# agentmemory (Cursor fork)

Fork of [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory).

For install, architecture, MCP tools, REST API, and everything else about the product, read the [upstream README](https://github.com/rohitg00/agentmemory/blob/main/README.md).

## Why

Upstream is shaped around Claude Code: session start/end, tool observations as the main event type, short-window content dedup, summarization that expects a finished session.

Cursor does not match that model. Conversations stay open. Hook payloads differ. Cloud hooks are unreliable. A Cursor integration today has to remap events into Claude-shaped observations, cache prompts client-side, and work around dedup and session-reset footguns. That is the wrong place to keep growing patches.

This fork exists so the server understands Cursor-shaped work directly. Once that lands, the Cursor side can stay super lean: translate native hook payloads and send them. No fake tool events, no prompt caches, no compensating for Claude Code expectations.

## Goals

- First-class events for prompts, responses, tool calls, tool results, subagents, and compaction. Do not disguise conversation as fake tool observations.
- Idempotent ingestion by client-generated event ID. Keep raw events. Put semantic dedup in derived memories, not the source log.
- Open-ended conversations. No requirement for session start/end, and no "completed session" gate before summarization or consolidation can run.
- Thin Cursor hooks that only translate native payloads into a shared event envelope and ship them here.
