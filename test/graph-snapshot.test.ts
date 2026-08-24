import { describe, it, expect } from "vitest";
import type { GraphEdge, GraphNode } from "../src/types.js";
import {
  SNAPSHOT_TOP_CAP,
  emptyGraphSnapshot,
  isResetOrphan,
  removeSnapshotEdge,
  removeSnapshotNode,
  upsertSnapshotEdge,
  upsertSnapshotNode,
} from "../src/state/graph-snapshot.js";

function node(id: string): GraphNode {
  return {
    id,
    type: "concept",
    name: id,
    properties: {},
    sourceObservationIds: ["obs_1"],
    createdAt: "2026-08-01T00:00:00Z",
  };
}

function edge(id: string, source: string, target: string): GraphEdge {
  return {
    id,
    type: "related_to",
    sourceNodeId: source,
    targetNodeId: target,
    weight: 1,
    sourceObservationIds: ["obs_1"],
    createdAt: "2026-08-01T00:00:00Z",
  };
}

describe("graph snapshot helpers", () => {
  it("counts nodes past the top cap", () => {
    const snap = emptyGraphSnapshot();
    for (let i = 0; i < SNAPSHOT_TOP_CAP + 3; i++) {
      upsertSnapshotNode(snap, node(`n${i}`));
    }
    expect(snap.topNodes).toHaveLength(SNAPSHOT_TOP_CAP);
    expect(snap.stats.totalNodes).toBe(SNAPSHOT_TOP_CAP + 3);
    upsertSnapshotNode(snap, node("n0"));
    upsertSnapshotNode(snap, node(`n${SNAPSHOT_TOP_CAP}`));
    expect(snap.stats.totalNodes).toBe(SNAPSHOT_TOP_CAP + 3);
  });

  it("counts edges that miss the top-N display set", () => {
    const snap = emptyGraphSnapshot();
    upsertSnapshotNode(snap, node("n1"));
    upsertSnapshotEdge(snap, edge("e_off", "missing", "n1"));
    expect(snap.topEdges).toHaveLength(0);
    expect(snap.stats.totalEdges).toBe(1);
  });

  it("removeSnapshotNode does not decrement live edge totals", () => {
    const snap = emptyGraphSnapshot();
    upsertSnapshotNode(snap, node("n1"));
    upsertSnapshotNode(snap, node("n2"));
    upsertSnapshotEdge(snap, edge("e1", "n1", "n2"));
    expect(snap.stats.totalEdges).toBe(1);
    removeSnapshotNode(snap, "n1");
    expect(snap.topNodes.some((n) => n.id === "n1")).toBe(false);
    expect(snap.topEdges).toHaveLength(0);
    expect(snap.stats.totalEdges).toBe(1);
    removeSnapshotEdge(snap, "e1");
    expect(snap.stats.totalEdges).toBe(0);
  });

  it("detects pre-resetAt orphans", () => {
    const snap = emptyGraphSnapshot();
    snap.resetAt = "2026-08-24T00:00:00Z";
    expect(isResetOrphan(snap, "2026-08-01T00:00:00Z")).toBe(true);
    expect(isResetOrphan(snap, "2026-08-25T00:00:00Z")).toBe(false);
    expect(isResetOrphan(null, "2026-08-01T00:00:00Z")).toBe(false);
  });
});
