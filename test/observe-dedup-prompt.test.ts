import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function observePayload(hookType: string, data: unknown) {
  return {
    sessionId: "ses_dedup_test",
    project: "/home/user/myrepo",
    cwd: "/home/user/myrepo",
    hookType,
    timestamp: new Date().toISOString(),
    data,
  };
}

describe("observe without content-hash ingest dedup", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("records consecutive prompt_submit observations with different prompts", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const first = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", { prompt: "ship the helm chart" }),
    )) as { observationId?: string; deduplicated?: boolean };
    const second = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", { prompt: "now fix the failing test" }),
    )) as { observationId?: string; deduplicated?: boolean };

    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBeUndefined();
    expect(second.observationId).toBeTruthy();
  });

  it("records two prompt_submit observations whose data is distinct primitive strings", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const first = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", "ship the helm chart"),
    )) as { observationId?: string; deduplicated?: boolean };
    const second = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", "now fix the failing test"),
    )) as { observationId?: string; deduplicated?: boolean };

    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBeUndefined();
    expect(second.observationId).toBeTruthy();
  });

  it("does not content-dedup an identical prompt_submit without eventId", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const payload = { prompt: "ship the helm chart" };
    const first = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", payload),
    )) as { observationId?: string };
    const second = (await sdk.trigger(
      "mem::observe",
      observePayload("prompt_submit", payload),
    )) as { observationId?: string; deduplicated?: boolean };

    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBeUndefined();
    expect(second.observationId).toBeTruthy();
    expect(second.observationId).not.toBe(first.observationId);
  });

  it("does not content-dedup tool hooks that share tool_input", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const first = (await sdk.trigger(
      "mem::observe",
      observePayload("post_tool_use", {
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: "a.txt",
      }),
    )) as { observationId?: string };
    const second = (await sdk.trigger(
      "mem::observe",
      observePayload("post_tool_use", {
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_response: "b.txt",
      }),
    )) as { observationId?: string; deduplicated?: boolean };

    expect(first.observationId).toBeTruthy();
    expect(second.deduplicated).toBeUndefined();
    expect(second.observationId).toBeTruthy();
  });
});
