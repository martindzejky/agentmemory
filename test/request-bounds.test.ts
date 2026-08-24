// Protects the bounding primitives added after the production OOM crashes:
// concurrency limits, wall-clock budgets, state-RPC timeouts, and the
// container-memory reading that makes the failure visible at all. See
// docs/investigations/2026-08-24-latency-and-oom.md.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Semaphore, setSearchGate, getSearchGateStats } from "../src/utils/semaphore.js";
import {
  Deadline,
  withTimeout,
  getDeadlineExceededCounts,
  resetDeadlineCounters,
} from "../src/utils/deadline.js";
import {
  recordKvList,
  getKvListStats,
  resetKvListStats,
} from "../src/state/kv-metrics.js";
import {
  recordOperation,
  getOperationStats,
  resetOperationStats,
  setSlowOperationThresholdMs,
} from "../src/utils/op-timing.js";
import { evaluateHealth } from "../src/health/thresholds.js";
import { StateKV } from "../src/state/kv.js";
import type { HealthSnapshot } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Semaphore", () => {
  it("never runs more than the limit concurrently", async () => {
    const gate = new Semaphore(2);
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        gate.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(gate.inFlight).toBe(0);
    expect(gate.queued).toBe(0);
  });

  it("queues excess work instead of rejecting it", async () => {
    const gate = new Semaphore(1);
    const first = deferred<void>();

    const a = gate.run(() => first.promise);
    const b = gate.run(async () => "done");

    // b is waiting behind a, and that is observable for /health.
    await new Promise((r) => setTimeout(r, 0));
    expect(gate.inFlight).toBe(1);
    expect(gate.queued).toBe(1);

    first.resolve();
    await expect(b).resolves.toBe("done");
    await a;
  });

  it("releases its slot when the work throws", async () => {
    const gate = new Semaphore(1);
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });

  it("reports gate stats once registered", () => {
    const gate = new Semaphore(3);
    setSearchGate(gate);
    expect(getSearchGateStats()).toEqual({ inFlight: 0, queued: 0 });
    setSearchGate(null);
  });
});

describe("Deadline", () => {
  beforeEach(() => resetDeadlineCounters());

  it("runs work while budget remains", async () => {
    const deadline = new Deadline(1000);
    await expect(deadline.guard("t", async () => "ran", "fallback")).resolves.toBe(
      "ran",
    );
    expect(getDeadlineExceededCounts()["t"]).toBeUndefined();
  });

  it("skips work and counts the skip once expired", async () => {
    const deadline = new Deadline(0);
    let ran = false;
    const result = await deadline.guard(
      "expired-op",
      async () => {
        ran = true;
        return "ran";
      },
      "fallback",
    );

    expect(result).toBe("fallback");
    expect(ran).toBe(false);
    expect(getDeadlineExceededCounts()["expired-op"]).toBe(1);
  });
});

describe("withTimeout", () => {
  beforeEach(() => resetDeadlineCounters());

  it("passes a value through when it lands in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "fast")).resolves.toBe(7);
  });

  it("rejects and counts when the ceiling is hit", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise((r) => setTimeout(r, 60_000));
      const guarded = withTimeout(never, 100, "kv.list(mem:graph:nodes)");
      const assertion = expect(guarded).rejects.toThrow(/exceeded 100ms/);
      await vi.advanceTimersByTimeAsync(150);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    expect(
      getDeadlineExceededCounts()["kv.list(mem:graph:nodes)"],
    ).toBe(1);
  });
});

describe("state RPC timeouts apply to reads only", () => {
  // A timeout is not a cancellation: nothing tells the engine to abandon an
  // in-flight invocation, so a write that times out client-side can still
  // commit. Callers compensate on rejection (mem::observe rolls back the raw row
  // when the derived write fails), and that delete would race the late commit.
  // Reads are free to abandon; writes are not.
  function slowSdk() {
    const calls: string[] = [];
    return {
      calls,
      trigger: async ({ function_id }: { function_id: string }) => {
        calls.push(function_id);
        await new Promise((r) => setTimeout(r, 50));
        return null;
      },
    };
  }

  beforeEach(() => {
    resetDeadlineCounters();
    process.env["AGENTMEMORY_KV_TIMEOUT_MS"] = "10";
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_KV_TIMEOUT_MS"];
  });

  it("rejects a read that outruns the ceiling", async () => {
    const kv = new StateKV(slowSdk() as never);
    await expect(kv.list("mem:graph:nodes")).rejects.toThrow(/exceeded 10ms/);
    await expect(kv.get("mem:sessions", "s1")).rejects.toThrow(/exceeded 10ms/);
  });

  it("lets writes run to completion past the read ceiling", async () => {
    const sdk = slowSdk();
    const kv = new StateKV(sdk as never);

    await expect(kv.set("mem:obs:s1", "o1", { a: 1 })).resolves.toBeNull();
    await expect(kv.update("mem:sessions", "s1", [])).resolves.toBeNull();
    await expect(kv.delete("mem:obs:s1", "o1")).resolves.toBeNull();

    expect(sdk.calls).toEqual(["state::set", "state::update", "state::delete"]);
    expect(getDeadlineExceededCounts()).toEqual({});
  });
});

describe("kv list accounting", () => {
  beforeEach(() => resetKvListStats());

  it("surfaces the widest enumerations first", () => {
    recordKvList("mem:graph:nodes", 32127, 500);
    recordKvList("mem:graph:edges", 61577, 800);
    recordKvList("mem:memories", 12, 2);

    const stats = getKvListStats();
    expect(stats[0].scope).toBe("mem:graph:edges");
    expect(stats[0].maxRows).toBe(61577);
    expect(stats.map((s) => s.scope)).toContain("mem:graph:nodes");
  });

  it("collapses per-session scopes so the tally stays bounded", () => {
    for (let i = 0; i < 500; i++) recordKvList(`mem:obs:session-${i}`, 10, 1);
    const stats = getKvListStats(50);
    expect(stats.filter((s) => s.scope === "mem:obs:*")).toHaveLength(1);
    expect(stats.find((s) => s.scope === "mem:obs:*")!.calls).toBe(500);
  });
});

describe("operation timings", () => {
  beforeEach(() => {
    resetOperationStats();
    setSlowOperationThresholdMs(1000);
  });

  it("summarizes count, percentiles and slow calls per operation", () => {
    for (const ms of [10, 20, 30, 40, 2000]) recordOperation("enrich.search", ms);
    const stats = getOperationStats()["enrich.search"];
    expect(stats.count).toBe(5);
    expect(stats.slowCount).toBe(1);
    expect(stats.maxMs).toBe(2000);
    expect(stats.p50).toBeGreaterThan(0);
  });

  it("invokes the slow callback only above the threshold", () => {
    const slow: string[] = [];
    recordOperation("fast.op", 5, (name) => slow.push(name));
    recordOperation("slow.op", 5000, (name) => slow.push(name));
    expect(slow).toEqual(["slow.op"]);
  });
});

describe("health thresholds see container memory", () => {
  function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
    return {
      connectionState: "connected",
      workers: [],
      // A comfortable heap: the point is that heap health says nothing about
      // whether the container is about to be killed.
      memory: {
        heapUsed: 50 * 1024 * 1024,
        heapTotal: 200 * 1024 * 1024,
        rss: 400 * 1024 * 1024,
        external: 20 * 1024 * 1024,
      },
      cpu: { userMicros: 0, systemMicros: 0, percent: 1 },
      eventLoopLagMs: 1,
      uptimeSeconds: 100,
      status: "healthy",
      alerts: [],
      ...overrides,
    };
  }

  it("stays healthy with plenty of container headroom", () => {
    const result = evaluateHealth(
      snapshot({
        container: {
          usedBytes: 400 * 1024 * 1024,
          limitBytes: 2048 * 1024 * 1024,
          percent: 19.5,
        },
      }),
    );
    expect(result.status).toBe("healthy");
    expect(result.alerts).toEqual([]);
  });

  it("warns when the container approaches its limit even though the heap looks fine", () => {
    const result = evaluateHealth(
      snapshot({
        container: {
          usedBytes: 1600 * 1024 * 1024,
          limitBytes: 2048 * 1024 * 1024,
          percent: 78,
        },
      }),
    );
    expect(result.status).toBe("degraded");
    expect(result.alerts.join()).toMatch(/container_memory_warn_78%/);
  });

  it("escalates to critical near the limit", () => {
    const result = evaluateHealth(
      snapshot({
        container: {
          usedBytes: 1950 * 1024 * 1024,
          limitBytes: 2048 * 1024 * 1024,
          percent: 95,
        },
      }),
    );
    expect(result.status).toBe("critical");
    expect(result.alerts.join()).toMatch(/container_memory_critical_95%/);
  });

  it("ignores container memory when no limit is known", () => {
    const result = evaluateHealth(
      snapshot({
        container: {
          usedBytes: 7000 * 1024 * 1024,
          limitBytes: null,
          percent: null,
        },
      }),
    );
    expect(result.status).toBe("healthy");
  });
});
