import type { GraphEdge, GraphNode, GraphSnapshot } from "../types.js";
import { KV } from "./schema.js";
import type { StateKV } from "./kv.js";
import { logger } from "../logger.js";

export const GRAPH_SNAPSHOT_KEY = "current";

export function emptyGraphSnapshot(): GraphSnapshot {
  return {
    version: 1,
    topNodes: [],
    topEdges: [],
    topDegrees: {},
    stats: {
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: {},
      edgesByType: {},
    },
    updatedAt: new Date(0).toISOString(),
    dirty: true,
  };
}

export async function readGraphSnapshot(
  kv: StateKV,
): Promise<GraphSnapshot | null> {
  try {
    const snap = await kv.get<GraphSnapshot>(KV.graphSnapshot, GRAPH_SNAPSHOT_KEY);
    if (snap && typeof snap === "object" && snap.version === 1) {
      return snap;
    }
    return null;
  } catch (err) {
    logger.warn("Graph snapshot read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function snapshotFromGraphTables(
  nodes: GraphNode[],
  edges: GraphEdge[],
): GraphSnapshot {
  const liveNodes = nodes.filter((n) => !n.stale);
  const liveEdges = edges.filter((e) => !e.stale);
  return {
    version: 1,
    topNodes: liveNodes,
    topEdges: liveEdges,
    topDegrees: {},
    stats: {
      totalNodes: liveNodes.length,
      totalEdges: liveEdges.length,
      nodesByType: {},
      edgesByType: {},
    },
    updatedAt: new Date().toISOString(),
    dirty: false,
  };
}

export function snapshotGraphTables(snap: GraphSnapshot | null): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  if (!snap) return { nodes: [], edges: [] };
  return {
    nodes: (snap.topNodes ?? []).filter((n) => !n.stale),
    edges: (snap.topEdges ?? []).filter((e) => !e.stale),
  };
}

export async function loadSnapshotGraph(kv: StateKV): Promise<{
  snapshot: GraphSnapshot | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}> {
  const snapshot = await readGraphSnapshot(kv);
  return { snapshot, ...snapshotGraphTables(snapshot) };
}

export function snapshotCapWarning(
  snap: GraphSnapshot | null,
): string | undefined {
  if (!snap) return undefined;
  const visible = (snap.topNodes ?? []).length;
  const total = snap.stats?.totalNodes ?? 0;
  if (total > visible) {
    return (
      `Graph snapshot is capped at ${visible} of ${total} nodes. ` +
      "Query, export, retrieval, and related readers see the top-degree subset only."
    );
  }
  return undefined;
}
