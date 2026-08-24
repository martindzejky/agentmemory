import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { z } from "zod";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { getAllTools, getVisibleTools } from "../src/mcp/tools-registry.js";
import { toolOutputSchemas } from "../src/mcp/output-schemas.js";
import type { JsonSchema } from "../src/mcp/json-schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  const triggerOverrides = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      if (triggerOverrides.has(id)) {
        return triggerOverrides.get(id)!(payload);
      }
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
    overrideTrigger: (id: string, handler: Function) => {
      triggerOverrides.set(id, handler);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function makeReq(body?: unknown, headers?: Record<string, string>) {
  return {
    body,
    headers: headers || {},
    query_params: {},
  };
}

function validateAgainstOutputSchema(schema: JsonSchema, data: unknown): void {
  const parsed = z.fromJSONSchema(schema as never).safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
}

function expectTextContent(body: {
  content?: Array<{ type?: string; text?: string }>;
}): string {
  expect(Array.isArray(body.content)).toBe(true);
  expect(body.content!.length).toBeGreaterThan(0);
  expect(body.content![0].type).toBe("text");
  expect(typeof body.content![0].text).toBe("string");
  return body.content![0].text!;
}

describe("MCP output schemas", () => {
  const origTools = process.env["AGENTMEMORY_TOOLS"];

  afterEach(() => {
    if (origTools === undefined) delete process.env["AGENTMEMORY_TOOLS"];
    else process.env["AGENTMEMORY_TOOLS"] = origTools;
  });

  it("every registered tool declares an outputSchema", () => {
    const tools = getAllTools();
    expect(tools.length).toBe(54);
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(
        tool.outputSchema.type === "object" ||
          Array.isArray(tool.outputSchema.oneOf),
        tool.name,
      ).toBe(true);
    }
  });

  it("output schemas cover the complete registry with no leftovers", () => {
    const names = getAllTools().map((t) => t.name).sort();
    const schemaNames = Object.keys(toolOutputSchemas).sort();
    expect(schemaNames).toEqual(names);
  });

  it("getVisibleTools exposes outputSchema in both core and all modes", () => {
    process.env["AGENTMEMORY_TOOLS"] = "all";
    for (const tool of getVisibleTools()) {
      expect(tool.outputSchema).toBeDefined();
    }
    process.env["AGENTMEMORY_TOOLS"] = "core";
    const core = getVisibleTools();
    expect(core).toHaveLength(8);
    for (const tool of core) {
      expect(tool.outputSchema).toBeDefined();
    }
  });
});

describe("MCP structuredContent via /mcp/tools and /mcp/call", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerMcpEndpoints(sdk as never, kv as never);
  });

  async function listTools() {
    const fn = sdk.getFunction("mcp::tools::list")!;
    return (await fn(makeReq())) as {
      status_code: number;
      body: { tools: Array<{ name: string; outputSchema?: JsonSchema }> };
    };
  }

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const fn = sdk.getFunction("mcp::tools::call")!;
    return (await fn(makeReq({ name, arguments: args }))) as {
      status_code: number;
      body: {
        content?: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
        error?: string;
      };
    };
  }

  function schemaFor(name: string): JsonSchema {
    const tool = getAllTools().find((t) => t.name === name);
    expect(tool, name).toBeDefined();
    return tool!.outputSchema;
  }

  it("GET /agentmemory/mcp/tools exposes outputSchema on every tool", async () => {
    const listed = await listTools();
    expect(listed.status_code).toBe(200);
    expect(listed.body.tools.length).toBe(getAllTools().length);
    for (const tool of listed.body.tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it("memory_save returns structuredContent matching the schema and compact text", async () => {
    const memory = {
      id: "mem_1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      type: "fact",
      title: "Use HMAC",
      content: "Use HMAC",
      concepts: ["hmac"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    };
    sdk.overrideTrigger("mem::remember", async () => ({ success: true, memory }));
    const res = await callTool("memory_save", { content: "Use HMAC" });
    expect(res.status_code).toBe(200);
    const text = expectTextContent(res.body);
    expect(text).toBe(JSON.stringify({ success: true, memory }));
    expect(res.body.structuredContent).toEqual({ success: true, memory });
    validateAgainstOutputSchema(schemaFor("memory_save"), res.body.structuredContent);
  });

  it("memory_recall keeps narrative text while returning the object as structuredContent", async () => {
    const result = {
      format: "narrative",
      results: [
        {
          obsId: "obs_1",
          sessionId: "ses_1",
          title: "Decision",
          narrative: "We chose HMAC.",
          score: 0.9,
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
      text: "1. Decision\nWe chose HMAC.",
      tokens_used: 12,
      truncated: false,
    };
    sdk.overrideTrigger("mem::search", async () => result);
    const res = await callTool("memory_recall", {
      query: "hmac",
      format: "narrative",
    });
    expect(res.status_code).toBe(200);
    expect(expectTextContent(res.body)).toBe(result.text);
    expect(res.body.structuredContent).toEqual(result);
    validateAgainstOutputSchema(schemaFor("memory_recall"), res.body.structuredContent);
  });

  it("memory_file_history keeps the plain-text block and structures the function result", async () => {
    sdk.overrideTrigger("mem::file-context", async () => ({
      context: "<agentmemory-file-context>\n## src/a.ts\n</agentmemory-file-context>",
    }));
    const res = await callTool("memory_file_history", { files: "src/a.ts" });
    expect(res.status_code).toBe(200);
    expect(expectTextContent(res.body)).toContain("<agentmemory-file-context>");
    expect(res.body.structuredContent).toEqual({
      context: "<agentmemory-file-context>\n## src/a.ts\n</agentmemory-file-context>",
    });
    validateAgainstOutputSchema(
      schemaFor("memory_file_history"),
      res.body.structuredContent,
    );
  });

  it("memory_file_history empty result keeps the fallback text and object shape", async () => {
    sdk.overrideTrigger("mem::file-context", async () => ({ context: "" }));
    const res = await callTool("memory_file_history", { files: "missing.ts" });
    expect(expectTextContent(res.body)).toBe("No history found.");
    expect(res.body.structuredContent).toEqual({ context: "" });
    validateAgainstOutputSchema(
      schemaFor("memory_file_history"),
      res.body.structuredContent,
    );
  });

  it("memory_sessions and memory_audit wrap list results as objects", async () => {
    await kv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "demo",
      cwd: "/demo",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 2,
    });
    const sessionsRes = await callTool("memory_sessions");
    expect(sessionsRes.status_code).toBe(200);
    expect(expectTextContent(sessionsRes.body)).toContain("ses_1");
    expect(Array.isArray((sessionsRes.body.structuredContent as { sessions: unknown[] }).sessions)).toBe(true);
    validateAgainstOutputSchema(
      schemaFor("memory_sessions"),
      sessionsRes.body.structuredContent,
    );

    const entries = [
      {
        id: "aud_1",
        timestamp: "2026-01-01T00:00:00Z",
        operation: "remember",
        functionId: "mem::remember",
        targetIds: ["mem_1"],
        details: { ok: true },
      },
    ];
    sdk.overrideTrigger("mem::audit-query", async () => entries);
    const auditRes = await callTool("memory_audit", { limit: 10 });
    expect(expectTextContent(auditRes.body)).toBe(JSON.stringify(entries, null, 2));
    expect(auditRes.body.structuredContent).toEqual({ entries });
    validateAgainstOutputSchema(schemaFor("memory_audit"), auditRes.body.structuredContent);
  });

  it("memory_smart_search and memory_export return the underlying objects", async () => {
    const search = {
      mode: "compact",
      results: [
        {
          obsId: "obs_1",
          sessionId: "ses_1",
          title: "Auth",
          type: "decision",
          score: 1,
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
    };
    sdk.overrideTrigger("mem::smart-search", async () => search);
    const searchRes = await callTool("memory_smart_search", { query: "auth" });
    expect(searchRes.body.structuredContent).toEqual(search);
    validateAgainstOutputSchema(
      schemaFor("memory_smart_search"),
      searchRes.body.structuredContent,
    );

    const exported = {
      version: "0.9.29",
      exportedAt: "2026-01-01T00:00:00Z",
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    };
    sdk.overrideTrigger("mem::export", async () => exported);
    const exportRes = await callTool("memory_export");
    expect(exportRes.body.structuredContent).toEqual(exported);
    validateAgainstOutputSchema(schemaFor("memory_export"), exportRes.body.structuredContent);
  });

  it("feature-disabled vision search keeps the in-function error object", async () => {
    sdk.overrideTrigger("mem::vision-search", async () => ({
      success: false,
      error: "image embeddings disabled (set AGENTMEMORY_IMAGE_EMBEDDINGS=true)",
    }));
    const res = await callTool("memory_vision_search", { queryText: "login form" });
    expect(res.status_code).toBe(200);
    expect(expectTextContent(res.body)).toContain("image embeddings disabled");
    expect(res.body.structuredContent).toEqual({
      success: false,
      error: "image embeddings disabled (set AGENTMEMORY_IMAGE_EMBEDDINGS=true)",
    });
    validateAgainstOutputSchema(
      schemaFor("memory_vision_search"),
      res.body.structuredContent,
    );
  });

  it("unregistered optional features return a structured unavailable object", async () => {
    const cases = [
      {
        name: "memory_claude_bridge_sync",
        args: { direction: "read" },
        fn: "mem::claude-bridge-read",
        message: "Claude bridge not enabled. Set CLAUDE_MEMORY_BRIDGE=true",
      },
      {
        name: "memory_graph_query",
        args: {},
        fn: "mem::graph-query",
        message: "Knowledge graph not enabled. Set GRAPH_EXTRACTION_ENABLED=true",
      },
      {
        name: "memory_consolidate",
        args: {},
        fn: "mem::consolidate-pipeline",
        message: "Consolidation not enabled. Set CONSOLIDATION_ENABLED=true",
      },
      {
        name: "memory_team_feed",
        args: {},
        fn: "mem::team-feed",
        message: "Team memory not enabled. Set TEAM_ID and USER_ID",
      },
      {
        name: "memory_snapshot_create",
        args: { message: "checkpoint" },
        fn: "mem::snapshot-create",
        message: "Snapshots not enabled. Set SNAPSHOT_ENABLED=true",
      },
    ] as const;

    for (const item of cases) {
      sdk.overrideTrigger(item.fn, async () => {
        throw new Error("not registered");
      });
      const res = await callTool(item.name, { ...item.args });
      expect(res.status_code).toBe(200);
      expect(expectTextContent(res.body)).toBe(item.message);
      expect(res.body.structuredContent).toEqual({
        status: "unavailable",
        message: item.message,
      });
      validateAgainstOutputSchema(schemaFor(item.name), res.body.structuredContent);
    }
  });

  it("memory_consolidate in-function disabled shape stays consistent", async () => {
    const disabled = {
      success: false,
      skipped: true,
      reason: "Consolidation disabled: set CONSOLIDATION_ENABLED=true or configure an LLM provider",
    };
    sdk.overrideTrigger("mem::consolidate-pipeline", async () => disabled);
    const res = await callTool("memory_consolidate", {});
    expect(res.body.structuredContent).toEqual(disabled);
    validateAgainstOutputSchema(schemaFor("memory_consolidate"), res.body.structuredContent);
  });

  it("audit and governance catch paths return structured error objects", async () => {
    sdk.overrideTrigger("mem::audit-query", async () => {
      throw new Error("boom");
    });
    const audit = await callTool("memory_audit", {});
    expect(audit.body.isError).toBe(true);
    expect(expectTextContent(audit.body)).toBe("Audit query failed");
    expect(audit.body.structuredContent).toEqual({
      status: "error",
      message: "Audit query failed",
    });
    validateAgainstOutputSchema(schemaFor("memory_audit"), audit.body.structuredContent);

    sdk.overrideTrigger("mem::governance-delete", async () => {
      throw new Error("boom");
    });
    const gone = await callTool("memory_governance_delete", {
      memoryIds: "mem_1",
    });
    expect(gone.body.isError).toBe(true);
    expect(gone.body.structuredContent).toEqual({
      status: "error",
      message: "Governance delete failed",
    });
    validateAgainstOutputSchema(
      schemaFor("memory_governance_delete"),
      gone.body.structuredContent,
    );
  });

  it("memory_commit_lookup and memory_next keep nullable success shapes", async () => {
    const lookup = await callTool("memory_commit_lookup", { sha: "abc123" });
    expect(lookup.body.structuredContent).toEqual({ commit: null, sessions: [] });
    validateAgainstOutputSchema(
      schemaFor("memory_commit_lookup"),
      lookup.body.structuredContent,
    );

    sdk.overrideTrigger("mem::next", async () => ({
      success: true,
      suggestion: null,
      message: "No actionable work found",
      totalActions: 0,
    }));
    const next = await callTool("memory_next", {});
    expect(next.body.structuredContent).toEqual({
      success: true,
      suggestion: null,
      message: "No actionable work found",
      totalActions: 0,
    });
    validateAgainstOutputSchema(schemaFor("memory_next"), next.body.structuredContent);
  });

  it("does not execute the underlying function twice to build text and structured output", async () => {
    let calls = 0;
    sdk.overrideTrigger("mem::remember", async () => {
      calls += 1;
      return {
        success: true,
        memory: {
          id: "mem_once",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          type: "fact",
          title: "once",
          content: "once",
          concepts: [],
          files: [],
          sessionIds: [],
          strength: 1,
          version: 1,
          isLatest: true,
        },
      };
    });
    await callTool("memory_save", { content: "once" });
    expect(calls).toBe(1);
  });

  it("400 validation errors stay API errors without structuredContent", async () => {
    const res = await callTool("memory_save", {});
    expect(res.status_code).toBe(400);
    expect(res.body.error).toBe("content is required for memory_save");
    expect(res.body.structuredContent).toBeUndefined();
  });
});
