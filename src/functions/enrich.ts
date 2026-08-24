import type { ISdk } from "iii-sdk";
import type { Memory } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { ensureSession } from "./ensure-session.js";
import { logger } from "../logger.js";
import { getEnrichBudgetMs } from "../config.js";
import { recordDeadlineExceeded } from "../utils/deadline.js";
import { timedOp } from "../utils/op-timing.js";

const MAX_CONTEXT_LENGTH = 4000;

// Resolves to the branch's value if it lands inside the budget, otherwise to
// the fallback. The underlying work is not cancellable (there is no cancel in
// the iii protocol), so this bounds the response, not the work. Bounding the
// work itself is what the deadline checks inside search and file-context do.
async function settleWithin<T>(
  promise: Promise<T>,
  budgetMs: number,
  label: string,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      recordDeadlineExceeded(label);
      resolve(fallback);
    }, budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function registerEnrichFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::enrich",
    async (data: {
      sessionId: string;
      files: string[];
      terms?: string[];
      toolName?: string;
      project?: string;
      cwd?: string;
      agentId?: string;
    }) => {
      const project =
        typeof data.project === "string" && data.project.trim().length > 0
          ? data.project.trim()
          : undefined;
      const cwd =
        typeof data.cwd === "string" && data.cwd.trim().length > 0
          ? data.cwd.trim()
          : undefined;

      // Best-effort lazy session create for hosts that skip /session/start.
      // Missing project/cwd is ignored — enrich still returns context.
      if (
        typeof data.sessionId === "string" &&
        data.sessionId.trim().length > 0 &&
        project &&
        cwd
      ) {
        await ensureSession(kv, {
          sessionId: data.sessionId.trim(),
          project,
          cwd,
          agentId: data.agentId,
          createObservationCount: 0,
        });
      }

      const parts: string[] = [];

      const fileContextPromise = timedOp("enrich.file-context", () =>
        sdk
          .trigger<{ sessionId: string; files: string[] }, { context: string }>({
            function_id: "mem::file-context",
            payload: {
              sessionId: data.sessionId,
              files: data.files,
            },
          })
          .catch(() => ({ context: "" })),
      );

      const searchQueries: string[] = [
        ...data.files.map((f) => f.split("/").pop() || f),
        ...(data.terms || []),
      ].filter((q) => q.length > 0);

      const searchPromise =
        searchQueries.length > 0
          ? timedOp("enrich.search", () =>
              sdk
                .trigger<
                  { query: string; limit: number; project?: string },
                  { results: Array<{ observation: { narrative: string } }> }
                >({
                  function_id: "mem::search",
                  payload: {
                    query: searchQueries.join(" "),
                    limit: 5,
                    ...(project !== undefined && { project }),
                  },
                })
                .catch(() => ({ results: [] })),
            )
          : Promise.resolve({ results: [] });

      const bugMemoriesPromise = kv
        .list<Memory>(KV.memories)
        .then((memories) =>
          memories
            .filter(
              (m) =>
                m.type === "bug" &&
                m.isLatest &&
                // Guard only when both sides have an explicit project; unscoped memories pass through.
                (!project || !m.project || m.project === project) &&
                m.files.some((f) =>
                  data.files.some((df) => f.includes(df) || df.includes(f)),
                ),
            )
            .sort(
              (a, b) =>
                new Date(b.updatedAt || b.createdAt).getTime() -
                new Date(a.updatedAt || a.createdAt).getTime(),
            ),
        )
        .catch(() => []);

      // Enrich sits on a hook's critical path with a 2.5s client abort, and the
      // server never learns about that abort (iii's HTTP request carries no
      // signal). Without a budget a slow branch keeps working for a caller that
      // already left, which is what turned hook bursts into an OOM. Whatever
      // finished in time is used; the rest is dropped. Enrich is best-effort
      // context, so partial context beats a timed-out request.
      const budgetMs = getEnrichBudgetMs();
      const [fileContext, searchResult, bugMemories] = await Promise.all([
        settleWithin(fileContextPromise, budgetMs, "enrich.file-context", {
          context: "",
        }),
        settleWithin(searchPromise, budgetMs, "enrich.search", { results: [] }),
        settleWithin(bugMemoriesPromise, budgetMs, "enrich.bug-memories", []),
      ]);

      if (fileContext.context) {
        parts.push(fileContext.context);
      }

      if (searchResult.results.length > 0) {
        const observations = searchResult.results
          .map((r) => r.observation?.narrative)
          .filter(Boolean)
          .map((n) => escapeXml(n as string))
          .join("\n");
        if (observations) {
          parts.push(
            `<agentmemory-relevant-context>\n${observations}\n</agentmemory-relevant-context>`,
          );
        }
      }

      if (bugMemories.length > 0) {
        const bugs = bugMemories
          .slice(0, 3)
          .map((m) => `- ${escapeXml(m.title)}: ${escapeXml(m.content)}`)
          .join("\n");
        parts.push(
          `<agentmemory-past-errors>\n${bugs}\n</agentmemory-past-errors>`,
        );
      }

      let context = parts.join("\n\n");
      let truncated = false;
      if (context.length > MAX_CONTEXT_LENGTH) {
        context = context.slice(0, MAX_CONTEXT_LENGTH);
        truncated = true;
      }

      logger.info("Enrichment completed", {
        sessionId: data.sessionId,
        project,
        fileCount: data.files.length,
        contextLength: context.length,
        truncated,
      });

      return { context, truncated };
    },
  );
}
