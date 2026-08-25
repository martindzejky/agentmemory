import type {
  GraphNode,
  GraphEdge,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { getGraphSearchBudgetMs, getGraphSearchMaxSeeds } from "../config.js";
import { recordDeadlineExceeded } from "../utils/deadline.js";
import { loadSnapshotGraph } from "../state/graph-snapshot.js";
import {
  ensureSearchIndex,
  graphEdgeFromSearchNeighbor,
  graphNodeFromSearchRecord,
  loadSearchNodeRecord,
  lookupObsNodeIds,
  lookupTokenNodeIds,
  tokenizeGraphName,
} from "../state/graph-search-index.js";

export interface GraphRetrievalResult {
  obsId: string;
  sessionId: string;
  score: number;
  graphContext: string;
  pathLength: number;
}

interface LazyTraversal {
  resetAt: string;
  nodes: Map<string, GraphNode>;
  adj: Map<string, Array<{ neighborId: string; edge: GraphEdge }>>;
}

function buildGraphContext(
  path: Array<{ node: GraphNode; edge?: GraphEdge }>,
): string {
  const parts: string[] = [];
  for (const step of path) {
    const props = Object.entries(step.node.properties)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    let line = `[${step.node.type}] ${step.node.name}`;
    if (props) line += ` (${props})`;
    if (step.edge) {
      line += ` --${step.edge.type}-->`;
      if (step.edge.context?.reasoning) {
        line += ` [${step.edge.context.reasoning}]`;
      }
      if (step.edge.tvalid) {
        line += ` @${step.edge.tvalid}`;
      }
    }
    parts.push(line);
  }
  return parts.join(" ");
}

export class GraphRetrieval {
  constructor(private kv: StateKV) {}

  async searchByEntities(
    entityNames: string[],
    maxDepth = 2,
    maxResults = 20,
  ): Promise<GraphRetrievalResult[]> {
    const resetAt = await ensureSearchIndex(this.kv);
    const tokens = [
      ...new Set(entityNames.flatMap((name) => tokenizeGraphName(name))),
    ];
    if (tokens.length === 0) return [];

    const candidateIds = await lookupTokenNodeIds(this.kv, resetAt, tokens);
    const seeds = await this.rankSeedNodes(candidateIds, resetAt);
    if (seeds.length === 0) return [];

    const ctx: LazyTraversal = {
      resetAt,
      nodes: new Map(seeds.map((n) => [n.id, n])),
      adj: new Map(),
    };
    const budgetExpiresAt = Date.now() + getGraphSearchBudgetMs();
    const results: GraphRetrievalResult[] = [];
    const visitedObs = new Set<string>();

    for (const startNode of seeds) {
      if (Date.now() >= budgetExpiresAt) {
        recordDeadlineExceeded("graph.searchByEntities");
        break;
      }
      const paths = await this.dijkstraTraversal(startNode, ctx, maxDepth);

      for (const path of paths) {
        const lastNode = path[path.length - 1].node;
        for (const obsId of lastNode.sourceObservationIds) {
          if (visitedObs.has(obsId)) continue;
          visitedObs.add(obsId);

          const pathLength = path.length;
          const edgeWeights = path
            .filter((s) => s.edge)
            .map((s) => s.edge!.weight);
          const avgWeight =
            edgeWeights.length > 0
              ? edgeWeights.reduce((a, b) => a + b, 0) / edgeWeights.length
              : 0.5;
          const score = avgWeight * (1 / pathLength);

          results.push({
            obsId,
            sessionId: "",
            score,
            graphContext: buildGraphContext(path),
            pathLength,
          });
        }
      }

      for (const obsId of startNode.sourceObservationIds) {
        if (visitedObs.has(obsId)) continue;
        visitedObs.add(obsId);
        results.push({
          obsId,
          sessionId: "",
          score: 1.0,
          graphContext: `[${startNode.type}] ${startNode.name}`,
          pathLength: 0,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  async expandFromChunks(
    obsIds: string[],
    maxDepth = 1,
    maxResults = 10,
  ): Promise<GraphRetrievalResult[]> {
    const resetAt = await ensureSearchIndex(this.kv);
    const linkedIds = await lookupObsNodeIds(this.kv, resetAt, obsIds);
    const linkedNodes = (
      await this.loadLiveNodes(linkedIds, resetAt)
    ).slice(0, getGraphSearchMaxSeeds());

    const ctx: LazyTraversal = {
      resetAt,
      nodes: new Map(linkedNodes.map((n) => [n.id, n])),
      adj: new Map(),
    };
    const budgetExpiresAt = Date.now() + getGraphSearchBudgetMs();
    const results: GraphRetrievalResult[] = [];
    const visitedObs = new Set<string>(obsIds);

    for (const node of linkedNodes) {
      if (Date.now() >= budgetExpiresAt) {
        recordDeadlineExceeded("graph.expandFromChunks");
        break;
      }
      const paths = await this.dijkstraTraversal(node, ctx, maxDepth);
      for (const path of paths) {
        const lastNode = path[path.length - 1].node;
        for (const obsId of lastNode.sourceObservationIds) {
          if (visitedObs.has(obsId)) continue;
          visitedObs.add(obsId);

          const pathLength = path.length;
          const score = 0.5 * (1 / (pathLength + 1));

          results.push({
            obsId,
            sessionId: "",
            score,
            graphContext: buildGraphContext(path),
            pathLength,
          });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  async temporalQuery(
    entityName: string,
    asOf?: string,
  ): Promise<{
    entity: GraphNode | null;
    currentState: GraphEdge[];
    history: GraphEdge[];
  }> {
    const { nodes: allNodes, edges: allEdges } = await loadSnapshotGraph(this.kv);

    const entity = allNodes.find(
      (n) => n.name.toLowerCase() === entityName.toLowerCase(),
    );
    if (!entity) return { entity: null, currentState: [], history: [] };

    const relatedEdges = allEdges.filter(
      (e) => e.sourceNodeId === entity.id || e.targetNodeId === entity.id,
    );

    if (!asOf) {
      const latestEdges = this.getLatestEdges(relatedEdges);
      const historicalEdges = relatedEdges.filter(
        (e) => !latestEdges.some((le) => le.id === e.id),
      );
      return { entity, currentState: latestEdges, history: historicalEdges };
    }

    const asOfDate = new Date(asOf).getTime();
    const validEdges = relatedEdges.filter((e) => {
      const commitDate = new Date(e.tcommit || e.createdAt).getTime();
      if (commitDate > asOfDate) return false;
      if (e.tvalid) {
        const validDate = new Date(e.tvalid).getTime();
        if (validDate > asOfDate) return false;
      }
      if (e.tvalidEnd) {
        const endDate = new Date(e.tvalidEnd).getTime();
        if (endDate < asOfDate) return false;
      }
      return true;
    });

    return {
      entity,
      currentState: this.getLatestEdges(validEdges),
      history: validEdges,
    };
  }

  private getLatestEdges(edges: GraphEdge[]): GraphEdge[] {
    const byKey = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      const key = `${e.sourceNodeId}|${e.targetNodeId}|${e.type}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(e);
    }

    const latest: GraphEdge[] = [];
    for (const group of byKey.values()) {
      if (group.length === 0) continue;
      group.sort(
        (a, b) =>
          new Date(b.tcommit || b.createdAt).getTime() -
          new Date(a.tcommit || a.createdAt).getTime(),
      );
      const newest = group.find((e) => e.isLatest !== false) || group[0];
      latest.push(newest);
    }
    return latest;
  }

  private async rankSeedNodes(
    candidateIds: string[],
    resetAt: string,
  ): Promise<GraphNode[]> {
    if (candidateIds.length === 0) return [];
    const degrees = await Promise.all(
      candidateIds.map((id) => kvGetNumber(this.kv, id)),
    );
    const rankedIds = candidateIds
      .map((id, i) => ({ id, degree: degrees[i] }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, getGraphSearchMaxSeeds())
      .map((r) => r.id);
    return this.loadLiveNodes(rankedIds, resetAt);
  }

  private async loadLiveNodes(
    ids: string[],
    resetAt: string,
  ): Promise<GraphNode[]> {
    const rows = await Promise.all(
      ids.map(async (id) => {
        const [live, record] = await Promise.all([
          this.kv.get<GraphNode>(KV.graphNodes, id),
          loadSearchNodeRecord(this.kv, resetAt, id),
        ]);
        if (live?.stale) return null;
        if (resetAt && live?.createdAt && live.createdAt < resetAt) return null;
        if (live) return live;
        if (!record) return null;
        if (resetAt && record.createdAt && record.createdAt < resetAt) {
          return null;
        }
        return graphNodeFromSearchRecord(record);
      }),
    );
    return rows.filter((node): node is GraphNode => node !== null);
  }

  private async neighborsOf(
    ctx: LazyTraversal,
    nodeId: string,
  ): Promise<Array<{ neighborId: string; edge: GraphEdge }>> {
    const cached = ctx.adj.get(nodeId);
    if (cached) return cached;

    const record = await loadSearchNodeRecord(this.kv, ctx.resetAt, nodeId);
    const out: Array<{ neighborId: string; edge: GraphEdge }> = [];
    for (const n of record?.neighbors ?? []) {
      const [liveNode, liveEdge] = await Promise.all([
        this.kv.get<GraphNode>(KV.graphNodes, n.neighborId),
        this.kv.get<GraphEdge>(KV.graphEdges, n.edgeId),
      ]);
      if (liveNode?.stale) continue;
      if (ctx.resetAt && liveNode?.createdAt && liveNode.createdAt < ctx.resetAt) {
        continue;
      }
      if (liveEdge?.stale) continue;
      if (ctx.resetAt && liveEdge?.createdAt && liveEdge.createdAt < ctx.resetAt) {
        continue;
      }
      const neighbor =
        liveNode ??
        (await loadSearchNodeRecord(this.kv, ctx.resetAt, n.neighborId).then(
          (row) => (row ? graphNodeFromSearchRecord(row) : null),
        ));
      if (!neighbor) continue;
      const edge = liveEdge ?? graphEdgeFromSearchNeighbor(n, nodeId);
      ctx.nodes.set(neighbor.id, neighbor);
      out.push({ neighborId: n.neighborId, edge });
    }
    ctx.adj.set(nodeId, out);
    return out;
  }

  // Weighted shortest-path traversal (#328). Replaces the prior BFS,
  // which fell back to edge-count order and ignored the 0.1-1.0 weight
  // attached to every graph edge. Dijkstra over `cost = 1/weight`
  // (cheaper edges = stronger relationships) returns the
  // highest-weighted path to each reachable node within maxDepth.
  // Neighbors come from the write-path adjacency index, not a full
  // in-memory graph.
  private async dijkstraTraversal(
    startNode: GraphNode,
    ctx: LazyTraversal,
    maxDepth: number,
  ): Promise<Array<Array<{ node: GraphNode; edge?: GraphEdge }>>> {
    const dist = new Map<string, number>();
    const pathTo = new Map<string, Array<{ node: GraphNode; edge?: GraphEdge }>>();
    dist.set(startNode.id, 0);
    pathTo.set(startNode.id, [{ node: startNode }]);

    const heap = new MinHeap<{ nodeId: string; depth: number; cost: number }>(
      (a, b) => a.cost - b.cost,
    );
    heap.push({ nodeId: startNode.id, depth: 0, cost: 0 });

    while (heap.size() > 0) {
      const { nodeId, depth, cost } = heap.pop()!;
      if (cost > (dist.get(nodeId) ?? Infinity)) continue;
      if (depth >= maxDepth) continue;

      const neighbors = await this.neighborsOf(ctx, nodeId);
      for (const { neighborId, edge } of neighbors) {
        const nextNode = ctx.nodes.get(neighborId);
        if (!nextNode) continue;
        const edgeCost = 1 / Math.max(edge.weight, 0.01);
        const newCost = cost + edgeCost;
        if (newCost < (dist.get(neighborId) ?? Infinity)) {
          dist.set(neighborId, newCost);
          pathTo.set(neighborId, [
            ...pathTo.get(nodeId)!,
            { node: nextNode, edge },
          ]);
          heap.push({ nodeId: neighborId, depth: depth + 1, cost: newCost });
        }
      }
    }

    // Drop the startNode's own entry before returning: callers
    // (searchByEntities, expandFromChunks) score start-node
    // observations via a dedicated fallback loop with score=1.0. If
    // we leave it in here, the start-path (length 1, no edges) goes
    // through the generic path-scoring loop first — pathLength=1 +
    // empty edgeWeights makes avgWeight fall to 0.5, the obs get
    // marked visited, and the score=1.0 fallback becomes dead code.
    pathTo.delete(startNode.id);
    return Array.from(pathTo.values());
  }
}

async function kvGetNumber(kv: StateKV, nodeId: string): Promise<number> {
  const raw = await kv.get<number>(KV.graphNodeDegree, nodeId);
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

// Minimal binary min-heap. Pulled inline so graph-retrieval doesn't
// take a new dependency for the perf-critical inner loop of #328.
// Comparator returns negative when `a` should pop before `b`.
class MinHeap<T> {
  private heap: T[] = [];

  constructor(private compare: (a: T, b: T) => number) {}

  size(): number {
    return this.heap.length;
  }

  push(value: T): void {
    this.heap.push(value);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.heap[i], this.heap[parent]) < 0) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else break;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && this.compare(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < n && this.compare(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === i) break;
      [this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]];
      i = smallest;
    }
  }
}
