// Background vector-index writes with bounded concurrency and a bounded queue.
//
// /observe used to await vectorIndexAddGuarded, which is a network round-trip to
// the embedding provider, inside withKeyedLock("obs:" + sessionId). Two
// consequences on a path whose client aborts at 2.5s: the response waited on a
// third party, and one slow embedding serialised every later observe for that
// session behind the lock.
//
// The vector index is a derived, in-memory structure rebuilt from KV at boot
// (rebuildIndex in src/functions/search.ts), so a queued write is not durable
// state and dropping one under extreme pressure costs semantic recall for that
// observation until the next rebuild. That is a much better failure mode than
// blocking ingest or growing an unbounded backlog, so the queue drops the oldest
// pending item when full and counts it.

import { vectorIndexAddGuarded } from "../functions/search.js";
import { logger } from "../logger.js";

interface QueueItem {
  id: string;
  sessionId: string;
  text: string;
  kind: "memory" | "observation" | "synthetic";
}

const MAX_QUEUE = 500;
const CONCURRENCY = 2;

const queue: QueueItem[] = [];
let inFlight = 0;
let processed = 0;
let failed = 0;
let dropped = 0;
let lastDropWarnAt = 0;

export function enqueueVectorIndexAdd(item: QueueItem): void {
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
    dropped++;
    // Rate-limited: a saturated queue means many drops per second and the
    // interesting fact is "we are dropping", not each individual drop.
    if (Date.now() - lastDropWarnAt > 60_000) {
      lastDropWarnAt = Date.now();
      logger.warn("embed queue saturated — dropping oldest pending embeddings", {
        queued: queue.length,
        dropped,
        hint: "vectors are rebuilt from KV at boot; recall degrades until then",
      });
    }
  }
  queue.push(item);
  drain();
}

function drain(): void {
  while (inFlight < CONCURRENCY && queue.length > 0) {
    const item = queue.shift()!;
    inFlight++;
    void vectorIndexAddGuarded(item.id, item.sessionId, item.text, {
      kind: item.kind,
      logId: item.id,
    })
      .then((ok) => {
        if (ok) processed++;
        else failed++;
      })
      .catch(() => {
        failed++;
      })
      .finally(() => {
        inFlight--;
        drain();
      });
  }
}

export function getEmbedQueueStats(): {
  queued: number;
  inFlight: number;
  processed: number;
  failed: number;
  dropped: number;
} {
  return { queued: queue.length, inFlight, processed, failed, dropped };
}

// Waits for the queue to drain. Used by shutdown and tests; not on any request
// path.
export async function flushEmbedQueue(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((queue.length > 0 || inFlight > 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function resetEmbedQueue(): void {
  queue.length = 0;
  inFlight = 0;
  processed = 0;
  failed = 0;
  dropped = 0;
  lastDropWarnAt = 0;
}
