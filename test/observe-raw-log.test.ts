import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  CompressedObservation,
  RawObservation,
  Session,
} from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

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
  return {
    fns,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      if (
        typeof idOrInput === "object" &&
        idOrInput.action !== undefined &&
        idOrInput.action !== null
      ) {
        return null;
      }
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

function observePayload(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "ses_raw",
    project: "/workspace",
    cwd: "/workspace",
    hookType: "post_tool_use",
    timestamp: new Date().toISOString(),
    data: {
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
      tool_output: "full tool output preserved in raw log",
    },
    ...overrides,
  };
}

async function registerObserveAndCompress(
  sdk: ReturnType<typeof mockSdk>,
  kv: ReturnType<typeof mockKV>,
  compressResponse = "<response><type>file_read</type><title>Read</title><facts></facts><narrative>LLM compressed</narrative><concepts></concepts><files></files><importance>8</importance></response>",
) {
  const { registerObserveFunction } = await import(
    "../src/functions/observe.js"
  );
  const { registerCompressFunction } = await import(
    "../src/functions/compress.js"
  );
  registerObserveFunction(sdk as never, kv as never);
  registerCompressFunction(sdk as never, kv as never, {
    name: "test",
    summarize: vi.fn(async () => compressResponse),
    compress: vi.fn(async () => compressResponse),
  } as never);
}

describe("mem::observe raw event log", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  });

  it("stores raw and derived rows separately with synthetic compression", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await registerObserveAndCompress(sdk, kv);

    const result = (await sdk.trigger(
      "mem::observe",
      observePayload(),
    )) as { observationId: string };

    const raw = await kv.get<RawObservation>(
      "mem:raw:ses_raw",
      result.observationId,
    );
    const derived = await kv.get<CompressedObservation>(
      "mem:obs:ses_raw",
      result.observationId,
    );

    expect(raw?.toolOutput).toBe("full tool output preserved in raw log");
    expect(raw?.hookType).toBe("post_tool_use");
    expect(derived?.title).toBe("Read");
    expect(derived?.confidence).toBe(0.3);
  });

  it("keeps raw readable after derived row is written with auto-compress", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    const sdk = mockSdk();
    const kv = mockKV();
    await registerObserveAndCompress(sdk, kv);

    const result = (await sdk.trigger(
      "mem::observe",
      observePayload(),
    )) as { observationId: string };

    const raw = await kv.get<RawObservation>(
      "mem:raw:ses_raw",
      result.observationId,
    );
    const derived = await kv.get<CompressedObservation>(
      "mem:obs:ses_raw",
      result.observationId,
    );

    expect(raw?.toolOutput).toBe("full tool output preserved in raw log");
    expect(derived?.title).toBe("Read");
    expect(derived?.confidence).toBe(0.3);

    await sdk.trigger({
      function_id: "mem::compress",
      payload: {
        observationId: result.observationId,
        sessionId: "ses_raw",
      },
    });

    const rawAfter = await kv.get<RawObservation>(
      "mem:raw:ses_raw",
      result.observationId,
    );
    const upgraded = await kv.get<CompressedObservation>(
      "mem:obs:ses_raw",
      result.observationId,
    );
    expect(rawAfter?.toolOutput).toBe("full tool output preserved in raw log");
    expect(upgraded?.narrative).toBe("LLM compressed");
  });

  it("compress loads raw from KV.rawEvents without payload fallback", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await registerObserveAndCompress(sdk, kv);

    const result = (await sdk.trigger(
      "mem::observe",
      observePayload(),
    )) as { observationId: string };

    const compressResult = (await sdk.trigger({
      function_id: "mem::compress",
      payload: {
        observationId: result.observationId,
        sessionId: "ses_raw",
      },
    })) as { success: boolean; compressed?: CompressedObservation };

    expect(compressResult.success).toBe(true);
    expect(compressResult.compressed?.narrative).toBe("LLM compressed");
  });

  it("compress returns raw_not_found when neither KV nor payload raw is available", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await registerObserveAndCompress(sdk, kv);

    const compressResult = (await sdk.trigger({
      function_id: "mem::compress",
      payload: {
        observationId: "obs_missing",
        sessionId: "ses_raw",
      },
    })) as { success: boolean; error?: string };

    expect(compressResult).toEqual({
      success: false,
      error: "raw_not_found",
    });
  });

  it("compress falls back to payload raw when KV.rawEvents miss", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    await registerObserveAndCompress(sdk, kv);

    const fallbackRaw: RawObservation = {
      id: "obs_fallback",
      sessionId: "ses_raw",
      timestamp: "2026-01-01T10:00:00.000Z",
      hookType: "post_tool_use",
      toolName: "Read",
      toolInput: { file_path: "src/fallback.ts" },
      toolOutput: "fallback output",
      raw: {},
    };

    const compressResult = (await sdk.trigger({
      function_id: "mem::compress",
      payload: {
        observationId: "obs_fallback",
        sessionId: "ses_raw",
        raw: fallbackRaw,
      },
    })) as { success: boolean; compressed?: CompressedObservation };

    expect(compressResult.success).toBe(true);
    expect(compressResult.compressed?.narrative).toBe("LLM compressed");
  });

  it("leaves synthetic derived row and raw event intact when compression fails", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    const sdk = mockSdk();
    const kv = mockKV();
    await registerObserveAndCompress(sdk, kv, "not valid xml");

    const result = (await sdk.trigger(
      "mem::observe",
      observePayload(),
    )) as { observationId: string };

    const compressResult = (await sdk.trigger({
      function_id: "mem::compress",
      payload: {
        observationId: result.observationId,
        sessionId: "ses_raw",
      },
    })) as { success: boolean; error?: string };

    expect(compressResult.success).toBe(false);
    expect(compressResult.error).toBe("parse_failed");

    const raw = await kv.get<RawObservation>(
      "mem:raw:ses_raw",
      result.observationId,
    );
    const derived = await kv.get<CompressedObservation>(
      "mem:obs:ses_raw",
      result.observationId,
    );
    expect(raw?.toolOutput).toBe("full tool output preserved in raw log");
    expect(derived?.title).toBe("Read");
    expect(derived?.confidence).toBe(0.3);
  });

  it("rolls back raw row when derived write fails", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const store = new Map<string, Map<string, unknown>>();
    const kv = {
      store,
      get: async <T>(scope: string, key: string): Promise<T | null> =>
        (store.get(scope)?.get(key) as T) ?? null,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope.startsWith("mem:obs:")) {
          throw new Error("derived write failed");
        }
        if (!store.has(scope)) store.set(scope, new Map());
        store.get(scope)!.set(key, data);
        return data;
      },
      delete: async (scope: string, key: string) => {
        store.get(scope)?.delete(key);
      },
      list: async <T>(scope: string): Promise<T[]> => {
        const m = store.get(scope);
        return m ? (Array.from(m.values()) as T[]) : [];
      },
    };
    registerObserveFunction(sdk as never, kv as never);

    await expect(
      sdk.trigger("mem::observe", observePayload()),
    ).rejects.toThrow("derived write failed");

    expect(store.get("mem:raw:ses_raw")?.size ?? 0).toBe(0);
    expect(store.get("mem:obs:ses_raw")?.size ?? 0).toBe(0);
  });

  it("rolls back raw and derived when eventId index write fails", async () => {
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const sdk = mockSdk();
    const store = new Map<string, Map<string, unknown>>();
    const kv = {
      store,
      get: async <T>(scope: string, key: string): Promise<T | null> =>
        (store.get(scope)?.get(key) as T) ?? null,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope.startsWith("mem:evt:")) {
          throw new Error("eventId index write failed");
        }
        if (!store.has(scope)) store.set(scope, new Map());
        store.get(scope)!.set(key, data);
        return data;
      },
      delete: async (scope: string, key: string) => {
        store.get(scope)?.delete(key);
      },
      list: async <T>(scope: string): Promise<T[]> => {
        const m = store.get(scope);
        return m ? (Array.from(m.values()) as T[]) : [];
      },
    };
    registerObserveFunction(sdk as never, kv as never);

    await expect(
      sdk.trigger(
        "mem::observe",
        observePayload({ eventId: "evt_index_fail" }),
      ),
    ).rejects.toThrow("eventId index write failed");

    expect(store.get("mem:raw:ses_raw")?.size ?? 0).toBe(0);
    expect(store.get("mem:obs:ses_raw")?.size ?? 0).toBe(0);
    expect(store.get("mem:evt:ses_raw")?.size ?? 0).toBe(0);
  });
});

describe("raw event deletion", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("mem::forget removes raw and derived rows by observation id", async () => {
    const { registerRememberFunction } = await import(
      "../src/functions/remember.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    await kv.set("mem:raw:ses_raw", "obs_1", {
      id: "obs_1",
      sessionId: "ses_raw",
      hookType: "post_tool_use",
    });
    await kv.set("mem:obs:ses_raw", "obs_1", {
      id: "obs_1",
      sessionId: "ses_raw",
      title: "Read",
      type: "file_read",
    });

    await sdk.trigger({
      function_id: "mem::forget",
      payload: { sessionId: "ses_raw", observationIds: ["obs_1"] },
    });

    expect(await kv.get("mem:raw:ses_raw", "obs_1")).toBeNull();
    expect(await kv.get("mem:obs:ses_raw", "obs_1")).toBeNull();
  });

  it("mem::forget session removes all raw and derived rows", async () => {
    const { registerRememberFunction } = await import(
      "../src/functions/remember.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_raw", { id: "ses_raw" });
    await kv.set("mem:summaries", "ses_raw", { sessionId: "ses_raw" });
    await kv.set("mem:raw:ses_raw", "obs_a", { id: "obs_a" });
    await kv.set("mem:obs:ses_raw", "obs_a", { id: "obs_a", title: "a" });
    await kv.set("mem:raw:ses_raw", "obs_b", { id: "obs_b" });
    await kv.set("mem:obs:ses_raw", "obs_b", { id: "obs_b", title: "b" });

    await sdk.trigger({
      function_id: "mem::forget",
      payload: { sessionId: "ses_raw" },
    });

    expect(await kv.list("mem:raw:ses_raw")).toHaveLength(0);
    expect(await kv.list("mem:obs:ses_raw")).toHaveLength(0);
  });

  it("mem::forget session removes orphan raw-only rows", async () => {
    const { registerRememberFunction } = await import(
      "../src/functions/remember.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_raw", { id: "ses_raw" });
    await kv.set("mem:summaries", "ses_raw", { sessionId: "ses_raw" });
    await kv.set("mem:raw:ses_raw", "obs_orphan", {
      id: "obs_orphan",
      sessionId: "ses_raw",
      hookType: "prompt_submit",
      userPrompt: "orphan raw only",
    });

    await sdk.trigger({
      function_id: "mem::forget",
      payload: { sessionId: "ses_raw" },
    });

    expect(await kv.get("mem:raw:ses_raw", "obs_orphan")).toBeNull();
    expect(await kv.list("mem:obs:ses_raw")).toHaveLength(0);
  });

  it("mem::auto-forget removes raw and derived low-value observations", async () => {
    const { registerAutoForgetFunction } = await import(
      "../src/functions/auto-forget.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerAutoForgetFunction(sdk as never, kv as never);

    const oldTs = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const session: Session = {
      id: "ses_old",
      project: "p",
      cwd: "/tmp",
      startedAt: oldTs,
      status: "completed",
      observationCount: 1,
    };
    await kv.set("mem:sessions", "ses_old", session);
    await kv.set("mem:raw:ses_old", "obs_old", {
      id: "obs_old",
      sessionId: "ses_old",
      timestamp: oldTs,
    });
    await kv.set("mem:obs:ses_old", "obs_old", {
      id: "obs_old",
      sessionId: "ses_old",
      timestamp: oldTs,
      title: "old",
      importance: 1,
    });

    await sdk.trigger("mem::auto-forget", { dryRun: false });

    expect(await kv.get("mem:raw:ses_old", "obs_old")).toBeNull();
    expect(await kv.get("mem:obs:ses_old", "obs_old")).toBeNull();
  });

  it("mem::evict removes raw and derived rows on low-importance delete", async () => {
    const { registerEvictFunction } = await import(
      "../src/functions/evict.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerEvictFunction(sdk as never, kv as never);

    const oldTs = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    await kv.set("mem:sessions", "ses_evict", {
      id: "ses_evict",
      project: "p",
      cwd: "/tmp",
      startedAt: oldTs,
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:raw:ses_evict", "obs_evict", {
      id: "obs_evict",
      sessionId: "ses_evict",
      timestamp: oldTs,
    });
    await kv.set("mem:obs:ses_evict", "obs_evict", {
      id: "obs_evict",
      sessionId: "ses_evict",
      timestamp: oldTs,
      title: "low",
      importance: 1,
    });

    await sdk.trigger("mem::evict", { dryRun: false });

    expect(await kv.get("mem:raw:ses_evict", "obs_evict")).toBeNull();
    expect(await kv.get("mem:obs:ses_evict", "obs_evict")).toBeNull();
  });

  it("export replace strategy deletes raw and derived rows", async () => {
    const { registerExportImportFunction } = await import(
      "../src/functions/export-import.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerExportImportFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_old", {
      id: "ses_old",
      project: "p",
      cwd: "/tmp",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:raw:ses_old", "obs_old", { id: "obs_old" });
    await kv.set("mem:obs:ses_old", "obs_old", {
      id: "obs_old",
      sessionId: "ses_old",
      title: "old",
      type: "other",
      timestamp: "2026-01-01T00:00:00Z",
      facts: [],
      narrative: "",
      concepts: [],
      files: [],
      importance: 5,
    });

    await sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.29",
        exportedAt: new Date().toISOString(),
        sessions: [],
        observations: {},
        memories: [],
        summaries: [],
      },
      strategy: "replace",
    });

    expect(await kv.get("mem:raw:ses_old", "obs_old")).toBeNull();
    expect(await kv.get("mem:obs:ses_old", "obs_old")).toBeNull();
  });
});

describe("raw event export/import", () => {
  it("omits rawEvents by default and includes them when requested", async () => {
    const { registerExportImportFunction } = await import(
      "../src/functions/export-import.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerExportImportFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "p",
      cwd: "/tmp",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:raw:ses_1", "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      timestamp: "2026-01-01T00:00:00Z",
      hookType: "prompt_submit",
      userPrompt: "hello",
      raw: { prompt: "hello" },
    });

    const defaultExport = (await sdk.trigger("mem::export", {})) as {
      rawEvents?: unknown;
    };
    expect(defaultExport.rawEvents).toBeUndefined();

    const withRaw = (await sdk.trigger("mem::export", {
      includeRawEvents: true,
    })) as { rawEvents?: Record<string, RawObservation[]> };
    expect(withRaw.rawEvents?.["ses_1"]?.[0]?.userPrompt).toBe("hello");
  });

  it("import restores rawEvents when present", async () => {
    const { registerExportImportFunction } = await import(
      "../src/functions/export-import.js"
    );
    const sdk = mockSdk();
    const kv = mockKV();
    registerExportImportFunction(sdk as never, kv as never);

    const raw: RawObservation = {
      id: "obs_import",
      sessionId: "ses_import",
      timestamp: "2026-01-01T00:00:00Z",
      hookType: "prompt_submit",
      userPrompt: "import me",
      raw: { prompt: "import me" },
    };

    await sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.29",
        exportedAt: new Date().toISOString(),
        sessions: [
          {
            id: "ses_import",
            project: "p",
            cwd: "/tmp",
            startedAt: "2026-01-01T00:00:00Z",
            status: "completed",
            observationCount: 0,
          },
        ],
        observations: {},
        rawEvents: { ses_import: [raw] },
        memories: [],
        summaries: [],
      },
      strategy: "merge",
    });

    const stored = await kv.get<RawObservation>(
      "mem:raw:ses_import",
      "obs_import",
    );
    expect(stored?.userPrompt).toBe("import me");
  });
});
