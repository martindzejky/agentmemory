import type {
  GraphEdge,
  GraphNode,
  GraphSearchIndexMeta,
  GraphSearchNeighbor,
  GraphSearchNodeIndex,
  GraphSearchObsPosting,
  GraphSearchTokenPosting,
} from "../types.js";
import { KV } from "./schema.js";
import type { StateKV } from "./kv.js";
import {
  isResetOrphan,
  readGraphSnapshot,
  snapshotGraphTables,
} from "./graph-snapshot.js";

export const SEARCH_INDEX_META_KEY = "current";
export const TOKEN_POSTING_CAP = 200;
export const OBS_POSTING_CAP = 50;
export const OBS_PER_NODE_CAP = 50;
export const NEIGHBOR_CAP = 100;
export const SEARCH_CANDIDATE_CAP = 200;

export function searchIndexNamespace(resetAt?: string): string {
  return resetAt ?? "";
}

export function searchTokenKey(resetAt: string, token: string): string {
  return `${resetAt}|${token}`;
}

export function searchNodeKey(resetAt: string, nodeId: string): string {
  return `${resetAt}|${nodeId}`;
}

export function searchObsKey(resetAt: string, observationId: string): string {
  return `${resetAt}|${observationId}`;
}

export function tokenizeGraphName(name: string, aliases?: string[]): string[] {
  const tokens = new Set<string>();
  for (const raw of [name, ...(aliases ?? [])]) {
    const lower = raw.toLowerCase().trim();
    if (!lower) continue;
    if (lower.length >= 1) tokens.add(lower);
    for (const part of lower.split(/[^a-z0-9]+/)) {
      if (part.length >= 2) tokens.add(part);
    }
  }
  return [...tokens];
}

function isUnusable(
  createdAt: string | undefined,
  stale: boolean | undefined,
  resetAt: string,
): boolean {
  if (stale) return true;
  if (resetAt && createdAt && createdAt < resetAt) return true;
  return false;
}

async function addToTokenPosting(
  kv: StateKV,
  resetAt: string,
  token: string,
  nodeId: string,
): Promise<void> {
  const key = searchTokenKey(resetAt, token);
  const existing = await kv.get<GraphSearchTokenPosting>(
    KV.graphSearchTokens,
    key,
  );
  const nodeIds = existing?.nodeIds ? [...existing.nodeIds] : [];
  if (nodeIds.includes(nodeId)) return;
  if (nodeIds.length >= TOKEN_POSTING_CAP) return;
  nodeIds.push(nodeId);
  await kv.set<GraphSearchTokenPosting>(KV.graphSearchTokens, key, {
    token,
    nodeIds,
    resetAt,
  });
}

async function removeFromTokenPosting(
  kv: StateKV,
  resetAt: string,
  token: string,
  nodeId: string,
): Promise<void> {
  const key = searchTokenKey(resetAt, token);
  const existing = await kv.get<GraphSearchTokenPosting>(
    KV.graphSearchTokens,
    key,
  );
  if (!existing) return;
  const nodeIds = existing.nodeIds.filter((id) => id !== nodeId);
  if (nodeIds.length === 0) {
    await kv.delete(KV.graphSearchTokens, key);
    return;
  }
  await kv.set<GraphSearchTokenPosting>(KV.graphSearchTokens, key, {
    ...existing,
    nodeIds,
  });
}

async function addToObsPosting(
  kv: StateKV,
  resetAt: string,
  observationId: string,
  nodeId: string,
): Promise<void> {
  const key = searchObsKey(resetAt, observationId);
  const existing = await kv.get<GraphSearchObsPosting>(KV.graphSearchObs, key);
  const nodeIds = existing?.nodeIds ? [...existing.nodeIds] : [];
  if (nodeIds.includes(nodeId)) return;
  if (nodeIds.length >= OBS_POSTING_CAP) return;
  nodeIds.push(nodeId);
  await kv.set<GraphSearchObsPosting>(KV.graphSearchObs, key, {
    observationId,
    nodeIds,
    resetAt,
  });
}

async function removeFromObsPosting(
  kv: StateKV,
  resetAt: string,
  observationId: string,
  nodeId: string,
): Promise<void> {
  const key = searchObsKey(resetAt, observationId);
  const existing = await kv.get<GraphSearchObsPosting>(KV.graphSearchObs, key);
  if (!existing) return;
  const nodeIds = existing.nodeIds.filter((id) => id !== nodeId);
  if (nodeIds.length === 0) {
    await kv.delete(KV.graphSearchObs, key);
    return;
  }
  await kv.set<GraphSearchObsPosting>(KV.graphSearchObs, key, {
    ...existing,
    nodeIds,
  });
}

async function writeNodeRecord(
  kv: StateKV,
  record: GraphSearchNodeIndex,
): Promise<void> {
  await kv.set<GraphSearchNodeIndex>(
    KV.graphSearchNodes,
    searchNodeKey(record.resetAt, record.nodeId),
    record,
  );
}

async function readNodeRecord(
  kv: StateKV,
  resetAt: string,
  nodeId: string,
): Promise<GraphSearchNodeIndex | null> {
  return kv.get<GraphSearchNodeIndex>(
    KV.graphSearchNodes,
    searchNodeKey(resetAt, nodeId),
  );
}

function neighborFromEdge(
  edge: GraphEdge,
  neighborId: string,
): GraphSearchNeighbor {
  return {
    neighborId,
    edgeId: edge.id,
    type: edge.type,
    weight: edge.weight,
    ...(edge.context ? { context: edge.context } : {}),
    ...(edge.tvalid ? { tvalid: edge.tvalid } : {}),
  };
}

function withNeighbor(
  neighbors: GraphSearchNeighbor[],
  entry: GraphSearchNeighbor,
): GraphSearchNeighbor[] {
  const idx = neighbors.findIndex(
    (n) => n.neighborId === entry.neighborId && n.edgeId === entry.edgeId,
  );
  if (idx !== -1) {
    const next = [...neighbors];
    next[idx] = entry;
    return next;
  }
  if (neighbors.length >= NEIGHBOR_CAP) return neighbors;
  return [...neighbors, entry];
}

function withoutNeighbor(
  neighbors: GraphSearchNeighbor[],
  neighborId: string,
  edgeId: string,
): GraphSearchNeighbor[] {
  return neighbors.filter(
    (n) => !(n.neighborId === neighborId && n.edgeId === edgeId),
  );
}

async function upsertNodeInSearchIndex(
  kv: StateKV,
  node: GraphNode,
  resetAt: string,
): Promise<void> {
  const tokens = tokenizeGraphName(node.name, node.aliases);
  const observationIds = [...new Set(node.sourceObservationIds)].slice(
    0,
    OBS_PER_NODE_CAP,
  );
  const prev = await readNodeRecord(kv, resetAt, node.id);
  const prevTokens = new Set(prev?.tokens ?? []);
  const nextTokens = new Set(tokens);
  const prevObs = new Set(prev?.observationIds ?? []);
  const nextObs = new Set(observationIds);

  const tokenAdds: Promise<void>[] = [];
  const tokenRemoves: Promise<void>[] = [];
  for (const token of tokens) {
    if (!prevTokens.has(token)) {
      tokenAdds.push(addToTokenPosting(kv, resetAt, token, node.id));
    }
  }
  for (const token of prev?.tokens ?? []) {
    if (!nextTokens.has(token)) {
      tokenRemoves.push(removeFromTokenPosting(kv, resetAt, token, node.id));
    }
  }
  const obsAdds: Promise<void>[] = [];
  const obsRemoves: Promise<void>[] = [];
  for (const obsId of observationIds) {
    if (!prevObs.has(obsId)) {
      obsAdds.push(addToObsPosting(kv, resetAt, obsId, node.id));
    }
  }
  for (const obsId of prev?.observationIds ?? []) {
    if (!nextObs.has(obsId)) {
      obsRemoves.push(removeFromObsPosting(kv, resetAt, obsId, node.id));
    }
  }
  await Promise.all([...tokenRemoves, ...obsRemoves, ...tokenAdds, ...obsAdds]);

  await writeNodeRecord(kv, {
    nodeId: node.id,
    name: node.name,
    type: node.type,
    properties: node.properties ?? {},
    createdAt: node.createdAt,
    tokens,
    observationIds,
    neighbors: prev?.neighbors ?? [],
    resetAt,
  });
}

async function removeNodeFromSearchIndex(
  kv: StateKV,
  nodeId: string,
  resetAt: string,
): Promise<void> {
  const prev = await readNodeRecord(kv, resetAt, nodeId);
  if (!prev) return;

  await Promise.all([
    ...prev.tokens.map((token) =>
      removeFromTokenPosting(kv, resetAt, token, nodeId),
    ),
    ...prev.observationIds.map((obsId) =>
      removeFromObsPosting(kv, resetAt, obsId, nodeId),
    ),
    ...prev.neighbors.map((n) =>
      detachNeighbor(kv, resetAt, n.neighborId, nodeId, n.edgeId),
    ),
  ]);
  await kv.delete(KV.graphSearchNodes, searchNodeKey(resetAt, nodeId));
}

async function detachNeighbor(
  kv: StateKV,
  resetAt: string,
  nodeId: string,
  neighborId: string,
  edgeId: string,
): Promise<void> {
  const record = await readNodeRecord(kv, resetAt, nodeId);
  if (!record) return;
  const neighbors = withoutNeighbor(record.neighbors, neighborId, edgeId);
  if (neighbors.length === record.neighbors.length) return;
  await writeNodeRecord(kv, { ...record, neighbors });
}

async function attachNeighbor(
  kv: StateKV,
  resetAt: string,
  nodeId: string,
  entry: GraphSearchNeighbor,
): Promise<void> {
  const record = await readNodeRecord(kv, resetAt, nodeId);
  const next = withNeighbor(record?.neighbors ?? [], entry);
  if (
    record &&
    next.length === record.neighbors.length &&
    next.every((n, i) => n === record.neighbors[i])
  ) {
    return;
  }
  await writeNodeRecord(kv, {
    nodeId,
    name: record?.name ?? "",
    type: record?.type ?? "concept",
    properties: record?.properties ?? {},
    createdAt: record?.createdAt ?? "",
    tokens: record?.tokens ?? [],
    observationIds: record?.observationIds ?? [],
    neighbors: next,
    resetAt,
  });
}

async function upsertEdgeInSearchIndex(
  kv: StateKV,
  edge: GraphEdge,
  resetAt: string,
): Promise<void> {
  await Promise.all([
    attachNeighbor(
      kv,
      resetAt,
      edge.sourceNodeId,
      neighborFromEdge(edge, edge.targetNodeId),
    ),
    attachNeighbor(
      kv,
      resetAt,
      edge.targetNodeId,
      neighborFromEdge(edge, edge.sourceNodeId),
    ),
  ]);
}

async function removeEdgeFromSearchIndex(
  kv: StateKV,
  edge: GraphEdge,
  resetAt: string,
): Promise<void> {
  await Promise.all([
    detachNeighbor(
      kv,
      resetAt,
      edge.sourceNodeId,
      edge.targetNodeId,
      edge.id,
    ),
    detachNeighbor(
      kv,
      resetAt,
      edge.targetNodeId,
      edge.sourceNodeId,
      edge.id,
    ),
  ]);
}

export async function indexGraphDelta(
  kv: StateKV,
  nodes: GraphNode[],
  edges: GraphEdge[],
  resetAt: string,
): Promise<void> {
  for (const node of nodes) {
    if (isUnusable(node.createdAt, node.stale, resetAt)) {
      await removeNodeFromSearchIndex(kv, node.id, resetAt);
      continue;
    }
    await upsertNodeInSearchIndex(kv, node, resetAt);
  }
  for (const edge of edges) {
    if (isUnusable(edge.createdAt, edge.stale, resetAt)) {
      await removeEdgeFromSearchIndex(kv, edge, resetAt);
      continue;
    }
    await upsertEdgeInSearchIndex(kv, edge, resetAt);
  }
}

export async function stampSearchIndexMeta(
  kv: StateKV,
  resetAt: string,
  nodeCount = 0,
  edgeCount = 0,
): Promise<void> {
  await kv.set<GraphSearchIndexMeta>(KV.graphSearchMeta, SEARCH_INDEX_META_KEY, {
    resetAt,
    indexedAt: new Date().toISOString(),
    nodeCount,
    edgeCount,
  });
}

export async function ensureSearchIndex(kv: StateKV): Promise<string> {
  const meta = await kv.get<GraphSearchIndexMeta>(
    KV.graphSearchMeta,
    SEARCH_INDEX_META_KEY,
  );
  if (meta && typeof meta.resetAt === "string") {
    return meta.resetAt;
  }

  const snap = await readGraphSnapshot(kv);
  const resetAt = searchIndexNamespace(snap?.resetAt);
  const tables = snapshotGraphTables(snap);
  const nodes = tables.nodes.filter(
    (n) => !isResetOrphan(snap, n.createdAt) && !n.stale,
  );
  const edges = tables.edges.filter(
    (e) => !isResetOrphan(snap, e.createdAt) && !e.stale,
  );
  await indexGraphDelta(kv, nodes, edges, resetAt);
  await stampSearchIndexMeta(kv, resetAt, nodes.length, edges.length);
  return resetAt;
}

export async function lookupTokenNodeIds(
  kv: StateKV,
  resetAt: string,
  tokens: string[],
): Promise<string[]> {
  const ids = new Set<string>();
  const postings = await Promise.all(
    tokens.map((token) =>
      kv.get<GraphSearchTokenPosting>(
        KV.graphSearchTokens,
        searchTokenKey(resetAt, token),
      ),
    ),
  );
  for (const posting of postings) {
    for (const id of posting?.nodeIds ?? []) {
      ids.add(id);
      if (ids.size >= SEARCH_CANDIDATE_CAP) {
        return [...ids];
      }
    }
  }
  return [...ids];
}

export async function lookupObsNodeIds(
  kv: StateKV,
  resetAt: string,
  observationIds: string[],
): Promise<string[]> {
  const ids = new Set<string>();
  const postings = await Promise.all(
    observationIds.map((obsId) =>
      kv.get<GraphSearchObsPosting>(KV.graphSearchObs, searchObsKey(resetAt, obsId)),
    ),
  );
  for (const posting of postings) {
    for (const id of posting?.nodeIds ?? []) {
      ids.add(id);
      if (ids.size >= SEARCH_CANDIDATE_CAP) {
        return [...ids];
      }
    }
  }
  return [...ids];
}

export async function loadSearchNodeRecord(
  kv: StateKV,
  resetAt: string,
  nodeId: string,
): Promise<GraphSearchNodeIndex | null> {
  return readNodeRecord(kv, resetAt, nodeId);
}

export function graphNodeFromSearchRecord(
  record: GraphSearchNodeIndex,
): GraphNode {
  return {
    id: record.nodeId,
    type: record.type || "concept",
    name: record.name,
    properties: record.properties ?? {},
    sourceObservationIds: record.observationIds,
    createdAt: record.createdAt || new Date(0).toISOString(),
  };
}

export function graphEdgeFromSearchNeighbor(
  entry: GraphSearchNeighbor,
  sourceNodeId: string,
): GraphEdge {
  return {
    id: entry.edgeId,
    type: entry.type,
    sourceNodeId,
    targetNodeId: entry.neighborId,
    weight: entry.weight,
    sourceObservationIds: [],
    createdAt: "",
    ...(entry.context ? { context: entry.context } : {}),
    ...(entry.tvalid ? { tvalid: entry.tvalid } : {}),
  };
}
