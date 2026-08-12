import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  parseCursorCloudMessages,
  parseCursorLocalTranscript,
  extractUserQueryText,
} from "../src/replay/cursor-transcript.js";
import {
  registerImportCursorSessionFunction,
  importCursorSession,
} from "../src/functions/import-cursor-session.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

const SECRET = "cursor-import-secret";
const NOW = "2026-08-12T12:00:00.000Z";

function mockKV(store = new Map<string, Map<string, unknown>>()) {
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T | undefined) ?? null,
    set: async <T>(scope: string, key: string, data: T) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async () => {},
    update: vi.fn(async () => {}),
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
    _store: store,
  };
}

function mockSdk(kv: ReturnType<typeof mockKV>) {
  const fns = new Map<string, Function>();
  const observeCalls: unknown[] = [];
  const trigger = vi.fn(
    async (input: { function_id: string; payload?: unknown }) => {
      if (input.function_id === "mem::observe") {
        observeCalls.push(input.payload);
        return { observationId: `obs_${observeCalls.length}` };
      }
      return fns.get(input.function_id)?.(input.payload);
    },
  );
  return {
    registerFunction: (id: string, h: Function) => fns.set(id, h),
    registerTrigger: () => {},
    trigger,
    _fns: fns,
    _observeCalls: observeCalls,
    _kv: kv,
  };
}

function localTranscript(): string {
  return [
    JSON.stringify({
      role: "user",
      message: {
        content: [
          {
            type: "text",
            text: `<timestamp>${NOW}</timestamp>\n<user_query>Fix the login bug</user_query>`,
          },
          { type: "tool_use", name: "Shell", input: { command: "ls" } },
        ],
      },
    }),
    JSON.stringify({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking at the auth flow." },
          { type: "tool_use", name: "Read", input: { path: "a.ts" } },
        ],
      },
    }),
    JSON.stringify({ type: "turn_ended", status: "completed" }),
    "not-json",
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "Also check cookies" }] },
    }),
  ].join("\n");
}

describe("cursor transcript parser", () => {
  it("extracts <user_query> when present", () => {
    expect(
      extractUserQueryText(
        `<timestamp>${NOW}</timestamp>\n<user_query>Hello</user_query>`,
      ),
    ).toBe("Hello");
  });

  it("parses local JSONL user+assistant text only", () => {
    const events = parseCursorLocalTranscript(
      localTranscript(),
      "sess-local",
      NOW,
    );
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      hookType: "prompt_submit",
      text: "Fix the login bug",
      eventId: "cursor-local:sess-local:u:1",
      timestamp: NOW,
    });
    expect(events[1]).toMatchObject({
      hookType: "assistant_response",
      text: "Looking at the auth flow.",
      eventId: "cursor-local:sess-local:a:1",
    });
    expect(events[2]).toMatchObject({
      hookType: "prompt_submit",
      text: "Also check cookies",
      eventId: "cursor-local:sess-local:u:2",
    });
  });

  it("ignores empty/malformed local lines", () => {
    const events = parseCursorLocalTranscript(
      ["{", "", JSON.stringify({ role: "system", message: {} }), null]
        .filter((x) => x !== null)
        .join("\n"),
      "sess-empty",
      NOW,
    );
    expect(events).toEqual([]);
  });

  it("parses cloud messages into prompt/assistant events", () => {
    const events = parseCursorCloudMessages(
      [
        { id: "m1", type: "user_message", text: "Ship it" },
        { id: "m2", type: "assistant_message", text: "Done." },
        { id: "m3", type: "thinking", text: "noise" },
        { type: "user_message", text: "   " },
      ],
      "bc-abc",
      NOW,
    );
    expect(events).toEqual([
      {
        hookType: "prompt_submit",
        text: "Ship it",
        eventId: "cursor-cloud:bc-abc:m1",
        timestamp: NOW,
      },
      {
        hookType: "assistant_response",
        text: "Done.",
        eventId: "cursor-cloud:bc-abc:m2",
        timestamp: NOW,
      },
    ]);
  });
});

describe("mem::replay::import-cursor-session", () => {
  let kv: ReturnType<typeof mockKV>;
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    kv = mockKV();
    sdk = mockSdk(kv);
    registerImportCursorSessionFunction(sdk as never, kv as never);
  });

  it("skips when the session already exists", async () => {
    const session: Session = {
      id: "sess-exists",
      project: "p",
      cwd: "/tmp/p",
      startedAt: NOW,
      status: "active",
      observationCount: 1,
    };
    await kv.set(KV.sessions, session.id, session);

    const result = await importCursorSession(sdk as never, kv as never, {
      sessionId: "sess-exists",
      transcript: localTranscript(),
      project: "p",
      cwd: "/tmp/p",
    });

    expect(result).toEqual({
      success: true,
      skipped: true,
      reason: "exists",
      sessionId: "sess-exists",
    });
    expect(sdk._observeCalls).toHaveLength(0);
  });

  it("imports local transcript through mem::observe", async () => {
    const result = await importCursorSession(sdk as never, kv as never, {
      sessionId: "sess-local",
      transcript: localTranscript(),
      project: "agentmemory",
      cwd: "/workspace",
      source: "cursor-local",
    });

    expect(result).toMatchObject({
      success: true,
      skipped: false,
      sessionId: "sess-local",
      imported: 3,
      source: "cursor-local",
    });
    expect(sdk._observeCalls).toHaveLength(3);
    expect(sdk._observeCalls[0]).toMatchObject({
      hookType: "prompt_submit",
      sessionId: "sess-local",
      project: "agentmemory",
      cwd: "/workspace",
      agentId: "cursor",
      eventId: "cursor-local:sess-local:u:1",
      data: { prompt: "Fix the login bug" },
    });
    expect(sdk._observeCalls[1]).toMatchObject({
      hookType: "assistant_response",
      eventId: "cursor-local:sess-local:a:1",
      data: { assistantResponse: "Looking at the auth flow." },
    });
  });

  it("imports cloud messages through mem::observe", async () => {
    const result = await importCursorSession(sdk as never, kv as never, {
      sessionId: "bc-9f8a",
      messages: [
        { id: "u1", type: "user_message", text: "Hello cloud" },
        { id: "a1", type: "assistant_message", text: "Hi" },
      ],
      source: "cursor-cloud",
      project: "cloud-proj",
      cwd: "/cloud",
      agentId: "cursor",
    });

    expect(result).toMatchObject({
      success: true,
      skipped: false,
      imported: 2,
      source: "cursor-cloud",
    });
    expect(sdk._observeCalls[0]).toMatchObject({
      hookType: "prompt_submit",
      eventId: "cursor-cloud:bc-9f8a:u1",
      data: { prompt: "Hello cloud" },
    });
    expect(sdk._observeCalls[1]).toMatchObject({
      hookType: "assistant_response",
      eventId: "cursor-cloud:bc-9f8a:a1",
      data: { assistantResponse: "Hi" },
    });
  });

  it("rejects missing transcript and messages", async () => {
    const result = await importCursorSession(sdk as never, kv as never, {
      sessionId: "sess-none",
    });
    expect(result).toEqual({
      success: false,
      error: "transcript or messages is required",
    });
  });

  it("imports zero events for empty transcript without writing observations", async () => {
    const result = await importCursorSession(sdk as never, kv as never, {
      sessionId: "sess-empty",
      transcript: "\n{\n",
      project: "p",
      cwd: "/tmp",
    });
    expect(result).toMatchObject({
      success: true,
      skipped: false,
      imported: 0,
    });
    expect(sdk._observeCalls).toHaveLength(0);
  });
});

describe("api::replay::import-cursor-session", () => {
  it("whitelists fields and fans out to the mem function", async () => {
    const kv = mockKV();
    const sdk = mockSdk(kv);
    registerImportCursorSessionFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const handler = sdk._fns.get("api::replay::import-cursor-session")!;
    const res = await handler({
      headers: { authorization: `Bearer ${SECRET}` },
      body: {
        sessionId: "sess-api",
        project: "p",
        cwd: "/tmp/p",
        source: "cursor-local",
        agentId: "cursor",
        transcript: localTranscript(),
        extra: "drop-me",
      },
    });

    expect(res.status_code).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      skipped: false,
      imported: 3,
    });

    const memCall = sdk.trigger.mock.calls.find(
      (c) => c[0]?.function_id === "mem::replay::import-cursor-session",
    );
    expect(memCall?.[0]?.payload).toEqual({
      sessionId: "sess-api",
      project: "p",
      cwd: "/tmp/p",
      source: "cursor-local",
      agentId: "cursor",
      transcript: localTranscript(),
    });
  });

  it("returns 400 when neither transcript nor messages is provided", async () => {
    const kv = mockKV();
    const sdk = mockSdk(kv);
    registerApiTriggers(sdk as never, kv as never, SECRET);
    const handler = sdk._fns.get("api::replay::import-cursor-session")!;
    const res = await handler({
      headers: { authorization: `Bearer ${SECRET}` },
      body: { sessionId: "sess-api" },
    });
    expect(res.status_code).toBe(400);
    expect(res.body).toEqual({
      error: "transcript or messages is required",
    });
  });

  it("returns skipped exists through the REST handler", async () => {
    const kv = mockKV();
    const session: Session = {
      id: "sess-api-exists",
      project: "p",
      cwd: "/tmp/p",
      startedAt: NOW,
      status: "active",
      observationCount: 4,
    };
    await kv.set(KV.sessions, session.id, session);
    const sdk = mockSdk(kv);
    registerImportCursorSessionFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const handler = sdk._fns.get("api::replay::import-cursor-session")!;
    const res = await handler({
      headers: { authorization: `Bearer ${SECRET}` },
      body: {
        sessionId: "sess-api-exists",
        transcript: localTranscript(),
      },
    });

    expect(res.status_code).toBe(200);
    expect(res.body).toEqual({
      success: true,
      skipped: true,
      reason: "exists",
      sessionId: "sess-api-exists",
    });
  });
});
