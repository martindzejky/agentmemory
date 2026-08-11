---
name: agentmemory-rest-api
description: The agentmemory HTTP REST API surface, the primary protocol for talking to the memory server. Use when calling agentmemory over HTTP, when MCP is unavailable and you need a fallback, or when integrating a host that does not speak MCP.
user-invocable: false
---

REST is agentmemory's primary surface. MCP is a bridge on top of it. Every memory operation has an HTTP endpoint under `http://localhost:3111/agentmemory/*`.

## Quick start

```bash
# liveness
curl -fsS http://localhost:3111/agentmemory/livez

# save
curl -X POST http://localhost:3111/agentmemory/remember \
  -H "Content-Type: application/json" \
  -d '{"content":"chose JWT refresh rotation","concepts":["jwt-refresh-rotation"]}'

# recall
curl -X POST http://localhost:3111/agentmemory/smart-search \
  -H "Content-Type: application/json" \
  -d '{"query":"auth token strategy","limit":5}'
```

## Auth

By default localhost is open and no auth is needed. When `AGENTMEMORY_SECRET` is set, every request needs `Authorization: Bearer $AGENTMEMORY_SECRET`. See agentmemory-config.

## Conventions

- Save returns `201`, reads return `200`, validation errors return `400`.
- Handlers whitelist body fields and drop unknown ones, so passing extra keys is safe but ignored.
- The port is configurable with `--port` or `--instance`; streams, viewer, and engine derive from it.

## Observe

`POST /agentmemory/observe` requires `hookType`, `sessionId`, `project`, `cwd`, and `timestamp`. Optional: `agentId`, `data`, and `eventId`.

`eventId` is the client idempotency key. A repeat of the same `eventId` for the same session is a no-op (`deduplicated: true`, plus the original `observationId`). Identical content with different `eventId`s both persist. Omitting `eventId` always writes; content/time-window ingest dedup is gone. Recommended for retries, not required.

Idempotency is durable: the server indexes `eventId` in KV for as long as the raw event exists (survives restart and replicas; pruned when the event is pruned).

Lifted `data` keys by `hookType` (these feed compression; unlisted keys stay in the opaque blob):

- `prompt_submit` — `prompt`
- `post_tool_use` / `post_tool_failure` — `tool_name`, `tool_input`, `tool_output` (or `error`)
- `assistant_response` — `assistantResponse`
- `subagent_start` / `subagent_stop` — `subagent_id`, `subagent_type`, `task`, `status`, `summary`

## See also

- agentmemory-mcp-tools for the MCP equivalents.
- agentmemory-config for the port quartet and the secret.

## Reference

The full endpoint list with methods lives in REFERENCE.md, generated from `src/triggers/api.ts`.
