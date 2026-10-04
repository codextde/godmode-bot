/**
 * Keeps the runner's Mac awake: a runner that falls asleep stops working, and working while nobody is at the machine is
 * what it is for. macOS only — everywhere else each function does nothing.
 *
 * `caffeinate` holds the power assertions. It is bound to this process with `-w <pid>`, so nothing is left behind when
 * the runner is killed.
 */
import { bus } from "../events/bus";
import { logger } from "../log";

const log = logger("keep-awake");

const CAFFEINATE = "/usr/bin/caffeinate";

/** `system`: no idle, disk or system sleep, for as long as the runner serves · `display`: the screen stays on while runs work. */
type Assertion = "system" | "display";
const FLAGS: Record<Assertion, string[]> = { system: ["-i", "-m", "-s"], display: ["-d"] };

interface Helper {
  exited: Promise<unknown>;
  kill(): void;
}

export interface KeepAwakeDeps {
  platform: NodeJS.Platform;
  spawn(argv: string[]): Helper;
  /** Pause before a helper that died is started again (a missing binary must not spin). */
  restartDelayMs: number;
}

const defaults: KeepAwakeDeps = {
  platform: process.platform,
  spawn: (argv) => Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
  restartDelayMs: 5_000,
};
let deps = defaults;

/** Replace how helpers are spawned (tests); null restores the real ones. */
export function setKeepAwakeDeps(overrides: Partial<KeepAwakeDeps> | null) {
  deps = overrides ? { ...defaults, ...overrides } : defaults;
}

export interface KeepAwakeStatus {
  supported: boolean;
  /** The system assertion is held. */
  active: boolean;
  /** The display assertion is held (runs are working). */
  display: boolean;
}

const helpers: Record<Assertion, Helper | null> = { system: null, display: null };
const retries: Record<Assertion, ReturnType<typeof setTimeout> | null> = { system: null, display: null };
/** Runs that work right now; the display stays on while there is one. */
const activeRuns = new Set<string>();
let started = false;
let working = false;
let unsubscribe: (() => void) | null = null;

function wanted(kind: Assertion): boolean {
  return started && (kind === "system" || working);
}

function hold(kind: Assertion) {
  if (helpers[kind]) return;
  let helper: Helper;
  try {
    helper = deps.spawn([CAFFEINATE, ...FLAGS[kind], "-w", String(process.pid)]);
  } catch (err) {
    log.warn(`could not start caffeinate (${kind})`, err);
    retryLater(kind);
    return;
  }
  helpers[kind] = helper;
  const onExit = () => {
    // Released or replaced on purpose: nothing to bring back.
    if (helpers[kind] !== helper) return;
    helpers[kind] = null;
    if (!wanted(kind)) return;
    log.warn(`caffeinate (${kind}) stopped, starting it again`);
    retryLater(kind);
  };
  helper.exited.then(onExit, onExit);
}

function retryLater(kind: Assertion) {
  if (retries[kind]) return;
  const timer = setTimeout(() => {
    retries[kind] = null;
    if (wanted(kind)) hold(kind);
  }, deps.restartDelayMs);
  timer.unref?.();
  retries[kind] = timer;
}

function release(kind: Assertion) {
  if (retries[kind]) clearTimeout(retries[kind]);
  retries[kind] = null;
  const helper = helpers[kind];
  helpers[kind] = null;
  try {
    helper?.kill();
  } catch {
    /* already gone */
  }
}

/** Hold the machine awake for the life of this process and keep the display on while runs work. */
export function startKeepAwake() {
  if (started || deps.platform !== "darwin") return;
  started = true;
  hold("system");
  unsubscribe = bus.on((event) => {
    // A paused run waits (for a usage limit, for the human): the screen may sleep until it continues with `run.started`.
    if (event.type === "run.started") activeRuns.add(event.run.id);
    else if (event.type === "run.finished" || event.type === "run.paused") activeRuns.delete(event.run.id);
    else return;
    setWorking(activeRuns.size > 0);
  });
}

/** While runs are active the display stays on too: a sleeping display gives browsers and screen control nothing to draw on. */
export function setWorking(active: boolean) {
  working = active;
  if (!started) return;
  if (active) hold("display");
  else release("display");
}

export function keepAwakeStatus(): KeepAwakeStatus {
  return { supported: deps.platform === "darwin", active: helpers.system !== null, display: helpers.display !== null };
}

/** Replace the helpers (the health view's fix for a caffeinate that is gone) without losing track of the active runs. */
export function restartKeepAwake() {
  if (!started) {
    startKeepAwake();
    return;
  }
  release("system");
  release("display");
  hold("system");
  if (working) hold("display");
}

export function stopKeepAwake() {
  started = false;
  working = false;
  unsubscribe?.();
  unsubscribe = null;
  activeRuns.clear();
  release("system");
  release("display");
}
