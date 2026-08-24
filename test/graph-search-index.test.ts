import { describe, it, expect, beforeEach } from "vitest";
import { persistGraphDelta } from "../src/functions/graph.js";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import { KV } from "../src/state/schema.js";
import {
  GRAPH_SNAPSHOT_KEY,
  snapshotFromGraphTables,
} from "../src/state/graph-snapshot.js";
import {
  OBS_PER_NODE_CAP,
  SEARCH_INDEX_META_KEY,
  ensureSearchIndex,
  searchNodeKey,
  searchObsKey,
  searchTokenKey,
  tokenizeGraphName,
} from "../src/state/graph-search-index.js";
import type {
  GraphEdge,
  GraphNode,
  GraphSearchIndexMeta,
  GraphSearchNodeIndex,
  GraphSearchObsPosting,
  GraphSearchTokenPosting,
} from "../src/types.js";

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

function node(
  id: string,
  name: string,
  obsIds: string[] = ["obs_1"],
  createdAt = "2026-08-24T12:00:00.000Z",
): GraphNode {
  return {
    id,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: obsIds,
    createdAt,
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  createdAt = "2026-08-24T12:00:00.000Z",
): GraphEdge {
  return {
    id,
    type: "related_to",
    sourceNodeId: source,
    targetNodeId: target,
    weight: 0.8,
    sourceObservationIds: ["obs_1"],
    createdAt,
  };
}

describe("tokenizeGraphName", () => {
  it("keeps the full name and alphanumeric parts", () => {
    expect(tokenizeGraphName("auth-middleware")).toEqual(
      expect.arrayContaining(["auth-middleware", "auth", "middleware"]),
    );
  });

  it("indexes aliases", () => {
    const tokens = tokenizeGraphName("Railway", ["deploy service"]);
    expect(tokens).toEqual(
      expect.arrayContaining(["railway", "deploy service", "deploy", "service"]),
    );
  });

  it("keeps a one-letter whole name but drops one-letter scraps", () => {
    expect(tokenizeGraphName("A")).toEqual(["a"]);
    expect(tokenizeGraphName("a/b")).toEqual(["a/b"]);
  });
});

describe("write-path graph search indexes", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("persistGraphDelta writes token, adjacency, and obs indexes", async () => {
    await persistGraphDelta(
      kv as never,
      [node("n1", "Railway deploy"), node("n2", "timeout")],
      [edge("e1", "n1", "n2")],
      ["obs_1"],
    );

    const railway = await kv.get<GraphSearchTokenPosting>(
      KV.graphSearchTokens,
      searchTokenKey("", "railway"),
    );
    expect(railway?.nodeIds).toContain("n1");

    const record = await kv.get<GraphSearchNodeIndex>(
      KV.graphSearchNodes,
      searchNodeKey("", "n1"),
    );
    expect(record?.neighbors).toEqual([
      {
        neighborId: "n2",
        edgeId: "e1",
        type: "related_to",
        weight: 0.8,
      },
    ]);
    expect(record?.observationIds).toContain("obs_1");

    const obs = await kv.get<GraphSearchObsPosting>(
      KV.graphSearchObs,
      searchObsKey("", "obs_1"),
    );
    expect(obs?.nodeIds).toEqual(expect.arrayContaining(["n1", "n2"]));
    expect(kv.listCalls).toEqual([]);
  });

  it("keeps the newest observation ids when a node exceeds the cap", async () => {
    const oldest = Array.from({ length: OBS_PER_NODE_CAP }, (_, i) => `obs_old_${i}`);
    const newest = ["obs_new_a", "obs_new_b"];
    await persistGraphDelta(
      kv as never,
      [
        node("n1", "Railway", [...oldest, ...newest]),
        node("n2", "timeout", ["obs_timeout"]),
      ],
      [edge("e1", "n1", "n2")],
      [],
    );

    const record = await kv.get<GraphSearchNodeIndex>(
      KV.graphSearchNodes,
      searchNodeKey("", "n1"),
    );
    expect(record?.observationIds).toHaveLength(OBS_PER_NODE_CAP);
    expect(record?.observationIds).toEqual(expect.arrayContaining(newest));
    expect(record?.observationIds).not.toContain("obs_old_0");

    expect(
      (await kv.get<GraphSearchObsPosting>(
        KV.graphSearchObs,
        searchObsKey("", "obs_old_0"),
      ))?.nodeIds ?? [],
    ).not.toContain("n1");
    expect(
      (await kv.get<GraphSearchObsPosting>(
        KV.graphSearchObs,
        searchObsKey("", "obs_new_b"),
      ))?.nodeIds,
    ).toContain("n1");

    const retrieval = new GraphRetrieval(kv as never);
    const fromNew = await retrieval.expandFromChunks(["obs_new_b"]);
    expect(fromNew.map((r) => r.obsId)).toContain("obs_timeout");
    const fromOld = await retrieval.expandFromChunks(["obs_old_0"]);
    expect(fromOld).toEqual([]);
  });

  it("serializes concurrent index writes so a shared token keeps both nodes", async () => {
    await Promise.all([
      persistGraphDelta(
        kv as never,
        [node("n1", "Railway", ["obs_1"])],
        [],
        [],
      ),
      persistGraphDelta(
        kv as never,
        [node("n2", "Railway", ["obs_2"])],
        [],
        [],
      ),
    ]);

    const posting = await kv.get<GraphSearchTokenPosting>(
      KV.graphSearchTokens,
      searchTokenKey("", "railway"),
    );
    expect(posting?.nodeIds).toEqual(expect.arrayContaining(["n1", "n2"]));
  });

  it("search uses indexes and never lists graph tables", async () => {
    await persistGraphDelta(
      kv as never,
      [node("n1", "React", ["obs_react"]), node("n2", "Hook", ["obs_hook"])],
      [edge("e1", "n1", "n2")],
      ["obs_react"],
    );
    kv.listCalls.length = 0;

    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.searchByEntities(["React"], 2);

    expect(results.map((r) => r.obsId)).toEqual(
      expect.arrayContaining(["obs_react"]),
    );
    expect(kv.listCalls).not.toContain(KV.graphNodes);
    expect(kv.listCalls).not.toContain(KV.graphEdges);
    expect(kv.listCalls).toEqual([]);
  });

  it("expandFromChunks uses the observation index", async () => {
    await persistGraphDelta(
      kv as never,
      [
        node("n1", "auth.ts", ["obs_1"]),
        node("n2", "jwt", ["obs_2"]),
      ],
      [edge("e1", "n1", "n2")],
      [],
    );
    kv.listCalls.length = 0;

    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.expandFromChunks(["obs_1"]);
    expect(results.map((r) => r.obsId)).toContain("obs_2");
    expect(kv.listCalls).toEqual([]);
  });

  it("first search backfills from the snapshot once", async () => {
    const nodes = [node("n1", "Railway")];
    const edges: GraphEdge[] = [];
    await kv.set(
      KV.graphSnapshot,
      GRAPH_SNAPSHOT_KEY,
      snapshotFromGraphTables(nodes, edges),
    );
    await kv.set(KV.graphNodes, "n1", nodes[0]);

    const retrieval = new GraphRetrieval(kv as never);
    const first = await retrieval.searchByEntities(["railway"]);
    expect(first).toHaveLength(1);

    const meta = await kv.get<GraphSearchIndexMeta>(
      KV.graphSearchMeta,
      SEARCH_INDEX_META_KEY,
    );
    expect(meta?.nodeCount).toBe(1);

    await kv.set(
      KV.graphSnapshot,
      GRAPH_SNAPSHOT_KEY,
      snapshotFromGraphTables(
        [nodes[0], node("n2", "Railway extra", ["obs_2"])],
        [],
      ),
    );
    await kv.set(KV.graphNodes, "n2", node("n2", "Railway extra", ["obs_2"]));

    const second = await retrieval.searchByEntities(["railway"]);
    expect(second.map((r) => r.obsId)).toEqual(["obs_1"]);
    expect(kv.listCalls).toEqual([]);
  });

  it("does not index pre-reset orphan rows", async () => {
    const resetAt = "2026-08-24T10:00:00.000Z";
    await kv.set(KV.graphSnapshot, GRAPH_SNAPSHOT_KEY, {
      ...snapshotFromGraphTables([], []),
      resetAt,
    });

    await persistGraphDelta(
      kv as never,
      [node("n_old", "legacy", ["obs_old"], "2026-08-01T00:00:00.000Z")],
      [],
      ["obs_old"],
    );

    const posting = await kv.get<GraphSearchTokenPosting>(
      KV.graphSearchTokens,
      searchTokenKey(resetAt, "legacy"),
    );
    expect(posting).toBeNull();

    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.searchByEntities(["legacy"]);
    expect(results).toEqual([]);
  });

  it("skips stale nodes at read even if a posting remains", async () => {
    await persistGraphDelta(
      kv as never,
      [node("n1", "Railway")],
      [],
      ["obs_1"],
    );
    await kv.set(KV.graphNodes, "n1", {
      ...node("n1", "Railway"),
      stale: true,
    });

    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.searchByEntities(["railway"]);
    expect(results).toEqual([]);
  });

  it("namespaces postings by resetAt so old keys stay invisible", async () => {
    await persistGraphDelta(
      kv as never,
      [node("n1", "Railway")],
      [],
      ["obs_1"],
    );
    const oldPosting = await kv.get<GraphSearchTokenPosting>(
      KV.graphSearchTokens,
      searchTokenKey("", "railway"),
    );
    expect(oldPosting?.nodeIds).toContain("n1");

    const resetAt = "2026-08-24T18:00:00.000Z";
    await kv.set(KV.graphSnapshot, GRAPH_SNAPSHOT_KEY, {
      ...snapshotFromGraphTables([], []),
      resetAt,
    });
    await kv.set(KV.graphSearchMeta, SEARCH_INDEX_META_KEY, {
      resetAt,
      indexedAt: resetAt,
      nodeCount: 0,
      edgeCount: 0,
    });

    await persistGraphDelta(
      kv as never,
      [node("n2", "Railway", ["obs_2"], "2026-08-24T19:00:00.000Z")],
      [],
      ["obs_2"],
    );

    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.searchByEntities(["railway"]);
    expect(results.map((r) => r.obsId)).toEqual(["obs_2"]);
    expect(
      await kv.get<GraphSearchTokenPosting>(
        KV.graphSearchTokens,
        searchTokenKey("", "railway"),
      ),
    ).toEqual(oldPosting);
  });

  it("ensureSearchIndex does not list graph tables", async () => {
    await kv.set(
      KV.graphSnapshot,
      GRAPH_SNAPSHOT_KEY,
      snapshotFromGraphTables([node("n1", "Railway")], []),
    );
    await kv.set(KV.graphNodes, "n1", node("n1", "Railway"));
    await ensureSearchIndex(kv as never);
    await ensureSearchIndex(kv as never);
    expect(kv.listCalls).toEqual([]);
  });
});
