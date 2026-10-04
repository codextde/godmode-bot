import { isIP } from "node:net";

/**
 * The key per-address limits count under: an IPv4 address as is, an IPv6 address by its /64, because one subscriber
 * usually gets a whole /64 and could otherwise take a fresh address for every attempt.
 */
export function addressKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [left = "", right] = ip.split("%")[0]!.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  // A dotted IPv4 tail ("::ffff:1.2.3.4") stands for two groups.
  const tailGroups = tail.reduce((n, group) => n + (group.includes(".") ? 2 : 1), 0);
  const groups = right === undefined ? head : [...head, ...Array<string>(Math.max(0, 8 - head.length - tailGroups)).fill("0"), ...tail];
  return `${groups
    .slice(0, 4)
    .map((group) => (Number.parseInt(group, 16) || 0).toString(16))
    .join(":")}::/64`;
}

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
