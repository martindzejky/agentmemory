// Bounded concurrency with a FIFO queue.
//
// Hook traffic arrives fully concurrent: Cursor spawns one subprocess per event,
// postToolUse fires observe and enrich together, and every subagent adds its own
// stream. Each retrieval allocates in proportion to the corpus, so N concurrent
// searches cost N times the peak memory. Queueing them costs latency the client
// is already prepared to abandon.

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }
}

// The retrieval gate is registered at boot so /health can report how deep the
// queue is. Without it, "slow" and "queued behind 40 other searches" look
// identical from the outside.
let searchGate: Semaphore | null = null;

export function setSearchGate(gate: Semaphore | null): void {
  searchGate = gate;
}

export function getSearchGateStats(): { inFlight: number; queued: number } {
  return {
    inFlight: searchGate?.inFlight ?? 0,
    queued: searchGate?.queued ?? 0,
  };
}
