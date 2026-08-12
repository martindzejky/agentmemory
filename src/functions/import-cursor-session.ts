import type { ISdk } from "iii-sdk";
import type { HookPayload, Session } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { normalizeRequestAgentId } from "./ensure-session.js";
import { safeAudit } from "./audit.js";
import {
  parseCursorCloudMessages,
  parseCursorLocalTranscript,
  type CursorCloudMessage,
  type CursorImportEvent,
  type CursorImportSource,
} from "../replay/cursor-transcript.js";

/** Concurrent mem::observe fan-out size; keeps large imports under function timeouts. */
export const CURSOR_IMPORT_OBSERVE_BATCH = 8;

export type ImportCursorSessionInput = {
  sessionId: string;
  project?: string;
  cwd?: string;
  source?: CursorImportSource;
  agentId?: string;
  transcript?: string;
  messages?: CursorCloudMessage[];
};

export type ImportCursorSessionResult =
  | {
      success: true;
      skipped: true;
      reason: "exists";
      sessionId: string;
    }
  | {
      success: true;
      skipped: false;
      sessionId: string;
      imported: number;
      deduplicated?: number;
      errors?: string[];
      source: CursorImportSource;
    }
  | { success: false; error: string };

function resolveSource(data: ImportCursorSessionInput): CursorImportSource | null {
  if (data.source === "cursor-local" || data.source === "cursor-cloud") {
    return data.source;
  }
  if (typeof data.transcript === "string") return "cursor-local";
  if (Array.isArray(data.messages)) return "cursor-cloud";
  return null;
}

function parseEvents(
  data: ImportCursorSessionInput,
  source: CursorImportSource,
  nowIso: string,
): CursorImportEvent[] {
  if (source === "cursor-local") {
    const transcript = typeof data.transcript === "string" ? data.transcript : "";
    return parseCursorLocalTranscript(transcript, data.sessionId, nowIso);
  }
  const messages = Array.isArray(data.messages) ? data.messages : [];
  return parseCursorCloudMessages(messages, data.sessionId, nowIso);
}

export async function importCursorSession(
  sdk: ISdk,
  kv: StateKV,
  data: ImportCursorSessionInput,
): Promise<ImportCursorSessionResult> {
  const sessionId =
    typeof data.sessionId === "string" ? data.sessionId.trim() : "";
  if (!sessionId) {
    return { success: false, error: "sessionId is required" };
  }

  const hasTranscript = typeof data.transcript === "string";
  const hasMessages = Array.isArray(data.messages);
  if (!hasTranscript && !hasMessages) {
    return {
      success: false,
      error: "transcript or messages is required",
    };
  }

  const source = resolveSource(data);
  if (!source) {
    return {
      success: false,
      error: 'source must be "cursor-local" or "cursor-cloud"',
    };
  }

  if (source === "cursor-local" && !hasTranscript) {
    return {
      success: false,
      error: "transcript is required when source is cursor-local",
    };
  }
  if (source === "cursor-cloud" && !hasMessages) {
    return {
      success: false,
      error: "messages is required when source is cursor-cloud",
    };
  }

  const existing = await kv.get<Session>(KV.sessions, sessionId);
  if (existing) {
    return {
      success: true,
      skipped: true,
      reason: "exists",
      sessionId,
    };
  }

  const nowIso = new Date().toISOString();
  const project =
    typeof data.project === "string" && data.project.trim()
      ? data.project.trim()
      : "unknown";
  const cwd =
    typeof data.cwd === "string" && data.cwd.trim()
      ? data.cwd.trim()
      : process.cwd();
  const agentId = normalizeRequestAgentId(data.agentId) ?? "cursor";

  const events = parseEvents({ ...data, sessionId }, source, nowIso);

  let imported = 0;
  let deduplicated = 0;
  const errors: string[] = [];

  for (let i = 0; i < events.length; i += CURSOR_IMPORT_OBSERVE_BATCH) {
    const batch = events.slice(i, i + CURSOR_IMPORT_OBSERVE_BATCH);
    const results = await Promise.all(
      batch.map(async (event) => {
        const payload: HookPayload = {
          hookType: event.hookType,
          sessionId,
          project,
          cwd,
          timestamp: event.timestamp,
          agentId,
          eventId: event.eventId,
          data:
            event.hookType === "prompt_submit"
              ? { prompt: event.text }
              : { assistantResponse: event.text },
        };
        try {
          const result = (await sdk.trigger({
            function_id: "mem::observe",
            payload,
          })) as
            | { observationId?: string; deduplicated?: boolean; success?: boolean; error?: string }
            | undefined;
          return { eventId: event.eventId, result };
        } catch (err) {
          return {
            eventId: event.eventId,
            result: {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            },
          };
        }
      }),
    );

    for (const { eventId, result } of results) {
      if (result?.deduplicated) {
        deduplicated += 1;
        continue;
      }
      if (result && result.success === false) {
        errors.push(
          `${eventId}: ${typeof result.error === "string" ? result.error : "observe failed"}`,
        );
        continue;
      }
      if (result && typeof result.observationId === "string") {
        imported += 1;
        continue;
      }
      // Some mocks return { success: true } without observationId.
      if (result && result.success !== false) {
        imported += 1;
        continue;
      }
      errors.push(`${eventId}: unexpected observe result`);
    }
  }

  await safeAudit(kv, "import", "mem::replay::import-cursor-session", [sessionId], {
    source,
    imported,
    deduplicated,
    errors: errors.length,
    events: events.length,
  });

  return {
    success: true,
    skipped: false,
    sessionId,
    imported,
    ...(deduplicated > 0 ? { deduplicated } : {}),
    ...(errors.length > 0 ? { errors } : {}),
    source,
  };
}

export function registerImportCursorSessionFunction(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction(
    "mem::replay::import-cursor-session",
    async (data: ImportCursorSessionInput): Promise<ImportCursorSessionResult> =>
      importCursorSession(sdk, kv, data ?? ({} as ImportCursorSessionInput)),
  );
}
