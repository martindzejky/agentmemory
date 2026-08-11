import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const loggerWarn = vi.fn();

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn() },
}));

import { DedupMap } from "../src/functions/dedup.js";

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
  let dedupMap: DedupMap;

  beforeEach(() => {
    vi.resetModules();
    loggerWarn.mockClear();
    dedupMap = new DedupMap();
  });

  afterEach(() => {
    dedupMap.stop();
  });

  it("deduplicates the same eventId within a session", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, dedupMap);

    const first = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_1" }),
    )) as { observationId: string };
    const second = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_1" }),
    )) as { deduplicated: boolean; sessionId: string; eventId: string };

    expect(first.observationId).toBeTruthy();
    expect(second).toEqual({
      deduplicated: true,
      sessionId: "ses_event_id",
      eventId: "evt_1",
    });

    const obs = await kv.list("mem:obs:ses_event_id");
    expect(obs).toHaveLength(1);
  });

  it("persists two observations with identical content when eventIds differ", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, dedupMap);

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
    registerObserveFunction(sdk as never, kv as never, dedupMap);

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

  it("puts eventId on stream envelopes, not on the stored observation", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, dedupMap);

    const result = (await sdk.trigger(
      "mem::observe",
      basePayload({ eventId: "evt_stream" }),
    )) as { observationId: string };

    const stored = await kv.get<Record<string, unknown>>(
      "mem:obs:ses_event_id",
      result.observationId,
    );
    expect(stored?.["eventId"]).toBeUndefined();

    const streamSet = sdk.triggered.find((t) => t.id === "stream::set");
    const streamSend = sdk.triggered.find((t) => t.id === "stream::send");
    expect(
      (streamSet?.payload as { data?: { eventId?: string } })?.data?.eventId,
    ).toBe("evt_stream");
    expect(
      (streamSend?.payload as { data?: { eventId?: string } })?.data?.eventId,
    ).toBe("evt_stream");
  });

  it("allows the same eventId in two different sessions", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, dedupMap);

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
    registerObserveFunction(sdk as never, kv as never, dedupMap);

    const results = await Promise.all([
      sdk.trigger("mem::observe", basePayload({ eventId: "evt_race" })),
      sdk.trigger("mem::observe", basePayload({ eventId: "evt_race" })),
    ]);

    const written = results.filter(
      (r): r is { observationId: string } =>
        typeof r === "object" &&
        r !== null &&
        "observationId" in r &&
        typeof (r as { observationId: unknown }).observationId === "string",
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
  });

  it("does not collide when sessionId/eventId pairs share a colon shape", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, dedupMap);

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
});
