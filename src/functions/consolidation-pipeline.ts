import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type {
  SemanticMemory,
  ProceduralMemory,
  SessionSummary,
  Memory,
  MemoryProvider,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import {
  SEMANTIC_MERGE_SYSTEM,
  buildSemanticMergePrompt,
  PROCEDURAL_EXTRACTION_SYSTEM,
  buildProceduralExtractionPrompt,
} from "../prompts/consolidation.js";
import { recordAudit } from "./audit.js";
import { getConsolidationDecayDays, isConsolidationEnabled } from "../config.js";
import { logger } from "../logger.js";

const CORPUS_FINGERPRINT_KEY = "consolidation:corpusFingerprint";

type CorpusFingerprint = { hash: string; at: string; reflected?: boolean };

function corpusFingerprint(
  episodes: Array<{ title: string; narrative: string; concepts: string[] }>,
): string {
  const payload = episodes
    .map((e) => `${e.title}\n${e.narrative}\n${(e.concepts ?? []).join("\0")}`)
    .join("\n---\n");
  return createHash("sha256").update(payload).digest("hex");
}

function applyDecay<
  T extends {
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
  },
>(items: T[], decayDays: number, nowMs: number, nowIso: string): T[] {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return [];
  const dirty: T[] = [];
  for (const item of items) {
    const accessedMs = item.lastAccessedAt
      ? new Date(item.lastAccessedAt).getTime()
      : Number.NEGATIVE_INFINITY;
    const updatedMs = new Date(item.updatedAt).getTime();
    const lastTouchMs = Math.max(accessedMs, updatedMs);
    const daysSince = (nowMs - lastTouchMs) / (1000 * 60 * 60 * 24);
    if (daysSince > decayDays) {
      const decayPeriods = Math.floor(daysSince / decayDays);
      const next = Math.max(
        0.1,
        item.strength * Math.pow(0.9, decayPeriods),
      );
      if (next !== item.strength) {
        item.strength = next;
        item.updatedAt = nowIso;
        dirty.push(item);
      }
    }
  }
  return dirty;
}

export function registerConsolidationPipelineFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::consolidate-pipeline", 
    async (data?: { tier?: string; force?: boolean; project?: string }) => {
      if (!data?.force && !isConsolidationEnabled()) {
        return { success: false, skipped: true, reason: "Consolidation disabled: set CONSOLIDATION_ENABLED=true or configure an LLM provider (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / MINIMAX_API_KEY / OPENAI_BASE_URL / AGENTMEMORY_PROVIDER=agent-sdk)" };
      }
      const tier = data?.tier || "all";
      const decayDays = getConsolidationDecayDays();
      const results: Record<string, unknown> = {};
      let skipCorpusLlm = false;
      let skipReflect = false;
      let corpusHash: string | undefined;
      let pendingCorpusFingerprint: CorpusFingerprint | null = null;

      if (tier === "all" || tier === "semantic") {
        const summaries = await kv.list<SessionSummary>(KV.summaries);

        if (summaries.length >= 5) {
          const recentSummaries = summaries
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )
            .slice(0, 20);

          const episodes = recentSummaries.map((s) => ({
            title: s.title,
            narrative: s.narrative,
            concepts: s.concepts ?? [],
          }));
          const fingerprint = corpusFingerprint(episodes);
          corpusHash = fingerprint;
          const stored = await kv
            .get<CorpusFingerprint>(KV.config, CORPUS_FINGERPRINT_KEY)
            .catch(() => null);
          if (stored?.hash === fingerprint) {
            skipCorpusLlm = true;
            skipReflect = stored.reflected === true;
            results.semantic = {
              skipped: true,
              reason: "unchanged_corpus",
              totalSummaries: summaries.length,
            };
          } else {
            const existingSemantic = await kv.list<SemanticMemory>(KV.semantic);
            const prompt = buildSemanticMergePrompt(episodes);

            try {
              const response = await provider.summarize(
                SEMANTIC_MERGE_SYSTEM,
                prompt,
              );

              const factRegex = /<fact\s+confidence="([^"]+)">([^<]+)<\/fact>/g;
              let match;
              let newFacts = 0;
              const now = new Date().toISOString();

              while ((match = factRegex.exec(response)) !== null) {
                const parsedConf = parseFloat(match[1]);
                const confidence = Number.isNaN(parsedConf) ? 0.5 : parsedConf;
                const fact = match[2].trim();

                const existing = existingSemantic.find(
                  (s) => s.fact.toLowerCase() === fact.toLowerCase(),
                );
                if (existing) {
                  existing.accessCount++;
                  existing.lastAccessedAt = now;
                  existing.updatedAt = now;
                  existing.confidence = Math.max(existing.confidence, confidence);
                  await kv.set(KV.semantic, existing.id, existing);
                } else {
                  const sem: SemanticMemory = {
                    id: generateId("sem"),
                    fact,
                    confidence,
                    sourceSessionIds: recentSummaries.map((s) => s.sessionId),
                    sourceMemoryIds: [],
                    accessCount: 1,
                    lastAccessedAt: now,
                    strength: confidence,
                    createdAt: now,
                    updatedAt: now,
                  };
                  await kv.set(KV.semantic, sem.id, sem);
                  newFacts++;
                }
              }
              pendingCorpusFingerprint = { hash: fingerprint, at: now };
              results.semantic = { newFacts, totalSummaries: summaries.length };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error("Semantic consolidation failed", { error: msg });
              results.semantic = { error: msg };
            }
          }
        } else {
          results.semantic = {
            skipped: true,
            reason: "fewer than 5 summaries",
          };
        }
      }

      if (tier === "all" || tier === "reflect") {
        if (skipReflect) {
          results.reflect = {
            skipped: true,
            reason: "unchanged_corpus",
          };
        } else {
          try {
            const reflectResult = await sdk.trigger({ function_id: "mem::reflect", payload: {
              maxClusters: 10,
              project: data?.project,
            } });
            results.reflect = reflectResult;
            if (corpusHash) {
              pendingCorpusFingerprint = {
                hash: corpusHash,
                at: pendingCorpusFingerprint?.at ?? new Date().toISOString(),
                reflected: true,
              };
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("Reflect tier failed", { error: msg });
            results.reflect = { error: msg };
            pendingCorpusFingerprint = null;
          }
        }
      }

      if (pendingCorpusFingerprint) {
        await kv
          .set(KV.config, CORPUS_FINGERPRINT_KEY, pendingCorpusFingerprint)
          .catch((err) => {
            logger.warn("Failed to stamp consolidation corpus fingerprint", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      if (tier === "all" || tier === "procedural") {
        const memories = await kv.list<Memory>(KV.memories);
        const patterns = memories
          .filter((m) => m.isLatest && m.type === "pattern")
          .map((m) => ({
            content: m.content,
            frequency: m.sessionIds.length || 1,
          }))
          .filter((p) => p.frequency >= 2);

        if (patterns.length >= 2) {
          const prompt = buildProceduralExtractionPrompt(patterns);

          try {
            const response = await provider.summarize(
              PROCEDURAL_EXTRACTION_SYSTEM,
              prompt,
            );

            const procRegex =
              /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
            let match;
            let newProcs = 0;
            const now = new Date().toISOString();
            const existingProcs = await kv.list<ProceduralMemory>(
              KV.procedural,
            );

            while ((match = procRegex.exec(response)) !== null) {
              const name = match[1];
              const trigger = match[2];
              const stepsBlock = match[3];
              const steps: string[] = [];

              const stepRegex = /<step>([^<]+)<\/step>/g;
              let stepMatch;
              while ((stepMatch = stepRegex.exec(stepsBlock)) !== null) {
                steps.push(stepMatch[1].trim());
              }

              const existing = existingProcs.find(
                (p) => p.name.toLowerCase() === name.toLowerCase(),
              );
              if (existing) {
                existing.frequency++;
                existing.updatedAt = now;
                existing.strength = Math.min(1, existing.strength + 0.1);
                await kv.set(KV.procedural, existing.id, existing);
              } else {
                const proc: ProceduralMemory = {
                  id: generateId("proc"),
                  name,
                  steps,
                  triggerCondition: trigger,
                  frequency: 1,
                  sourceSessionIds: [],
                  strength: 0.5,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.procedural, proc.id, proc);
                newProcs++;
              }
            }
            results.procedural = {
              newProcedures: newProcs,
              patternsAnalyzed: patterns.length,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Procedural extraction failed", { error: msg });
            results.procedural = { error: msg };
          }
        } else {
          results.procedural = {
            skipped: true,
            reason: "fewer than 2 recurring patterns",
          };
        }
      }

      if (tier === "all" || tier === "decay") {
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const semantic = await kv.list<SemanticMemory>(KV.semantic);
        const dirtySemantic = applyDecay(semantic, decayDays, nowMs, nowIso);
        for (const s of dirtySemantic) {
          await kv.set(KV.semantic, s.id, s);
        }

        const procedural = await kv.list<ProceduralMemory>(KV.procedural);
        const dirtyProcedural = applyDecay(procedural, decayDays, nowMs, nowIso);
        for (const p of dirtyProcedural) {
          await kv.set(KV.procedural, p.id, p);
        }

        results.decay = {
          semantic: {
            scanned: semantic.length,
            written: dirtySemantic.length,
          },
          procedural: {
            scanned: procedural.length,
            written: dirtyProcedural.length,
          },
        };
      }

      if (process.env["OBSIDIAN_AUTO_EXPORT"] === "true") {
        try {
          await sdk.trigger({ function_id: "mem::obsidian-export", payload: {} });
          results.obsidianExport = { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Obsidian auto-export failed", { error: msg });
          results.obsidianExport = { success: false, error: msg };
        }
      }

      await recordAudit(kv, "consolidate", "mem::consolidate-pipeline", [], {
        tier,
        results,
      });

      logger.info("Consolidation pipeline complete", { tier, results });
      return { success: true, results };
    },
  );
}
