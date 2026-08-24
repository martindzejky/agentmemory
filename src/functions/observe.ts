import { TriggerAction, type ISdk } from "iii-sdk";
import type {
  EventIdIndexEntry,
  RawObservation,
  HookPayload,
  Origin,
} from "../types.js";
import { KV, STREAM, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { isAutoCompressEnabled } from "../config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { getSearchIndex } from "./search.js";
import { enqueueVectorIndexAdd } from "../state/embed-queue.js";
import { logger } from "../logger.js";
import { saveImageToDisk } from "../utils/image-store.js";
import { ensureSession, resolveCreateAgentId } from "./ensure-session.js";
import { writeEventIdIndexEntry } from "./event-id-index.js";

const TOOL_HOOKS = new Set(["pre_tool_use", "post_tool_use", "post_tool_failure"]);

export function extractImage(d: unknown): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") {
    if (d.startsWith("data:image/") || d.startsWith("iVBORw0KGgo") || d.startsWith("/9j/")) {
      return d;
    }
    return undefined;
  }
  if (typeof d === "object" && d !== null) {
    const obj = d as Record<string, unknown>;
    if (typeof obj["image_data"] === "string") return obj["image_data"];
    if (typeof obj["image_path"] === "string") return obj["image_path"];
    if (typeof obj["imageBase64"] === "string") return obj["imageBase64"];
    if (typeof obj["imagePath"] === "string") return obj["imagePath"];

    for (const key of Object.keys(obj)) {
      const match = extractImage(obj[key]);
      if (match) return match;
    }
  }
  return undefined;
}

export function registerObserveFunction(
  sdk: ISdk,
  kv: StateKV,
  maxObservationsPerSession?: number,
): void {
  sdk.registerFunction("mem::observe", 
    async (payload: HookPayload) => {

      if (
        !payload?.sessionId ||
        typeof payload.sessionId !== "string" ||
        !payload.hookType ||
        typeof payload.hookType !== "string" ||
        !payload.timestamp ||
        typeof payload.timestamp !== "string"
      ) {
        return {
          success: false,
          error:
            "Invalid payload: sessionId, hookType, and timestamp are required",
        };
      }

      const obsId = generateId("obs");

      const eventId =
        typeof payload.eventId === "string" && payload.eventId.trim().length > 0
          ? payload.eventId.trim()
          : undefined;

      if (!eventId) {
        logger.warn("Observation accepted without eventId", {
          sessionId: payload.sessionId,
          hookType: payload.hookType,
        });
      }

      let sanitizedRaw: unknown = payload.data;
      try {
        const jsonStr = JSON.stringify(payload.data);
        const sanitized = stripPrivateData(jsonStr);
        sanitizedRaw = JSON.parse(sanitized);
      } catch {
        sanitizedRaw = stripPrivateData(String(payload.data));
      }

      let originChannel: Origin["channel"] = "agent";
      if (payload.hookType === "prompt_submit") originChannel = "user";
      else if (TOOL_HOOKS.has(payload.hookType)) originChannel = "tool";
      const raw: RawObservation = {
        id: obsId,
        sessionId: payload.sessionId,
        timestamp: payload.timestamp,
        hookType: payload.hookType,
        raw: sanitizedRaw,
        ...(eventId ? { eventId } : {}),
        origin: {
          channel: originChannel,
          capturedAt: payload.timestamp,
        },
      };

      let extractedImage: string | undefined;

      if (typeof sanitizedRaw === "object" && sanitizedRaw !== null) {
        const d = sanitizedRaw as Record<string, unknown>;
        if (
          payload.hookType === "post_tool_use" ||
          payload.hookType === "post_tool_failure"
        ) {
          raw.toolName = d["tool_name"] as string | undefined;
          raw.toolInput = d["tool_input"];
          raw.toolOutput = d["tool_output"] || d["error"];
          if (raw.origin && raw.toolName) raw.origin.detail = raw.toolName;
        }
        if (payload.hookType === "prompt_submit") {
          raw.userPrompt = d["prompt"] as string | undefined;
        }
        if (payload.hookType === "assistant_response") {
          raw.assistantResponse = d["assistantResponse"] as string | undefined;
        }
        if (
          payload.hookType === "subagent_start" ||
          payload.hookType === "subagent_stop"
        ) {
          raw.subagentId = d["subagent_id"] as string | undefined;
          raw.subagentType = d["subagent_type"] as string | undefined;
          raw.subagentTask = d["task"] as string | undefined;
          raw.subagentStatus = d["status"] as string | undefined;
          raw.subagentSummary = d["summary"] as string | undefined;
        }

        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = (raw.toolInput || raw.toolOutput || raw.userPrompt || raw.assistantResponse) ? "mixed" : "image";
        }
      } else if (typeof sanitizedRaw === "string") {
        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = "image";
        }
      }

      const pendingImageData = extractedImage;

      return withKeyedLock(`obs:${payload.sessionId}`, async () => {
        // Checked under the existing obs:session lock. Index write stays
        // after successful raw+derived kv.set so a failed write cannot poison the key.
        if (eventId) {
          const existing = await kv.get<EventIdIndexEntry>(
            KV.eventIds(payload.sessionId),
            eventId,
          );
          if (existing) {
            const rawStillThere = await kv.get(
              KV.rawEvents(payload.sessionId),
              existing.observationId,
            );
            if (rawStillThere) {
              return {
                deduplicated: true,
                sessionId: payload.sessionId,
                eventId,
                observationId: existing.observationId,
              };
            }
            // Stale index (prune/clear failed, or race with forget): drop it
            // and fall through so the retry can rewrite the event.
            try {
              await kv.delete(KV.eventIds(payload.sessionId), eventId);
            } catch {
              /* best-effort */
            }
          }
        }

        if (maxObservationsPerSession && maxObservationsPerSession > 0) {
          const existing = await kv.list(KV.observations(payload.sessionId));
          if (existing.length >= maxObservationsPerSession) {
            return {
              success: false,
              error: `Session observation limit reached (${maxObservationsPerSession})`,
            };
          }
        }

        // Existing session is the source of truth for agentId (even
        // undefined). Request agentId / env AGENT_ID only apply on lazy
        // create — otherwise an unscoped session would get retroactively
        // scoped by a later AGENT_ID export or observe body.
        const existingSession = await kv.get<{
          agentId?: string;
          observationCount?: number;
          firstPrompt?: string;
        }>(KV.sessions, payload.sessionId);
        if (existingSession?.agentId) {
          raw.agentId = existingSession.agentId;
        } else if (!existingSession) {
          const createAgentId = resolveCreateAgentId(payload.agentId);
          if (createAgentId) {
            raw.agentId = createAgentId;
          }
        }

        if (pendingImageData && (pendingImageData.startsWith("data:image/") || pendingImageData.startsWith("iVBORw0KGgo") || pendingImageData.startsWith("/9j/"))) {
          const { filePath, bytesWritten } = await saveImageToDisk(pendingImageData);
          raw.imageData = filePath;
          const { incrementImageRef } = await import("./image-refs.js");
          await incrementImageRef(kv, filePath);
          sdk.trigger({
            function_id: "mem::disk-size-delta",
            payload: { deltaBytes: bytesWritten },
            action: TriggerAction.Void(),
          });
          if (process.env["AGENTMEMORY_IMAGE_EMBEDDINGS"] === "true") {
            sdk.trigger({
              function_id: "mem::vision-embed",
              payload: {
                imageRef: filePath,
                sessionId: payload.sessionId,
                observationId: obsId,
              },
              action: TriggerAction.Void(),
            });
          }
        }

        let synthetic: ReturnType<typeof buildSyntheticCompression>;
        try {
          await kv.set(KV.rawEvents(payload.sessionId), obsId, raw);
          synthetic = buildSyntheticCompression(raw);
          await kv.set(
            KV.observations(payload.sessionId),
            obsId,
            synthetic,
          );
          if (eventId) {
            await writeEventIdIndexEntry(
              kv,
              payload.sessionId,
              eventId,
              obsId,
              payload.timestamp,
            );
          }
        } catch (error) {
          try {
            await kv.delete(KV.rawEvents(payload.sessionId), obsId);
          } catch (rollbackError) {
            logger.error("Failed to roll back raw event after observation write failure", {
              sessionId: payload.sessionId,
              obsId,
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
          try {
            await kv.delete(KV.observations(payload.sessionId), obsId);
          } catch (rollbackError) {
            logger.error("Failed to roll back derived observation after observation write failure", {
              sessionId: payload.sessionId,
              obsId,
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
          if (eventId) {
            try {
              await kv.delete(KV.eventIds(payload.sessionId), eventId);
            } catch (rollbackError) {
              logger.error("Failed to roll back eventId index after observation write failure", {
                sessionId: payload.sessionId,
                eventId,
                error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              });
            }
          }
          if (raw.imageData) {
            // Roll back the ref taken above. decrementImageRef deletes the file
            // only when no other observation still references it (deduped images
            // survive) and emits the disk-size delta itself — deleting the file
            // directly here would orphan shared images and leave a stale ref.
            // If the rollback itself fails, log it but still surface the
            // original write error (the more useful failure to diagnose).
            try {
              const { decrementImageRef } = await import("./image-refs.js");
              await decrementImageRef(kv, sdk, raw.imageData);
            } catch (rollbackError) {
              logger.error("Failed to roll back image ref after observation write failure", {
                imageRef: raw.imageData,
                error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
              });
            }
          }
          throw error;
        }

        await sdk.trigger({
          function_id: "stream::set",
          payload: {
          stream_name: STREAM.name,
          group_id: STREAM.group(payload.sessionId),
          item_id: obsId,
          data: {
            type: "raw",
            observation: raw,
            ...(eventId ? { eventId } : {}),
          },
          },
        });

        await sdk.trigger({
          function_id: "stream::send",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.viewerGroup,
            id: `raw-${obsId}`,
            type: "raw_observation",
            data: {
              type: "raw",
              observation: raw,
              sessionId: payload.sessionId,
              ...(eventId ? { eventId } : {}),
            },
          },
          action: TriggerAction.Void(),
        });

        // OpenCode / Cursor Cloud (and any host that skips POST /session/start)
        // can fire observations before the session record exists. ensureSession
        // lazy-creates when project + cwd are present; older test payloads
        // without those fields keep the original no-op behaviour.
        const trimmedPrompt =
          typeof raw.userPrompt === "string"
            ? raw.userPrompt.replace(/\s+/g, " ").trim().slice(0, 200)
            : undefined;
        await ensureSession(kv, {
          sessionId: payload.sessionId,
          project: payload.project,
          cwd: payload.cwd,
          agentId: payload.agentId,
          startedAt: payload.timestamp,
          createObservationCount: 1,
          incrementObservationCount: 1,
          lastEventAt: payload.timestamp,
          ...(trimmedPrompt && trimmedPrompt.length > 0
            ? { firstPrompt: trimmedPrompt }
            : {}),
        });

        getSearchIndex().add(synthetic);
        // Queued, not awaited: embedding is a provider round-trip and this runs
        // inside the per-session lock, so awaiting it both blew the hook's 2.5s
        // budget and serialised every later observe for the session behind a
        // third party. The vector index is derived and rebuilt from KV at boot.
        enqueueVectorIndexAdd({
          id: synthetic.id,
          sessionId: synthetic.sessionId,
          text: synthetic.title + " " + (synthetic.narrative || ""),
          kind: "synthetic",
        });
        await sdk.trigger({
          function_id: "stream::set",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.group(payload.sessionId),
            item_id: obsId,
            data: { type: "compressed", observation: synthetic },
          },
        });
        await sdk.trigger({
          function_id: "stream::set",
          payload: {
            stream_name: STREAM.name,
            group_id: STREAM.viewerGroup,
            item_id: obsId,
            data: {
              type: "compressed",
              observation: synthetic,
              sessionId: payload.sessionId,
            },
          },
        });

        if (isAutoCompressEnabled()) {
          await sdk.trigger({
            function_id: "mem::compress",
            payload: {
              observationId: obsId,
              sessionId: payload.sessionId,
            },
            action: TriggerAction.Void(),
          });
        }

        logger.info("Observation captured", {
          obsId,
          sessionId: payload.sessionId,
          hook: payload.hookType,
          compress: isAutoCompressEnabled() ? "llm" : "synthetic",
        });
        return { observationId: obsId };
      });
    },
  );
}
