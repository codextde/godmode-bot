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
/** Without the stream: how far back `log show` reads, and how often at most. */
const SHOW_LAST = "90s";
const SHOW_EVERY_MS = 30_000;
/** A stream that ended is started again after this long; one that ends right after it starts three times, never. */
const RESTREAM_MS = 60_000;
/** One notification per service in this long: a command that gave up and tried again meets the same dialog. */
const TELL_EVERY_MS = 30 * 60_000;

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
  | { kind: "prompting"; at: number; msgId: string; service: string; responsiblePath: string | null; binaryPath: string | null; identifier: string | null; pid: number | null }
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
    // The process macOS holds responsible ("Resp:{TCCDProcess: identifier=…, pid=…, responsible_path=…, binary_path=…}").
    const resp = message.slice(Math.max(0, message.indexOf("Resp:{")));
    const pid = Number(field(resp, "pid"));
    return {
      kind: "prompting",
      at,
      msgId: m[1]!,
      service: serviceName(m[2]!),
      responsiblePath: field(resp, "responsible_path"),
      binaryPath: field(resp, "binary_path"),
      identifier: field(resp, "identifier"),
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
  /** On the awake clock (like the watchdog's times): when macOS first asked, and last asked again. */
  first: number;
  at: number;
  /** Runs it held; without the stream, once none of them is silent any more, someone answered. */
  held: Set<string>;
  /** Runs that show it as their activity. */
  shown: Set<string>;
}

/** By service: macOS shows one dialog per service, however many commands wait for it. */
const pending = new Map<string, Prompt>();
/** Prompts nobody answered: the watchdog names them when it stops a run they held. */
const givenUp: Prompt[] = [];
/** Prompts already read: `log show` reads the same lines again. */
const seen = new Set<string>();
/** When the human was last told about a dialog, by service (wall clock). */
const told = new Map<string, number>();

/** What the watchdog learns about a run a macOS dialog holds. `pending`: it is still open, so the run waits for it. */
export interface MacPromptHold {
  pending: boolean;
  act: string;
  computer: string;
}

/** Silent since macOS asked (its lines are read a moment after they are written). */
const silentSince = (p: Prompt, r: Pick<WatchedRun, "lastOutputAt" | "waiting">) => !r.waiting && r.lastOutputAt <= p.at + deps.slackMs;
/** In a step that may wait for macOS: Godmode's own tools run in Godmode, not in a command of the run. */
const inStep = (r: WatchedRun) => r.blocks.some((b) => b.type === "tool_use" && b.result === undefined && !b.name.startsWith("mcp__godmode__"));

/**
 * The macOS dialog a silent run may wait for. While one is open that is any run silent for less than macOS is waited
 * for: a second command that asks for the same thing waits behind the dialog without a line in the log. Past that, or
 * once nobody answered, only the runs it held are told what they waited for.
 */
export function macPromptHolding(run: Pick<WatchedRun, "runId" | "lastOutputAt" | "waiting">): MacPromptHold | null {
  const open = pending.values().next().value;
  if (open && performance.now() - run.lastOutputAt <= deps.giveUpMs) return { pending: true, act: open.act, computer: computerName() };
  const old = [...givenUp, ...pending.values()].findLast((p) => p.held.has(run.runId) && silentSince(p, run));
  return old ? { pending: false, act: old.act, computer: computerName() } : null;
}

function onLine(line: string) {
  if (!watching) return;
  const e = parseTccLine(line);
  if (!e) return;
  if (e.kind === "result" || e.kind === "event") {
    const answers = (p: Prompt) => (e.kind === "result" ? p.msgIds.has(e.msgId) : p.service === e.service && ours(e.identifier));
    for (const p of [...pending.values()]) if (answers(p)) settle(p, "answered");
    for (let i = givenUp.length - 1; i >= 0; i--) if (answers(givenUp[i]!)) givenUp.splice(i, 1);
    return;
  }
  if (seen.has(e.msgId) || !(ours(e.responsiblePath) || ours(e.binaryPath) || ours(e.identifier) || e.pid === process.pid)) return;
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
  pending.set(e.service, { service: e.service, act: promptAct(e.service), msgIds: new Set([e.msgId]), first: at, at, held: new Set(), shown: new Set() });
  log.info("macOS asks the person at this computer", { service: e.service });
  review();
  // Who it holds shows once the runs at work wrote again.
  setTimeout(() => safely(review), Math.max(0, at + deps.slackMs - performance.now()) + 100).unref?.();
}

function settle(p: Prompt, why: string) {
  pending.delete(p.service);
  for (const runId of p.shown) noteRunActivity(runId, null);
  log.info(`the macOS prompt is over (${why})`, { service: p.service });
}

/** Show pending prompts on the runs they hold, tell the human once, and let go of what is over. */
function review() {
  if (!watching || !pending.size) return;
  const runs = watchedRuns();
  for (const p of [...pending.values()]) {
    if (performance.now() - p.first > deps.giveUpMs) {
      settle(p, "nobody answered");
      givenUp.push(p);
      if (givenUp.length > 20) givenUp.shift();
      continue;
    }
    // Right after macOS asked, every run still looks silent: the ones at work show once they wrote again.
    if (performance.now() < p.at + deps.slackMs) continue;
    const holding = runs.filter((r) => inStep(r) && silentSince(p, r));
    // The stream reads the answer; without it, runs that go on again are the sign (a command that timed out goes on too).
    if (!stream && !holding.length && p.held.size) {
      settle(p, "its runs went on");
      continue;
    }
    for (const r of holding) p.held.add(r.runId);
    if (Date.now() - (told.get(p.service) ?? 0) > TELL_EVERY_MS) {
      told.set(p.service, Date.now());
      tell(p, holding.length ? holding : runs);
    }
    const label = `Waiting for you on ${computerName()}: macOS asks whether Godmode may ${p.act}`;
    for (const r of holding) {
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
  /** A run that wrote nothing since this long after macOS asked waits for it (its lines are read a little later). */
  slackMs: number;
}

const defaults: MacPromptDeps = {
  platform: process.platform,
  spawn: (argv) => Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" }),
  show: async (argv) => (await runCommand(argv, { timeoutMs: 20_000, maxOutput: 4_000_000 })).stdout,
  lingerMs: 60_000,
  tickMs: 15_000,
  silentMs: 45_000,
  giveUpMs: 2 * 3_600_000,
  slackMs: 5_000,
};
let deps = defaults;

/** Replace how the log is read and the timings (tests); null restores the real ones. */
export function setMacPromptDeps(overrides: Partial<MacPromptDeps> | null) {
  deps = overrides ? { ...defaults, ...overrides } : defaults;
}

let unsubscribe: (() => void) | null = null;
let watching = false;
/** null: no stream (it ended, or this user may not run it), so `log show` reads the log while a step is silent. */
let stream: LogProcess | null = null;
let streamEndedAt = 0;
/** Streams in a row that ended right after they started. */
let quickEnds = 0;
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

const mayStream = () => quickEnds < 3;

function watch() {
  if (watching) return;
  watching = true;
  if (mayStream()) follow();
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
  watching = false;
  shownAt = 0;
}

function follow() {
  const startedAt = Date.now();
  let s: LogProcess;
  try {
    s = deps.spawn([LOG, "stream", "--style", "ndjson", "--predicate", PREDICATE]);
  } catch (err) {
    log.warn("could not follow the macOS privacy log", err);
    quickEnds = 3;
    return;
  }
  stream = s;
  void eachLine(s.stdout, onLine).catch(() => {});
  const ended = () => {
    // Stopped on purpose.
    if (stream !== s) return;
    stream = null;
    streamEndedAt = Date.now();
    quickEnds = Date.now() - startedAt < 10_000 ? quickEnds + 1 : 0;
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
    for (const line of lines) safely(() => onLine(line));
    if (done) return;
  }
}

function safely(fn: () => void) {
  try {
    fn();
  } catch (err) {
    log.warn("could not handle a macOS privacy prompt", err);
  }
}

function tick() {
  safely(() => {
    // A run that ended without telling (it crashed) leaves no event behind.
    if (!busy()) update();
    if (!watching) return;
    if (!stream && mayStream() && Date.now() - streamEndedAt >= RESTREAM_MS) follow();
    const silent = () => watchedRuns().some((r) => !r.waiting && inStep(r) && performance.now() - r.lastOutputAt > deps.silentMs);
    if (!stream && !showing && Date.now() - shownAt >= SHOW_EVERY_MS && silent()) void show();
    review();
  });
}

async function show() {
  showing = true;
  shownAt = Date.now();
  try {
    const out = await deps.show([LOG, "show", "--last", SHOW_LAST, "--style", "ndjson", "--predicate", PREDICATE]);
    for (const line of out.split("\n")) safely(() => onLine(line));
  } catch (err) {
    log.warn("could not read the macOS privacy log", err);
  } finally {
    showing = false;
  }
}
