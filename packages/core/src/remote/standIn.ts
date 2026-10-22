/**
 * A secondary standing in for its primary while that is away (owner: remote). Every computer of the group has the
 * shared data (replica.ts), so a secondary works fully on its own the moment its primary can't be reached. What only one
 * computer of a group runs — the schedules, the board, messaging, phone calls — moves here `standInMinutes` after the
 * primary went (at once when it said goodbye): index.ts starts it once `runsShared()` says so, and the chats that were
 * working on the primary continue here from a recap. remote/devices.ts hands it all back when the primary returns.
 */
import type { StandIn } from "@godmode/shared";
import { deleteMeta, get, getMeta, setMeta } from "../db";
import { logger } from "../log";
import { badRequest, now } from "../util";
import { isSecondary, primaryRunnerId, setStandingIn, standingIn, standingInSince } from "./group";
import { missingFolders } from "./localPaths";

const log = logger("devices");

const ENABLED_META = "link.group.standIn";
const MINUTES_META = "link.group.standInMinutes";
const DEFAULT_MINUTES = 2;
const GOODBYE_WAIT_MS = 45_000;
const RECHECK_MS = 60_000;

export interface TakeOver {
  /** When the primary was last seen: automations due since then run here once. */
  lostAt: string;
}

let waiting: { timer: ReturnType<typeof setTimeout>; at: string; lostAt: string } | null = null;
let goodbye = false;
/** Counts the primary's returns: a take-over that started before one doesn't go on after it. */
let returns = 0;
let takeOver: ((t: TakeOver) => Promise<void>) | null = null;
let changed: (() => void) | null = null;
let online: (() => Promise<boolean>) | null = null;

/**
 * remote/devices.ts: what taking over means (continue the primary's work here), how the UI hears of it, and whether
 * this computer itself is online (one that lost the internet is the one cut off: it doesn't take over).
 */
export function setStandInHooks(hooks: { takeOver: (t: TakeOver) => Promise<void>; changed: () => void; online: () => Promise<boolean> } | null): void {
  takeOver = hooks?.takeOver ?? null;
  changed = hooks?.changed ?? null;
  online = hooks?.online ?? null;
  if (!hooks) cancelWaiting();
}

export function standInSettings(): { standInEnabled: boolean; standInMinutes: number } {
  const minutes = Number(getMeta(MINUTES_META));
  return {
    standInEnabled: getMeta(ENABLED_META) !== "0",
    standInMinutes: Number.isInteger(minutes) && minutes >= 1 && minutes <= 60 ? minutes : DEFAULT_MINUTES,
  };
}

/** The primary keeps the setting; secondaries keep the copy it last told them, for while it is away. */
export function setStandInSettings(input: { standInEnabled?: boolean; standInMinutes?: number }): void {
  if (input.standInMinutes !== undefined && (!Number.isInteger(input.standInMinutes) || input.standInMinutes < 1 || input.standInMinutes > 60)) {
    throw badRequest("Give 1 to 60 minutes");
  }
  if (input.standInEnabled !== undefined) setMeta(ENABLED_META, input.standInEnabled ? "1" : "0");
  if (input.standInMinutes !== undefined) setMeta(MINUTES_META, String(input.standInMinutes));
  changed?.();
}

export function standInState(): StandIn {
  const since = standingInSince();
  if (since) return { state: "active", since, takesOverAt: null };
  if (waiting) return { state: "waiting", since: null, takesOverAt: waiting.at };
  return { state: "off", since: null, takesOverAt: null };
}

function cancelWaiting(): void {
  if (waiting) clearTimeout(waiting.timer);
  waiting = null;
}

/** The primary can't be reached (again): this computer takes over after the grace time, unless it is back by then. */
export function primaryWentAway(lastSeen: string | null): void {
  if (!isSecondary() || standingIn() || waiting || !takeOver) return;
  const settings = standInSettings();
  if (!settings.standInEnabled) return;
  // GODMODE_STAND_IN_MS: tests don't wait minutes. A primary that said goodbye may only be restarting (an update): a
  // short wait still, so its chats keep their sessions when it is back within it.
  const full = Number(process.env.GODMODE_STAND_IN_MS) || settings.standInMinutes * 60_000;
  const wait = goodbye ? Math.min(full, GOODBYE_WAIT_MS) : full;
  const at = new Date(Date.now() + wait).toISOString();
  const lostAt = lastSeen ?? now();
  const timer = setTimeout(() => {
    waiting = null;
    void begin(lostAt);
  }, wait);
  timer.unref?.();
  waiting = { timer, at, lostAt };
  log.info("the primary is away; this computer stands in if it isn't back in time", { minutes: wait / 60_000 });
  changed?.();
}

/** The primary said it goes away now (Godmode quits or restarts there): a shorter grace time. */
export function primaryLeftNow(): void {
  goodbye = true;
  if (!waiting) return;
  const lostAt = waiting.lostAt;
  cancelWaiting();
  primaryWentAway(lostAt);
}

/** The primary can be reached again: a take-over that waited doesn't happen. */
export function primaryIsBack(): void {
  returns++;
  goodbye = false;
  if (!waiting) return;
  cancelWaiting();
  changed?.();
}

async function begin(lostAt: string): Promise<void> {
  if (!isSecondary() || standingIn() || !takeOver) return;
  const since = returns;
  // GODMODE_STAND_IN_MS (tests) also skips the internet check.
  const reachable = online && !process.env.GODMODE_STAND_IN_MS ? await online().catch(() => true) : true;
  if (returns !== since) return;
  if (!reachable) {
    // Cut off itself (no internet): it looks again in a minute instead of running the group's work twice later.
    log.info("this computer is offline itself; it doesn't stand in yet");
    const timer = setTimeout(() => {
      waiting = null;
      void begin(lostAt);
    }, RECHECK_MS);
    timer.unref?.();
    waiting = { timer, at: new Date(Date.now() + RECHECK_MS).toISOString(), lostAt };
    changed?.();
    return;
  }
  if (!isSecondary() || standingIn() || !takeOver) return;
  setStandingIn(now());
  log.info("standing in for the primary");
  try {
    await takeOver({ lostAt });
  } catch (err) {
    log.warn("could not continue all of the primary's work here", err instanceof Error ? err.message : err);
  }
  changed?.();
}

/** The primary is back and has what changed here: the shared work stops here (index.ts). */
export function endStandIn(): void {
  cancelWaiting();
  goodbye = false;
  if (standingIn()) setStandingIn(null);
  changed?.();
}

/** Leaving the group: nothing to stand in for anymore. */
export function forgetStandIn(): void {
  cancelWaiting();
  goodbye = false;
  deleteMeta(ENABLED_META);
  deleteMeta(MINUTES_META);
}

/**
 * Why a stand-in doesn't start an agent's dream or automation on its own, or null. The agent's memory never came over
 * from the primary (its folder here is the empty template), or the prompt names folders this computer doesn't have:
 * that work would run blind and its memory would clash with the primary's when it is back.
 */
export function standInHold(agentId: string, prompt?: string): string | null {
  if (!standingIn()) return null;
  const primary = primaryRunnerId();
  if (primary && !get("SELECT 1 FROM runner_memory WHERE runner_id = ? AND agent_id = ?", primary, agentId)) {
    return "Waits for the primary: this agent's memory never came over to this computer";
  }
  const missing = prompt ? missingFolders(prompt) : [];
  if (missing.length) return `Waits for the primary: ${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} on this computer`;
  return null;
}
