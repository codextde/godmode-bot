/**
 * Where this computer stands in its device group (owner: remote). Kept small and free of imports from the rest of
 * remote/, so the router, the event hub and the tools can ask without pulling in the links.
 *
 *  role      meta `link.group.role`: "primary" | "secondary"; none = not in a group
 *  primary   meta `link.group.primary`: on a secondary, the id of the primary's row in `runners`
 *  forwarded a secondary whose primary is connected: its app shows the primary's Godmode (deviceRouting.ts, ws.ts)
 *
 * `link.*` meta never goes into backups, like the pairings it describes.
 */
import type { DeviceRole } from "@godmode/shared";
import { deleteMeta, getMeta, setMeta } from "../db";

const ROLE_META = "link.group.role";
const PRIMARY_META = "link.group.primary";
const STAND_IN_META = "link.group.standIn.since";

let cached: { role: DeviceRole | null; primary: string | null } | null = null;
let standInCache: string | null | undefined;
let primaryUp = false;
const listeners = new Set<() => void>();

function read(): { role: DeviceRole | null; primary: string | null } {
  if (cached) return cached;
  const raw = getMeta(ROLE_META);
  const role = raw === "primary" || raw === "secondary" ? raw : null;
  cached = { role, primary: role === "secondary" ? getMeta(PRIMARY_META) : null };
  return cached;
}

export function groupRole(): DeviceRole | null {
  try {
    return read().role;
  } catch {
    return null;
  }
}

export function isPrimary(): boolean {
  return groupRole() === "primary";
}

export function isSecondary(): boolean {
  return groupRole() === "secondary";
}

/** On a secondary: its own id in the primary's runner list (how the primary's app names it). */
export function selfDeviceId(): string | null {
  try {
    return isSecondary() ? getMeta("link.group.self") : null;
  } catch {
    return null;
  }
}

/** On a secondary: the id of the primary's row in `runners`. */
export function primaryRunnerId(): string | null {
  try {
    return read().primary;
  } catch {
    return null;
  }
}

/**
 * The app on this computer shows the primary's Godmode right now: requests go there (except what is about this
 * computer itself) and its events come from there.
 */
export function forwarding(): boolean {
  return primaryUp && isSecondary();
}

export function primaryOnline(): boolean {
  return primaryUp;
}

/** On a secondary: since when it stands in for its primary (it is away), or null. */
export function standingInSince(): string | null {
  try {
    if (!isSecondary()) return null;
    if (standInCache === undefined) standInCache = getMeta(STAND_IN_META);
    return standInCache;
  } catch {
    return null;
  }
}

export function standingIn(): boolean {
  return standingInSince() !== null;
}

/**
 * This computer runs what only one computer of a group runs — the schedules, the board, messaging, phone calls: the
 * primary, a computer alone, or a secondary while it stands in.
 */
export function runsShared(): boolean {
  return !isSecondary() || standingIn();
}

export function setStandingIn(since: string | null): void {
  if (since) setMeta(STAND_IN_META, since);
  else deleteMeta(STAND_IN_META);
  standInCache = since;
  changed();
}

export function setGroup(role: DeviceRole, primaryId: string | null = null): void {
  setMeta(ROLE_META, role);
  if (role === "secondary" && primaryId) setMeta(PRIMARY_META, primaryId);
  else deleteMeta(PRIMARY_META);
  cached = null;
  if (role !== "secondary") primaryUp = false;
  changed();
}

export function clearGroup(): void {
  deleteMeta(ROLE_META);
  deleteMeta(PRIMARY_META);
  deleteMeta(STAND_IN_META);
  standInCache = undefined;
  cached = null;
  primaryUp = false;
  changed();
}

export function setPrimaryUp(up: boolean): void {
  if (primaryUp === up) return;
  primaryUp = up;
  changed();
}

/** Called when the role or the primary's reachability changes (and so whether this computer forwards). */
export function onGroupChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a listener's problem stays its own */
    }
  }
}

/** Tests open several databases one after another. */
export function resetGroupCache(): void {
  cached = null;
  standInCache = undefined;
  primaryUp = false;
}
