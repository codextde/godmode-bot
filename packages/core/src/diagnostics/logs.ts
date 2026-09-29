/**
 * The diagnostic log (owner: core): reading, filtering and grouping `logs/godmode.jsonl`, the report that
 * Settings → Logs copies for an AI to analyze, and deleting it.
 */
import { closeSync, openSync, readFileSync, readSync, rmSync, statSync, truncateSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { join } from "node:path";
import type { LogEntry, LogIssue, LogLevel, LogOverview } from "@godmode/shared";
import { config } from "../config";
import { get } from "../db";
import { LOG_FILE, ROTATED_LOG_FILE, logFileCleared, scrub } from "../log";
import { listActiveRuns } from "../runner/runner";
import { getSettings } from "../services/settings";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const REPORT_MAX_BYTES = 250_000;
const DESKTOP_LOG = "desktop.log";
const DESKTOP_TAIL_LINES = 60;
const CACHE_IDLE_MS = 120_000;

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

interface FileCache {
  ino: number;
  size: number;
  entries: LogEntry[];
}

const cache = new Map<string, FileCache>();
let dropTimer: ReturnType<typeof setTimeout> | null = null;

function isEntry(v: unknown): v is LogEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.ts === "string" && typeof e.msg === "string" && typeof e.scope === "string" && typeof e.level === "string" && e.level in RANK;
}

function parse(buf: Buffer): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      const e: unknown = JSON.parse(line);
      if (isEntry(e)) out.push(e);
    } catch {
      /* not a log line */
    }
  }
  return out;
}

function readRange(path: string, from: number, to: number): Buffer {
  const buf = Buffer.alloc(to - from);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Entries of one file, oldest first. The live file is read incrementally: only what was appended since last time. */
function entriesOf(path: string, appendOnly: boolean): LogEntry[] {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    cache.delete(path);
    return [];
  }
  const prev = cache.get(path);
  if (prev && prev.ino === st.ino && prev.size === st.size) return prev.entries;
  const from = appendOnly && prev && prev.ino === st.ino && st.size > prev.size ? prev.size : 0;
  const buf = readRange(path, from, st.size);
  // A line still being written stays for the next read.
  const end = buf.lastIndexOf(0x0a) + 1;
  const parsed = parse(buf.subarray(0, end));
  const entries = from && prev ? prev.entries.concat(parsed) : parsed;
  cache.set(path, { ino: st.ino, size: from + end, entries });
  return entries;
}

function logPath(name = LOG_FILE): string {
  return join(config().logsDir, name);
}

/** Both files: [older (rotated), current], each oldest first. */
function sources(): LogEntry[][] {
  if (dropTimer) clearTimeout(dropTimer);
  dropTimer = setTimeout(() => cache.clear(), CACHE_IDLE_MS);
  dropTimer.unref?.();
  return [entriesOf(logPath(ROTATED_LOG_FILE), false), entriesOf(logPath(), true)];
}

function* newestFirst(lists: LogEntry[][]): Generator<LogEntry> {
  for (let l = lists.length - 1; l >= 0; l--) {
    const list = lists[l];
    for (let i = list.length - 1; i >= 0; i--) yield list[i];
  }
}

export interface LogQuery {
  /** Minimum level. */
  level?: LogLevel;
  search?: string;
  limit?: number;
}

function matches(e: LogEntry, q: string): boolean {
  if (e.msg.toLowerCase().includes(q) || e.scope.toLowerCase().includes(q)) return true;
  if (e.err && `${e.err.message} ${e.err.stack ?? ""}`.toLowerCase().includes(q)) return true;
  return !!e.data && JSON.stringify(e.data).toLowerCase().includes(q);
}

/** Newest first. */
export function listLogEntries(query: LogQuery = {}): LogEntry[] {
  const min = RANK[query.level ?? "debug"];
  const q = query.search?.trim().toLowerCase() ?? "";
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 300)), 2000);
  const out: LogEntry[] = [];
  for (const e of newestFirst(sources())) {
    if (RANK[e.level] < min || (q && !matches(e, q))) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

/** What a message says without the ids, numbers and hashes that differ between occurrences. */
export function fingerprint(msg: string): string {
  return msg
    .replace(/\b[a-z]+_[A-Za-z0-9]{8,}\b/g, "<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .trim();
}

function groupIssues(lists: LogEntry[][], limit: number): (LogIssue & { sample: LogEntry })[] {
  const groups = new Map<string, LogIssue & { sample: LogEntry }>();
  for (const list of lists) {
    for (const e of list) {
      if (e.level !== "warn" && e.level !== "error") continue;
      const key = `${e.level}|${e.scope}|${fingerprint(e.msg)}`;
      const g = groups.get(key);
      if (g) {
        g.count++;
        g.lastTs = e.ts;
        g.msg = e.msg;
        g.sample = e;
      } else groups.set(key, { level: e.level, scope: e.scope, msg: e.msg, count: 1, firstTs: e.ts, lastTs: e.ts, sample: e });
    }
  }
  return [...groups.values()]
    .sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1) || b.count - a.count || b.lastTs.localeCompare(a.lastTs))
    .slice(0, limit);
}

export function logOverview(): LogOverview {
  const lists = sources();
  const counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  let entries = 0;
  for (const list of lists) {
    for (const e of list) counts[e.level]++;
    entries += list.length;
  }
  let sizeBytes = 0;
  for (const name of [LOG_FILE, ROTATED_LOG_FILE]) {
    try {
      sizeBytes += statSync(logPath(name)).size;
    } catch {
      /* missing */
    }
  }
  const oldest = lists.find((l) => l.length)?.[0] ?? null;
  const newest = [...lists].reverse().find((l) => l.length)?.at(-1) ?? null;
  return {
    path: logPath(),
    sizeBytes,
    entries,
    counts,
    firstTs: oldest?.ts ?? null,
    lastTs: newest?.ts ?? null,
    issues: groupIssues(lists, 10).map(({ sample: _sample, ...issue }) => issue),
  };
}

/** Delete the diagnostic log (and the desktop shell's log, which the shell keeps open: emptied instead). */
export function clearLogs(): void {
  for (const name of [LOG_FILE, ROTATED_LOG_FILE, "core.log", `${DESKTOP_LOG}.1`]) rmSync(logPath(name), { force: true });
  try {
    truncateSync(logPath(DESKTOP_LOG), 0);
  } catch {
    /* not running as the desktop app */
  }
  logFileCleared();
  cache.clear();
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function duration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min ${Math.round((ms % 60_000) / 1000)} s`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function when(ts: string): string {
  return `${ts.slice(0, 19).replace("T", " ")}Z`;
}

function cell(text: unknown): string {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").slice(0, 240);
}

function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function max(values: number[]): number {
  return values.reduce((a, b) => (b > a ? b : a), -Infinity);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function environment(): string[] {
  const cfg = config();
  const s = getSettings();
  const cpu = cpus();
  const active = listActiveRuns();
  const count = (table: string, noun: string) => {
    const n = get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? 0;
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
  };
  const on = (v: boolean) => (v ? "on" : "off");
  return [
    `- Godmode ${cfg.version} · ${cfg.mode === "server" ? "web dashboard (godmode serve)" : "desktop app"} · ${cfg.platform} ${release()} (${cfg.arch}) · Bun ${Bun.version}`,
    `- ${cpu.length} × ${cpu[0]?.model.trim() ?? "CPU"} · ${bytes(totalmem())} RAM · core up ${duration(process.uptime() * 1000)}, using ${bytes(process.memoryUsage().rss)}`,
    `- Settings: model ${s.runner.model}, effort ${s.runner.effort}, up to ${s.runner.maxConcurrentRuns} runs at once, run timeout ${s.runner.runTimeoutMinutes ? `${s.runner.runTimeoutMinutes} min` : "none"} · browser ${on(s.browser.enabled)}${s.browser.headless ? " (headless)" : ""} · computer use ${on(s.computer.enabled)} · VMs ${on(s.vm.enabled)} · memory ${s.memory.backend}, dreaming ${on(s.memory.dreaming.enabled)} · detailed logging ${on(s.diagnostics.verbose)}`,
    `- ${count("agents", "agent")}, ${count("routines", "routine")}, ${count("workspaces", "workspace")} · now ${active.filter((r) => r.status === "running").length} running and ${active.filter((r) => r.status === "queued").length} queued runs`,
  ];
}

function issuesSection(lists: LogEntry[][]): string[] {
  const issues = groupIssues(lists, 15);
  if (!issues.length) return ["No warnings or errors recorded."];
  const out = ["| Count | Level | Scope | Message (latest) | First seen | Last seen |", "|---:|---|---|---|---|---|"];
  for (const i of issues) out.push(`| ${i.count} | ${i.level} | ${cell(i.scope)} | ${cell(i.msg)} | ${when(i.firstTs)} | ${when(i.lastTs)} |`);
  const samples = issues.filter((i) => i.sample.err?.stack || i.sample.data).slice(0, 6);
  if (samples.length) {
    out.push("", "Latest occurrence of the top problems:", "");
    for (const i of samples) out.push("```json", JSON.stringify(i.sample, null, 2), "```");
  }
  return out;
}

function runsSection(lists: LogEntry[][]): string[] {
  const runs = lists.flat().filter((e) => e.scope === "runner" && typeof e.data?.status === "string" && (e.msg === "run finished" || e.msg.startsWith("run failed")));
  if (!runs.length) return ["No runs finished while this log was recorded."];
  const status = (s: string) => runs.filter((e) => e.data!.status === s).length;
  const ms = runs.map((e) => num(e.data!.ms)).filter((v): v is number => v !== null);
  const queued = runs.map((e) => num(e.data!.queuedMs)).filter((v): v is number => v !== null);
  const cost = runs.reduce((sum, e) => sum + (num(e.data!.costUsd) ?? 0), 0);
  const slowest = runs.reduce<LogEntry | null>((a, e) => ((num(e.data!.ms) ?? 0) > (num(a?.data?.ms) ?? -1) ? e : a), null);
  const out = [
    `- ${runs.length} runs: ${status("succeeded")} succeeded, ${status("failed")} failed, ${status("cancelled")} cancelled · total cost $${cost.toFixed(2)}`,
    `- Duration: median ${duration(median(ms))}, slowest ${duration(num(slowest?.data?.ms) ?? NaN)}${slowest ? ` (${str(slowest.data!.runId) ?? "?"}, ${str(slowest.data!.trigger) ?? "?"})` : ""} · queue wait: median ${duration(median(queued))}, longest ${duration(queued.length ? max(queued) : NaN)}`,
  ];
  const failures = new Map<string, { count: number; text: string }>();
  for (const e of runs) {
    const error = str(e.data!.error);
    if (e.data!.status !== "failed" || !error) continue;
    const key = fingerprint(error);
    const f = failures.get(key);
    if (f) f.count++;
    else failures.set(key, { count: 1, text: error });
  }
  if (failures.size) {
    out.push("- Failures:");
    for (const f of [...failures.values()].sort((a, b) => b.count - a.count).slice(0, 8)) out.push(`  - ${f.count}× ${cell(f.text)}`);
  }
  const tools = new Map<string, number>();
  for (const e of runs) {
    const failed = e.data!.failedTools;
    if (!Array.isArray(failed)) continue;
    for (const t of failed) {
      const name = str((t as { name?: unknown })?.name);
      if (name) tools.set(name, (tools.get(name) ?? 0) + 1);
    }
  }
  if (tools.size) {
    const top = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    out.push(`- Tool calls that failed most: ${top.map(([name, n]) => `${name} ×${n}`).join(", ")}`);
  }
  return out;
}

function slowSection(lists: LogEntry[][]): string[] {
  const all = lists.flat();
  const table = (title: string, rows: LogEntry[], key: (e: LogEntry) => string | null) => {
    const groups = new Map<string, number[]>();
    for (const e of rows) {
      const k = key(e);
      const ms = num(e.data?.ms);
      if (!k || ms === null) continue;
      const list = groups.get(k);
      if (list) list.push(ms);
      else groups.set(k, [ms]);
    }
    if (!groups.size) return [];
    const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || max(b[1]) - max(a[1])).slice(0, 12);
    return [`**${title}**`, "", "| What | Count | Median | Slowest |", "|---|---:|---:|---:|", ...sorted.map(([k, v]) => `| ${cell(k)} | ${v.length} | ${duration(median(v))} | ${duration(max(v))} |`), ""];
  };
  const out = [
    ...table("Requests slower than 1 s", all.filter((e) => e.scope === "http" && e.msg === "slow request"), (e) => `${str(e.data?.method) ?? ""} ${str(e.data?.route) ?? ""}`.trim()),
    ...table("Agent tool calls slower than 10 s", all.filter((e) => e.scope === "mcp" && e.msg === "slow tool call"), (e) => str(e.data?.tool)),
    ...table("Slow database queries", all.filter((e) => e.scope === "db" && e.msg === "slow database query"), (e) => str(e.data?.sql)),
    ...table("Event loop blocked (the core could not respond meanwhile)", all.filter((e) => e.scope === "perf" && e.msg === "event loop blocked"), () => "core"),
  ];
  return out.length ? out : ["Nothing slow recorded."];
}

function desktopTail(): string[] {
  let text: string;
  try {
    text = readFileSync(logPath(DESKTOP_LOG), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean).slice(-DESKTOP_TAIL_LINES);
  if (!lines.length) return [];
  return ["## Desktop app shell (last lines of desktop.log)", "", "```text", ...lines.map((l) => scrub(l).slice(0, 1000)), "```", ""];
}

/**
 * Markdown for an AI: environment, recurring problems, runs, slow spots, then the newest entries as JSON Lines —
 * as many as fit in `maxBytes`.
 */
export function buildLogReport(maxBytes = REPORT_MAX_BYTES): string {
  const lists = sources();
  const overview = logOverview();
  const range = overview.firstTs && overview.lastTs ? `from ${when(overview.firstTs)} to ${when(overview.lastTs)}` : "(empty)";
  const head = [
    "# Godmode diagnostic log",
    "",
    "Diagnostic log of Godmode Bot (https://github.com/codextde/godmode-bot). Please find bugs, slow spots and other problems,",
    "explain their likely cause in the code and suggest fixes. Passwords, 2FA codes, tokens and API keys are masked.",
    "",
    "## Environment",
    "",
    ...environment(),
    `- Log: ${overview.entries} entries ${range} · ${overview.counts.error} errors, ${overview.counts.warn} warnings`,
    "",
    "## Recurring problems",
    "",
    ...issuesSection(lists),
    "",
    "## Runs",
    "",
    ...runsSection(lists),
    "",
    "## Slow spots",
    "",
    ...slowSection(lists),
    "",
    ...desktopTail(),
  ].join("\n");

  const budget = maxBytes - Buffer.byteLength(head) - 400;
  const picked: string[] = [];
  let used = 0;
  for (const e of newestFirst(lists)) {
    const line = JSON.stringify(e);
    const size = Buffer.byteLength(line) + 1;
    if (used + size > budget) break;
    picked.push(line);
    used += size;
  }
  picked.reverse();
  const omitted = overview.entries - picked.length;
  return [
    head,
    `## Entries (${picked.length === overview.entries ? "all" : `newest ${picked.length}`}, oldest first)`,
    "",
    ...(omitted > 0 ? [`${omitted} older entries don't fit here — the full log is in Settings → Logs → Download.`, ""] : []),
    "```jsonl",
    ...picked,
    "```",
    "",
  ].join("\n");
}
