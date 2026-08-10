const TTL_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60_000;

interface DedupEntry {
  key: string;
  expiresAt: number;
}

export class DedupMap {
  private entries = new Map<string, DedupEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  private entryKey(sessionId: string, eventId: string): string {
    return `${sessionId}:${eventId}`;
  }

  isDuplicate(sessionId: string, eventId: string): boolean {
    const key = this.entryKey(sessionId, eventId);
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  record(sessionId: string, eventId: string): void {
    const key = this.entryKey(sessionId, eventId);
    this.entries.set(key, { key, expiresAt: Date.now() + TTL_MS });
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(key);
    }
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  get size(): number {
    return this.entries.size;
  }
}
