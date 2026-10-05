/**
 * Upkeep of the tools Godmode relies on: "Fix all" (repair permissions, install what is missing), installing
 * updates and cleaning up — on request, and on its own in the background (settings.maintenance).
 *
 * Only what Godmode can do by itself happens here. System dialogs (macOS privacy) are never opened unasked, a tool is
 * only replaced while nothing runs from it (updates wait until no agent is working), and what failed unasked is left
 * alone for a day instead of being tried again every few hours.
 */
import type { CleanupId, CleanupRun, DependencyId, FixReport, FixResult, MaintenanceStatus, ToolId, ToolUpdateResult, ToolUpdateStatus } from "@godmode/shared";
import { bus } from "../events/bus";
import { logger } from "../log";
import { listActiveRuns } from "../runner/runner";
import { now } from "../util";
import { RECOMMENDED, lastAutomaticCleanup, runCleanup } from "./cleanup";
import { installDependency, runDoctor } from "./doctor";
import { checkPermissions, fixPermission } from "./permissions";
import { onSettingsApplied } from "./runtime";
import { getSettings } from "./settings";
import { NEWEST_UNKNOWN, checkUpdates, dueUpdates, leftToHuman, updateAll, updateBlocked, updateTool } from "./updates";

const log = logger("maintenance");

const DELAYS = {
  firstPass: 2 * 60_000,
  pass: 6 * 60 * 60_000,
  /** Updates that had to wait (agents working, a browser open) are looked at again this often. */
  retry: 15 * 60_000,
  settingChanged: 5_000,
  /** What failed unasked isn't tried again unasked for this long. */
  giveUp: 24 * 60 * 60_000,
  /** The automatic cleanup runs at most this often. */
  cleanup: 24 * 60 * 60_000,
};
let delays = { ...DELAYS };

/** uv first: browser-use, Chromium and Cua Driver are downloaded with it. */
const INSTALL_ORDER: DependencyId[] = ["uv", "claude", "browser-use", "chrome", "claude-mem", "cua-driver"];

/* ------------------------------------------------------------------ */
/* One at a time                                                        */
/* ------------------------------------------------------------------ */

let queue: Promise<unknown> = Promise.resolve();

/** Repairs, installs and updates write into the same places, so they take turns — whoever asked for them. */
export function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------------ */
/* Giving up for a while                                                */
/* ------------------------------------------------------------------ */

/** Unasked attempts that failed ("install:uv", "update:claude:2.1.300") → when they may be tried again. */
const gaveUp = new Map<string, number>();

const tired = (key: string) => (gaveUp.get(key) ?? 0) > Date.now();

/** The human asked: whatever failed before gets another chance. */
function forget(prefix: string) {
  for (const key of gaveUp.keys()) if (key.startsWith(prefix)) gaveUp.delete(key);
}

/* ------------------------------------------------------------------ */
/* Fix all                                                              */
/* ------------------------------------------------------------------ */

/**
 * Repair every problem Godmode can repair itself: its own files and folders, and required tools that are missing.
 * Problems only the human can solve come back as "manual" with what to do; optional pieces and macOS privacy
 * permissions are left to their own buttons.
 */
export function fixAll(): Promise<FixReport> {
  return inTurn(() => {
    forget("install:");
    return doFixAll(false);
  });
}

async function doFixAll(unasked: boolean): Promise<FixReport> {
  const startedAt = now();
  const results: FixResult[] = [];

  // Permissions first: nothing can be installed into a folder Godmode may not write. Only files — the macOS privacy
  // permissions need the human anyway.
  for (const p of (await checkPermissions({ privacy: false })).permissions) {
    if (!p.ok) results.push(await fixPermission(p.id, { interactive: false }));
  }

  // Installs reset the system check's cache, so each step sees what the one before changed.
  await runDoctor(true);
  for (const id of INSTALL_ORDER) {
    const dep = (await runDoctor()).dependencies.find((d) => d.id === id);
    if (!dep || dep.ok || !dep.required || !dep.installable) continue;
    if (unasked) {
      // A program that is there but doesn't answer may be in the middle of its own update, or broken in a way its
      // installer won't cure. Unasked, only what is plainly absent gets installed.
      if ((id === "claude" || id === "uv") && dep.path) continue;
      if (tired(`install:${id}`)) continue;
    }
    const res = await installDependency(id);
    // What counts is that it works now, not what the installer's exit code said.
    const ok = !!(await runDoctor()).dependencies.find((d) => d.id === id)?.ok;
    if (ok) gaveUp.delete(`install:${id}`);
    else if (unasked) gaveUp.set(`install:${id}`, Date.now() + delays.giveUp);
    const output = ok || !res.ok ? res.output : `${res.output}\n\nThe installer finished, but ${dep.name} still doesn't work.`;
    results.push({ kind: "dependency", id, name: dep.name, outcome: ok ? "fixed" : "failed", output });
  }
  const [doctor, permissions] = await Promise.all([runDoctor(), checkPermissions({ privacy: false })]);
  const tried = new Set(results.map((r) => r.id));
  for (const dep of doctor.dependencies) {
    if (!dep.ok && dep.required && !tried.has(dep.id)) results.push({ kind: "dependency", id: dep.id, name: dep.name, outcome: "manual", output: dep.installHint });
  }

  const fixed = results.filter((r) => r.outcome === "fixed");
  if (fixed.length) {
    log.info(`fixed ${fixed.map((r) => r.id).join(", ")}`);
    bus.changed("system");
  }
  for (const r of results) if (r.outcome === "failed") log.warn(`could not fix ${r.id}: ${r.output.slice(-300)}`);
  return { ok: doctor.ok && permissions.ok, startedAt, finishedAt: now(), results };
}

/* ------------------------------------------------------------------ */
/* Updates                                                              */
/* ------------------------------------------------------------------ */

/** Install the update of one tool, or every available update. */
export function installUpdates(id?: ToolId): Promise<ToolUpdateResult[]> {
  return inTurn(async () => {
    forget(id ? `update:${id}:` : "update:");
    const results = id ? [await updateTool(id)] : await updateAll();
    if (results.length) bus.changed("system");
    return results;
  });
}

const BUSY = "Agents are working — updates are installed once they are done.";

/** Updates the background pass found but couldn't install yet (agents working, a browser open). */
let waiting: ToolUpdateStatus[] = [];

/**
 * Install what may be installed right now. An update can take minutes, so "is anything working?" is asked again
 * before every single one.
 */
async function installDue(due: ToolUpdateStatus[]): Promise<{ updates: ToolUpdateResult[]; postponed: string | null; left: ToolUpdateStatus[] }> {
  const updates: ToolUpdateResult[] = [];
  const left: ToolUpdateStatus[] = [];
  let postponed: string | null = null;
  for (const tool of due) {
    const blocked = busyCheck() ? BUSY : await updateBlocked(tool.id);
    if (blocked) {
      postponed = blocked;
      left.push(tool);
      continue;
    }
    const result = await updateTool(tool.id);
    // Already done by someone else in the meantime: nothing to report.
    if (result.upToDate) continue;
    // Offline just now: that is no failed update, it keeps waiting.
    if (result.output === NEWEST_UNKNOWN) {
      postponed = "The release feeds couldn't be reached — updates are installed once they answer.";
      left.push(tool);
      continue;
    }
    updates.push(result);
    if (!result.ok) gaveUp.set(`update:${tool.id}:${tool.latest}`, Date.now() + delays.giveUp);
  }
  const done = updates.filter((u) => u.ok).map((u) => `${u.id} ${u.version ?? ""}`.trim());
  if (done.length) log.info(`updated ${done.join(", ")}`);
  return { updates, postponed, left };
}

/* ------------------------------------------------------------------ */
/* Cleanup                                                              */
/* ------------------------------------------------------------------ */

/** Clean up the given items (Settings → Cleanup); takes its turn with repairs and updates. */
export function cleanUp(ids: readonly CleanupId[]): Promise<CleanupRun> {
  return inTurn(() => runCleanup(ids));
}

/** The recommended items, once a day, while nothing works. */
async function cleanUpUnasked(): Promise<void> {
  if (Date.now() - lastAutomaticCleanup() < delays.cleanup) return;
  if (busyCheck()) return;
  await runCleanup(RECOMMENDED, { automatic: true });
}

/* ------------------------------------------------------------------ */
/* Background                                                           */
/* ------------------------------------------------------------------ */

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let nextPassAt = 0;
let status: MaintenanceStatus = { running: false, lastRunAt: null, nextRunAt: null, postponed: null, fixes: [], updates: [] };

const agentsWorking = () => listActiveRuns().length > 0;
let busyCheck = agentsWorking;

/** Tests: forget what earlier passes did; optionally replace the "is an agent working?" check and the waiting times. */
export function __resetMaintenanceForTests(opts: { busy?: () => boolean; delays?: Partial<typeof DELAYS> } = {}) {
  busyCheck = opts.busy ?? agentsWorking;
  delays = { ...DELAYS, ...opts.delays };
  gaveUp.clear();
  waiting = [];
  nextPassAt = 0;
  status = { running: false, lastRunAt: null, nextRunAt: null, postponed: null, fixes: [], updates: [] };
}

export function maintenanceStatus(): MaintenanceStatus {
  return status;
}

function schedule(delayMs: number, task: () => Promise<unknown>) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!started) return;
  status = { ...status, nextRunAt: new Date(Date.now() + delayMs).toISOString() };
  timer = setTimeout(() => {
    timer = null;
    void task().catch((err) => log.warn("maintenance pass failed", err));
  }, delayMs);
}

/** The next thing to do: look again at updates that are waiting, or the next full pass. */
function scheduleNext() {
  const untilPass = Math.max(nextPassAt - Date.now(), 0);
  if (waiting.length && untilPass > delays.retry) schedule(delays.retry, retryPostponedUpdates);
  else schedule(untilPass, runMaintenance);
}

/** One background pass: repairs, then updates, as far as the settings allow. Schedules the next one. */
export function runMaintenance(): Promise<MaintenanceStatus> {
  return inTurn(async () => {
    const settings = getSettings();
    const { autoFix, autoUpdate, autoCleanup } = settings.maintenance;
    nextPassAt = Date.now() + delays.pass;
    waiting = [];
    // Until onboarding is done the human installs things step by step, with their own clicks.
    if (!settings.onboardingComplete || (!autoFix && !autoUpdate && !autoCleanup)) {
      status = { ...status, running: false, postponed: null };
      scheduleNext();
      return status;
    }
    status = { ...status, running: true };
    let fixes: FixResult[] = [];
    let updates: ToolUpdateResult[] = [];
    let postponed: string | null = null;
    try {
      if (autoFix) fixes = (await doFixAll(true)).results;
      if (autoUpdate) {
        const due = dueUpdates(await checkUpdates(true)).filter((t) => !leftToHuman(t.id) && !tired(`update:${t.id}:${t.latest}`));
        ({ updates, postponed, left: waiting } = await installDue(due));
      }
      if (autoCleanup) await cleanUpUnasked().catch((err) => log.warn("automatic cleanup failed", err));
    } finally {
      status = { running: false, lastRunAt: now(), nextRunAt: status.nextRunAt, postponed, fixes, updates };
      scheduleNext();
      // The page shows what the last pass did, even when that was nothing.
      bus.changed("system");
    }
    return status;
  });
}

/**
 * Between passes: install the updates that had to wait, as soon as nothing stands in their way. Only asks whether
 * the way is clear — no release feeds, no system check — so it can run often.
 */
export function retryPostponedUpdates(): Promise<MaintenanceStatus> {
  return inTurn(async () => {
    const due = getSettings().maintenance.autoUpdate ? waiting : [];
    const { updates, postponed, left } = await installDue(due);
    waiting = left;
    status = { ...status, postponed, updates: [...status.updates, ...updates] };
    scheduleNext();
    if (updates.length) bus.changed("system");
    return status;
  });
}

let applied = { autoFix: false, autoUpdate: false, autoCleanup: false };

export function startMaintenance() {
  if (started) return;
  started = true;
  applied = { ...getSettings().maintenance };
  nextPassAt = Date.now() + delays.firstPass;
  scheduleNext();
}

export function stopMaintenance() {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

// Turning the upkeep on shouldn't take hours to show: run a pass shortly after.
onSettingsApplied((settings) => {
  const next = settings.maintenance;
  const turnedOn = (next.autoFix && !applied.autoFix) || (next.autoUpdate && !applied.autoUpdate) || (next.autoCleanup && !applied.autoCleanup);
  applied = { ...next };
  if (started && turnedOn) schedule(delays.settingChanged, runMaintenance);
});
