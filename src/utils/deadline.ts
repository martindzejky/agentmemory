// Cooperative deadlines.
//
// iii's HTTP trigger gives the worker no abort signal and the SDK protocol has
// no cancel message (node_modules/iii-sdk/dist/utils-Cx5sef26.d.mts:934-941,
// index.mjs:194-207). A client that gives up at 2.5s therefore leaves the
// server running its work to completion — measured in
// docs/investigations/2026-08-24-latency-and-oom.md as +212 MB of engine RSS
// acquired after the caller was already gone.
//
// A deadline is the substitute: callers state how long the result is still worth
// producing, and each stage checks before starting more work. It cannot
// interrupt an in-flight KV round-trip, but it stops the request from starting
// the next one, which is what turns a burst into a queue instead of a pile.
//
// Writes are never dropped on a deadline. Only speculative read work
// (retrieval, expansion, context assembly) is skippable.

export class Deadline {
  private readonly expiresAt: number;

  constructor(budgetMs: number) {
    this.expiresAt = Date.now() + Math.max(0, budgetMs);
  }

  get remainingMs(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  get expired(): boolean {
    return Date.now() >= this.expiresAt;
  }

  // Runs `work` only if there is budget left. Returns `fallback` otherwise, and
  // counts the skip so /health can show how often requests are outliving their
  // callers.
  async guard<T>(label: string, work: () => Promise<T>, fallback: T): Promise<T> {
    if (this.expired) {
      recordDeadlineExceeded(label);
      return fallback;
    }
    return work();
  }
}

const deadlineExceeded = new Map<string, number>();

export function recordDeadlineExceeded(label: string): void {
  deadlineExceeded.set(label, (deadlineExceeded.get(label) ?? 0) + 1);
}

export function getDeadlineExceededCounts(): Record<string, number> {
  return Object.fromEntries(deadlineExceeded);
}

export function resetDeadlineCounters(): void {
  deadlineExceeded.clear();
}

// Wraps a promise in a wall-clock ceiling. Used for state RPCs, which otherwise
// inherit the 180s iii invocation timeout.
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          recordDeadlineExceeded(label);
          reject(new Error(`${label} exceeded ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
