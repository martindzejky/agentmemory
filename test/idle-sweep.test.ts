import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Session } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import {
  registerIdleSweepFunction,
  __resetIdleSweepInFlightForTests,
} from "../src/functions/idle-sweep.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  isIdleSweepEnabled: vi.fn(() => true),
  getIdleThresholdMs: vi.fn(() => 30 * 60 * 1000),
  getIdleSweepMaxSessions: vi.fn(() => 5),
  getIdleSweepSessionCooldownMs: vi.fn(() => 60 * 60 * 1000),
  getIdleSweepObsCatchup: vi.fn(() => 25),
}));

import {
  isIdleSweepEnabled,
  getIdleThresholdMs,
  getIdleSweepMaxSessions,
  getIdleSweepSessionCooldownMs,
  getIdleSweepObsCatchup,
} from "../src/config.js";

type Store = Map<string, Map<string, unknown>>;
type Handler = (payload: unknown) => unknown | Promise<unknown>;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function makeSession(
  id: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    project: "agentmemory",
    cwd: "/repo/agentmemory",
    startedAt: minutesAgo(120),
    updatedAt: minutesAgo(60),
    status: "active",
    observationCount: 3,
    ...overrides,
  };
}

function mockKV(store: Store) {
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    update: async (
      scope: string,
      key: string,
      updates: Array<{ type?: string; path: string; value: unknown }>,
    ) => {
      const m = store.get(scope);
      if (!m) return;
      const v = { ...((m.get(key) as Record<string, unknown>) ?? {}) };
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk(opts?: {
  stoppedResult?: unknown;
  rejectStopped?: boolean;
  rejectForSessionIds?: Set<string>;
  resultForSessionIds?: Map<string, unknown>;
}) {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ function_id: string; payload: unknown }> = [];
  return {
    calls,
    sdk: {
      registerFunction: (functionId: string, handler: Handler) => {
        handlers.set(functionId, handler);
      },
      trigger: async (input: { function_id: string; payload: unknown }) => {
        calls.push(input);
        if (input.function_id === "event::session::stopped") {
          const sessionId = (input.payload as { sessionId?: string }).sessionId;
          if (
            opts?.rejectStopped ||
            (sessionId && opts?.rejectForSessionIds?.has(sessionId))
          ) {
            throw new Error("stopped failed");
          }
          if (sessionId && opts?.resultForSessionIds?.has(sessionId)) {
            return opts.resultForSessionIds.get(sessionId);
          }
          return opts?.stoppedResult ?? { success: true, summary: { title: "ok" } };
        }
        const handler = handlers.get(input.function_id);
        if (!handler) throw new Error(`missing handler: ${input.function_id}`);
        return handler(input.payload);
      },
    },
    handlers,
  };
}

function storeWithSessions(sessions: Session[]): Store {
  return new Map([
    [KV.sessions, new Map(sessions.map((s) => [s.id, s]))],
    [KV.summaries, new Map()],
    [KV.config, new Map()],
  ]);
}

async function runSweep(store: Store, sdkOpts?: Parameters<typeof mockSdk>[0]) {
  const { sdk, calls, handlers } = mockSdk(sdkOpts);
  registerIdleSweepFunction(sdk as never, mockKV(store) as never);
  const sweep = handlers.get("mem::idle-sweep")!;
  const result = await sweep({});
  return { result, calls, store, sweep, sdk };
}

describe("mem::idle-sweep", () => {
  beforeEach(() => {
    __resetIdleSweepInFlightForTests();
    vi.mocked(isIdleSweepEnabled).mockReturnValue(true);
    vi.mocked(getIdleThresholdMs).mockReturnValue(30 * 60 * 1000);
    vi.mocked(getIdleSweepMaxSessions).mockReturnValue(5);
    vi.mocked(getIdleSweepSessionCooldownMs).mockReturnValue(60 * 60 * 1000);
    vi.mocked(getIdleSweepObsCatchup).mockReturnValue(25);
  });

  afterEach(() => {
    __resetIdleSweepInFlightForTests();
  });

  it("processes a changed idle session via event::session::stopped", async () => {
    const store = storeWithSessions([
      makeSession("ses_idle", {
        updatedAt: minutesAgo(60),
        observationCount: 4,
      }),
    ]);

    const { result, calls } = await runSweep(store);

    expect(result).toMatchObject({
      success: true,
      processed: 1,
      candidates: 1,
      failed: 0,
    });
    expect(calls).toEqual([
      {
        function_id: "event::session::stopped",
        payload: { sessionId: "ses_idle", skipConsolidation: true },
      },
    ]);

    const updated = store.get(KV.sessions)!.get("ses_idle") as Session;
    expect(updated.summarizedObservationCount).toBe(4);
    expect(typeof updated.lastSweepAttemptAt).toBe("string");
  });

  it("skips an unchanged session with no trigger calls", async () => {
    const store = storeWithSessions([
      makeSession("ses_done", {
        updatedAt: minutesAgo(60),
        lastEventAt: minutesAgo(90),
        observationCount: 4,
        summarizedObservationCount: 4,
        lastSummarizedEventAt: minutesAgo(90),
        lastSummarizedEventId: "obs_done",
        lastSweepAttemptAt: minutesAgo(90),
      }),
    ]);

    const { result, calls } = await runSweep(store);

    expect(result).toMatchObject({
      success: true,
      processed: 0,
      candidates: 0,
    });
    expect(calls).toEqual([]);
  });

  it("skips a recently-active session below the observation catch-up threshold", async () => {
    const store = storeWithSessions([
      makeSession("ses_hot", {
        updatedAt: minutesAgo(5),
        observationCount: 8,
      }),
    ]);

    const { result, calls } = await runSweep(store);

    expect(result).toMatchObject({
      success: true,
      processed: 0,
      candidates: 0,
    });
    expect(calls).toEqual([]);
  });

  it("processes a recently-active session once pending observations hit catch-up", async () => {
    vi.mocked(getIdleSweepObsCatchup).mockReturnValue(10);
    const store = storeWithSessions([
      makeSession("ses_long", {
        updatedAt: minutesAgo(1),
        observationCount: 30,
        summarizedObservationCount: 5,
      }),
    ]);

    const { result, calls } = await runSweep(store);

    expect(result).toMatchObject({
      success: true,
      processed: 1,
      candidates: 1,
      failed: 0,
    });
    expect(calls).toEqual([
      {
        function_id: "event::session::stopped",
        payload: { sessionId: "ses_long", skipConsolidation: true },
      },
    ]);
    const updated = store.get(KV.sessions)!.get("ses_long") as Session;
    expect(updated.summarizedObservationCount).toBe(30);
  });

  it("respects the per-sweep session cap", async () => {
    vi.mocked(getIdleSweepMaxSessions).mockReturnValue(2);
    const store = storeWithSessions([
      makeSession("ses_a", { updatedAt: minutesAgo(90), observationCount: 1 }),
      makeSession("ses_b", { updatedAt: minutesAgo(80), observationCount: 1 }),
      makeSession("ses_c", { updatedAt: minutesAgo(70), observationCount: 1 }),
    ]);

    const { result, calls } = await runSweep(store);

    expect(result).toMatchObject({
      success: true,
      candidates: 3,
      processed: 2,
      capped: true,
    });
    expect(calls).toHaveLength(2);
    const ids = calls.map(
      (c) => (c.payload as { sessionId: string }).sessionId,
    );
    expect(ids).toEqual(["ses_a", "ses_b"]);
  });

  it("does no work when the sweep is disabled / no LLM provider", async () => {
    vi.mocked(isIdleSweepEnabled).mockReturnValue(false);
    const store = storeWithSessions([
      makeSession("ses_idle", { updatedAt: minutesAgo(60), observationCount: 2 }),
    ]);

    const { result, calls } = await runSweep(store);

    expect(result).toMatchObject({
      success: true,
      skipped: true,
      reason: "disabled_or_no_provider",
      processed: 0,
      scanned: 0,
    });
    expect(calls).toEqual([]);
  });

  it("never triggers corpus consolidation from the sweep", async () => {
    const store = storeWithSessions([
      makeSession("ses_1", { updatedAt: minutesAgo(60), observationCount: 2 }),
      makeSession("ses_2", { updatedAt: minutesAgo(55), observationCount: 2 }),
    ]);

    const { calls } = await runSweep(store);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.function_id).toBe("event::session::stopped");
      expect(call.payload).toEqual(
        expect.objectContaining({ skipConsolidation: true }),
      );
    }
    expect(
      calls.some((c) => c.function_id === "mem::consolidate-pipeline"),
    ).toBe(false);
    expect(calls.some((c) => c.function_id === "mem::auto-crystallize")).toBe(
      false,
    );
  });

  it("handles legacy sessions missing the progress marker without crashing", async () => {
    const legacy: Session = {
      id: "ses_legacy",
      project: "agentmemory",
      cwd: "/repo",
      startedAt: minutesAgo(120),
      status: "active",
      observationCount: 2,
    };
    const store = storeWithSessions([legacy]);

    const { result, calls } = await runSweep(store);

    expect(result).toMatchObject({
      success: true,
      processed: 1,
      failed: 0,
    });
    expect(calls).toEqual([
      {
        function_id: "event::session::stopped",
        payload: { sessionId: "ses_legacy", skipConsolidation: true },
      },
    ]);
    const updated = store.get(KV.sessions)!.get("ses_legacy") as Session;
    expect(updated.summarizedObservationCount).toBe(2);
  });

  it("skips sessions still inside the per-session cooldown window", async () => {
    const store = storeWithSessions([
      makeSession("ses_cool", {
        updatedAt: minutesAgo(60),
        observationCount: 5,
        summarizedObservationCount: 3,
        lastSweepAttemptAt: minutesAgo(10),
      }),
    ]);

    const { result, calls } = await runSweep(store);

    expect(result).toMatchObject({
      success: true,
      candidates: 0,
      processed: 0,
    });
    expect(calls).toEqual([]);
  });

  it("marks no_observations results so empty sessions are not retried forever", async () => {
    const store = storeWithSessions([
      makeSession("ses_empty_obs", {
        updatedAt: minutesAgo(60),
        observationCount: 1,
      }),
    ]);

    const { result, store: out } = await runSweep(store, {
      stoppedResult: { success: false, error: "no_observations" },
    });

    expect(result).toMatchObject({ processed: 1, failed: 0 });
    const updated = out.get(KV.sessions)!.get("ses_empty_obs") as Session;
    expect(updated.summarizedObservationCount).toBe(1);
  });

  it("records attempt time on rejected trigger without advancing the count marker", async () => {
    vi.mocked(getIdleSweepMaxSessions).mockReturnValue(1);
    const store = storeWithSessions([
      makeSession("ses_fail", {
        updatedAt: minutesAgo(90),
        observationCount: 3,
      }),
      makeSession("ses_ok", {
        updatedAt: minutesAgo(60),
        observationCount: 2,
      }),
    ]);

    const { result, calls, store: out, sweep } = await runSweep(store, {
      rejectForSessionIds: new Set(["ses_fail"]),
    });

    expect(result).toMatchObject({ processed: 0, failed: 1, candidates: 2 });
    expect(calls).toHaveLength(1);
    expect((calls[0].payload as { sessionId: string }).sessionId).toBe(
      "ses_fail",
    );

    const failed = out.get(KV.sessions)!.get("ses_fail") as Session;
    expect(failed.summarizedObservationCount).toBeUndefined();
    expect(typeof failed.lastSweepAttemptAt).toBe("string");

    // Second sweep: failing session is in cooldown, healthy session proceeds.
    const second = await sweep({});
    expect(second).toMatchObject({ processed: 1, failed: 0, candidates: 1 });
    const ok = out.get(KV.sessions)!.get("ses_ok") as Session;
    expect(ok.summarizedObservationCount).toBe(2);
  });

  it("records attempt time on non-processable results like no_provider", async () => {
    vi.mocked(getIdleSweepMaxSessions).mockReturnValue(1);
    const store = storeWithSessions([
      makeSession("ses_noprov", {
        updatedAt: minutesAgo(90),
        observationCount: 4,
      }),
      makeSession("ses_ok2", {
        updatedAt: minutesAgo(60),
        observationCount: 2,
      }),
    ]);

    const { result, calls, store: out, sweep } = await runSweep(store, {
      resultForSessionIds: new Map([
        ["ses_noprov", { success: false, error: "no_provider" }],
      ]),
    });

    expect(result).toMatchObject({ processed: 0, failed: 1, candidates: 2 });
    expect(calls).toHaveLength(1);
    expect((calls[0].payload as { sessionId: string }).sessionId).toBe(
      "ses_noprov",
    );
    const failed = out.get(KV.sessions)!.get("ses_noprov") as Session;
    expect(failed.summarizedObservationCount).toBeUndefined();
    expect(typeof failed.lastSweepAttemptAt).toBe("string");

    // After backoff, ses_ok2 is selected and succeeds — ses_noprov no longer
    // monopolizes the cap=1 slot.
    const second = await sweep({});
    expect(second).toMatchObject({ processed: 1, failed: 0, candidates: 1 });
    expect(
      (out.get(KV.sessions)!.get("ses_ok2") as Session)
        .summarizedObservationCount,
    ).toBe(2);
  });

  it("does not overlap concurrent sweep invocations", async () => {
    const store = storeWithSessions([
      makeSession("ses_slow", { updatedAt: minutesAgo(60), observationCount: 1 }),
    ]);
    const handlers = new Map<string, Handler>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Array<{ function_id: string; payload: unknown }> = [];

    const sdk = {
      registerFunction: (functionId: string, handler: Handler) => {
        handlers.set(functionId, handler);
      },
      trigger: async (input: { function_id: string; payload: unknown }) => {
        calls.push(input);
        if (input.function_id === "event::session::stopped") {
          await gate;
          return { success: true };
        }
        return {};
      },
    };

    registerIdleSweepFunction(sdk as never, mockKV(store) as never);
    const sweep = handlers.get("mem::idle-sweep")!;

    const first = sweep({});
    const second = await sweep({});
    expect(second).toMatchObject({
      skipped: true,
      reason: "already_running",
    });
    release();
    const firstResult = await first;
    expect(firstResult).toMatchObject({ processed: 1 });
    expect(calls).toHaveLength(1);
  });
});
