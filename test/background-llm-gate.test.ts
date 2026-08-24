// Background LLM jobs (compress, summarize, graph-extract) used to start one
// provider call per event with no cap. After a graph reset that burst is the
// next OOM risk: idle-sweep plus observe fire-and-forget extract/compress onto
// the same event loop. The gate queues them. See
// docs/investigations/2026-08-24-latency-and-oom.md.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerGraphFunction } from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";
import {
  Semaphore,
  setBackgroundLlmGate,
} from "../src/utils/semaphore.js";

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
      updates: Array<{ type?: string; path: string; value: unknown }>,
    ) => {
      if (!store.has(scope)) store.set(scope, new Map());
      const m = store.get(scope)!;
      const v = { ...((m.get(key) as Record<string, unknown>) ?? {}) };
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
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
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger: async (
      input: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof input === "string" ? input : input.function_id;
      const payload = typeof input === "string" ? data : input.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function obs(id: string): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp: `2026-02-01T10:00:0${id.slice(-1)}Z`,
    type: "file_read",
    title: "Read something",
    facts: [],
    narrative: "Nothing structural here",
    concepts: [],
    files: [],
    importance: 3,
    derivedBy: "synthetic",
  };
}

describe("graph-extract LLM pass uses the background gate", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
    sdk = mockSdk();
    kv = mockKV();
    const session: Session = {
      id: "ses_1",
      project: "ebox-app",
      cwd: "/tmp",
      startedAt: "2026-02-01T09:00:00Z",
      updatedAt: "2026-02-01T10:00:00Z",
      observationCount: 2,
      status: "active",
    } as Session;
    await kv.set(KV.sessions, "ses_1", session);
    setBackgroundLlmGate(new Semaphore(1));
  });

  afterEach(() => {
    setBackgroundLlmGate(null);
    delete process.env["GRAPH_EXTRACTION_ENABLED"];
  });

  it("never runs two graph-extract LLM calls at once", async () => {
    let running = 0;
    let peak = 0;
    const provider = {
      name: "test",
      compress: vi.fn(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return "<entities></entities>";
      }),
      summarize: vi.fn(),
    };
    registerGraphFunction(sdk as never, kv as never, provider as never);

    await Promise.all([
      sdk.trigger("mem::graph-extract", {
        sessionId: "ses_1",
        observations: [obs("obs_1")],
      }),
      sdk.trigger("mem::graph-extract", {
        sessionId: "ses_1",
        observations: [obs("obs_2")],
      }),
    ]);

    expect(provider.compress).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });
});
