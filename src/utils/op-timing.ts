// Operation timings with a slow-operation warning.
//
// During the investigation the only latency figures available were Railway's
// edge log (total request time, no breakdown) and two LLM averages in
// functionMetrics. Nothing said whether a 3-second /enrich was spent in the
// graph enumeration, the embedding round-trip, or the file-context scan, which
// is why the diagnosis needed a local reproduction and a profiler.
//
// Cheap and low-volume by design: an in-memory histogram summary per operation,
// exposed via /health, plus one warn line when a single operation crosses a
// threshold. No per-request logging.

import { logger } from "../logger.js";

interface OpStats {
  count: number;
  totalMs: number;
  maxMs: number;
  slowCount: number;
  p50: number;
  p95: number;
}

// Reservoir per operation. Fixed size so a long-running process cannot grow
// this without bound.
const SAMPLE_SIZE = 256;
const samples = new Map<string, number[]>();
const counters = new Map<string, { count: number; totalMs: number; maxMs: number; slowCount: number }>();

let slowThresholdMs = 1_000;

export function setSlowOperationThresholdMs(ms: number): void {
  slowThresholdMs = ms;
}

export function recordOperation(
  name: string,
  ms: number,
  onSlow?: (name: string, ms: number) => void,
): void {
  const c = counters.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, slowCount: 0 };
  c.count++;
  c.totalMs += ms;
  c.maxMs = Math.max(c.maxMs, ms);

  const reservoir = samples.get(name) ?? [];
  if (reservoir.length < SAMPLE_SIZE) reservoir.push(ms);
  else reservoir[Math.floor(Math.random() * SAMPLE_SIZE)] = ms;
  samples.set(name, reservoir);

  if (ms > slowThresholdMs) {
    c.slowCount++;
    onSlow?.(name, ms);
  }
  counters.set(name, c);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx]);
}

export function getOperationStats(): Record<string, OpStats> {
  const out: Record<string, OpStats> = {};
  for (const [name, c] of counters) {
    const sorted = [...(samples.get(name) ?? [])].sort((a, b) => a - b);
    out[name] = {
      count: c.count,
      totalMs: Math.round(c.totalMs),
      maxMs: Math.round(c.maxMs),
      slowCount: c.slowCount,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
    };
  }
  return out;
}

export function resetOperationStats(): void {
  samples.clear();
  counters.clear();
}

// Times `work` and records it under `name`. Failures are timed too: a slow
// failure is exactly as interesting as a slow success.
export async function timed<T>(
  name: string,
  work: () => Promise<T>,
  onSlow?: (name: string, ms: number) => void,
): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    recordOperation(name, performance.now() - started, onSlow);
  }
}

// Rate-limited per operation so a sustained slow phase logs once a minute
// instead of once a request.
const lastSlowLogAt = new Map<string, number>();

export function timedOp<T>(name: string, work: () => Promise<T>): Promise<T> {
  return timed(name, work, (op, ms) => {
    const now = Date.now();
    if (now - (lastSlowLogAt.get(op) ?? 0) < 60_000) return;
    lastSlowLogAt.set(op, now);
    logger.warn("Slow operation", {
      operation: op,
      ms: Math.round(ms),
      thresholdMs: slowThresholdMs,
    });
  });
}
