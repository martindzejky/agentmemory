import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  __resetEngineSuperviseForTests,
  exitCodeForSpawnedEngineDeath,
  markEngineShutdown,
  markEngineSupervised,
} from "../src/cli/engine-supervise.js";

afterEach(() => {
  __resetEngineSuperviseForTests();
});

describe("exitCodeForSpawnedEngineDeath", () => {
  it("does not exit before the engine is marked ready", () => {
    expect(exitCodeForSpawnedEngineDeath(1, null)).toBeNull();
    expect(exitCodeForSpawnedEngineDeath(null, "SIGKILL")).toBeNull();
  });

  it("exits 1 after a ready engine dies with signal or zero", () => {
    markEngineSupervised();
    expect(exitCodeForSpawnedEngineDeath(null, "SIGKILL")).toBe(1);
    expect(exitCodeForSpawnedEngineDeath(0, null)).toBe(1);
  });

  it("preserves a non-zero engine exit code", () => {
    markEngineSupervised();
    expect(exitCodeForSpawnedEngineDeath(137, null)).toBe(137);
  });

  it("does not exit during an intentional shutdown", () => {
    markEngineSupervised();
    markEngineShutdown();
    expect(exitCodeForSpawnedEngineDeath(1, null)).toBeNull();
  });
});

describe("CLI engine supervise wiring", () => {
  const src = readFileSync("src/cli.ts", "utf-8");

  it("exits when a supervised engine child dies", () => {
    expect(src).toContain("exitCodeForSpawnedEngineDeath");
    expect(src).toContain("markEngineSupervised");
    expect(src).toContain("exiting so the supervisor can restart");
  });
});
