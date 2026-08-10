import { describe, expect, it, beforeEach, afterEach } from "vitest";

const KEYS = [
  "AGENTMEMORY_IDLE_SWEEP_ENABLED",
  "AGENTMEMORY_IDLE_SWEEP_INTERVAL_MS",
  "AGENTMEMORY_IDLE_THRESHOLD_MS",
  "AGENTMEMORY_IDLE_SWEEP_MAX_SESSIONS",
  "AGENTMEMORY_IDLE_SWEEP_SESSION_COOLDOWN_MS",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_BASE_URL",
  "AGENTMEMORY_PROVIDER",
] as const;

describe("idle sweep config", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    const cfg = await import("../src/config.js");
    cfg.__resetEnvFileCache();
  });

  afterEach(async () => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    const cfg = await import("../src/config.js");
    cfg.__resetEnvFileCache();
  });

  it("falls back when interval/threshold/max are zero or negative", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.AGENTMEMORY_IDLE_SWEEP_INTERVAL_MS = "0";
    process.env.AGENTMEMORY_IDLE_THRESHOLD_MS = "-1";
    process.env.AGENTMEMORY_IDLE_SWEEP_MAX_SESSIONS = "0";
    const cfg = await import("../src/config.js");
    cfg.__resetEnvFileCache();

    expect(cfg.getIdleSweepIntervalMs()).toBe(900_000);
    expect(cfg.getIdleThresholdMs()).toBe(1_800_000);
    expect(cfg.getIdleSweepMaxSessions()).toBe(5);
    expect(cfg.isIdleSweepEnabled()).toBe(true);
  });

  it("disables via kill switch even with a provider key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.AGENTMEMORY_IDLE_SWEEP_ENABLED = "false";
    const cfg = await import("../src/config.js");
    cfg.__resetEnvFileCache();
    expect(cfg.isIdleSweepEnabled()).toBe(false);
  });

  it("disables when no LLM provider is configured", async () => {
    process.env.AGENTMEMORY_PROVIDER = "noop";
    const cfg = await import("../src/config.js");
    cfg.__resetEnvFileCache();
    expect(cfg.isIdleSweepEnabled()).toBe(false);
  });
});
