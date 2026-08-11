import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { getAgentId } from "../config.js";

export type SessionRecord = Session;

export interface EnsureSessionInput {
  sessionId: string;
  project?: string;
  cwd?: string;
  /** Request-scoped agentId (already trimmed). Used only on create. */
  agentId?: string;
  startedAt?: string;
  /** observationCount when creating. Default 0. */
  createObservationCount?: number;
  /** Bump observationCount by this amount when the session already exists. */
  incrementObservationCount?: number;
  /** Set firstPrompt on create, or fill it when missing on update. */
  firstPrompt?: string;
  /** Refresh updatedAt on existing sessions. Default true. */
  touchUpdatedAt?: boolean;
  /** Stamp lastEventAt when ingesting an observation (ISO timestamp). */
  lastEventAt?: string;
}

export type EnsureSessionResult =
  | { ok: true; created: boolean; session: SessionRecord }
  | { ok: false; reason: "missing_project_cwd" };

export function normalizeRequestAgentId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 128);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve agentId for a newly created session.
 * Precedence: non-empty request agentId > getAgentId() env.
 * Existing sessions keep their agentId (including unset) — callers must not
 * pass env as a request agentId to force a retrofit.
 */
export function resolveCreateAgentId(
  requestAgentId?: string,
): string | undefined {
  return normalizeRequestAgentId(requestAgentId) ?? getAgentId();
}

function hasProjectAndCwd(
  project: string | undefined,
  cwd: string | undefined,
): boolean {
  return (
    typeof project === "string" &&
    project.trim().length > 0 &&
    typeof cwd === "string" &&
    cwd.trim().length > 0
  );
}

/**
 * Ensure a session row exists for write/touch paths that may arrive before
 * /session/start. Existing rows are touched safely (updatedAt / counts /
 * firstPrompt fill) without wiping identity fields or overwriting agentId.
 *
 * Serialized per sessionId via withKeyedLock (same pattern as
 * api::session::commit) so concurrent observe/summarize lazy-creates cannot
 * overwrite each other.
 */
export async function ensureSession(
  kv: StateKV,
  input: EnsureSessionInput,
): Promise<EnsureSessionResult> {
  return withKeyedLock(`session:${input.sessionId}`, async () => {
    const existing = await kv.get<SessionRecord>(KV.sessions, input.sessionId);
    const now = new Date().toISOString();

    if (existing) {
      const touchUpdatedAt = input.touchUpdatedAt !== false;
      const updates: Array<{ type: "set"; path: string; value: unknown }> = [];

      if (touchUpdatedAt) {
        updates.push({ type: "set", path: "updatedAt", value: now });
      }

      if (
        typeof input.incrementObservationCount === "number" &&
        input.incrementObservationCount !== 0
      ) {
        updates.push({
          type: "set",
          path: "observationCount",
          value:
            (existing.observationCount || 0) + input.incrementObservationCount,
        });
      }

      if (
        !existing.firstPrompt &&
        typeof input.firstPrompt === "string" &&
        input.firstPrompt.trim().length > 0
      ) {
        updates.push({
          type: "set",
          path: "firstPrompt",
          value: input.firstPrompt.trim().slice(0, 200),
        });
      }

      if (typeof input.lastEventAt === "string" && input.lastEventAt.trim()) {
        const incoming = input.lastEventAt.trim();
        const current = existing.lastEventAt;
        const incomingMs = new Date(incoming).getTime();
        const currentMs =
          typeof current === "string" ? new Date(current).getTime() : NaN;
        if (
          Number.isFinite(incomingMs) &&
          (!Number.isFinite(currentMs) || incomingMs > currentMs)
        ) {
          updates.push({ type: "set", path: "lastEventAt", value: incoming });
        }
      }

      if (updates.length > 0) {
        await kv.update(KV.sessions, input.sessionId, updates);
      }

      const session =
        (await kv.get<SessionRecord>(KV.sessions, input.sessionId)) ?? existing;
      return { ok: true, created: false, session };
    }

    if (!hasProjectAndCwd(input.project, input.cwd)) {
      return { ok: false, reason: "missing_project_cwd" };
    }

    const project = (input.project as string).trim();
    const cwd = (input.cwd as string).trim();
    const agentId = resolveCreateAgentId(input.agentId);
    const firstPrompt =
      typeof input.firstPrompt === "string" &&
      input.firstPrompt.trim().length > 0
        ? input.firstPrompt.trim().slice(0, 200)
        : undefined;

    const session: SessionRecord = {
      id: input.sessionId,
      project,
      cwd,
      startedAt: input.startedAt ?? now,
      updatedAt: now,
      status: "active",
      observationCount: input.createObservationCount ?? 0,
      lastEventAt:
        typeof input.lastEventAt === "string" && input.lastEventAt.trim()
          ? input.lastEventAt.trim()
          : now,
      ...(agentId ? { agentId } : {}),
      ...(firstPrompt ? { firstPrompt } : {}),
    };

    await kv.set(KV.sessions, input.sessionId, session);
    return { ok: true, created: true, session };
  });
}
