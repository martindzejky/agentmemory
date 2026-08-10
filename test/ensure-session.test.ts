import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    update: async (
      scope: string,
      key: string,
      updates: Array<{ path: string; value: unknown }>,
    ) => {
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

describe("ensureSession", () => {
  const ORIG_AGENT = process.env["AGENT_ID"];

  beforeEach(() => {
    vi.resetModules();
    delete process.env["AGENT_ID"];
  });

  afterEach(() => {
    if (ORIG_AGENT === undefined) delete process.env["AGENT_ID"];
    else process.env["AGENT_ID"] = ORIG_AGENT;
  });

  it("creates a session with request agentId and createObservationCount", async () => {
    const { ensureSession } = await import("../src/functions/ensure-session.js");
    const kv = mockKV();

    const result = await ensureSession(kv as never, {
      sessionId: "ses_new",
      project: "/workspace",
      cwd: "/workspace",
      agentId: "cursor",
      createObservationCount: 1,
      firstPrompt: "hello",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.session.agentId).toBe("cursor");
    expect(result.session.observationCount).toBe(1);
    expect(result.session.firstPrompt).toBe("hello");
    expect(result.session.status).toBe("active");
  });

  it("returns missing_project_cwd when create inputs are incomplete", async () => {
    const { ensureSession } = await import("../src/functions/ensure-session.js");
    const kv = mockKV();

    const result = await ensureSession(kv as never, {
      sessionId: "ses_incomplete",
      agentId: "cursor",
    });

    expect(result).toEqual({ ok: false, reason: "missing_project_cwd" });
  });

  it("touches existing sessions without wiping fields or agentId", async () => {
    const { ensureSession } = await import("../src/functions/ensure-session.js");
    const kv = mockKV();
    await kv.set("mem:sessions", "ses_existing", {
      id: "ses_existing",
      project: "/orig",
      cwd: "/orig",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 4,
      firstPrompt: "keep me",
      agentId: "claude",
    });

    const result = await ensureSession(kv as never, {
      sessionId: "ses_existing",
      project: "/other",
      cwd: "/other",
      agentId: "cursor",
      incrementObservationCount: 1,
      firstPrompt: "ignored because already set",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.session.project).toBe("/orig");
    expect(result.session.firstPrompt).toBe("keep me");
    expect(result.session.agentId).toBe("claude");
    expect(result.session.observationCount).toBe(5);
    expect(result.session.updatedAt).toBeTruthy();
  });

  it("uses AGENT_ID env when request agentId is absent on create", async () => {
    process.env["AGENT_ID"] = "env-agent";
    const { ensureSession } = await import("../src/functions/ensure-session.js");
    const kv = mockKV();

    const result = await ensureSession(kv as never, {
      sessionId: "ses_env",
      project: "/workspace",
      cwd: "/workspace",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.agentId).toBe("env-agent");
  });
});
