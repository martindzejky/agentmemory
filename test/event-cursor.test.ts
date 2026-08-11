import { describe, expect, it } from "vitest";
import {
  compareEventCursors,
  isAfterCursor,
  normalizeEventCursor,
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

  it("treats malformed timestamps as new until covered by a valid cursor", () => {
    const cursor = {
      timestamp: "2026-01-01T12:00:00.000Z",
      id: "obs_mdm123_abc",
    };
    const malformed = {
      id: "obs_mdm999_newer",
      timestamp: "not-a-date",
    };
    expect(isAfterCursor(malformed, cursor)).toBe(true);
    const normalized = normalizeEventCursor(malformed);
    expect(normalized.timestamp).not.toBe("not-a-date");
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
});
