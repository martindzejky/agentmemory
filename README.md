# agentmemory (Cursor fork)

Fork of [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory).

For install, architecture, MCP tools, REST API, and everything else about the product, read the [upstream README](https://github.com/rohitg00/agentmemory/blob/main/README.md).

## Why

Upstream is shaped around Claude Code: session start/end, tool observations as the main event type, short-window content dedup, summarization that expects a finished session.

Cursor does not match that model. Conversations stay open.