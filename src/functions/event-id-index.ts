import type { EventIdIndexEntry, RawObservation } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";

export async function writeEventIdIndexEntry(
  kv: StateKV,
  sessionId: string,
  eventId: string,
  observationId: string,
  at: string,
): Promise<void> {
  const entry: EventIdIndexEntry = { eventId, observationId, at };
  await kv.set(KV.eventIds(sessionId), eventId, entry);
}

export async function pruneEventIdIndexEntry(
  kv: StateKV,
  sessionId: string,
  observationId: string,
): Promise<void> {
  try {
    const raw = await kv.get<RawObservation>(
      KV.rawEvents(sessionId),
      observationId,
    );
    if (typeof raw?.eventId === "string" && raw.eventId.length > 0) {
      await kv.delete(KV.eventIds(sessionId), raw.eventId);
    }
  } catch (error) {
    logger.warn("Failed to prune eventId index entry", {
      sessionId,
      observationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function clearEventIdIndex(
  kv: StateKV,
  sessionId: string,
): Promise<void> {
  try {
    const entries = await kv
      .list<EventIdIndexEntry>(KV.eventIds(sessionId))
      .catch(() => [] as EventIdIndexEntry[]);
    for (const entry of entries) {
      if (typeof entry?.eventId === "string" && entry.eventId.length > 0) {
        await kv.delete(KV.eventIds(sessionId), entry.eventId);
      }
    }
  } catch (error) {
    logger.warn("Failed to clear eventId index", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function indexRawEventIfPresent(
  kv: StateKV,
  sessionId: string,
  event: Pick<RawObservation, "id" | "eventId" | "timestamp">,
): Promise<void> {
  if (typeof event.eventId !== "string" || event.eventId.length === 0) return;
  await writeEventIdIndexEntry(
    kv,
    sessionId,
    event.eventId,
    event.id,
    event.timestamp,
  );
}
