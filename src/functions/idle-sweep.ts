import type { ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  getIdleSweepMaxSessions,
  getIdleSweepObsCatchup,
  getIdleSweepSessionCooldownMs,
  getIdleThresholdMs,
  isIdleSweepEnabled,
} from "../config.js";
import { logger } from "../logger.js";
import { eventTimestampMs } from "./event-cursor.js";

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

type SessionRow = Session;

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

function newestIngestedAt(session: SessionRow): string | undefined {
  return session.lastEventAt ?? session.updatedAt ?? session.startedAt;
}

function pendingObservationCount(session: SessionRow): number {
  const obsCount =
    typeof session.observationCount === "number" ? session.observationCount : 0;
  const processed =
    typeof session.summarizedObservationCount === "number"
      ? session.summarizedObservationCount
      : 0;
  return obsCount - processed;
}

function hasEventPending(session: SessionRow): boolean {
  const obsCount =
    typeof session.observationCount === "number" ? session.observationCount : 0;
  if (obsCount <= 0) return false;
  if (!session.lastSummarizedEventAt) return true;
  const newest = newestIngestedAt(session);
  if (!newest) return false;
  const newestMs = eventTimestampMs(newest);
  const summarizedMs = eventTimestampMs(session.lastSummarizedEventAt);
  if (newestMs === null || summarizedMs === null) return false;
  return newestMs > summarizedMs;
}

function hasPendingWork(session: SessionRow): boolean {
  return hasEventPending(session) || pendingObservationCount(session) > 0;
}

function inCooldown(
  session: SessionRow,
  nowMs: number,
  cooldownMs: number,
): boolean {
  if (cooldownMs <= 0 || typeof session.lastSweepAttemptAt !== "string") {
    return false;
  }
  const at = new Date(session.lastSweepAttemptAt).getTime();
  return Number.isFinite(at) && nowMs - at < cooldownMs;
}

/**
 * A session is due when it has pending observations, is outside cooldown, and
 * either (a) has been idle long enough, or (b) has accumulated enough pending
 * observations that an all-day conversation should catch up without waiting
 * for idle (updatedAt is refreshed on every /observe).
 */
function needsProcessing(
  session: SessionRow,
  nowMs: number,
  idleThresholdMs: number,
  cooldownMs: number,
  obsCatchup: number,
): boolean {
  if (!hasPendingWork(session)) return false;
  if (inCooldown(session, nowMs, cooldownMs)) return false;

  const pending = pendingObservationCount(session);
  const activityMs = activityAtMs(session);
  const isIdle =
    activityMs !== null && nowMs - activityMs >= idleThresholdMs;
  const countCatchup = pending >= obsCatchup;
  return isIdle || countCatchup;
}

function isProcessableResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  if (!("success" in result)) return true;
  const success = (result as { success?: unknown }).success;
  if (success === true) return true;
  // Empty sessions are done — advance the count marker so we do not retry.
  // no_provider is a failure: record attempt time for cooldown, but do not
  // advance the count so a later working provider can still catch up.
  const error = (result as { error?: unknown }).error;
  return error === "no_observations";
}

async function touchIdleAttempt(
  kv: StateKV,
  sessionId: string,
  attemptedAt: string,
  advanceObservationCount?: number,
): Promise<void> {
  await withKeyedLock(`session:${sessionId}`, async () => {
    const updates: Array<{ type: "set"; path: string; value: unknown }> = [
      { type: "set", path: "lastSweepAttemptAt", value: attemptedAt },
    ];
    if (typeof advanceObservationCount === "number") {
      updates.push({
        type: "set",
        path: "summarizedObservationCount",
        value: advanceObservationCount,
      });
    }
    await kv.update(KV.sessions, sessionId, updates);
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
      const attemptedAt = new Date(nowMs).toISOString();
      const idleThresholdMs = getIdleThresholdMs();
      const cooldownMs = getIdleSweepSessionCooldownMs();
      const maxSessions = getIdleSweepMaxSessions();
      const obsCatchup = getIdleSweepObsCatchup();

      try {
        const sessions = await kv.list<SessionRow>(KV.sessions).catch(() => []);
        const candidates = sessions
          .filter((s) =>
            needsProcessing(
              s,
              nowMs,
              idleThresholdMs,
              cooldownMs,
              obsCatchup,
            ),
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
                !needsProcessing(
                  fresh,
                  Date.now(),
                  idleThresholdMs,
                  cooldownMs,
                  obsCatchup,
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
              // Attempt timestamp only — keep pending count so a later
              // success can catch up, but stay out of the next few sweeps.
              await touchIdleAttempt(kv, stillDue.id, attemptedAt);
              logger.warn("Idle sweep session processing failed", {
                sessionId: stillDue.id,
                result,
              });
              continue;
            }
            await touchIdleAttempt(
              kv,
              stillDue.id,
              attemptedAt,
              stillDue.observationCount || 0,
            );
            processed++;
          } catch (err) {
            failed++;
            await touchIdleAttempt(kv, stillDue.id, attemptedAt);
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
