/** Fixed-window rate limits (in memory, one process) and the client address behind the proxy. */
import { BlockList, isIP } from "node:net";
import { shared } from "./shared";

interface Bucket {
  count: number;
  resetAt: number;
}

interface Limits {
  buckets: Map<string, Bucket>;
  sweptAt: number;
}

const limits = () => shared<Limits>("rateLimits", () => ({ buckets: new Map(), sweptAt: Date.now() }));

/** Counts one hit for `key`. `ok` is false once more than `limit` hits fell into the current window. */
export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const state = limits();
  const now = Date.now();
  // Drop finished windows now and then so keys that are never used again do not pile up.
  if (now - state.sweptAt > 60_000) {
    for (const [k, b] of state.buckets) if (b.resetAt <= now) state.buckets.delete(k);
    state.sweptAt = now;
  }
  let bucket = state.buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    state.buckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > limit) return { ok: false, retryAfterMs: bucket.resetAt - now };
  return { ok: true, retryAfterMs: 0 };
}

/** For tests. */
export function resetRateLimits(): void {
  limits().buckets.clear();
}

/**
 * The custom server copies the socket's peer address into this request header (overwriting anything the client
 * sent) before Next handles the request, because Next code cannot see the socket.
 */
export const PEER_HEADER = "x-godmode-peer";

interface ProxyTrust {
  trustProxy: boolean;
  hops: number;
}

// Settings defaults until the security settings were read once (settings/index.ts keeps this current).
const proxyTrust = () => shared<ProxyTrust>("proxyTrust", () => ({ trustProxy: true, hops: 1 }));

/** Called by the settings service whenever `security` is read from the database or written. */
export function setProxyTrust(value: { trustProxy: boolean; trustedProxyHops: number }): void {
  const state = proxyTrust();
  state.trustProxy = value.trustProxy;
  state.hops = Math.min(Math.max(Math.floor(value.trustedProxyHops) || 1, 1), 5);
}

let privateRanges: BlockList | null = null;

/** Loopback and private networks: where the reverse proxy sits (the Docker network). */
function isPrivateAddress(address: string): boolean {
  if (!privateRanges) {
    privateRanges = new BlockList();
    privateRanges.addSubnet("127.0.0.0", 8, "ipv4");
    privateRanges.addSubnet("10.0.0.0", 8, "ipv4");
    privateRanges.addSubnet("172.16.0.0", 12, "ipv4");
    privateRanges.addSubnet("192.168.0.0", 16, "ipv4");
    privateRanges.addAddress("::1", "ipv6");
    privateRanges.addSubnet("fc00::", 7, "ipv6");
  }
  const family = isIP(address);
  if (family === 4) return privateRanges.check(address, "ipv4");
  if (family === 6) return privateRanges.check(address, "ipv6");
  return false;
}

/** "::ffff:10.0.0.2" (IPv4 on a dual-stack socket) → "10.0.0.2". */
function plainAddress(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  const address = mapped ? mapped[1]! : v;
  return isIP(address) ? address : null;
}

type HeaderSource = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === "function") return (headers as { get(name: string): string | null }).get(name);
  const value = (headers as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value.join(", ");
  return value ?? null;
}

/**
 * The address of whoever sent the request. Only when `security.trustProxy` is on and the socket peer is on a
 * loopback or private network (our proxy) is X-Forwarded-For used, and then only the entry `trustedProxyHops` from the
 * right: everything left of it was written by the client and could be anything.
 */
export function clientIp(headers: HeaderSource, socketAddress?: string | null): string {
  const peer = plainAddress(socketAddress);
  const fallback = peer ?? "unknown";
  const trust = proxyTrust();
  if (!trust.trustProxy || !peer || !isPrivateAddress(peer)) return fallback;
  const forwarded = readHeader(headers, "x-forwarded-for");
  if (!forwarded) return fallback;
  const hops = forwarded
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!hops.length) return fallback;
  // Fewer entries than proxies: every entry was written by a proxy, so the leftmost is the furthest we know.
  const entry = hops[Math.max(hops.length - trust.hops, 0)];
  return plainAddress(entry) ?? fallback;
}
