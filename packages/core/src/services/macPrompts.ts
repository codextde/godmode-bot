/**
 * macOS asks the person at the computer before a program may open some folders (the Desktop, Documents, a removable
 * drive) or do some things (control another app, record the screen), and whatever asked stands still until someone
 * answers: a command that lists ~/Desktop, or Claude Code itself. Nobody may sit at a runner's Mac for hours.
 *
 * While runs work on this Mac, Godmode follows the log of macOS's privacy service (`log stream`; where that can't run,
 * a short `log show` while a step is silent) for prompts that belong to this program. A pending prompt shows on the
 * runs it holds, tells the human once, and keeps the watchdog from stopping a run that only waits for the answer.
 * macOS only — elsewhere nothing starts.
 */
import { realpathSync } from "node:fs";
import { get } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { computerName } from "../mobile/devices";
import { listActiveRuns, noteRunActivity, watchedRuns, type WatchedRun } from "../runner/runner";
import { runCommand } from "./doctor";
import { notify } from "./notifications";
import { hostApp } from "./permissions";

const log = logger("mac-prompts");

const LOG = "/usr/bin/log";
const PREDICATE =
  'process == "tccd" AND subsystem == "com.apple.TCC" AND (eventMessage BEGINSWITH "AUTHREQ_PROMPTING" OR eventMessage BEGINSWITH "AUTHREQ_RESULT" OR eventMessage BEGINSWITH "Publishing <TCCDEvent")';
/** A run that wrote nothing since a moment after the prompt waits for it (its lines are read a little later). */
const SLACK_MS = 5_000;
/** Without the stream: how far back `log show` reads, and how often at most. */
const SHOW_LAST = "90s";
const SHOW_EVERY_MS = 30_000;

/** What a service lets a program do, in plain words: "macOS asks whether Godmode may <act>". */
const ACTS: Record<string, string> = {
  SystemPolicyDesktopFolder: "open your Desktop folder",
  SystemPolicyDocumentsFolder: "open your Documents folder",
  SystemPolicyDownloadsFolder: "open your Downloads folder",
  SystemPolicyRemovableVolumes: "open a removable drive",
  SystemPolicyNetworkVolumes: "open a network drive",
  SystemPolicyAppData: "open another app's data",
  FileProviderDomain: "open iCloud Drive or another cloud folder",
  FileProviderPresence: "open iCloud Drive or another cloud folder",
  AppleEvents: "control another app",
  AddressBook: "open your contacts",
  Calendar: "open your calendar",
  Reminders: "open your reminders",
  Photos: "open your photos",
  MediaLibrary: "open your music library",
  Microphone: "use the microphone",
  Camera: "use the camera",
  ScreenCapture: "record the screen",
  Accessibility: "control the computer",
  ListenEvent: "watch the keyboard",
};

/** Places Full Disk Access opens without asking. */
const FILES = new Set([
  "SystemPolicyDesktopFolder",
  "SystemPolicyDocumentsFolder",
  "SystemPolicyDownloadsFolder",
  "SystemPolicyRemovableVolumes",
  "SystemPolicyNetworkVolumes",
  "SystemPolicyAppData",
  "FileProviderDomain",
  "FileProviderPresence",
]);

const serviceName = (s: string) => s.replace(/^kTCCService/, "");

export function promptAct(service: string): string {
  return ACTS[serviceName(service)] ?? "use something macOS protects";
}

/* ------------------------------------------------------------------ */
/* The log                                                              */
/* ------------------------------------------------------------------ */

export type TccLine =
  | { kind: "prompting"; at: number; msgId: string; service: string; responsiblePath: string | null; binaryPath: string | null; pid: number | null }
  | { kind: "result"; at: number; msgId: string }
  | { kind: "event"; at: number; service: string; identifier: string };

const TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?\d*(Z|[+-]\d{2}:?\d{2})?/;

/** "2026-10-20 12:16:24.967038+0200" (ndjson, default style) or "2026-10-20 12:16:24.967" (compact, local time). */
function timeOf(text: string | undefined): number | null {
  const m = text ? TIME.exec(text) : null;
  if (!m) return null;
  const zone = m[4] ? m[4].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2") : "";
  const at = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ""}${zone}`);
  return Number.isFinite(at) ? at : null;
}

const field = (text: string, name: string) => new RegExp(`\\b${name}=([^,}]+)`).exec(text)?.[1]?.trim() || null;

/** One line of `log stream` / `log show` (ndjson, compact or default style) about a privacy prompt; null for anything else. */
export function parseTccLine(line: string): TccLine | null {
  const raw = line.trim();
  let message = raw;
  let time: string | undefined = raw;
  if (raw.startsWith("{")) {
    try {
      const e = JSON.parse(raw) as { eventMessage?: unknown; timestamp?: unknown };
      if (typeof e.eventMessage !== "string") return null;
      message = e.eventMessage;
      time = typeof e.timestamp === "string" ? e.timestamp : undefined;
    } catch {
      return null;
    }
  }
  const at = timeOf(time) ?? Date.now();
  let m = /AUTHREQ_PROMPTING: msgID=([^,\s]+), service=(\w+)/.exec(message);
  if (m) {
    // The process macOS holds responsible ("Resp:{TCCDProcess: … pid=…, responsible_path=…, binary_path=…}").
    const resp = message.slice(Math.max(0, message.indexOf("Resp:{")));
    const pid = Number(field(resp, "pid"));
    return {
      kind: "prompting",
      at,
      msgId: m[1]!,
      service: serviceName(m[2]!),
      responsiblePath: field(resp, "responsible_path"),
      binaryPath: field(resp, "binary_path"),
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    };
  }
  m = /AUTHREQ_RESULT: msgID=([^,\s]+)/.exec(message);
  if (m) return { kind: "result", at, msgId: m[1]! };
  m = /TCCDEvent: type=\w+, service=(\w+), identifier_type=\w+, identifier=([^>]+)>/.exec(message);
  if (m) return { kind: "event", at, service: serviceName(m[1]!), identifier: m[2]!.trim() };
  return null;
}

interface Owner {
  paths: Set<string>;
  bundle: string | null;
  bundleId: string | null;
}

let owner: Owner | null = null;

/** This program, and Godmode's app when it runs in one: what macOS holds responsible for what Godmode starts. */
function ownerOf(): Owner {
  if (owner) return owner;
  const paths = new Set([process.execPath]);
  try {
    paths.add(realpathSync(process.execPath));
  } catch {
    /* gone */
  }
  // Only Godmode's own app: a terminal it was started from asks for everything else in it too.
  const app = hostApp();
  owner = { paths, bundle: app.bundleId ? app.path : null, bundleId: app.bundleId };
  return owner;
}

/** A path (or bundle id) of this program. */
function ours(id: string | null): boolean {
  if (!id) return false;
  const own = ownerOf();
  return own.paths.has(id) || id === own.bundleId || (!!own.bundle && id.startsWith(`${own.bundle}/`));
}

/* ------------------------------------------------------------------ */
/* Pending prompts                                                      */
/* ------------------------------------------------------------------ */

interface Prompt {
  service: string;
  act: string;
  msgIds: Set<string>;
  /** When macOS asked: on the awake clock (like the watchdog's times), and on the wall clock. */
  at: number;
  since: number;
  /** Runs it held; once none of them is silent any more, someone answered. */
  held: Set<string>;
  /** Runs that show it as their activity. */
  shown: Set<string>;
  told: boolean;
}

/** By service: macOS shows one dialog per service, however many commands wait for it. */
const pending = new Map<string, Prompt>();
/** Prompts nobody answered: the watchdog names them when it stops a run they held. */
const givenUp: Prompt[] = [];
/** Prompts already read: `log show` reads the same lines again. */
const seen = new Set<string>();

/** What the watchdog learns about a run a macOS dialog holds. `pending`: it is still open, so the run waits for it. */
export interface MacPromptHold {
  pending: boolean;
  act: string;
  computer: string;
}

const holds = (p: Prompt, r: Pick<WatchedRun, "lastOutputAt" | "waiting">) => !r.waiting && r.lastOutputAt <= p.at + SLACK_MS;
const inStep = (r: WatchedRun) => r.blocks.some((b) => b.type === "tool_use" && b.result === undefined);

/**
 * The macOS dialog a silent run may wait for. While one is open that is any run: a second command that asks for the
 * same thing waits behind the dialog without a line in the log. A dialog nobody answered names the runs it held.
 */
export function macPromptHolding(run: Pick<WatchedRun, "runId" | "lastOutputAt" | "waiting">): MacPromptHold | null {
  const open = pending.values().next().value;
  if (open) return { pending: true, act: open.act, computer: computerName() };
  const old = givenUp.findLast((p) => p.held.has(run.runId) || holds(p, run));
  return old ? { pending: false, act: old.act, computer: computerName() } : null;
}

function onLine(line: string) {
  if (!watching) return;
  const e = parseTccLine(line);
  if (!e) return;
  if (e.kind === "result") {
    for (const p of [...pending.values()]) if (p.msgIds.has(e.msgId)) settle(p, "answered");
    return;
  }
  if (e.kind === "event") {
    const p = pending.get(e.service);
    if (p && ours(e.identifier)) settle(p, "answered");
    return;
  }
  if (seen.has(e.msgId) || !(ours(e.responsiblePath) || ours(e.binaryPath) || e.pid === process.pid)) return;
  seen.add(e.msgId);
  if (seen.size > 500) seen.delete(seen.values().next().value!);
  const at = performance.now() - Math.max(0, Date.now() - e.at);
  const known = pending.get(e.service);
  if (known) {
    // Another command waits for the same dialog: runs silent since then wait for it too.
    known.msgIds.add(e.msgId);
    known.at = Math.max(known.at, at);
    return;
  }
  pending.set(e.service, { service: e.service, act: promptAct(e.service), msgIds: new Set([e.msgId]), at, since: e.at, held: new Set(), shown: new Set(), told: false });
  log.info("macOS asks the person at this computer", { service: e.service });
  review();
}

function settle(p: Prompt, why: string) {
  pending.delete(p.service);
  for (const runId of p.shown) noteRunActivity(runId, null);
  log.info(`the macOS prompt is over (${why})`, { service: p.service });
}

/** Show pending prompts on the runs they hold, tell the human once, and let go of what is over. */
function review() {
  if (!pending.size) return;
  const runs = watchedRuns();
  for (const p of [...pending.values()]) {
    if (Date.now() - p.since > deps.giveUpMs) {
      settle(p, "nobody answered");
      givenUp.push(p);
      if (givenUp.length > 20) givenUp.shift();
      continue;
    }
    const holding = runs.filter((r) => holds(p, r));
    if (!holding.length && p.held.size) {
      settle(p, "its runs went on");
      continue;
    }
    for (const r of holding) p.held.add(r.runId);
    if (!p.told) {
      p.told = true;
      tell(p, holding.length ? holding : runs);
    }
    const label = `Waiting for you on ${computerName()}: macOS asks whether Godmode may ${p.act}`;
    for (const r of holding) {
      if (!inStep(r)) continue;
      p.shown.add(r.runId);
      noteRunActivity(r.runId, label);
    }
  }
}

function tell(p: Prompt, runs: WatchedRun[]) {
  const computer = computerName();
  const one = runs.length === 1 ? runs[0]! : null;
  const who = (one && get<{ name: string }>("SELECT name FROM agents WHERE id = ?", one.agentId)?.name) || "An agent";
  const app = ownerOf().bundle ? "Godmode" : `Godmode (${process.execPath})`;
  const never = FILES.has(p.service) ? `, or give ${app} Full Disk Access (System Settings → Privacy & Security → Full Disk Access) so it never asks again` : "";
  notify("warning", `macOS is waiting on ${computer}`, `${who} wants to ${p.act}. Click Allow in the macOS dialog on ${computer}${never}.`, one ? `/chat/${one.conversationId}` : null);
}

/* ------------------------------------------------------------------ */
/* Watching while runs work                                             */
/* ------------------------------------------------------------------ */

interface LogProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<unknown>;
  kill(): void;
}

export interface MacPromptDeps {
  platform: NodeJS.Platform;
  /** Follows the log (`log stream …`). */
  spawn(argv: string[]): LogProcess;
  /** Reads the log once (`log show …`): what it printed. */
  show(argv: string[]): Promise<string>;
  /** The watch goes on this long after the last run ended: the next one often follows right away. */
  lingerMs: number;
  tickMs: number;
  /** Without the stream, the log is read while a step has been silent this long. */
  silentMs: number;
  /** Nobody answered in this long: the prompt is given up, and named when the watchdog stops a run it held. */
  giveUpMs: number;
}

const defaults: MacPromptDeps = {
  platform: process.platform,
  spawn: (argv) => Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" }),
  show: async (argv) => (await runCommand(argv, { timeoutMs: 20_000, maxOutput: 4_000_000 })).stdout,
  lingerMs: 60_000,
  tickMs: 15_000,
  silentMs: 45_000,
  giveUpMs: 2 * 3_600_000,
};
let deps = defaults;

/** Replace how the log is read and the timings (tests); null restores the real ones. */
export function setMacPromptDeps(overrides: Partial<MacPromptDeps> | null) {
  deps = overrides ? { ...defaults, ...overrides } : defaults;
}

let unsubscribe: (() => void) | null = null;
let watching = false;
let stream: LogProcess | null = null;
/** No stream (it ended, or this user may not run it): `log show` while a step is silent. */
let polling = false;
/** The stream ended right after it started: not tried again until Godmode restarts. */
let streamRefused = false;
let linger: ReturnType<typeof setTimeout> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let shownAt = 0;
let showing = false;

const busy = () => listActiveRuns().some((r) => r.status === "running");

export function startMacPrompts(): void {
  if (unsubscribe || deps.platform !== "darwin") return;
  unsubscribe = bus.on((e) => {
    if (e.type === "run.started" || e.type === "run.finished" || e.type === "run.paused") update();
  });
  update();
}

export function stopMacPrompts(): void {
  unsubscribe?.();
  unsubscribe = null;
  unwatch();
}

/** Prompts pending right now (tests, diagnostics). */
export function pendingMacPrompts(): { service: string; act: string }[] {
  return [...pending.values()].map((p) => ({ service: p.service, act: p.act }));
}

function update() {
  if (busy()) {
    if (linger) clearTimeout(linger);
    linger = null;
    watch();
  } else if (watching && !linger) {
    linger = setTimeout(() => {
      linger = null;
      if (!busy()) unwatch();
    }, deps.lingerMs);
    linger.unref?.();
  }
}

function watch() {
  if (watching) return;
  watching = true;
  polling = streamRefused;
  if (!polling) follow();
  ticker = setInterval(tick, deps.tickMs);
  ticker.unref?.();
}

function unwatch() {
  if (linger) clearTimeout(linger);
  if (ticker) clearInterval(ticker);
  linger = ticker = null;
  const s = stream;
  stream = null;
  try {
    s?.kill();
  } catch {
    /* gone */
  }
  for (const p of [...pending.values()]) settle(p, "no run left");
  givenUp.length = 0;
  watching = polling = false;
  shownAt = 0;
}

function follow() {
  const startedAt = Date.now();
  let s: LogProcess;
  try {
    s = deps.spawn([LOG, "stream", "--style", "ndjson", "--predicate", PREDICATE]);
  } catch (err) {
    log.warn("could not follow the macOS privacy log", err);
    streamRefused = polling = true;
    return;
  }
  stream = s;
  void eachLine(s.stdout, onLine).catch(() => {});
  const ended = () => {
    // Stopped on purpose.
    if (stream !== s) return;
    stream = null;
    if (Date.now() - startedAt < 10_000) streamRefused = true;
    polling = true;
    log.info("the macOS privacy log stream ended: reading the log while a step is silent instead");
  };
  s.exited.then(ended, ended);
}

async function eachLine(stdout: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = done ? "" : lines.pop()!;
    for (const line of lines) onLine(line);
    if (done) return;
  }
}

function tick() {
  const silent = () => watchedRuns().some((r) => !r.waiting && inStep(r) && performance.now() - r.lastOutputAt > deps.silentMs);
  if (polling && !showing && Date.now() - shownAt >= SHOW_EVERY_MS && silent()) void show();
  review();
}

async function show() {
  showing = true;
  shownAt = Date.now();
  try {
    const out = await deps.show([LOG, "show", "--last", SHOW_LAST, "--style", "ndjson", "--predicate", PREDICATE]);
    for (const line of out.split("\n")) onLine(line);
  } catch (err) {
    log.warn("could not read the macOS privacy log", err);
  } finally {
    showing = false;
  }
}
