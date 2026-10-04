/**
 * Counting failures per key (an IP address) in a fixed window, with a lock-out once there were too many. The
 * platform's rateLimit() counts every call; here only failures count, and a caller must be able to ask whether a key
 * is locked without adding to it.
 */
export class Strikes {
  private entries = new Map<string, { count: number; windowEnds: number; lockedUntil: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly lockMs: number,
  ) {}

  /** Milliseconds until `key` may try again; 0 when it is not locked. */
  lockedFor(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.lockedUntil - Date.now());
  }

  strike(key: string): void {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.windowEnds <= now) {
      entry = { count: 0, windowEnds: now + this.windowMs, lockedUntil: entry?.lockedUntil ?? 0 };
      this.entries.set(key, entry);
    }
    entry.count++;
    if (entry.count >= this.max) entry.lockedUntil = now + this.lockMs;
  }

  /** Forget windows and locks that are over, so the map does not grow with every address ever seen. */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.windowEnds <= now && entry.lockedUntil <= now) this.entries.delete(key);
    }
  }
}
