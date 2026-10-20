/**
 * The computers a phone may talk to: the one it was paired with and the others of that computer's device group, which
 * take the same key. Plain logic (no React, no Expo), so `bun test` runs it.
 */
import type { MobileInstance, MobilePeer } from "@godmode/shared";

export interface Computers {
  /** The computer this phone was paired with. */
  instance: MobileInstance;
  urls: string[];
  /** The address that answered last; tried first. */
  activeUrl: string;
  /** The group as a computer listed it last (`GET /api/mobile/me`), the paired one included; empty outside a group. */
  peers: MobilePeer[];
  /** The computer that answered last. */
  activeInstanceId: string;
}

export interface Computer {
  instance: MobileInstance;
  urls: string[];
  /** null: the paired computer isn't in a group. */
  role: MobilePeer["role"] | null;
}

export interface Candidate {
  base: string;
  /** The computer the address is listed for. */
  instanceId: string;
}

/** An address without trailing slashes, so `${base}/api/…` also works for a gateway address with a path. */
export function baseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Every computer that takes this phone's key: the paired one first, then the others of its group as listed. */
export function computersOf(c: Computers): Computer[] {
  const home = c.peers.find((p) => p.instance.id === c.instance.id);
  return [{ instance: c.instance, urls: c.urls, role: home?.role ?? null }, ...c.peers.filter((p) => p.instance.id !== c.instance.id)];
}

/** The group's primary right now, as last listed. */
export function primaryOf(c: Computers): Computer | undefined {
  return computersOf(c).find((p) => p.role === "primary");
}

/** A computer of the group by id; the paired one when that one isn't listed (any more). */
export function computerOf(c: Computers, instanceId: string | null | undefined): Computer {
  const all = computersOf(c);
  return all.find((p) => p.instance.id === instanceId) ?? all[0]!;
}

/**
 * Addresses in the order to try them: the computer that answered last (its address that answered first), then the
 * primary, then the others. Each computer's addresses stay best first.
 */
export function candidateOrder(c: Computers): Candidate[] {
  const all = computersOf(c);
  const active = all.find((p) => p.instance.id === c.activeInstanceId) ?? all[0]!;
  const primary = all.find((p) => p.role === "primary" && p !== active);
  const ordered = [active, ...(primary ? [primary] : []), ...all.filter((p) => p !== active && p !== primary)];
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const p of ordered) {
    for (const url of p === active ? [c.activeUrl, ...p.urls] : p.urls) {
      const base = baseUrl(url);
      if (!base || seen.has(base)) continue;
      seen.add(base);
      out.push({ base, instanceId: p.instance.id });
    }
  }
  return out;
}

/** Whether the computer that answered at an address may get this phone's key: the paired one or one of its group. */
export function accepts(c: Computers, instanceId: string | null | undefined): boolean {
  return !!instanceId && computersOf(c).some((p) => p.instance.id === instanceId);
}

/**
 * Whether a refused key (401, or the socket closed with 4003) from this computer means the phone was removed: only the
 * paired computer and the group's primary say so. Another computer of the group may not have the key yet.
 */
export function removedBy(c: Computers, instanceId: string): boolean {
  return instanceId === c.instance.id || primaryOf(c)?.instance.id === instanceId;
}

/**
 * The group as a computer listed it: computers no longer listed are dropped, the paired one always stays. Addresses
 * the phone may not send its key to are left out. Without a group (an older Godmode, or not in one) only the paired
 * computer is left.
 */
export function withGroup<T extends Computers>(c: T, group: unknown, allowed: (url: string) => boolean): T {
  const peers: MobilePeer[] = [];
  for (const p of Array.isArray(group) ? (group as Partial<MobilePeer>[]) : []) {
    const id = p?.instance?.id;
    if (typeof id !== "string" || !id || peers.some((x) => x.instance.id === id)) continue;
    const urls = Array.isArray(p.urls) ? p.urls.filter((u): u is string => typeof u === "string" && allowed(u)).map(baseUrl) : [];
    const name = typeof p.instance!.name === "string" && p.instance!.name ? p.instance!.name : "Godmode";
    peers.push({ instance: { ...p.instance!, name }, urls: [...new Set(urls)], role: p.role === "primary" ? "primary" : "secondary" });
  }
  const next = { ...c, peers };
  if (accepts(next, c.activeInstanceId)) return next;
  return { ...next, activeInstanceId: c.instance.id, activeUrl: c.urls[0] ?? c.activeUrl };
}

/** A pairing stored before device groups: no group yet, and the paired computer answered last. */
export function withDefaults<T extends { instance: MobileInstance; peers?: unknown; activeInstanceId?: unknown }>(stored: T): T & Pick<Computers, "peers" | "activeInstanceId"> {
  return {
    ...stored,
    peers: Array.isArray(stored.peers) ? (stored.peers as MobilePeer[]) : [],
    activeInstanceId: typeof stored.activeInstanceId === "string" ? stored.activeInstanceId : stored.instance.id,
  };
}
