import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEngineWatchdog,
  engineWatchdogTimeoutMs,
} from "../src/health/engine-watchdog.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("engineWatchdogTimeoutMs", () => {
  it("defaults to 60s", () => {
    expect(engineWatchdogTimeoutMs({})).toBe(60_000);
  });

  it("honors a numeric override including disable", () => {
    expect(engineWatchdogTimeoutMs({ AGENTMEMORY_ENGINE_WATCHDOG_MS: "15000" })).toBe(
      15_000,
    );
    expect(engineWatchdogTimeoutMs({ AGENTMEMORY_ENGINE_WATCHDOG_MS: "0" })).toBe(0);
  });

  it("falls back on invalid values", () => {
    expect(engineWatchdogTimeoutMs({ AGENTMEMORY_ENGINE_WATCHDOG_MS: "nope" })).toBe(
      60_000,
    );
  });
});

describe("createEngineWatchdog", () => {
  it("exits after a sustained disconnect or reconnect loop", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const watchdog = createEngineWatchdog({ timeoutMs: 1_000, exit });

    watchdog.onConnectionState("reconnecting");
    vi.advanceTimersByTime(999);
    expect(exit).not.toHaveBeenCalled();

    watchdog.onConnectionState("disconnected");
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("clears the timer when the engine reconnects", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const watchdog = createEngineWatchdog({ timeoutMs: 1_000, exit });

    watchdog.onConnectionState("disconnected");
    vi.advanceTimersByTime(500);
    watchdog.onConnectionState("connected");
    vi.advanceTimersByTime(1_000);
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not exit after an intentional shutdown", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const watchdog = createEngineWatchdog({ timeoutMs: 1_000, exit });

    watchdog.onConnectionState("disconnected");
    watchdog.markShuttingDown();
    vi.advanceTimersByTime(2_000);
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not arm when timeout is 0", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const watchdog = createEngineWatchdog({ timeoutMs: 0, exit });

    watchdog.onConnectionState("failed");
    vi.advanceTimersByTime(5_000);
    expect(exit).not.toHaveBeenCalled();
  });
});
