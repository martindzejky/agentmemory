import type { CompressedObservation } from "../types.js";
import { eventTimestampMs } from "./event-cursor.js";

export function truncateAwaitingLlmUpgrade<T extends CompressedObservation>(
  items: T[],
  nowMs: number,
  graceMs: number,
): T[] {
  const cutoff = items.findIndex((item) => {
    if (item.derivedBy === "llm") return false;
    const ts = eventTimestampMs(item.timestamp);
    if (ts === null) return false;
    return nowMs - ts < graceMs;
  });
  return cutoff < 0 ? items : items.slice(0, cutoff);
}
