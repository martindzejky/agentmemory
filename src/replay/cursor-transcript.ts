import type { HookType } from "../types.js";

export type CursorImportSource = "cursor-local" | "cursor-cloud";

export interface CursorCloudMessage {
  id?: string;
  type?: string;
  role?: string;
  text?: string;
}

export interface CursorImportEvent {
  hookType: Extract<HookType, "prompt_submit" | "assistant_response">;
  text: string;
  eventId: string;
  timestamp: string;
}

const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;
const TIMESTAMP_RE = /<timestamp>\s*([^<]+?)\s*<\/timestamp>/i;

export function extractUserQueryText(raw: string): string {
  const match = USER_QUERY_RE.exec(raw);
  if (match?.[1] !== undefined) return match[1].trim();
  return raw.trim();
}

export function extractOptionalTimestamp(raw: string, fallback: string): string {
  const match = TIMESTAMP_RE.exec(raw);
  if (!match?.[1]) return fallback;
  const parsed = Date.parse(match[1].trim());
  if (Number.isNaN(parsed)) return fallback;
  return new Date(parsed).toISOString();
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("\n");
}

/**
 * Parse Cursor local agent-transcripts JSONL.
 * Keeps user/assistant text only; ignores tool_use and turn_ended lines.
 */
export function parseCursorLocalTranscript(
  transcript: string,
  sessionId: string,
  nowIso = new Date().toISOString(),
): CursorImportEvent[] {
  const events: CursorImportEvent[] = [];
  let userN = 0;
  let assistantN = 0;

  // Split once; skip blank/malformed lines without aborting the batch.
  const lines = transcript.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.type === "turn_ended") continue;

    const role =
      typeof entry.role === "string"
        ? entry.role
        : typeof (entry.message as { role?: unknown } | undefined)?.role ===
            "string"
          ? ((entry.message as { role: string }).role)
          : undefined;

    if (role !== "user" && role !== "assistant") continue;

    const message = entry.message;
    const content =
      message && typeof message === "object"
        ? (message as { content?: unknown }).content
        : undefined;
    const rawText = contentToText(content);
    if (!rawText.trim()) continue;

    if (role === "user") {
      userN += 1;
      const prompt = extractUserQueryText(rawText);
      if (!prompt) continue;
      events.push({
        hookType: "prompt_submit",
        text: prompt,
        eventId: `cursor-local:${sessionId}:u:${userN}`,
        timestamp: extractOptionalTimestamp(rawText, nowIso),
      });
      continue;
    }

    assistantN += 1;
    const response = rawText.trim();
    if (!response) continue;
    events.push({
      hookType: "assistant_response",
      text: response,
      eventId: `cursor-local:${sessionId}:a:${assistantN}`,
      timestamp: extractOptionalTimestamp(rawText, nowIso),
    });
  }

  return events;
}

/**
 * Parse Cursor Cloud v0 conversation messages.
 * user_message → prompt_submit; assistant_message → assistant_response.
 */
export function parseCursorCloudMessages(
  messages: CursorCloudMessage[],
  sessionId: string,
  nowIso = new Date().toISOString(),
): CursorImportEvent[] {
  const events: CursorImportEvent[] = [];
  let fallbackN = 0;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    const type =
      typeof message.type === "string" ? message.type.trim().toLowerCase() : "";
    const role =
      typeof message.role === "string" ? message.role.trim().toLowerCase() : "";

    let hookType: CursorImportEvent["hookType"] | null = null;
    if (type === "user_message" || role === "user") {
      hookType = "prompt_submit";
    } else if (type === "assistant_message" || role === "assistant") {
      hookType = "assistant_response";
    } else {
      continue;
    }

    const rawText = typeof message.text === "string" ? message.text : "";
    if (!rawText.trim()) continue;

    const text =
      hookType === "prompt_submit"
        ? extractUserQueryText(rawText)
        : rawText.trim();
    if (!text) continue;

    fallbackN += 1;
    const msgId =
      typeof message.id === "string" && message.id.trim().length > 0
        ? message.id.trim()
        : `n:${fallbackN}`;

    events.push({
      hookType,
      text,
      eventId: `cursor-cloud:${sessionId}:${msgId}`,
      timestamp: extractOptionalTimestamp(rawText, nowIso),
    });
  }

  return events;
}
