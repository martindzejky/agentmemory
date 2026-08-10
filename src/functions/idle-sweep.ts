import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  getIdleSweepMaxSessions,
  getIdleSweepSessionCooldownMs,
  getIdleThresholdMs,
  isIdleSweepEnabled,
} from "../config.js";
import { logger } from "../logger.js";

export interface IdleSweepResult {
  success: true;
  skipped?: boolean;
  reason?: string;
  scanned: number;
  candidates: number;
  processed: number;
  failed: number;
  capped: boolean;
}

type SessionRow = Session & {
  updatedAt?: string;
  idleProcessedObservationCount?: number;
  idleProcessedAt?: string;
};

let sweepInFlight = false;

/** Test-only: clear the in-process overlap guard between cases. */
export function __resetIdleSweepInFlightForTests(): void {
  sweepInFlight = false;
}

function activityAtMs(session: SessionRow): number | null {
  const raw = session.updatedAt || session.startedAt;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function needsIdleProcessing(
  session: SessionRow,
  nowMs: number,
  idleThresholdMs: number,
  cooldownMs: number,
): boolean {
  const obsCount =
    typeof session.observationCount === "number" ? session.observationCount : 0;
  if (obsCount <= 0) return false;

  const activityMs = activityAtMs(session);
  if (activityMs === null) return false;
  if (nowMs - activityMs < idleThresholdMs) return false;

  if (
    typeof session.idleProcessedObservationCount === "number" &&
    session.idleProcessedObservationCount >= obsCount
  ) {
    return false;
  }

  if (cooldownMs > 0 && typeof session.idleProcessedAt === "string") {
    const processedMs = new Date(session.idleProcessedAt).getTime();
    if (Number.isFinite(processedMs) && nowMs - processedMs < cooldownMs) {
      return false;
    }
  }

  return true;
}

function isProcessableResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  if (!("success" in result)) return true;
  const success = (result as { success?: unknown }).success;
  if (success === true) return true;
  // Summarize returns success:false for empty sessions; treat as done so we
  // do not retry forever when there is nothing compressible to summarize.
  const error = (result as { error?: unknown }).error;
  return error === "no_observations";
}

async function markIdleProcessed(
  kv: StateKV,
  sessionId: string,
  observationCount: number,
  processedAt: string,
): Promise<void> {
  await withKeyedLock(`session:${sessionId}`, async () => {
    const current = await kv.get<SessionRow>(KV.sessions, sessionId);
    if (!current) return;
    await kv.set(KV.sessions, sessionId, {
      ...current,
      idleProcessedObservationCount: observationCount,
      idleProcessedAt: processedAt,
    });
  });
}

export function registerIdleSweepFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::idle-sweep",
    async (): Promise<IdleSweepResult> => {
      if (!isIdleSweepEnabled()) {
        return {
          success: true,
          skipped: true,
          reason: "disabled_or_no_provider",
          scanned: 0,
          candidates: 0,
          processed: 0,
          failed: 0,
          capped: false,
        };
      }

      if (sweepInFlight) {
        return {
          success: true,
          skipped: true,
          reason: "already_running",
          scanned: 0,
          candidates: 0,
          processed: 0,
          failed: 0,
          capped: false,
        };
      }

      sweepInFlight = true;
      const nowMs = Date.now();
      const processedAt = new Date(nowMs).toISOString();
      const idleThresholdMs = getIdleThresholdMs();
      const cooldownMs = getIdleSweepSessionCooldownMs();
      const maxSessions = getIdleSweepMaxSessions();

      try {
        const sessions = await kv.list<SessionRow>(KV.sessions).catch(() => []);
        const candidates = sessions
          .filter((s) =>
            needsIdleProcessing(s, nowMs, idleThresholdMs, cooldownMs),
          )
          .sort((a, b) => (activityAtMs(a) ?? 0) - (activityAtMs(b) ?? 0));

        const batch = candidates.slice(0, maxSessions);
        let processed = 0;
        let failed = 0;

        for (const session of batch) {
          // Re-check under the session lock so concurrent observe writes win.
          const stillDue = await withKeyedLock(
            `session:${session.id}`,
            async () => {
              const fresh = await kv.get<SessionRow>(KV.sessions, session.id);
              if (!fresh) return null;
              if (
                !needsIdleProcessing(
                  fresh,
                  Date.now(),
                  idleThresholdMs,
                  cooldownMs,
                )
              ) {
                return null;
              }
              return fresh;
            },
          );
          if (!stillDue) continue;

          try {
            const result = await sdk.trigger({
              function_id: "event::session::stopped",
              // Never fan out corpus consolidate/crystallize per session.
              // The existing CONSOLIDATION_INTERVAL_MS timer owns that work.
              payload: { sessionId: stillDue.id, skipConsolidation: true },
            });
            if (!isProcessableResult(result)) {
              failed++;
              logger.warn("Idle sweep session processing failed", {
                sessionId: stillDue.id,
                result,
              });
              continue;
            }
            await markIdleProcessed(
              kv,
              stillDue.id,
              stillDue.observationCount || 0,
              processedAt,
            );
            processed++;
          } catch (err) {
            failed++;
            logger.warn("Idle sweep session processing failed", {
              sessionId: stillDue.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (processed > 0 || failed > 0 || candidates.length > 0) {
          logger.info("Idle sweep complete", {
            scanned: sessions.length,
            candidates: candidates.length,
            processed,
            failed,
            capped: candidates.length > maxSessions,
          });
        }

        return {
          success: true,
          scanned: sessions.length,
          candidates: candidates.length,
          processed,
          failed,
          capped: candidates.length > maxSessions,
        };
      } finally {
        sweepInFlight = false;
      }
    },
  );
}
