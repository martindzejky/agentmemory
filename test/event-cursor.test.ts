import { describe, expect, it } from "vitest";
import {
  compareEventCursors,
  isAfterCursor,
  isIsoTimestampAfter,
  normalizeEventCursor,
  sortByEventCursor,
  splitByCursor,
} from "../src/functions/event-cursor.js";

describe("event-cursor", () => {
  it("compares primarily by timestamp and uses id as tiebreaker", () => {
    expect(
      compareEventCursors(
        { timestamp: "2026-01-01T10:00:00.000Z", id: "obs_a" },
        { timestamp: "2026-01-01T11:00:00.000Z", id: "obs_b" },
      ),
    ).toBeLessThan(0);
    expect(
      compareEventCursors(
        { timestamp: "2026-01-01T10:00:00.000Z", id: "obs_a" },
        { timestamp: "2026-01-01T10:00:00.000Z", id: "obs_b" },
      ),
    ).toBeLessThan(0);
  });

  it("uses normalizeEventCursor for both sort and isAfterCursor", () => {
    const items = [
      { id: "obs_legacy", timestamp: "not-a-date" },
      { id: "obs_2", timestamp: "2026-01-01T11:00:00.000Z" },
    ];
    const sorted = sortByEventCursor(items);
    const cursor = normalizeEventCursor(sorted[0]);
    expect(isAfterCursor(sorted[0], cursor)).toBe(false);
    expect(isAfterCursor(sorted[1], cursor)).toBe(true);
    const { newItems } = splitByCursor(items, cursor);
    expect(newItems.map((o) => o.id)).toEqual([sorted[1].id]);
  });

  it("derives a sort key from obs id when timestamp is missing", () => {
    const ts = Date.now();
    const idTs = ts.toString(36);
    const obs = { id: `obs_${idTs}_abc123def456`, timestamp: undefined };
    const normalized = normalizeEventCursor(obs);
    expect(new Date(normalized.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("splitByCursor separates prior and new observations", () => {
    const items = [
      { id: "obs_1", timestamp: "2026-01-01T10:00:00.000Z" },
      { id: "obs_2", timestamp: "2026-01-01T11:00:00.000Z" },
      { id: "obs_3", timestamp: "2026-01-01T12:00:00.000Z" },
    ];
    const { prior, newItems } = splitByCursor(items, {
      timestamp: "2026-01-01T11:00:00.000Z",
      id: "obs_2",
    });
    expect(prior.map((o) => o.id)).toEqual(["obs_1", "obs_2"]);
    expect(newItems.map((o) => o.id)).toEqual(["obs_3"]);
  });

  it("compares ISO timestamps by epoch millis across formats", () => {
    expect(
      isIsoTimestampAfter("2026-01-01T10:00:00Z", "2026-01-01T10:00:00.000Z"),
    ).toBe(false);
    expect(
      isIsoTimestampAfter("2026-01-01T10:00:01Z", "2026-01-01T10:00:00.000Z"),
    ).toBe(true);
  });
});
