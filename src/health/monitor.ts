import type { ISdk } from "iii-sdk";
import type { HealthSnapshot } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { evaluateHealth } from "./thresholds.js";
import { readContainerMemory } from "./container-memory.js";
import { getSearchGateStats } from "../utils/semaphore.js";
import { getEmbedQueueStats } from "../state/embed-queue.js";
import { getDeadlineExceededCounts } from "../utils/deadline.js";
import { getKvListStats } from "../state/kv-metrics.js";
import { logger } from "../logger.js";

export function registerHealthMonitor(
  sdk: ISdk,
  kv: StateKV,
): { stop: () => void } {
  let connectionState = "connected";
  let prevCpuUsage = process.cpuUsage();
  let prevCpuTime = Date.now();
  let lastLoggedStatus: HealthSnapshot["status"] = "healthy";

  if (typeof sdk.on === "function") {
    sdk.on("connection_state", (state?: unknown) => {
      connectionState = state as string;
    });
  }

  async function collectHealth(): Promise<HealthSnapshot> {
    const mem = process.memoryUsage();
    const container = readContainerMemory();
    const searchGate = getSearchGateStats();
    const embed = getEmbedQueueStats();
    const currentCpu = process.cpuUsage();
    const now = Date.now();
    const uptime = process.uptime();

    const elapsedMs = now - prevCpuTime;
    const userDelta = currentCpu.user - prevCpuUsage.user;
    const systemDelta = currentCpu.system - prevCpuUsage.system;
    const cpuPercent =
      elapsedMs > 0 ? ((userDelta + systemDelta) / 1000 / elapsedMs) * 100 : 0;
    prevCpuUsage = currentCpu;
    prevCpuTime = now;

    const startMark = performance.now();
    await new Promise((resolve) => setImmediate(resolve));
    const eventLoopLagMs = performance.now() - startMark;

    let workers: HealthSnapshot["workers"] = [];
    try {
      const result = await sdk.trigger<
        unknown,
        { workers?: HealthSnapshot["workers"] }
      >({ function_id: "engine::workers::list", payload: {} });
      if (result?.workers) workers = result.workers;
    } catch {}

    const KV_PROBE_TIMEOUT = 5000;
    let kvConnectivity: { status: string; latencyMs?: number; error?: string };
    const kvStart = performance.now();
    try {
      await Promise.race([
        (async () => {
          await kv.set(KV.health, "_probe", { ts: Date.now() });
          await kv.get(KV.health, "_probe");
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), KV_PROBE_TIMEOUT),
        ),
      ]);
      kvConnectivity = { status: "ok", latencyMs: Math.round((performance.now() - kvStart) * 100) / 100 };
    } catch {
      kvConnectivity = { status: "error", error: "kv_probe_failed", latencyMs: Math.round((performance.now() - kvStart) * 100) / 100 };
    }

    const snapshot: HealthSnapshot = {
      connectionState,
      workers,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
      },
      cpu: {
        userMicros: currentCpu.user,
        systemMicros: currentCpu.system,
        percent: Math.round(cpuPercent * 100) / 100,
      },
      eventLoopLagMs,
      uptimeSeconds: uptime,
      kvConnectivity,
      ...(container ? { container } : {}),
      load: {
        searchInFlight: searchGate.inFlight,
        searchQueued: searchGate.queued,
        embedQueued: embed.queued,
        embedInFlight: embed.inFlight,
        embedDropped: embed.dropped,
        deadlineExceeded: getDeadlineExceededCounts(),
        widestKvLists: getKvListStats(),
      },
      status: "healthy",
      alerts: [],
    };

    const evaluated = evaluateHealth(snapshot);
    snapshot.status = evaluated.status;
    snapshot.alerts = evaluated.alerts;
    snapshot.notes = evaluated.notes;

    // The production OOM crashes left nothing in the log, because the snapshot
    // was only ever written to KV. One line per transition (not per tick) is
    // enough to reconstruct a death afterwards without adding log volume in
    // steady state.
    if (evaluated.status !== lastLoggedStatus) {
      lastLoggedStatus = evaluated.status;
      const line = {
        status: evaluated.status,
        alerts: evaluated.alerts,
        rssMb: Math.round(mem.rss / (1024 * 1024)),
        heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
        containerMb: container
          ? Math.round(container.usedBytes / (1024 * 1024))
          : undefined,
        containerLimitMb: container?.limitBytes
          ? Math.round(container.limitBytes / (1024 * 1024))
          : undefined,
        eventLoopLagMs: Math.round(eventLoopLagMs),
        searchInFlight: searchGate.inFlight,
        searchQueued: searchGate.queued,
        embedQueued: embed.queued,
        // The widest enumeration seen so far, because "what was it reading when
        // it died" is the first question after an OOM.
        widestKvList: getKvListStats(1)[0],
      };
      if (evaluated.status === "healthy") logger.info("Health recovered", line);
      else logger.warn("Health degraded", line);
    }

    await kv.set(KV.health, "latest", snapshot).catch(() => {});
    return snapshot;
  }

  collectHealth().catch(() => {});
  const interval = setInterval(() => {
    collectHealth().catch(() => {});
  }, 30_000);
  interval.unref();

  return {
    stop: () => clearInterval(interval),
  };
}

export async function getLatestHealth(
  kv: StateKV,
): Promise<HealthSnapshot | null> {
  return kv.get<HealthSnapshot>(KV.health, "latest");
}
