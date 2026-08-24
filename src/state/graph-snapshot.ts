import type { GraphEdge, GraphNode, GraphSnapshot } from "../types.js";
import { KV } from "./schema.js";
import type { StateKV } from "./kv.js";
import { logger } from "../logger.js";

export const GRAPH_SNAPSHOT_KEY = "current";
export const SNAPSHOT_TOP_CAP = 500;

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

export async function writeGraphSnapshot(
  kv: StateKV,
  snap: GraphSnapshot,
): Promise<void> {
  snap.updatedAt = new Date().toISOString();
  snap.dirty = false;
  await kv.set(KV.graphSnapshot, GRAPH_SNAPSHOT_KEY, snap);
}

export function isResetOrphan(
  snap: GraphSnapshot | null,
  createdAt: string | undefined,
): boolean {
  return !!(
    snap?.resetAt &&
    typeof createdAt === "string" &&
    createdAt < snap.resetAt
  );
}

export function upsertSnapshotNode(
  snap: GraphSnapshot,
  node: GraphNode,
): void {
  const idx = snap.topNodes.findIndex((n) => n.id === node.id);
  if (idx !== -1) {
    snap.topNodes[idx] = node;
    return;
  }
  if (node.stale) return;
  snap.stats.totalNodes += 1;
  snap.stats.nodesByType[node.type] =
    (snap.stats.nodesByType[node.type] ?? 0) + 1;
  if (snap.topNodes.length < SNAPSHOT_TOP_CAP) {
    snap.topNodes.push(node);
    snap.topDegrees[node.id] = snap.topDegrees[node.id] ?? 0;
  }
}

export function upsertSnapshotEdge(
  snap: GraphSnapshot,
  edge: GraphEdge,
): void {
  const idx = snap.topEdges.findIndex((e) => e.id === edge.id);
  if (idx !== -1) {
    snap.topEdges[idx] = edge;
    return;
  }
  if (edge.stale) return;
  snap.stats.totalEdges += 1;
  snap.stats.edgesByType[edge.type] =
    (snap.stats.edgesByType[edge.type] ?? 0) + 1;
  const topIds = new Set(snap.topNodes.map((n) => n.id));
  if (topIds.has(edge.sourceNodeId) && topIds.has(edge.targetNodeId)) {
    snap.topEdges.push(edge);
  }
}

export function removeSnapshotNode(
  snap: GraphSnapshot,
  nodeId: string,
): void {
  const idx = snap.topNodes.findIndex((n) => n.id === nodeId);
  if (idx === -1) return;
  const [removed] = snap.topNodes.splice(idx, 1);
  delete snap.topDegrees[nodeId];
  snap.stats.totalNodes = Math.max(0, snap.stats.totalNodes - 1);
  if (removed?.type && snap.stats.nodesByType[removed.type]) {
    snap.stats.nodesByType[removed.type] = Math.max(
      0,
      snap.stats.nodesByType[removed.type] - 1,
    );
  }
  snap.topEdges = snap.topEdges.filter(
    (e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId,
  );
}

export function removeSnapshotEdge(
  snap: GraphSnapshot,
  edgeId: string,
): void {
  const idx = snap.topEdges.findIndex((e) => e.id === edgeId);
  if (idx === -1) return;
  const [removed] = snap.topEdges.splice(idx, 1);
  snap.stats.totalEdges = Math.max(0, snap.stats.totalEdges - 1);
  if (removed?.type && snap.stats.edgesByType[removed.type]) {
    snap.stats.edgesByType[removed.type] = Math.max(
      0,
      snap.stats.edgesByType[removed.type] - 1,
    );
  }
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
