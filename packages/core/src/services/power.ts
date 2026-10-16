/**
 * Lid-closed mode: a MacBook keeps working with its lid closed.
 *
 * `caffeinate` can't hold a Mac awake once the lid closes; only `pmset disablesleep 1` does, and it needs root. The first
 * time it is turned on, macOS asks for the password once and Godmode installs a sudoers rule for this user that allows
 * exactly `pmset -a disablesleep 0|1` without a password. Every switch after that goes through `sudo -n`.
 *
 * Godmode lets the Mac sleep again when it quits, on low battery and (if set) while no agent works. A marker file in the
 * data dir says Godmode owns `disablesleep`: it is written before sleep is turned off, so a crash or a quit at the
 * password dialog is repaired on the next start, and a `disablesleep` someone set by hand (no marker) is left alone.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import type { PowerSettings, PowerState, PowerStatus } from "@godmode/shared";
import { config } from "../config";
import { get } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { HttpError, sleep } from "../util";
import { notify } from "./notifications";
import { getSettings, updateSettings } from "./settings";

const log = logger("power");

const PMSET = "/usr/bin/pmset";
const RULES_DIR = "/private/etc/sudoers.d";
/** After the last run ends, "only while agents work" waits this long before the Mac may sleep. */
const IDLE_GRACE_MS = 3 * 60_000;
/** Above the limit by this much before a paused mode holds the Mac awake again. */
const BATTERY_HYSTERESIS = 5;
/** A usage-limit pause that resets within this keeps the Mac awake for it. */
const SHORT_LIMIT_MS = 60 * 60_000;
/** On quit: how long a switch under way may finish before sleep is given back regardless. */
const STOP_WAIT_MS = 1_000;
const RELEASE_FAILED = "Godmode couldn't let the Mac sleep again. Click \"Let the Mac sleep\" in Settings → General and enter your Mac password.";
const HOLD_FAILED = "Godmode is no longer allowed to keep the Mac awake. Turn lid-closed mode off and on again.";

export interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PowerDeps {
  platform: NodeJS.Platform;
  /** `signal` stops the command (the password dialog when Godmode quits). */
  exec(argv: string[], signal?: AbortSignal): Promise<Exec>;
  user: string;
  markerPath(): string;
  pollMs: number;
  idleGraceMs: number;
}

async function run(argv: string[], signal?: AbortSignal): Promise<Exec> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stop = () => proc.kill();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

const defaults: PowerDeps = {
  platform: process.platform,
  exec: run,
  user: userInfo().username,
  markerPath: () => join(config().dataDir, "power-sleep-disabled"),
  pollMs: 60_000,
  idleGraceMs: IDLE_GRACE_MS,
};
let deps = defaults;

export function setPowerDeps(overrides: Partial<PowerDeps> | null) {
  deps = overrides ? { ...defaults, ...overrides } : defaults;
}

/** One rule file per user (several people on one Mac); sudo skips names with a dot, so the user's dots become `_`. */
export function ruleFile(user: string): string {
  return `${RULES_DIR}/godmode-power-${user.replace(/\./g, "_")}`;
}

interface Reading {
  hasLid: boolean;
  sleepDisabled: boolean;
  lidClosed: boolean | null;
  battery: { percent: number; charging: boolean } | null;
}

/** Once seen, a lid stays: a single empty `ioreg` answer must not hide the switch or skip a release. */
let lidSeen = false;

async function read(): Promise<Reading> {
  const [settings, batt, lid] = await Promise.all([
    deps.exec([PMSET, "-g"]),
    deps.exec([PMSET, "-g", "batt"]),
    deps.exec(["/usr/sbin/ioreg", "-r", "-k", "AppleClamshellState", "-d", "1"]),
  ]);
  const state = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(lid.stdout);
  const percent = /InternalBattery[^\n]*?(\d{1,3})%/.exec(batt.stdout);
  // A lid and a built-in battery: a MacBook, not a desktop Mac that reports a clamshell state.
  if (state && percent) lidSeen = true;
  return {
    hasLid: lidSeen,
    sleepDisabled: /^\s*SleepDisabled\s+1\b/m.test(settings.stdout),
    lidClosed: state ? state[1] === "Yes" : null,
    battery: percent ? { percent: Number(percent[1]), charging: !/'Battery Power'/.test(batt.stdout) } : null,
  };
}

let started = false;
let reading: Reading | null = null;
let permission: boolean | null = null;
let pausedForBattery = false;
let lastError: string | null = null;
/** Runs that work, or wait for an answer (or a usage limit that resets soon), which must reach them. */
const activeRuns = new Set<string>();
let idleSince: number | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();
let asking: AbortController | null = null;
/** Aborted when Godmode stops: no password dialog opens after that. */
let stopping = new AbortController();
let lastStatus = "";

/** One change to the power state at a time: the poll, the runs and the API must not interleave pmset calls. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

function settings(): PowerSettings {
  return getSettings().power;
}

function lowBattery(s: PowerSettings, r: Reading): boolean {
  const b = r.battery;
  if (!s.minBattery || !b || b.charging) return false;
  return b.percent <= s.minBattery + (pausedForBattery ? BATTERY_HYSTERESIS : 0);
}

function idle(s: PowerSettings): boolean {
  return s.onlyWhileWorking && activeRuns.size === 0 && idleSince !== null && Date.now() - idleSince >= deps.idleGraceMs;
}

function stateOf(s: PowerSettings): PowerState {
  if (!s.lidClosedAwake) return lastError ? "error" : "off";
  if (lastError) return "error";
  if (pausedForBattery) return "low_battery";
  if (idle(s)) return "idle";
  return "on";
}

function marked(): boolean {
  return existsSync(deps.markerPath());
}

function mark(on: boolean) {
  try {
    if (on) writeFileSync(deps.markerPath(), new Date().toISOString());
    else rmSync(deps.markerPath(), { force: true });
  } catch (err) {
    log.warn("could not write the lid-closed marker", err);
  }
}

async function checkPermission(): Promise<boolean> {
  // `-l <cmd>` says whether the command is allowed; `-n` makes it fail instead of asking for a password.
  const r = await deps.exec(["/usr/bin/sudo", "-n", "-l", PMSET, "-a", "disablesleep", "1"]);
  permission = r.code === 0;
  return permission;
}

async function pmset(on: boolean): Promise<boolean> {
  const r = await deps.exec(["/usr/bin/sudo", "-n", PMSET, "-a", "disablesleep", on ? "1" : "0"]);
  if (r.code !== 0) {
    permission = false;
    log.warn(`pmset disablesleep ${on ? 1 : 0} failed`, { code: r.code, stderr: r.stderr.trim().slice(0, 300) });
  }
  return r.code === 0;
}

/**
 * The shell script root runs once: write the rule next to its final place under a name sudo skips (only root can
 * write there, unlike $TMPDIR), check it with visudo, move it in place in one step, then apply the first switch.
 */
export function setupScript(user: string, on: boolean): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(user)) throw new Error("Unexpected user name");
  const rule = `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 0, ${PMSET} -a disablesleep 1`;
  return [
    `f=$(/usr/bin/mktemp ${RULES_DIR}/.godmode-power.XXXXXX) || exit 1`,
    `/usr/bin/printf '%s\\n' '# Godmode: keep working with the lid closed' '${rule}' > "$f"`,
    `/bin/chmod 0440 "$f" && /usr/sbin/visudo -cf "$f" && /bin/mv -f "$f" ${ruleFile(user)}`,
    "s=$?",
    '/bin/rm -f "$f"',
    `[ $s -eq 0 ] && ${PMSET} -a disablesleep ${on ? 1 : 0}`,
  ].join("; ");
}

/** macOS's own password dialog. Resolves false when the human cancels it (or Godmode quits meanwhile). */
async function askForPermission(on: boolean): Promise<boolean> {
  const script = setupScript(deps.user, on).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const prompt = "Godmode wants to keep this Mac awake while its lid is closed, so your agents keep working.";
  if (!started || stopping.signal.aborted) return false;
  asking = new AbortController();
  const signal = AbortSignal.any([asking.signal, stopping.signal]);
  try {
    const r = await deps.exec(["/usr/bin/osascript", "-e", `do shell script "${script}" with prompt "${prompt}" with administrator privileges`], signal);
    if (signal.aborted) return false;
    if (r.code === 0) {
      permission = true;
      return true;
    }
    if (/-128|cancel/i.test(r.stderr)) return false;
    throw new HttpError(500, `macOS refused the change: ${r.stderr.trim().slice(0, 200) || `exit ${r.code}`}`, "power_failed");
  } finally {
    asking = null;
  }
}

async function refresh(): Promise<Reading> {
  reading = await read();
  return reading;
}

function failed(message: string) {
  if (lastError === message) return;
  lastError = message;
  if (message === RELEASE_FAILED) notify("error", "Your Mac can't sleep with the lid closed", message, "/settings/general");
}

/** Bring `disablesleep` in line with the setting, the runs and the battery. */
async function reconcile(): Promise<void> {
  if (!started) return;
  const r = await refresh();
  // Godmode stopped while reading: stopPower gives sleep back, nothing may take it again.
  if (!started) return;
  const s = settings();
  const low = s.lidClosedAwake && lowBattery(s, r);
  if (low && !pausedForBattery) {
    notify("warning", "Lid-closed mode paused", `The battery is at ${r.battery?.percent}%. Your Mac may sleep with the lid closed until it charges.`, "/settings/general");
  }
  pausedForBattery = low;
  const want = s.lidClosedAwake && r.hasLid && !low && !idle(s);
  if (want && !r.sleepDisabled) {
    mark(true);
    if (await pmset(true)) lastError = null;
    else failed(HOLD_FAILED);
  } else if (!want && r.sleepDisabled && marked()) {
    if (await pmset(false)) {
      mark(false);
      lastError = null;
    } else failed(RELEASE_FAILED);
  } else {
    // Settled: nothing of Godmode's is left to give back once sleep is on again.
    if (!r.sleepDisabled) mark(false);
    if (want || !r.sleepDisabled) lastError = null;
  }
  await refresh();
  emitIfChanged();
  scheduleIdleCheck(s);
}

/** "Only while agents work": check again when the grace after the last run is over. */
function scheduleIdleCheck(s: PowerSettings) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!s.lidClosedAwake || !s.onlyWhileWorking || activeRuns.size || idleSince === null || idle(s)) return;
  idleTimer = setTimeout(() => void serial(reconcile).catch(() => undefined), Math.max(0, idleSince + deps.idleGraceMs - Date.now()) + 50);
  idleTimer.unref?.();
}

function emitIfChanged() {
  const s = snapshot(reading);
  const next = JSON.stringify({ ...s, battery: s.battery?.charging });
  if (next === lastStatus) return;
  lastStatus = next;
  bus.changed("power");
}

function snapshot(r: Reading | null): PowerStatus {
  const s = settings();
  return {
    supported: deps.platform === "darwin" && !!r?.hasLid,
    enabled: s.lidClosedAwake,
    active: !!r?.sleepDisabled,
    state: stateOf(s),
    permission: !!permission,
    owned: marked(),
    lidClosed: r?.lidClosed ?? null,
    battery: r?.battery ?? null,
    error: lastError,
  };
}

export async function powerStatus(): Promise<PowerStatus> {
  if (deps.platform !== "darwin") return { ...snapshot(null), supported: false };
  // Its own reading: a GET must not overwrite what a switch under way just read.
  const r = await read();
  if (permission === null) await checkPermission();
  return snapshot(r);
}

/** Turn lid-closed mode on or off. The first time (or after the rule was removed) macOS asks for the password. */
export function setLidClosedAwake(on: boolean): Promise<PowerStatus> {
  return serial(async () => {
    if (deps.platform !== "darwin" || !started) throw new HttpError(409, "Lid-closed mode only works in Godmode on a MacBook.", "unsupported");
    const r = await refresh();
    if (!r.hasLid) throw new HttpError(409, "This Mac has no lid to close.", "unsupported");
    // Switching it on hands disablesleep to Godmode, also when it was set by hand: the marker goes first.
    const switchNow = on ? !r.sleepDisabled : r.sleepDisabled && marked();
    const hadMarker = marked();
    if (on) mark(true);
    if (switchNow && !(await pmset(on))) {
      let allowed = false;
      try {
        allowed = await askForPermission(on);
      } catch (err) {
        if (on && !hadMarker) mark(false);
        throw err;
      }
      if (!allowed) {
        // Stopped at the dialog: root may already have acted, so the marker stays for stopPower and the next start.
        if (on && !hadMarker && started) mark(false);
        throw new HttpError(409, "The Mac password wasn't entered, so nothing changed.", "power_cancelled");
      }
    }
    if (!on && switchNow) mark(false);
    lastError = null;
    pausedForBattery = false;
    idleSince = activeRuns.size ? null : Date.now();
    updateSettings({ power: { lidClosedAwake: on } });
    if (on) startPolling();
    else stopPolling();
    // Godmode quit while the dialog was open: give sleep back right away.
    if (!started) {
      if (on && (await pmset(false))) mark(false);
      throw new HttpError(409, "Godmode is shutting down.", "unsupported");
    }
    await reconcile();
    await checkPermission();
    return snapshot(reading);
  });
}

function startPolling() {
  if (pollTimer || !started) return;
  pollTimer = setInterval(() => void serial(reconcile).catch((err) => log.warn("lid-closed check failed", err)), deps.pollMs);
  pollTimer.unref?.();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** A pause the Mac should stay awake for: a question, or a usage limit that resets soon. Paused by hand or held by a budget: no. */
function waitsShortly(runId: string): boolean {
  const pause = get<{ reason: string; resume_at: string | null }>("SELECT reason, resume_at FROM paused_runs WHERE run_id = ?", runId);
  if (pause?.reason === "question") return true;
  if (pause?.reason !== "limit" || !pause.resume_at) return false;
  return Date.parse(pause.resume_at) - Date.now() <= SHORT_LIMIT_MS;
}

function onRuns() {
  if (activeRuns.size) idleSince = null;
  else if (idleSince === null) idleSince = Date.now();
  const s = settings();
  if (!s.lidClosedAwake || !s.onlyWhileWorking) return;
  void serial(reconcile).catch((err) => log.warn("lid-closed check failed", err));
}

export function startPower(): Promise<void> {
  if (started || deps.platform !== "darwin") return Promise.resolve();
  started = true;
  idleSince = Date.now();
  stopping = new AbortController();
  unsubscribe = bus.on((event) => {
    if (event.type === "run.started") activeRuns.add(event.run.id);
    else if (event.type === "run.finished") activeRuns.delete(event.run.id);
    else if (event.type === "run.paused") {
      if (!waitsShortly(event.run.id)) activeRuns.delete(event.run.id);
    }
    else if (event.type === "entity.changed" && event.entity === "settings") {
      void serial(reconcile).catch(() => undefined);
      return;
    } else return;
    onRuns();
  });
  if (settings().lidClosedAwake) startPolling();
  return serial(reconcile).catch((err) => log.warn("lid-closed mode could not start", err));
}

/** On quit: the Mac may sleep with the lid closed again, unless sleep was turned off by hand. */
export async function stopPower(): Promise<void> {
  if (!started) return;
  started = false;
  unsubscribe?.();
  unsubscribe = null;
  stopPolling();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  activeRuns.clear();
  stopping.abort();
  await Promise.race([queue, sleep(STOP_WAIT_MS)]);
  if (!marked()) return;
  if (await pmset(false)) mark(false);
}

/** Tests: forget what this process learned about the Mac. */
export function resetPowerState() {
  lidSeen = false;
  reading = null;
  permission = null;
  pausedForBattery = false;
  lastError = null;
  lastStatus = "";
  idleSince = null;
}
