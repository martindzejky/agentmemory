import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DedupMap } from "../src/functions/dedup.js";
import type { CompressedObservation } from "../src/types.js";

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
      const v = (m.get(key) as Record<string, unknown>) ?? {};
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  const triggered: Array<{ id: string; payload: unknown }> = [];
  return {
    fns,
    triggered,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      triggered.push({ id, payload });
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "ses_lift",
    project: "/workspace",
    cwd: "/workspace",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("mem::observe lifted event types", () => {
  let dedupMap: DedupMap;

  beforeEach(() => {
    vi.resetModules();
    dedupMap = new DedupMap();
  });

  afterEach(() => {
    dedupMap.stop();
  });

  it("compresses assistant_response into a conversation row with readable title", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, dedupMap);

    const result = (await sdk.trigger(
      "mem::observe",
      basePayload({
        hookType: "assistant_response",
        data: {
          assistantResponse: "I fixed the null check in observe.ts.",
        },
      }),
    )) as { observationId: string };

    const stored = await kv.get<CompressedObservation>(
      "mem:obs:ses_lift",
      result.observationId,
    );
    expect(stored?.type).toBe("conversation");
    expect(stored?.title).toBe("Assistant response");
    expect(stored?.narrative).toContain("I fixed the null check in observe.ts.");
  });

  it("compresses subagent_start into a subagent row with type and task", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, dedupMap);

    const result = (await sdk.trigger(
      "mem::observe",
      basePayload({
        hookType: "subagent_start",
        data: {
          subagent_id: "sa_1",
          subagent_type: "explore",
          task: "Find where HookType is defined",
        },
      }),
    )) as { observationId: string };

    const stored = await kv.get<CompressedObservation>(
      "mem:obs:ses_lift",
      result.observationId,
    );
    expect(stored?.type).toBe("subagent");
    expect(stored?.title.toLowerCase()).toContain("explore");
    expect(stored?.narrative).toContain("id=sa_1");
    expect(stored?.narrative).toContain("explore");
    expect(stored?.narrative).toContain("Find where HookType is defined");
  });

  it("compresses subagent_stop into a subagent row with status and summary", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, dedupMap);

    const result = (await sdk.trigger(
      "mem::observe",
      basePayload({
        hookType: "subagent_stop",
        data: {
          subagent_id: "sa_1",
          subagent_type: "explore",
          status: "completed",
          summary: "Located HookType in src/types.ts",
        },
      }),
    )) as { observationId: string };

    const stored = await kv.get<CompressedObservation>(
      "mem:obs:ses_lift",
      result.observationId,
    );
    expect(stored?.type).toBe("subagent");
    expect(stored?.narrative).toContain("id=sa_1");
    expect(stored?.narrative).toContain("completed");
    expect(stored?.narrative).toContain("Located HookType in src/types.ts");
  });

  it("keeps existing prompt_submit and tool lifts unchanged", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, dedupMap);

    const prompt = (await sdk.trigger(
      "mem::observe",
      basePayload({
        hookType: "prompt_submit",
        data: { prompt: "please explain the lift rules" },
      }),
    )) as { observationId: string };
    const tool = (await sdk.trigger(
      "mem::observe",
      basePayload({
        hookType: "post_tool_use",
        data: {
          tool_name: "Read",
          tool_input: { file_path: "/workspace/src/types.ts" },
          tool_output: "export type HookType = ...",
        },
      }),
    )) as { observationId: string };
    const fail = (await sdk.trigger(
      "mem::observe",
      basePayload({
        hookType: "post_tool_failure",
        data: {
          tool_name: "Bash",
          tool_input: { command: "false" },
          error: "exit 1",
        },
      }),
    )) as { observationId: string };

    const promptRow = await kv.get<CompressedObservation>(
      "mem:obs:ses_lift",
      prompt.observationId,
    );
    const toolRow = await kv.get<CompressedObservation>(
      "mem:obs:ses_lift",
      tool.observationId,
    );
    const failRow = await kv.get<CompressedObservation>(
      "mem:obs:ses_lift",
      fail.observationId,
    );

    expect(promptRow?.type).toBe("conversation");
    expect(promptRow?.narrative).toContain("please explain the lift rules");
    expect(toolRow?.type).toBe("file_read");
    expect(toolRow?.title).toBe("Read");
    expect(toolRow?.narrative).toContain("/workspace/src/types.ts");
    expect(failRow?.type).toBe("error");
    expect(failRow?.narrative).toContain("exit 1");
  });

  it("stores hookTypes with no lifting rule without throwing", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never, dedupMap);

    const result = (await sdk.trigger(
      "mem::observe",
      basePayload({
        hookType: "pre_compact",
        data: { reason: "context_limit", opaque: true },
      }),
    )) as { observationId: string; success?: boolean };

    expect(result.observationId).toBeTruthy();
    const stored = await kv.get<CompressedObservation>(
      "mem:obs:ses_lift",
      result.observationId,
    );
    expect(stored).toBeTruthy();
    expect(stored?.title).toBe("pre_compact");
  });
});
