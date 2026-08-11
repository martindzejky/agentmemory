import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventIdIndexEntry, RawObservation } from "../src/types.js";

const loggerWarn = vi.fn();

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn() },
}));

function mockKV(store = new Map<string, Map<string, unknown>>()) {
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

function mockSdk() {
  const fns = new Map<string, Function>();
  const triggered: Array<{ id: string; payload: unknown }> = [];
  return {
    fns,
    triggered,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      triggered.push({ id, payload });
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "ses_event_id",
    project: "/workspace",
    cwd: "/workspace",
    hookType: "prompt_submit",
    timestamp: new Date().toISOString(),
    data: { prompt: "identical user text" },
    ...overrides,
  };
}

describe("mem::observe eventId idempotency", () => {
  beforeEach(() => {
    vi.resetModules();
    loggerWarn.mockClear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deduplicates the same eventId within a session and returns observationId", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const first = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_1" }),
    )) as { observationId: string };
    const second = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_1" }),
    )) as {
      deduplicated: boolean;
      sessionId: string;
      eventId: string;
      observationId: string;
    };

    expect(first.observationId).toBeTruthy();
    expect(second).toEqual({
      deduplicated: true,
      sessionId: "ses_event_id",
      eventId: "evt_1",
      observationId: first.observationId,
    });

    const obs = await kv.list("mem:obs:ses_event_id");
    expect(obs).toHaveLength(1);
    const raw = await kv.list("mem:raw:ses_event_id");
    expect(raw).toHaveLength(1);
  });

  it("persists eventId on the raw KV.rawEvents row", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_persist" }),
    )) as { observationId: string };

    const raw = await kv.get<RawObservation>(
      "mem:raw:ses_event_id",
      result.observationId,
    );
    expect(raw?.eventId).toBe("evt_persist");

    const derived = await kv.get<Record<string, unknown>>(
      "mem:obs:ses_event_id",
      result.observationId,
    );
    expect(derived?.["eventId"]).toBeUndefined();
    expect(derived?.["title"]).toBeTruthy();
  });

  it("persists two observations with identical content when eventIds differ", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const a = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_a" }),
    )) as { observationId: string };
    const b = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_b" }),
    )) as { observationId: string };

    expect(a.observationId).toBeTruthy();
    expect(b.observationId).toBeTruthy();
    expect(a.observationId).not.toBe(b.observationId);

    const obs = await kv.list("mem:obs:ses_event_id");
    expect(obs).toHaveLength(2);
  });

  it("always persists when eventId is missing and never dedups by content", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const first = (await sdk.trigger(
      "mem::observe",
      basePayload(),
    )) as { observationId: string };
    const second = (await sdk.trigger(
      "mem::observe",
      basePayload(),
    )) as { observationId: string };

    expect(first.observationId).toBeTruthy();
    expect(second.observationId).toBeTruthy();
    expect(first.observationId).not.toBe(second.observationId);

    const obs = await kv.list("mem:obs:ses_event_id");
    expect(obs).toHaveLength(2);
    expect(loggerWarn).toHaveBeenCalled();
  });

  it("puts eventId on stream envelopes and on the raw row, not on derived", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_stream" }),
    )) as { observationId: string };

    const derived = await kv.get<Record<string, unknown>>(
      "mem:obs:ses_event_id",
      result.observationId,
    );
    expect(derived?.["eventId"]).toBeUndefined();

    const raw = await kv.get<RawObservation>(
      "mem:raw:ses_event_id",
      result.observationId,
    );
    expect(raw?.eventId).toBe("evt_stream");

    const streamSet = sdk.triggered.find((t) => t.id === "stream::set");
    const streamSend = sdk.triggered.find((t) => t.id === "stream::send");
    expect(
      (streamSet?.payload as { data?: { eventId?: string } })?.data?.eventId,
    ).toBe("evt_stream");
    expect(
      (streamSend?.payload as { data?: { eventId?: string } })?.data?.eventId,
    ).toBe("evt_stream");
  });

  it("rewrites when the eventId index points at a missing raw row", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const first = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_stale" }),
    )) as { observationId: string };

    await kv.delete("mem:raw:ses_event_id", first.observationId);
    await kv.delete("mem:obs:ses_event_id", first.observationId);

    const staleIndex = await kv.get<EventIdIndexEntry>(
      "mem:evt:ses_event_id",
      "evt_stale",
    );
    expect(staleIndex?.observationId).toBe(first.observationId);

    const retry = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_stale" }),
    )) as {
      observationId: string;
      deduplicated?: boolean;
    };

    expect(retry.deduplicated).not.toBe(true);
    expect(retry.observationId).toBeTruthy();
    expect(retry.observationId).not.toBe(first.observationId);
    expect(await kv.list("mem:raw:ses_event_id")).toHaveLength(1);
    expect(await kv.list("mem:obs:ses_event_id")).toHaveLength(1);

    const index = await kv.get<EventIdIndexEntry>(
      "mem:evt:ses_event_id",
      "evt_stale",
    );
    expect(index?.observationId).toBe(retry.observationId);
  });

  it("allows the same eventId in two different sessions", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const a = (await sdk.trigger(
      "mem::observe",
      basePayload({ sessionId: "ses_a", eventId: "shared_evt" }),
    )) as { observationId: string };
    const b = (await sdk.trigger(
      "mem::observe",
      basePayload({ sessionId: "ses_b", eventId: "shared_evt" }),
    )) as { observationId: string };

    expect(a.observationId).toBeTruthy();
    expect(b.observationId).toBeTruthy();
    expect(a.observationId).not.toBe(b.observationId);

    expect(await kv.list("mem:obs:ses_a")).toHaveLength(1);
    expect(await kv.list("mem:obs:ses_b")).toHaveLength(1);
  });

  it("deduplicates concurrent observes with the same eventId", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const results = await Promise.all([
      sdk.trigger("mem::observe", basePayload({ eventId: "evt_race" })),
      sdk.trigger("mem::observe", basePayload({ eventId: "evt_race" })),
    ]);

    const written = results.filter(
      (r): r is { observationId: string } =>
        typeof r === "object" &&
        r !== null &&
        "observationId" in r &&
        typeof (r as { observationId: unknown }).observationId === "string" &&
        (r as { deduplicated?: boolean }).deduplicated !== true,
    );
    const deduped = results.filter(
      (r): r is { deduplicated: true } =>
        typeof r === "object" &&
        r !== null &&
        (r as { deduplicated?: boolean }).deduplicated === true,
    );

    expect(written).toHaveLength(1);
    expect(deduped).toHaveLength(1);
    expect(await kv.list("mem:obs:ses_event_id")).toHaveLength(1);
    expect(await kv.list("mem:raw:ses_event_id")).toHaveLength(1);
  });

  it("does not collide when sessionId/eventId pairs share a colon shape", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    // Flat `${sessionId}:${eventId}` would make these collide.
    const a = (await sdk.trigger(
      "mem::observe",
      basePayload({ sessionId: "a:b", eventId: "c" }),
    )) as { observationId: string };
    const b = (await sdk.trigger(
      "mem::observe",
      basePayload({ sessionId: "a", eventId: "b:c" }),
    )) as { observationId: string };

    expect(a.observationId).toBeTruthy();
    expect(b.observationId).toBeTruthy();
    expect(a.observationId).not.toBe(b.observationId);
    expect(await kv.list("mem:obs:a:b")).toHaveLength(1);
    expect(await kv.list("mem:obs:a")).toHaveLength(1);
  });

  it("dedup survives a simulated restart against the same kv", async () => {
    const store = new Map<string, Map<string, unknown>>();
    const kv = mockKV(store);

    const { registerObserveFunction: register1 } = await import(
      "../src/functions/observe.js"
    );
    const sdk1 = mockSdk();
    register1(sdk1 as never, kv as never);

    const first = (await sdk1.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_restart" }),
    )) as { observationId: string };
    expect(first.observationId).toBeTruthy();

    vi.resetModules();
    const { registerObserveFunction: register2 } = await import(
      "../src/functions/observe.js"
    );
    const sdk2 = mockSdk();
    register2(sdk2 as never, kv as never);

    const second = (await sdk2.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_restart" }),
    )) as {
      deduplicated: boolean;
      observationId: string;
    };

    expect(second.deduplicated).toBe(true);
    expect(second.observationId).toBe(first.observationId);
    expect(await kv.list("mem:raw:ses_event_id")).toHaveLength(1);
    expect(await kv.list("mem:obs:ses_event_id")).toHaveLength(1);
  });

  it("does not expire eventId index entries over time", async () => {
    vi.useFakeTimers();
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const first = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_long_lived" }),
    )) as { observationId: string };

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    const second = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_long_lived" }),
    )) as { deduplicated: boolean; observationId: string };

    expect(second.deduplicated).toBe(true);
    expect(second.observationId).toBe(first.observationId);
    expect(await kv.list("mem:raw:ses_event_id")).toHaveLength(1);

    const index = await kv.get<EventIdIndexEntry>(
      "mem:evt:ses_event_id",
      "evt_long_lived",
    );
    expect(index?.observationId).toBe(first.observationId);
  });

  it("clears the eventId index when a session is forgotten", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const { registerRememberFunction } = await import(
      "../src/functions/remember.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    registerRememberFunction(sdk as never, kv as never);

    await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_forget_me" }),
    );
    expect(await kv.list("mem:evt:ses_event_id")).toHaveLength(1);

    await sdk.trigger({
      function_id: "mem::forget",
      payload: { sessionId: "ses_event_id" },
    });

    expect(await kv.list("mem:evt:ses_event_id")).toHaveLength(0);
    expect(await kv.list("mem:raw:ses_event_id")).toHaveLength(0);
    expect(await kv.list("mem:obs:ses_event_id")).toHaveLength(0);
  });

  it("re-indexes eventIds on import so retries dedup after restore", async () => {
    const { registerExportImportFunction } = await import(
      "../src/functions/export-import.js"
    );
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerExportImportFunction(sdk as never, kv as never);
    registerObserveFunction(sdk as never, kv as never);

    const sessionId = "ses_event_id_import";
    const raw: RawObservation = {
      id: "obs_imported",
      sessionId,
      timestamp: "2026-08-11T00:00:00.000Z",
      hookType: "prompt_submit",
      userPrompt: "imported",
      raw: { prompt: "imported" },
      eventId: "evt_imported",
    };

    const importResult = (await sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.29",
        exportedAt: "2026-08-11T00:00:00.000Z",
        sessions: [
          {
            id: sessionId,
            project: "/workspace",
            cwd: "/workspace",
            startedAt: "2026-08-11T00:00:00.000Z",
            status: "active",
            observationCount: 1,
          },
        ],
        observations: {
          [sessionId]: [
            {
              id: "obs_imported",
              sessionId,
              timestamp: "2026-08-11T00:00:00.000Z",
              type: "conversation",
              title: "User prompt",
              facts: [],
              narrative: "imported",
              concepts: [],
              files: [],
              importance: 5,
            },
          ],
        },
        rawEvents: { [sessionId]: [raw] },
        memories: [],
        summaries: [],
      },
      strategy: "merge",
    })) as { success: boolean };
    expect(importResult.success).toBe(true);

    const index = await kv.get<EventIdIndexEntry>(
      `mem:evt:${sessionId}`,
      "evt_imported",
    );
    expect(index).toEqual({
      eventId: "evt_imported",
      observationId: "obs_imported",
      at: "2026-08-11T00:00:00.000Z",
    });

    const retry = (await sdk.trigger(
      "mem::observe",
      basePayload({
        sessionId,
        eventId: "evt_imported",
        data: { prompt: "retry after import" },
      }),
    )) as { deduplicated: boolean; observationId: string };

    expect(retry.deduplicated).toBe(true);
    expect(retry.observationId).toBe("obs_imported");
    expect(await kv.list(`mem:raw:${sessionId}`)).toHaveLength(1);
  });

  it("import overwrite drops the previous eventId index key", async () => {
    const { registerExportImportFunction } = await import(
      "../src/functions/export-import.js"
    );
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerExportImportFunction(sdk as never, kv as never);
    registerObserveFunction(sdk as never, kv as never);

    const sessionId = "ses_event_id_reimport";
    await sdk.trigger(
      "mem::observe",
      basePayload({
        sessionId,
        eventId: "evt_old",
        data: { prompt: "original" },
      }),
    );
    expect(
      await kv.get<EventIdIndexEntry>(`mem:evt:${sessionId}`, "evt_old"),
    ).toBeTruthy();

    const existingRaw = (await kv.list<RawObservation>(
      `mem:raw:${sessionId}`,
    ))[0];
    expect(existingRaw).toBeTruthy();

    const updated: RawObservation = {
      ...existingRaw,
      eventId: "evt_new",
      userPrompt: "updated",
      raw: { prompt: "updated" },
    };

    const importResult = (await sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.29",
        exportedAt: "2026-08-11T00:00:00.000Z",
        sessions: [
          {
            id: sessionId,
            project: "/workspace",
            cwd: "/workspace",
            startedAt: "2026-08-11T00:00:00.000Z",
            status: "active",
            observationCount: 1,
          },
        ],
        observations: {},
        rawEvents: { [sessionId]: [updated] },
        memories: [],
        summaries: [],
      },
      strategy: "merge",
    })) as { success: boolean };
    expect(importResult.success).toBe(true);

    expect(
      await kv.get<EventIdIndexEntry>(`mem:evt:${sessionId}`, "evt_old"),
    ).toBeNull();
    expect(
      await kv.get<EventIdIndexEntry>(`mem:evt:${sessionId}`, "evt_new"),
    ).toEqual({
      eventId: "evt_new",
      observationId: existingRaw.id,
      at: existingRaw.timestamp,
    });

    const staleRetry = (await sdk.trigger(
      "mem::observe",
      basePayload({
        sessionId,
        eventId: "evt_old",
        data: { prompt: "should write again" },
      }),
    )) as { observationId?: string; deduplicated?: boolean };
    expect(staleRetry.deduplicated).toBeUndefined();
    expect(staleRetry.observationId).toBeTruthy();
  });
});
