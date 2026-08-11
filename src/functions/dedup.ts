const TTL_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60_000;

export class DedupMap {
  /** sessionId -> eventId -> expiresAt — nested so ids may contain ':' safely */
  private entries = new Map<string, Map<string, number>>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  isDuplicate(sessionId: string, eventId: string): boolean {
    const session = this.entries.get(sessionId);
    if (!session) return false;
    const expiresAt = session.get(eventId);
    if (expiresAt === undefined) return false;
    if (Date.now() > expiresAt) {
      session.delete(eventId);
      if (session.size === 0) this.entries.delete(sessionId);
      return false;
    }
    return true;
  }

  record(sessionId: string, eventId: string): void {
    let session = this.entries.get(sessionId);
    if (!session) {
      session = new Map();
      this.entries.set(sessionId, session);
    }
    session.set(eventId, Date.now() + TTL_MS);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.entries) {
      for (const [eventId, expiresAt] of session) {
        if (now > expiresAt) session.delete(eventId);
      }
      if (session.size === 0) this.entries.delete(sessionId);
    }
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  get size(): number {
    let n = 0;
    for (const session of this.entries.values()) n += session.size;
    return n;
  }
}
