// PR 1: leftover graph readers must not kv.list KV.graphNodes / KV.graphEdges.
// After reset those scopes still hold orphaned pre-reset rows. The snapshot
// is the live graph. See docs/investigations/2026-08-24-latency-and-oom.md.
import { describe, it, expect, vi } from "vitest";
import { registerGraphFunction } from "../src/functions/graph.js";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import {
  GRAPH_SNAPSHOT_KEY,
  snapshotFromGraphTables,
} from "../src/state/graph-snapshot.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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
    delete: async () => {},
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

function node(id: string, name: string): GraphNode {
  return {
    id,
    type: "concept",
    name,
    properties: {},
    sourceObservationIds: ["obs_1"],
    createdAt: "2026-08-24T00:00:00Z",
  };
}

function edge(id: string, source: string, target: string): GraphEdge {
  return {
    id,
    type: "related_to",
    sourceNodeId: source,
    targetNodeId: target,
    weight: 0.5,
    sourceObservationIds: ["obs_1"],
    createdAt: "2026-08-24T00:00:00Z",
  };
}

describe("graph readers use the snapshot, not live tables", () => {
  it("graph-query search does not list orphan tables", async () => {
    const kv = mockKV();
    const n = node("n1", "railway");
    const e = edge("e1", "n1", "n1");
    await kv.set(KV.graphNodes, n.id, n);
    await kv.set(KV.graphEdges, e.id, e);
    await kv.set(
      KV.graphSnapshot,
      GRAPH_SNAPSHOT_KEY,
      snapshotFromGraphTables([n], [e]),
    );
    kv.listCalls.length = 0;

    const sdk = mockSdk();
    registerGraphFunction(sdk as never, kv as never, {
      name: "noop-test",
      compress: vi.fn(),
      summarize: vi.fn(),
    } as never);

    const result = (await sdk.trigger("mem::graph-query", {
      query: "rail",
    })) as { nodes: GraphNode[] };

    expect(result.nodes.some((x) => x.name === "railway")).toBe(true);
    expect(kv.listCalls).not.toContain(KV.graphNodes);
    expect(kv.listCalls).not.toContain(KV.graphEdges);
  });

  it("GraphRetrieval does not list orphan tables", async () => {
    const kv = mockKV();
    const n = node("n1", "railway");
    await kv.set(
      KV.graphSnapshot,
      GRAPH_SNAPSHOT_KEY,
      snapshotFromGraphTables([n], []),
    );
    kv.listCalls.length = 0;

    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.searchByEntities(["railway"], 1, 10);

    expect(results.length).toBeGreaterThan(0);
    expect(kv.listCalls).toEqual([]);
  });
});
