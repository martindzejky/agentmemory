// The hook endpoints (/observe, /enrich) sit on a 2.5s client abort that the
// server is never told about, so their cost has to be bounded server-side.
// Before this, /enrich awaited a search that enumerated the whole graph and
// /observe awaited an embedding round-trip inside the per-session lock, which
// made every hook a 499 under load. See
// docs/investigations/2026-08-24-latency-and-oom.md.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
  bootWarn: vi.fn(),
}));

import { registerEnrichFunction } from "../src/functions/enrich.js";
import {
  getDeadlineExceededCounts,
  resetDeadlineCounters,
} from "../src/utils/deadline.js";
import {
  enqueueVectorIndexAdd,
  getEmbedQueueStats,
  flushEmbedQueue,
  resetEmbedQueue,
} from "../src/state/embed-queue.js";
import {
  setVectorIndex,
  setEmbeddingProvider,
} from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { registerFileIndexFunction } from "../src/functions/file-index.js";
import { invalidateFileContextCache } from "../src/state/file-context-cache.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  EmbeddingProvider,
  Session,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async () => {},
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
  const overrides = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload: unknown } | string, data?: unknown) => {
      const id = typeof input === "string" ? input : input.function_id;
      const payload = typeof input === "string" ? data : input.payload;
      if (overrides.has(id)) return overrides.get(id)!(payload);
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
    overrideTrigger: (id: string, handler: Function) => overrides.set(id, handler),
  };
}

describe("enrich budget", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    resetDeadlineCounters();
    process.env["AGENTMEMORY_ENRICH_BUDGET_MS"] = "50";
    sdk = mockSdk();
    kv = mockKV();
    registerEnrichFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_ENRICH_BUDGET_MS"];
  });

  it("returns the branches that finished and drops the one that overran", async () => {
    sdk.overrideTrigger("mem::file-context", async () => ({
      context: "<agentmemory-file-context>fast branch</agentmemory-file-context>",
    }));
    // A search that outlives the budget, as the graph enumeration did.
    sdk.overrideTrigger("mem::search", async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { results: [{ observation: { narrative: "too late" } }] };
    });

    const started = Date.now();
    const result = (await sdk.trigger({
      function_id: "mem::enrich",
      payload: { sessionId: "ses_1", files: ["src/handler.ts"] },
    })) as { context: string };
    const elapsed = Date.now() - started;

    expect(result.context).toContain("fast branch");
    expect(result.context).not.toContain("too late");
    // Bounded by the budget, not by the slow branch.
    expect(elapsed).toBeLessThan(2000);
    expect(getDeadlineExceededCounts()["enrich.search"]).toBe(1);
  });

  it("does not truncate anything when every branch is inside the budget", async () => {
    sdk.overrideTrigger("mem::file-context", async () => ({ context: "ctx" }));
    sdk.overrideTrigger("mem::search", async () => ({
      results: [{ observation: { narrative: "relevant memory" } }],
    }));

    const result = (await sdk.trigger({
      function_id: "mem::enrich",
      payload: { sessionId: "ses_1", files: ["src/handler.ts"] },
    })) as { context: string };

    expect(result.context).toContain("ctx");
    expect(result.context).toContain("relevant memory");
    expect(getDeadlineExceededCounts()).toEqual({});
  });
});

describe("file-context enumeration reuse", () => {
  // file-context ran one kv.list of KV.sessions plus one per candidate session
  // on every file-touching tool call: 16 enumerations per enrich, measured as
  // 3840 across 240 enrich calls. The candidate sessions are other, historical
  // sessions, so repeating that work per tool call is pure waste.
  function countingKV() {
    const store = new Map<string, Map<string, unknown>>();
    const listCalls: string[] = [];
    return {
      listCalls,
      get: async <T>(scope: string, key: string): Promise<T | null> =>
        (store.get(scope)?.get(key) as T) ?? null,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (!store.has(scope)) store.set(scope, new Map());
        store.get(scope)!.set(key, data);
        return data;
      },
      update: async () => {},
      delete: async (scope: string, key: string): Promise<void> => {
        store.get(scope)?.delete(key);
      },
      list: async <T>(scope: string): Promise<T[]> => {
        listCalls.push(scope);
        const entries = store.get(scope);
        return entries ? (Array.from(entries.values()) as T[]) : [];
      },
    };
  }

  async function seed(kv: ReturnType<typeof countingKV>) {
    await kv.set(KV.sessions, "ses_old", {
      id: "ses_old",
      project: "ebox-app",
      cwd: "/w",
      startedAt: "2026-02-01T09:00:00Z",
      updatedAt: "2026-02-01T09:30:00Z",
      observationCount: 1,
      status: "active",
    } as Session);
    await kv.set(KV.observations("ses_old"), "obs_old", {
      id: "obs_old",
      sessionId: "ses_old",
      timestamp: "2026-02-01T09:15:00Z",
      type: "file_edit",
      title: "Edited the handler",
      facts: [],
      narrative: "Edited src/handler.ts to fix the timeout",
      concepts: [],
      files: ["src/handler.ts"],
      importance: 7,
    } as CompressedObservation);
  }

  beforeEach(() => {
    invalidateFileContextCache();
  });

  afterEach(() => {
    invalidateFileContextCache();
  });

  it("reuses the session and candidate enumerations across calls", async () => {
    const sdk = mockSdk();
    const kv = countingKV();
    await seed(kv);
    registerFileIndexFunction(sdk as never, kv as never);

    const call = () =>
      sdk.trigger({
        function_id: "mem::file-context",
        payload: { sessionId: "ses_new", files: ["src/handler.ts"] },
      }) as Promise<{ context: string }>;

    const first = await call();
    expect(first.context).toContain("Edited the handler");
    const afterFirst = kv.listCalls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await call();
    expect(second.context).toContain("Edited the handler");
    expect(kv.listCalls.length).toBe(afterFirst);
  });

  it("re-reads a session after its cache entry is invalidated", async () => {
    const sdk = mockSdk();
    const kv = countingKV();
    await seed(kv);
    registerFileIndexFunction(sdk as never, kv as never);

    await sdk.trigger({
      function_id: "mem::file-context",
      payload: { sessionId: "ses_new", files: ["src/handler.ts"] },
    });
    const afterFirst = kv.listCalls.length;

    invalidateFileContextCache("ses_old");

    await sdk.trigger({
      function_id: "mem::file-context",
      payload: { sessionId: "ses_new", files: ["src/handler.ts"] },
    });
    expect(kv.listCalls).toContain(KV.observations("ses_old"));
    expect(kv.listCalls.length).toBeGreaterThan(afterFirst);
  });
});

describe("background embed queue", () => {
  const slowEmbedder = (delayMs: number): EmbeddingProvider => ({
    name: "slow-test",
    dimensions: 3,
    embed: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return new Float32Array([0.1, 0.2, 0.3]);
    },
    embedBatch: async (texts: string[]) =>
      texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
  });

  beforeEach(() => {
    resetEmbedQueue();
    setVectorIndex(new VectorIndex());
    setEmbeddingProvider(slowEmbedder(20));
  });

  afterEach(() => {
    setVectorIndex(null);
    setEmbeddingProvider(null);
    resetEmbedQueue();
  });

  it("returns immediately and indexes afterwards", async () => {
    const index = new VectorIndex();
    setVectorIndex(index);

    enqueueVectorIndexAdd({
      id: "obs_1",
      sessionId: "ses_1",
      text: "railway deploy timeout",
      kind: "synthetic",
    });

    // Enqueueing hands back control without waiting on the provider, so the
    // index cannot be populated yet. Asserting on state rather than elapsed
    // time keeps this deterministic on a loaded CI runner.
    expect(index.size).toBe(0);
    expect(getEmbedQueueStats().processed).toBe(0);

    await flushEmbedQueue(5000);
    expect(getEmbedQueueStats().processed).toBe(1);
    expect(index.size).toBe(1);
  });

  it("never runs more than two embeddings at once", async () => {
    let running = 0;
    let peak = 0;
    setEmbeddingProvider({
      name: "counting",
      dimensions: 3,
      embed: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 15));
        running--;
        return new Float32Array([0.1, 0.2, 0.3]);
      },
      embedBatch: async (texts: string[]) =>
        texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    });

    for (let i = 0; i < 25; i++) {
      enqueueVectorIndexAdd({
        id: `obs_${i}`,
        sessionId: "ses_1",
        text: `observation ${i}`,
        kind: "synthetic",
      });
    }

    await flushEmbedQueue(10_000);
    expect(peak).toBeLessThanOrEqual(2);
    expect(getEmbedQueueStats().processed).toBe(25);
  });

  it("stays bounded under a flood and reports what it dropped", async () => {
    setEmbeddingProvider(slowEmbedder(50));
    for (let i = 0; i < 700; i++) {
      enqueueVectorIndexAdd({
        id: `obs_${i}`,
        sessionId: "ses_1",
        text: `observation ${i}`,
        kind: "synthetic",
      });
    }

    const stats = getEmbedQueueStats();
    expect(stats.queued).toBeLessThanOrEqual(500);
    expect(stats.dropped).toBeGreaterThan(0);
  });
});
