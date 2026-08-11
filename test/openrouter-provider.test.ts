import { describe, expect, it, afterEach, vi } from "vitest";
import { OpenRouterProvider } from "../src/providers/openrouter.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

function mockResponse(message: Record<string, unknown>): Response {
  return {
    ok: true,
    json: async () => ({ choices: [{ message }] }),
  } as unknown as Response;
}

async function captureBody(
  baseUrl: string,
  message: Record<string, unknown> = { content: "ok" },
): Promise<Record<string, unknown>> {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(mockResponse(message));
  try {
    const provider = new OpenRouterProvider("test-key", "test-model", 800, baseUrl);
    await provider.summarize("system", "user");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  } finally {
    fetchSpy.mockRestore();
  }
}

describe("OpenRouterProvider — OPENROUTER_REASONING_EFFORT", () => {
  const original = process.env["OPENROUTER_REASONING_EFFORT"];

  afterEach(() => {
    if (original === undefined) {
      delete process.env["OPENROUTER_REASONING_EFFORT"];
    } else {
      process.env["OPENROUTER_REASONING_EFFORT"] = original;
    }
    vi.restoreAllMocks();
  });

  it("omits reasoning_effort when the env var is unset", async () => {
    delete process.env["OPENROUTER_REASONING_EFFORT"];
    const body = await captureBody(OPENROUTER_URL);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("sends reasoning_effort as a top-level field when set", async () => {
    process.env["OPENROUTER_REASONING_EFFORT"] = "medium";
    const body = await captureBody(OPENROUTER_URL);
    expect(body["reasoning_effort"]).toBe("medium");
  });

  it("ignores an empty env var", async () => {
    process.env["OPENROUTER_REASONING_EFFORT"] = "";
    const body = await captureBody(OPENROUTER_URL);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("does not leak the OpenRouter knob onto the shared Gemini base URL", async () => {
    process.env["OPENROUTER_REASONING_EFFORT"] = "high";
    const body = await captureBody(GEMINI_URL);
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

describe("OpenRouterProvider — reasoning-only responses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers content when both content and reasoning are present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ content: "answer", reasoning: "thinking" }),
    );
    const provider = new OpenRouterProvider("k", "m", 800, OPENROUTER_URL);
    await expect(provider.summarize("s", "u")).resolves.toBe("answer");
  });

  it("falls back to reasoning when content is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ content: "", reasoning: "thinking" }),
    );
    const provider = new OpenRouterProvider("k", "m", 800, OPENROUTER_URL);
    await expect(provider.summarize("s", "u")).resolves.toBe("thinking");
  });

  it("falls back to reasoning_content when content is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ reasoning_content: "thinking" }),
    );
    const provider = new OpenRouterProvider("k", "m", 800, OPENROUTER_URL);
    await expect(provider.summarize("s", "u")).resolves.toBe("thinking");
  });

  it("still throws when neither content nor reasoning is present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({}));
    const provider = new OpenRouterProvider("k", "m", 800, OPENROUTER_URL);
    await expect(provider.summarize("s", "u")).rejects.toThrow(
      /openrouter returned unexpected response/,
    );
  });
});
