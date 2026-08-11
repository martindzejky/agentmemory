import { TriggerAction, type ISdk } from "iii-sdk";
import type { RawObservation, HookPayload } from "../types.js";
import { KV, STREAM, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";
import { DedupMap } from "./dedup.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { isAutoCompressEnabled } from "../config.js";
import { buildSyntheticCompression } from "./compress-synthetic.js";
import { getSearchIndex, vectorIndexAddGuarded } from "./search.js";
import { logger } from "../logger.js";
import { saveImageToDisk } from "../utils/image-store.js";
import { ensureSession, resolveCreateAgentId } from "./ensure-session.js";

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
  dedupMap?: DedupMap,
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

      const raw: RawObservation = {
        id: obsId,
        sessionId: payload.sessionId,
        timestamp: payload.timestamp,
        hookType: payload.hookType,
        raw: sanitizedRaw,
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
        }
        if (payload.hookType === "prompt_submit") {
          raw.userPrompt = d["prompt"] as string | undefined;
        }

        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = (raw.toolInput || raw.toolOutput || raw.userPrompt) ? "mixed" : "image";
        }
      } else if (typeof sanitizedRaw === "string") {
        extractedImage = extractImage(sanitizedRaw);
        if (extractedImage) {
          raw.modality = "image";
        }
      }

      const pendingImageData = extractedImage;

      return withKeyedLock(`obs:${payload.sessionId}`, async () => {
        // Inside the existing obs: session lock. record() stays after
        // successful kv.set so a failed write cannot poison the key.
        if (eventId && dedupMap?.isDuplicate(payload.sessionId, eventId)) {
          return {
            deduplicated: true,
            sessionId: payload.sessionId,
            eventId,
          };
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

        try {

          await kv.set(KV.observations(payload.sessionId), obsId, raw);

        } catch (error) {
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

        if (eventId && dedupMap) {
          dedupMap.record(payload.sessionId, eventId);
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
          ...(trimmedPrompt && trimmedPrompt.length > 0
            ? { firstPrompt: trimmedPrompt }
            : {}),
        });

        // Per-observation LLM compression is opt-in as of 0.8.8.
        // Default path: build a zero-LLM synthetic compression so recall
        // and BM25 search still work without burning the user's Claude
        // token allocation on every tool invocation.
        if (isAutoCompressEnabled()) {
          await sdk.trigger({
            function_id: "mem::compress",
            payload: {
              observationId: obsId,
              sessionId: payload.sessionId,
              raw,
            },
            action: TriggerAction.Void(),
          });
        } else {
          const synthetic = buildSyntheticCompression(raw);
          await kv.set(
            KV.observations(payload.sessionId),
            obsId,
            synthetic,
          );
          getSearchIndex().add(synthetic);
          await vectorIndexAddGuarded(
            synthetic.id,
            synthetic.sessionId,
            synthetic.title + " " + (synthetic.narrative || ""),
            { kind: "synthetic", logId: synthetic.id },
          );
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
