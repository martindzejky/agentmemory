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
import type { EmbeddingProvider } from "../src/types.js";

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
    const started = Date.now();
    enqueueVectorIndexAdd({
      id: "obs_1",
      sessionId: "ses_1",
      text: "railway deploy timeout",
      kind: "synthetic",
    });
    // Enqueueing must not wait on the provider round-trip.
    expect(Date.now() - started).toBeLessThan(10);

    await flushEmbedQueue(5000);
    expect(getEmbedQueueStats().processed).toBe(1);
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
