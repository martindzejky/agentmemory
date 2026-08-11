import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/schema.js", () => ({
  KV: {
    sessions: "sessions",
    summaries: "summaries",
    observations: (sessionId: string) => `obs:${sessionId}`,
    audit: "audit",
  },
}));

vi.mock("../src/eval/schemas.js", () => ({
  SummaryOutputSchema: {},
}));

vi.mock("../src/eval/validator.js", () => ({
  validateOutput: () => ({ valid: true, result: { errors: [] } }),
}));

vi.mock("../src/eval/quality.js", () => ({
  scoreSummary: () => 100,
}));

vi.mock("../src/functions/audit.js", () => ({
  safeAudit: vi.fn(),
}));

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  getSummaryRebuildInterval: vi.fn(() => 10),
}));

import { registerSummarizeFunction } from "../src/functions/summarize.js";
import { getSummaryRebuildInterval } from "../src/config.js";
import type {
  CompressedObservation,
  Session,
  SessionSummary,
  MemoryProvider,
} from "../src/types.js";

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
      updates: Array<{ path: string; value: unknown }>,
    ) => {
      const m = store.get(scope);
      if (!m) return;
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
    functions,
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async () => ({}),
  };
}

function makeObs(
  idx: number,
  sessionId: string,
  timestamp: string,
): CompressedObservation {
  return {
    id: `obs_${idx}`,
    sessionId,
    timestamp,
    type: "conversation",
    title: `obs ${idx}`,
    facts: [`fact ${idx}`],
    narrative: `narrative ${idx}`,
    concepts: [],
    files: [],
    importance: 5,
  };
}

function summaryXml(title: string): string {
  return `<summary>
<title>${title}</title>
<narrative>n</narrative>
<decisions><decision>d</decision></decisions>
<files><file>src/a.ts</file></files>
<concepts><concept>c</concept></concepts>
</summary>`;
}

function makeProvider(responses: string[]): MemoryProvider & {
  calls: Array<{ system: string; user: string }>;
} {
  const calls: Array<{ system: string; user: string }> = [];
  let i = 0;
  return {
    name: "test",
    calls,
    compress: async () => "",
    summarize: async (system: string, user: string) => {
      calls.push({ system, user });
      const r = responses[i] ?? responses[responses.length - 1];
      i += 1;
      return r;
    },
  };
}

describe("mem::summarize watermarks", () => {
  const sessionId = "ses_wm";

  beforeEach(() => {
    vi.mocked(getSummaryRebuildInterval).mockReturnValue(10);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function setup(opts: {
    observations: CompressedObservation[];
    session?: Partial<Session>;
    storedSummary?: SessionSummary;
    provider: MemoryProvider;
  }) {
    const sdk = mockSdk();
    const kv = mockKV();
    const session: Session = {
      id: sessionId,
      project: "test",
      cwd: "/tmp",
      startedAt: "2026-01-01T08:00:00.000Z",
      status: "active",
      observationCount: opts.observations.length,
      ...opts.session,
    };
    await kv.set("sessions", sessionId, session);
    for (const obs of opts.observations) {
      await kv.set(`obs:${sessionId}`, obs.id, obs);
    }
    if (opts.storedSummary) {
      await kv.set("summaries", sessionId, opts.storedSummary);
    }
    registerSummarizeFunction(sdk as never, kv as never, opts.provider);
    const handler = sdk.functions.get("mem::summarize")!;
    return { handler, kv };
  }

  it("returns nothing_new without calling the LLM when already summarized", async () => {
    const provider = makeProvider([summaryXml("unused")]);
    const { handler } = await setup({
      observations: [
        makeObs(1, sessionId, "2026-01-01T10:00:00.000Z"),
      ],
      session: {
        lastSummarizedEventAt: "2026-01-01T10:00:00.000Z",
        lastSummarizedEventId: "obs_1",
        summarizedObservationCount: 1,
        summaryRevision: 1,
      },
      storedSummary: {
        sessionId,
        project: "test",
        createdAt: "2026-01-01T10:05:00.000Z",
        title: "existing",
        narrative: "n",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        observationCount: 1,
      },
      provider,
    });

    const result: any = await handler({ sessionId });

    expect(result).toMatchObject({ success: true, skipped: true, reason: "nothing_new" });
    expect(provider.calls).toHaveLength(0);
  });

  it("uses the full path on first summary and stamps the watermark", async () => {
    const provider = makeProvider([summaryXml("first")]);
    const { handler, kv } = await setup({
      observations: [
        makeObs(1, sessionId, "2026-01-01T10:00:00.000Z"),
        makeObs(2, sessionId, "2026-01-01T11:00:00.000Z"),
      ],
      provider,
    });

    const result: any = await handler({ sessionId });

    expect(result.success).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.user).toContain("Session observations (2 total)");
    const session = (await kv.get("sessions", sessionId)) as Session;
    expect(session.lastSummarizedEventId).toBe("obs_2");
    expect(session.summarizedObservationCount).toBe(2);
    expect(session.summaryRevision).toBe(1);
  });

  it("merges only new observations on a second run", async () => {
    const provider = makeProvider([
      summaryXml("partial"),
      summaryXml("merged"),
    ]);
    const { handler, kv } = await setup({
      observations: [
        makeObs(1, sessionId, "2026-01-01T10:00:00.000Z"),
        makeObs(2, sessionId, "2026-01-01T11:00:00.000Z"),
      ],
      session: {
        lastSummarizedEventAt: "2026-01-01T10:00:00.000Z",
        lastSummarizedEventId: "obs_1",
        summarizedObservationCount: 1,
        summaryRevision: 1,
      },
      storedSummary: {
        sessionId,
        project: "test",
        createdAt: "2026-01-01T10:05:00.000Z",
        title: "stored",
        narrative: "stored narrative",
        keyDecisions: ["d1"],
        filesModified: ["src/old.ts"],
        concepts: ["c1"],
        observationCount: 1,
      },
      provider,
    });

    const result: any = await handler({ sessionId });

    expect(result.success).toBe(true);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.user).toContain("Session observations (1 total)");
    expect(provider.calls[1]?.system).toContain("merging");
    const stored = (await kv.get("summaries", sessionId)) as SessionSummary;
    expect(stored.observationCount).toBe(2);
    expect(stored.createdAt).toBe("2026-01-01T10:05:00.000Z");
    const session = (await kv.get("sessions", sessionId)) as Session;
    expect(session.lastSummarizedEventId).toBe("obs_2");
    expect(session.summaryRevision).toBe(2);
  });

  it("does not advance the watermark on failure", async () => {
    const provider = makeProvider(["garbage", "garbage"]);
    const { handler, kv } = await setup({
      observations: [makeObs(1, sessionId, "2026-01-01T10:00:00.000Z")],
      provider,
    });

    const result: any = await handler({ sessionId });

    expect(result.success).toBe(false);
    const session = (await kv.get("sessions", sessionId)) as Session;
    expect(session.lastSummarizedEventId).toBeUndefined();
    expect(session.summaryRevision).toBeUndefined();
  });

  it("forces a full rebuild when summaryRevision reaches the interval", async () => {
    vi.mocked(getSummaryRebuildInterval).mockReturnValue(2);
    const provider = makeProvider([summaryXml("full rebuild")]);
    const { handler, kv } = await setup({
      observations: [
        makeObs(1, sessionId, "2026-01-01T10:00:00.000Z"),
        makeObs(2, sessionId, "2026-01-01T11:00:00.000Z"),
      ],
      session: {
        lastSummarizedEventAt: "2026-01-01T11:00:00.000Z",
        lastSummarizedEventId: "obs_2",
        summarizedObservationCount: 2,
        summaryRevision: 2,
      },
      storedSummary: {
        sessionId,
        project: "test",
        createdAt: "2026-01-01T10:05:00.000Z",
        title: "stored",
        narrative: "n",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        observationCount: 2,
      },
      provider,
    });

    const result: any = await handler({ sessionId });

    expect(result.success).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.user).toContain("Session observations (2 total)");
    const session = (await kv.get("sessions", sessionId)) as Session;
    expect(session.summaryRevision).toBe(3);
  });
});
