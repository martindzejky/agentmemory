// Regression protection for the defect diagnosed in
// docs/investigations/2026-08-24-latency-and-oom.md: every hybrid search
// enumerated KV.graphNodes and KV.graphEdges (twice per query), which at
// production scale cost 60.8 MB of JSON and ~2.1s per search, grew iii-engine
// RSS by 573 MB that was never released, and produced results that were then
// discarded because retrieval never set a sessionId.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getDeadlineExceededCounts,
  resetDeadlineCounters,
} from "../src/utils/deadline.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import { KV } from "../src/state/schema.js";
import type {
  CompressedObservation,
  EmbeddingProvider,
  GraphEdge,
  GraphNode,
} from "../src/types.js";

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Deploy Railway service",
    facts: ["bumped the image"],
    narrative: "Deployed the Railway service and checked the timeout config",
    concepts: ["railway"],
    files: ["deploy/railway/Dockerfile"],
    importance: 7,
    ...overrides,
  };
}

// Records every scope enumerated so a test can assert that the graph tables are
// not touched, and how many times they are when the feature is on.
function mockKV() {
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

const embedder: EmbeddingProvider = {
  name: "test",
  dimensions: 3,
  embed: async () => new Float32Array([0.1, 0.2, 0.3]),
  embedBatch: async (texts: string[]) =>
    texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
};

function graphNode(id: string, name: string, obsIds: string[]): GraphNode {
  return {
    id,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: obsIds,
    createdAt: new Date().toISOString(),
  };
}

function graphEdge(id: string, source: string, target: string): GraphEdge {
  return {
    id,
    type: "related_to",
    sourceNodeId: source,
    targetNodeId: target,
    weight: 0.5,
    sourceObservationIds: [],
    createdAt: new Date().toISOString(),
  };
}

describe("graph stream is off unless explicitly enabled", () => {
  let kv: ReturnType<typeof mockKV>;
  let bm25: SearchIndex;
  let vector: VectorIndex;

  beforeEach(async () => {
    delete process.env["AGENTMEMORY_GRAPH_SEARCH"];
    kv = mockKV();
    bm25 = new SearchIndex();
    vector = new VectorIndex();

    const obs = makeObs();
    bm25.add(obs);
    vector.add(obs.id, obs.sessionId, new Float32Array([0.1, 0.2, 0.3]));
    await kv.set(KV.observations(obs.sessionId), obs.id, obs);
    await kv.set(KV.graphNodes, "n1", graphNode("n1", "railway", [obs.id]));
    await kv.set(KV.graphEdges, "e1", graphEdge("e1", "n1", "n1"));
    kv.listCalls.length = 0;
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_GRAPH_SEARCH"];
  });

  it("never enumerates the graph tables by default", async () => {
    const hybrid = new HybridSearch(bm25, vector, embedder, kv as never);

    const results = await hybrid.search("Railway deploy", 5);

    expect(results.length).toBeGreaterThan(0);
    expect(kv.listCalls).not.toContain(KV.graphNodes);
    expect(kv.listCalls).not.toContain(KV.graphEdges);
  });

  it("enumerates the graph tables when the flag is set", async () => {
    process.env["AGENTMEMORY_GRAPH_SEARCH"] = "true";
    const hybrid = new HybridSearch(bm25, vector, embedder, kv as never);

    await hybrid.search('"railway" Railway', 5);

    expect(kv.listCalls).toContain(KV.graphNodes);
    expect(kv.listCalls).toContain(KV.graphEdges);
  });

  it("resolves the sessionId graph retrieval leaves empty so hits can hydrate", async () => {
    process.env["AGENTMEMORY_GRAPH_SEARCH"] = "true";
    // An observation reachable only through the graph: not in the vector index,
    // and worded so BM25 cannot match the query.
    const graphOnly = makeObs({
      id: "obs_graph",
      sessionId: "ses_graph",
      title: "zzz unrelated wording",
      narrative: "zzz unrelated wording",
      concepts: [],
      files: [],
    });
    bm25.add(graphOnly);
    await kv.set(KV.observations("ses_graph"), "obs_graph", graphOnly);
    await kv.set(
      KV.graphNodes,
      "n2",
      graphNode("n2", "railway", ["obs_graph"]),
    );

    const hybrid = new HybridSearch(bm25, vector, embedder, kv as never);
    const results = await hybrid.search('"railway"', 10);

    const hit = results.find((r) => r.observation.id === "obs_graph");
    expect(hit).toBeDefined();
    expect(hit!.sessionId).toBe("ses_graph");
  });
});

describe("graph retrieval stays bounded when enabled", () => {
  beforeEach(() => {
    resetDeadlineCounters();
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_GRAPH_SEARCH_MAX_SEEDS"];
    delete process.env["AGENTMEMORY_GRAPH_SEARCH_BUDGET_MS"];
  });

  it("enumerates each graph table exactly once per call regardless of seed count", async () => {
    const kv = mockKV();
    for (let i = 0; i < 40; i++) {
      await kv.set(
        KV.graphNodes,
        `n${i}`,
        graphNode(`n${i}`, `railway-${i}`, [`obs_${i}`]),
      );
      await kv.set(
        KV.graphEdges,
        `e${i}`,
        graphEdge(`e${i}`, `n${i}`, `n${(i + 1) % 40}`),
      );
    }
    kv.listCalls.length = 0;

    const retrieval = new GraphRetrieval(kv as never);
    await retrieval.searchByEntities(["railway"], 2, 20);

    // Two lists total. Building adjacency per seed was O(seeds x edges) and
    // measured 62s for a single call on the production graph.
    expect(kv.listCalls.filter((s) => s === KV.graphNodes)).toHaveLength(1);
    expect(kv.listCalls.filter((s) => s === KV.graphEdges)).toHaveLength(1);
  });

  it("honours the seed cap", async () => {
    process.env["AGENTMEMORY_GRAPH_SEARCH_MAX_SEEDS"] = "2";
    const kv = mockKV();
    // 10 matching nodes, each with its own distinct source observation.
    for (let i = 0; i < 10; i++) {
      await kv.set(
        KV.graphNodes,
        `n${i}`,
        graphNode(`n${i}`, `railway-${i}`, [`obs_${i}`]),
      );
    }

    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.searchByEntities(["railway"], 1, 100);

    // Isolated nodes contribute exactly their own source observations, so the
    // seed cap is directly observable in the result count.
    expect(results).toHaveLength(2);
  });

  it("stops traversing once the budget is spent", async () => {
    process.env["AGENTMEMORY_GRAPH_SEARCH_BUDGET_MS"] = "1000";
    const kv = mockKV();
    for (let i = 0; i < 10; i++) {
      await kv.set(
        KV.graphNodes,
        `n${i}`,
        graphNode(`n${i}`, `railway-${i}`, [`obs_${i}`]),
      );
    }

    // An in-memory graph this small traverses inside a single millisecond, so
    // the clock is driven explicitly: each check advances 400ms against a
    // 1000ms budget, which must stop the loop well before all 10 seeds.
    const realNow = Date.now;
    let virtualNow = realNow();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      virtualNow += 400;
      return virtualNow;
    });

    try {
      const retrieval = new GraphRetrieval(kv as never);
      const results = await retrieval.searchByEntities(["railway"], 2, 100);
      expect(results.length).toBeLessThan(10);
      expect(getDeadlineExceededCounts()["graph.searchByEntities"]).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});
