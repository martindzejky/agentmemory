import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";

const SECRET = "observe-bulk-secret";

function mockKV() {
  return {
    get: async () => null,
    set: async <T>(_scope: string, _key: string, data: T) => data,
    delete: async () => {},
    update: vi.fn(async () => {}),
    list: async () => [],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  const trigger = vi.fn(
    async (input: { function_id: string; payload?: unknown }) => {
      if (input.function_id === "mem::observe") {
        const payload = input.payload as { eventId?: string };
        if (payload.eventId === "dup-1") {
          return { deduplicated: true, observationId: "obs_existing" };
        }
        if (payload.eventId === "boom") {
          throw new Error("observe blew up");
        }
        return { observationId: "obs_new" };
      }
      return fns.get(input.function_id)?.(input.payload);
    },
  );
  return {
    registerFunction: (id: string, h: Function) => fns.set(id, h),
    registerTrigger: () => {},
    trigger,
    _fns: fns,
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    hookType: "prompt_submit",
    sessionId: "ses_bulk",
    project: "/workspace",
    cwd: "/workspace",
    timestamp: "2026-08-12T00:00:00.000Z",
    data: { prompt: "hello" },
    ...overrides,
  };
}

describe("api::observe::bulk", () => {
  it("triggers mem::observe in series with whitelisted payloads", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, SECRET);
    const handler = sdk._fns.get("api::observe::bulk")!;

    const res = await handler({
      headers: { authorization: `Bearer ${SECRET}` },
      body: {
        observations: [
          observation({ eventId: "e1", agentId: "cursor", junk: "drop-me" }),
          observation({
            hookType: "assistant_response",
            eventId: "e2",
            data: { assistantResponse: "hi" },
            extra: 1,
          }),
        ],
        alsoIgnored: true,
      },
    });

    expect(res.status_code).toBe(200);
    expect(res.body).toEqual({
      success: true,
      total: 2,
      imported: 2,
      deduplicated: 0,
      failed: 0,
    });
    expect(sdk.trigger).toHaveBeenCalledTimes(2);
    expect(sdk.trigger.mock.calls[0]![0]).toEqual({
      function_id: "mem::observe",
      payload: {
        hookType: "prompt_submit",
        sessionId: "ses_bulk",
        project: "/workspace",
        cwd: "/workspace",
        timestamp: "2026-08-12T00:00:00.000Z",
        data: { prompt: "hello" },
        agentId: "cursor",
        eventId: "e1",
      },
    });
    expect(sdk.trigger.mock.calls[1]![0]).toEqual({
      function_id: "mem::observe",
      payload: {
        hookType: "assistant_response",
        sessionId: "ses_bulk",
        project: "/workspace",
        cwd: "/workspace",
        timestamp: "2026-08-12T00:00:00.000Z",
        data: { assistantResponse: "hi" },
        eventId: "e2",
      },
    });
    expect(sdk.trigger.mock.calls[0]![0].payload).not.toHaveProperty("junk");
    expect(sdk.trigger.mock.calls[1]![0].payload).not.toHaveProperty("extra");
  });

  it("counts deduplicated results from mem::observe", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, SECRET);
    const handler = sdk._fns.get("api::observe::bulk")!;

    const res = await handler({
      headers: { authorization: `Bearer ${SECRET}` },
      body: {
        observations: [
          observation({ eventId: "dup-1" }),
          observation({ eventId: "e2" }),
        ],
      },
    });

    expect(res.status_code).toBe(200);
    expect(res.body).toEqual({
      success: true,
      total: 2,
      imported: 1,
      deduplicated: 1,
      failed: 0,
    });
  });

  it("rejects empty or missing observations with 400", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, SECRET);
    const handler = sdk._fns.get("api::observe::bulk")!;

    for (const body of [{}, { observations: [] }, { observations: "nope" }]) {
      const res = await handler({
        headers: { authorization: `Bearer ${SECRET}` },
        body,
      });
      expect(res.status_code).toBe(400);
      expect(res.body).toEqual({
        error: "observations must be a non-empty array",
      });
    }
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects invalid items before any trigger (validate-all-then-write)", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, SECRET);
    const handler = sdk._fns.get("api::observe::bulk")!;

    const res = await handler({
      headers: { authorization: `Bearer ${SECRET}` },
      body: {
        observations: [
          observation({ eventId: "ok" }),
          observation({ sessionId: "" }),
        ],
      },
    });

    expect(res.status_code).toBe(400);
    expect(res.body.error).toMatch(/observations\[1\]/);
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("rejects over max length with 400", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, SECRET);
    const handler = sdk._fns.get("api::observe::bulk")!;

    const res = await handler({
      headers: { authorization: `Bearer ${SECRET}` },
      body: {
        observations: Array.from({ length: 501 }, (_, i) =>
          observation({ eventId: `e${i}` }),
        ),
      },
    });

    expect(res.status_code).toBe(400);
    expect(res.body).toEqual({
      error: "observations exceeds max length of 500",
    });
    expect(sdk.trigger).not.toHaveBeenCalled();
  });

  it("records per-item trigger failures and continues", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, SECRET);
    const handler = sdk._fns.get("api::observe::bulk")!;

    const res = await handler({
      headers: { authorization: `Bearer ${SECRET}` },
      body: {
        observations: [
          observation({ eventId: "boom" }),
          observation({ eventId: "ok" }),
        ],
      },
    });

    expect(res.status_code).toBe(200);
    expect(res.body).toEqual({
      success: true,
      total: 2,
      imported: 1,
      deduplicated: 0,
      failed: 1,
      errors: [{ index: 0, eventId: "boom", error: "observe blew up" }],
    });
    expect(sdk.trigger).toHaveBeenCalledTimes(2);
  });
});
