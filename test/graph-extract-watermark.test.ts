// The graph-extraction watermark has to advance even when a batch yields
// nothing. Heuristic extraction builds nodes only from obs.files and
// obs.concepts, and synthetic compression leaves concepts empty, so zero results
// is the common case. Upstream's zero-result early return landed above this
// fork's watermark stamp, so the cursor stopped moving and every session stop
// re-extracted the same ever-growing batch — the mechanism that grew the
// production graph to 32K nodes / 61K edges. See
// docs/investigations/2026-08-24-latency-and-oom.md.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerGraphFunction } from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async (
      scope: string,
      key: string,
      updates: Array<{ type?: string; path: string; value: unknown }>,
    ) => {
      if (!store.has(scope)) store.set(scope, new Map());
      const m = store.get(scope)!;
      const v = { ...((m.get(key) as Record<string, unknown>) ?? {}) };
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger: async (
      input: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof input === "string" ? input : input.function_id;
      const payload = typeof input === "string" ? data : input.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

// Nothing extractable: no files, no concepts, and the LLM pass returns an empty
// document. This is what a synthetic observation looks like in practice.
const barrenObs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "file_read",
  title: "Read something",
  facts: [],
  narrative: "Nothing structural here",
  concepts: [],
  files: [],
  importance: 3,
  derivedBy: "synthetic",
};

async function seedSession(kv: ReturnType<typeof mockKV>) {
  const session: Session = {
    id: "ses_1",
    project: "ebox-app",
    cwd: "/home/user/Projects/ebox-app",
    startedAt: "2026-02-01T09:00:00Z",
    updatedAt: "2026-02-01T10:00:00Z",
    observationCount: 1,
    status: "active",
  } as Session;
  await kv.set(KV.sessions, "ses_1", session);
  await kv.set(KV.observations("ses_1"), barrenObs.id, barrenObs);
}

describe("graph-extract watermark", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    delete process.env["GRAPH_EXTRACTION_ENABLED"];
    sdk = mockSdk();
    kv = mockKV();
    await seedSession(kv);
  });

  afterEach(() => {
    delete process.env["GRAPH_EXTRACTION_ENABLED"];
  });

  it("advances on a zero-result extraction so the batch is not re-processed forever", async () => {
    const provider = {
      name: "test",
      compress: vi.fn().mockResolvedValue("<entities></entities>"),
      summarize: vi.fn(),
    };
    registerGraphFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::graph-extract", {
      sessionId: "ses_1",
      observations: [barrenObs],
    })) as { success: boolean; nodesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(0);

    const session = (await kv.get(KV.sessions, "ses_1")) as Record<string, unknown>;
    expect(session["lastGraphExtractedEventId"]).toBe("obs_1");
    expect(session["lastGraphExtractedEventAt"]).toBe("2026-02-01T10:00:00Z");
  });

  it("leaves the cursor alone when the LLM pass failed, so the batch is retried", async () => {
    process.env["GRAPH_EXTRACTION_ENABLED"] = "true";
    const provider = {
      name: "test",
      compress: vi.fn().mockRejectedValue(new Error("provider down")),
      summarize: vi.fn(),
    };
    registerGraphFunction(sdk as never, kv as never, provider as never);

    const result = (await sdk.trigger("mem::graph-extract", {
      sessionId: "ses_1",
      observations: [barrenObs],
    })) as { success: boolean };

    expect(result.success).toBe(false);

    const session = (await kv.get(KV.sessions, "ses_1")) as Record<string, unknown>;
    expect(session["lastGraphExtractedEventId"]).toBeUndefined();
  });
});
