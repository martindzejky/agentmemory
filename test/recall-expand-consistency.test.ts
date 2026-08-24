import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  registerSearchFunction,
  getSearchIndex,
  rebuildIndex,
} from "../src/functions/search.js";
import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import { KV } from "../src/state/schema.js";
import type {
  CompactSearchResult,
  CompressedObservation,
  Memory,
  Session,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listCalls: string[] = [];
  return {
    listCalls,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
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

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_live",
    timestamp: "2026-08-24T10:00:00.000Z",
    type: "conversation",
    title: "Assistant response",
    facts: [],
    narrative: "Green Glade Games studio name domain greenglade.games",
    concepts: ["green-glade", "domain"],
    files: [],
    importance: 7,
    ...overrides,
  };
}

describe("recall IDs are expandable through smart-search", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerSearchFunction(sdk as never, kv as never);
    registerSmartSearchFunction(sdk as never, kv as never, async () => []);

    const live: Session = {
      id: "ses_live",
      project: "ggg",
      cwd: "/tmp/ggg",
      startedAt: "2026-08-01T00:00:00Z",
      status: "active",
      observationCount: 1,
    };
    await kv.set(KV.sessions, live.id, live);

    const liveObs = makeObs({
      id: "obs_msptphqk_7322a8edf680",
      sessionId: "ses_live",
      title: "Working control observation",
    });
    const orphanObs = makeObs({
      id: "obs_msptra69_0b80c4ab962d",
      sessionId: "ce9480ce-bb58-45f4-987f-eac4e9215f5a",
      timestamp: "2026-07-31T08:43:00.001Z",
      title: "Assistant response",
    });
    await kv.set(KV.observations(liveObs.sessionId), liveObs.id, liveObs);
    await kv.set(KV.observations(orphanObs.sessionId), orphanObs.id, orphanObs);

    const memory: Memory = {
      id: "mem_studio_domain",
      createdAt: "2026-07-31T08:43:00.001Z",
      updatedAt: "2026-07-31T08:43:00.001Z",
      type: "fact",
      title: "Studio domain",
      content: "Green Glade Games uses the greenglade.games domain",
      concepts: ["green-glade"],
      files: [],
      sessionIds: ["ses_live"],
      strength: 8,
      version: 1,
      isLatest: true,
    };
    await kv.set(KV.memories, memory.id, memory);

    getSearchIndex().clear();
    await rebuildIndex(kv as never);
    // Evicted sessions are absent from KV.sessions, so rebuild cannot see
    // their observations. The live BM25 snapshot still carries them, which
    // is how recall can return an ID expand could not resolve.
    getSearchIndex().add(orphanObs);
  });

  it("expands every compact memory_recall ID without a session hint or session list", async () => {
    const recalled = (await sdk.trigger("mem::search", {
      query: "Green Glade Games studio name domain greenglade.games",
      format: "compact",
      limit: 5,
    })) as { results: CompactSearchResult[] };

    expect(recalled.results.length).toBeGreaterThan(0);
    const recalledIds = recalled.results.map((r) => r.obsId);
    expect(recalledIds).toEqual(
      expect.arrayContaining([
        "obs_msptphqk_7322a8edf680",
        "obs_msptra69_0b80c4ab962d",
        "mem_studio_domain",
      ]),
    );

    kv.listCalls.length = 0;
    for (const obsId of recalledIds) {
      const expanded = (await sdk.trigger("mem::smart-search", {
        query: "Green Glade Games studio name domain greenglade.games",
        expandIds: [obsId],
      })) as {
        mode: string;
        results: Array<{ obsId: string; observation: CompressedObservation }>;
        lookup: { missing: number; staleIndex: number; lookupErrors: number };
      };

      expect(expanded.mode).toBe("expanded");
      expect(expanded.results).toHaveLength(1);
      expect(expanded.results[0].obsId).toBe(obsId);
      expect(expanded.lookup.missing).toBe(0);
      expect(expanded.lookup.staleIndex).toBe(0);
      expect(expanded.lookup.lookupErrors).toBe(0);
    }

    expect(kv.listCalls).not.toContain(KV.sessions);
  });

  it("expands the orphan recall ID that has no KV.sessions row", async () => {
    kv.listCalls.length = 0;
    const expanded = (await sdk.trigger("mem::smart-search", {
      query: "Green Glade Games",
      expandIds: ["obs_msptra69_0b80c4ab962d"],
    })) as {
      results: Array<{ observation: CompressedObservation }>;
      lookup: { foundByIndex: number };
    };

    expect(expanded.results).toHaveLength(1);
    expect(expanded.results[0].observation.sessionId).toBe(
      "ce9480ce-bb58-45f4-987f-eac4e9215f5a",
    );
    expect(expanded.lookup.foundByIndex).toBe(1);
    expect(kv.listCalls).not.toContain(KV.sessions);
  });
});
