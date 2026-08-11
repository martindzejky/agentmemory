import { describe, it, expect } from "vitest";
import { truncateAwaitingLlmUpgrade } from "../src/functions/compress-upgrade-gate.js";
import type { CompressedObservation } from "../src/types.js";

function obs(
  id: string,
  timestamp: string,
  derivedBy?: "synthetic" | "llm",
): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp,
    type: "conversation",
    title: id,
    facts: [],
    narrative: "",
    concepts: [],
    files: [],
    importance: 5,
    ...(derivedBy ? { derivedBy } : {}),
  };
}

describe("truncateAwaitingLlmUpgrade", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  const graceMs = 5 * 60 * 1000;

  it("truncates at the first recent non-llm row", () => {
    const items = [
      obs("obs_1", "2026-06-01T11:00:00.000Z", "llm"),
      obs("obs_2", "2026-06-01T11:58:00.000Z", "llm"),
      obs("obs_3", "2026-06-01T11:59:00.000Z", "synthetic"),
    ];
    expect(truncateAwaitingLlmUpgrade(items, now, graceMs).map((o) => o.id)).toEqual([
      "obs_1",
      "obs_2",
    ]);
  });

  it("keeps all rows when the pending synthetic is past grace", () => {
    const items = [
      obs("obs_1", "2026-06-01T10:00:00.000Z", "llm"),
      obs("obs_2", "2026-06-01T10:30:00.000Z", "synthetic"),
    ];
    expect(truncateAwaitingLlmUpgrade(items, now, graceMs).map((o) => o.id)).toEqual([
      "obs_1",
      "obs_2",
    ]);
  });
});
