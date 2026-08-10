import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

const SECRET = "session-end-noop-secret";

function mockKV(store = new Map<string, Map<string, unknown>>()) {
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T | undefined) ?? null,
    set: async <T>(scope: string, key: string, data: T) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async () => {},
    update: vi.fn(async () => {}),
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
    _store: store,
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  const trigger = vi.fn(
    async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
  );
  return {
    registerFunction: (id: string, h: Function) => fns.set(id, h),
    registerTrigger: () => {},
    trigger,
    _fns: fns,
  };
}

function activeSession(id: string): Session {
  return {
    id,
    project: "/tmp/proj",
    cwd: "/tmp/proj",
    startedAt: "2026-08-01T00:00:00.000Z",
    status: "active",
    observationCount: 2,
  };
}

describe("api::session::end noop behavior", () => {
  it("leaves the session active and does not fire stopped side effects", async () => {
    const kv = mockKV();
    const session = activeSession("ses_open");
    await kv.set(KV.sessions, session.id, session);
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const handler = sdk._fns.get("api::session::end")!;
    const res = await handler({
      headers: { authorization: `Bearer ${SECRET}` },
      body: { sessionId: session.id },
    });

    expect(res.status_code).toBe(200);
    expect(res.body).toEqual({ success: true, noop: true });

    const stored = await kv.get<Session>(KV.sessions, session.id);
    expect(stored?.status).toBe("active");
    expect(stored?.endedAt).toBeUndefined();
    expect(kv.update).not.toHaveBeenCalled();
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects missing sessionId", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const handler = sdk._fns.get("api::session::end")!;
    const res = await handler({
      headers: { authorization: `Bearer ${SECRET}` },
      body: {},
    });

    expect(res.status_code).toBe(400);
    expect(kv.update).not.toHaveBeenCalled();
    expect(sdk.trigger).not.toHaveBeenCalled();
  });
});

describe("event::session::ended noop behavior", () => {
  it("does not stamp completed or endedAt", async () => {
    const kv = mockKV();
    const session = activeSession("ses_topic");
    await kv.set(KV.sessions, session.id, session);
    const sdk = mockSdk();
    registerEventTriggers(sdk as never, kv as never);

    const handler = sdk._fns.get("event::session::ended")!;
    const result = await handler({ sessionId: session.id });

    expect(result).toEqual({ success: true, noop: true });
    expect(kv.update).not.toHaveBeenCalled();
    const stored = await kv.get<Session>(KV.sessions, session.id);
    expect(stored?.status).toBe("active");
    expect(stored?.endedAt).toBeUndefined();
  });
});
