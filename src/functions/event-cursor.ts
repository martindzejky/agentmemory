export interface EventCursor {
  timestamp: string;
  id: string;
}

export interface EventCursorSource {
  id: string;
  timestamp?: string;
}

function timestampFromObsId(id: string): string | null {
  const match = /^obs_([a-z0-9]+)_/.exec(id);
  if (!match?.[1]) return null;
  const ms = parseInt(match[1], 36);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const iso = new Date(ms).toISOString();
  return Number.isFinite(new Date(iso).getTime()) ? iso : null;
}

export function eventTimestampMs(raw: string | undefined): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = new Date(raw.trim()).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function parseEventTimestamp(raw: string | undefined): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = new Date(raw.trim()).getTime();
  return Number.isFinite(ms) ? raw.trim() : null;
}

export function normalizeEventCursor(source: EventCursorSource): EventCursor {
  const parsed = parseEventTimestamp(source.timestamp);
  if (parsed) return { timestamp: parsed, id: source.id };
  const fromId = timestampFromObsId(source.id);
  if (fromId) return { timestamp: fromId, id: source.id };
  return { timestamp: "1970-01-01T00:00:00.000Z", id: source.id };
}

export function compareEventCursors(a: EventCursor, b: EventCursor): number {
  const ta = new Date(a.timestamp).getTime();
  const tb = new Date(b.timestamp).getTime();
  if (ta !== tb) return ta - tb;
  return a.id.localeCompare(b.id);
}

export function isAfterCursor(
  source: EventCursorSource,
  cursor: EventCursor | undefined,
): boolean {
  if (!cursor) return true;
  return compareEventCursors(normalizeEventCursor(source), cursor) > 0;
}

export function sortByEventCursor<T extends EventCursorSource>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    compareEventCursors(normalizeEventCursor(a), normalizeEventCursor(b)),
  );
}

export function splitByCursor<T extends EventCursorSource>(
  items: T[],
  cursor: EventCursor | undefined,
): { prior: T[]; newItems: T[] } {
  const sorted = sortByEventCursor(items);
  if (!cursor) return { prior: [], newItems: sorted };
  const newItems = sorted.filter((item) => isAfterCursor(item, cursor));
  const prior = sorted.filter((item) => !isAfterCursor(item, cursor));
  return { prior, newItems };
}

export function newestEventCursor<T extends EventCursorSource>(
  items: T[],
): EventCursor | null {
  if (items.length === 0) return null;
  const sorted = sortByEventCursor(items);
  const last = sorted[sorted.length - 1];
  return normalizeEventCursor(last);
}

/** True when `a` is strictly later than `b` by epoch millis (format-safe). */
export function isIsoTimestampAfter(
  a: string | undefined,
  b: string | undefined,
): boolean {
  const am = eventTimestampMs(a);
  const bm = eventTimestampMs(b);
  if (am === null || bm === null) return false;
  return am > bm;
}
