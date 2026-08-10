import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async (scope: string, key: string, updates: Array<{ path: string; value: unknown }>) => {
      const m = store.get(scope);
      if (!m) return;
      const v = (m.get(key) as Record<string, unknown>) ?? {};
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    fns,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

describe("observe implicit session create (#638)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("creates the session on first observe when project+cwd present and session record missing", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_opencode_abc",
      project: "/home/user/myrepo",
      cwd: "/home/user/myrepo",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: { prompt: "ship the helm chart" },
    })) as { observationId: string };

    expect(result.observationId).toBeTruthy();

    const sessionScope = kv.store.get("mem:sessions");
    expect(sessionScope).toBeTruthy();
    const session = sessionScope!.get("ses_opencode_abc") as Record<string, unknown>;
    expect(session).toBeTruthy();
    expect(session.id).toBe("ses_opencode_abc");
    expect(session.project).toBe("/home/user/myrepo");
    expect(session.cwd).toBe("/home/user/myrepo");
    expect(session.status).toBe("active");
    expect(session.observationCount).toBe(1);
    expect(session.firstPrompt).toBe("ship the helm chart");
  });

  it("does not implicit-create when project+cwd missing (test-payload back-compat)", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_no_project",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: { file_path: "x.ts" } },
    });

    const sessionScope = kv.store.get("mem:sessions");
    // Either no scope at all, or no entry for this session
    expect(sessionScope?.get("ses_no_project")).toBeUndefined();
  });

  it("does not overwrite an existing session when one already exists", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_existing", {
      id: "ses_existing",
      project: "/orig/project",
      cwd: "/orig/cwd",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 7,
      firstPrompt: "original first prompt",
      agentId: "claude",
    });

    await sdk.trigger("mem::observe", {
      sessionId: "ses_existing",
      project: "/different/project",
      cwd: "/different/cwd",
      agentId: "cursor",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_existing") as Record<string, unknown>;
    // Original project + firstPrompt preserved
    expect(session.project).toBe("/orig/project");
    expect(session.firstPrompt).toBe("original first prompt");
    // Counter bumped, updatedAt refreshed
    expect(session.observationCount).toBe(8);
    expect(session.updatedAt).toBeTruthy();
    // Existing agentId is not overwritten by request body
    expect(session.agentId).toBe("claude");
  });

  it("stamps request agentId on lazy create without prior session/start", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_cursor_cloud",
      project: "/workspace",
      cwd: "/workspace",
      agentId: "cursor",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: { prompt: "make session start optional" },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_cursor_cloud") as Record<
      string,
      unknown
    >;
    expect(session.agentId).toBe("cursor");
    expect(session.observationCount).toBe(1);
  });

  it("falls back to AGENT_ID env when request agentId is omitted on lazy create", async () => {
    const prev = process.env["AGENT_ID"];
    process.env["AGENT_ID"] = "env-agent";
    try {
      const { registerObserveFunction } = await import("../src/functions/observe.js");
      const sdk = mockSdk();
      const kv = mockKV();
      registerObserveFunction(sdk as never, kv as never);

      await sdk.trigger("mem::observe", {
        sessionId: "ses_env_agent",
        project: "/workspace",
        cwd: "/workspace",
        hookType: "prompt_submit",
        timestamp: new Date().toISOString(),
        data: { prompt: "no body agentId" },
      });

      const session = kv.store.get("mem:sessions")!.get("ses_env_agent") as Record<
        string,
        unknown
      >;
      expect(session.agentId).toBe("env-agent");
    } finally {
      if (prev === undefined) delete process.env["AGENT_ID"];
      else process.env["AGENT_ID"] = prev;
    }
  });

  it("prefers request agentId over AGENT_ID env on lazy create", async () => {
    const prev = process.env["AGENT_ID"];
    process.env["AGENT_ID"] = "env-agent";
    try {
      const { registerObserveFunction } = await import("../src/functions/observe.js");
      const sdk = mockSdk();
      const kv = mockKV();
      registerObserveFunction(sdk as never, kv as never);

      await sdk.trigger("mem::observe", {
        sessionId: "ses_prefers_request",
        project: "/workspace",
        cwd: "/workspace",
        agentId: "cursor",
        hookType: "prompt_submit",
        timestamp: new Date().toISOString(),
        data: { prompt: "request wins" },
      });

      const session = kv.store
        .get("mem:sessions")!
        .get("ses_prefers_request") as Record<string, unknown>;
      expect(session.agentId).toBe("cursor");
    } finally {
      if (prev === undefined) delete process.env["AGENT_ID"];
      else process.env["AGENT_ID"] = prev;
    }
  });

  it("does not retrofit env AGENT_ID onto an existing session without agentId", async () => {
    const prev = process.env["AGENT_ID"];
    process.env["AGENT_ID"] = "env-agent";
    try {
      const { registerObserveFunction } = await import("../src/functions/observe.js");
      const sdk = mockSdk();
      const kv = mockKV();
      registerObserveFunction(sdk as never, kv as never);

      await kv.set("mem:sessions", "ses_unscoped", {
        id: "ses_unscoped",
        project: "/workspace",
        cwd: "/workspace",
        startedAt: "2026-01-01T00:00:00Z",
        status: "active",
        observationCount: 2,
      });

      await sdk.trigger("mem::observe", {
        sessionId: "ses_unscoped",
        project: "/workspace",
        cwd: "/workspace",
        hookType: "post_tool_use",
        timestamp: new Date().toISOString(),
        data: { tool_name: "Read" },
      });

      const session = kv.store.get("mem:sessions")!.get("ses_unscoped") as Record<
        string,
        unknown
      >;
      expect(session.agentId).toBeUndefined();
      expect(session.observationCount).toBe(3);
    } finally {
      if (prev === undefined) delete process.env["AGENT_ID"];
      else process.env["AGENT_ID"] = prev;
    }
  });
});
