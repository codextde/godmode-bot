/**
 * The watchdog looks at every running run twice a minute. A run that shows no sign of life (Claude Code wrote nothing)
 * for too long, or that calls the same tool with the same input and gets the same result over and over, is stopped:
 * it fails with a report that says exactly where it stood. A board ticket then tries again on its own (tasks/service
 * retries a stalled run once), a heartbeat's next beat picks the work up, and anything else is escalated to the human.
 */
import type { MessageBlock, WatchdogEvent, WatchdogKind } from "@godmode/shared";
import { DEFAULT_LOOP_REPEATS, DEFAULT_STALL_MINUTES, RUN_WATCHDOG, toolActivity } from "@godmode/shared";
import { all, get, insert, run as exec } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { newId, now } from "../util";
import { redact } from "../vault/vault";
import { notify } from "../services/notifications";
import { getSettings } from "../services/settings";
import { stopStalledRun, watchedRuns, type WatchedRun } from "./runner";

const log = logger("watchdog");

let TICK_MS = 30_000;
/** Tests: stall limits in ms instead of minutes. */
let stallMsForTests: number | null = null;
/** A step that runs (a build, a download, a background task) may take this much longer than the model alone. */
const TOOL_FACTOR = 3;
const MIN_TOOL_STALL_MS = 30 * 60_000;
const KEEP_DAYS = 90;
/** Steps that wait on purpose — for another agent, or for the human. */
const WAITING_TOOLS: ReadonlySet<string> = new Set(["mcp__godmode__agent_delegate", "mcp__godmode__ask_human", "mcp__godmode__request_approval"]);

export interface Verdict {
  kind: WatchdogKind;
  report: string;
}

export interface WatchdogLimits {
  stallMs: number;
  loopRepeats: number;
}

type ToolBlock = Extract<MessageBlock, { type: "tool_use" }>;

const DETAIL_KEYS = ["command", "url", "file_path", "path", "query", "pattern"];

function stepLabel(b: ToolBlock): string {
  const phrase = toolActivity(b.name, b.input, { redact }).replace(/…$/, "");
  const tool = /^mcp__(.+?)__(.+)$/.exec(b.name)?.[2] ?? b.name;
  const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
  const raw = DETAIL_KEYS.map((k) => input[k]).find((v): v is string => typeof v === "string" && !!v.trim());
  const detail = raw ? redact(raw).replace(/\s+/g, " ").trim() : "";
  const shown = detail && !phrase.includes(detail) ? `: ${detail.length > 80 ? `${detail.slice(0, 79)}…` : detail}` : "";
  return `“${phrase}” (${tool}${shown})`;
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** The same step, the same input and the same answer `repeats` times in a row (per agent: the run or a subagent). */
function loopOf(blocks: readonly MessageBlock[], repeats: number): ToolBlock | null {
  const byParent = new Map<string, ToolBlock[]>();
  for (const b of blocks) {
    if (b.type !== "tool_use") continue;
    const key = b.parentToolUseId ?? "";
    const list = byParent.get(key) ?? [];
    list.push(b);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    if (list.length < repeats) continue;
    const tail = list.slice(-repeats);
    const first = tail[0]!;
    if (first.result === undefined) continue;
    const input = JSON.stringify(first.input ?? null);
    if (tail.every((b) => b.name === first.name && b.result === first.result && JSON.stringify(b.input ?? null) === input)) return first;
  }
  return null;
}

/** What the watchdog makes of a running run right now; null = it is fine. */
export function assess(run: Pick<WatchedRun, "blocks" | "lastOutputAt" | "startedAt" | "waiting">, at: number, limits: WatchdogLimits): Verdict | null {
  if (run.waiting) return null;
  const tools = run.blocks.filter((b): b is ToolBlock => b.type === "tool_use");
  const looping = limits.loopRepeats >= 2 ? loopOf(run.blocks, limits.loopRepeats) : null;
  if (looping) {
    return {
      kind: "looping",
      report: `${RUN_WATCHDOG}: it ran ${stepLabel(looping)} ${limits.loopRepeats} times in a row with the same input and got the same result each time — it was going in circles.`,
    };
  }
  const pending = [...tools].reverse().find((b) => b.result === undefined) ?? null;
  if (pending && WAITING_TOOLS.has(pending.name)) return null;
  const background = tools.find((b) => b.task?.status === "running") ?? null;
  const busy = pending ?? background;
  const limit = busy ? Math.max(limits.stallMs * TOOL_FACTOR, Math.min(MIN_TOOL_STALL_MS, limits.stallMs * 10)) : limits.stallMs;
  const idle = at - run.lastOutputAt;
  if (idle < limit) return null;
  const done = tools.filter((b) => b.result !== undefined);
  const last = done[done.length - 1];
  const where = pending
    ? `while this step ran: ${stepLabel(pending)}`
    : background
      ? `while a background task ran: ${stepLabel(background)}`
      : last
        ? `after its last step, ${stepLabel(last)}, while the model was thinking or writing`
        : "before its first step, while the model was thinking or writing";
  const steps = done.length ? ` It had made ${done.length} step${done.length === 1 ? "" : "s"} in ${minutes(at - run.startedAt)}.` : "";
  return { kind: "stalled", report: `${RUN_WATCHDOG}: no sign of life for ${minutes(idle)} ${where}.${steps}` };
}

export function watchdogLimits(): WatchdogLimits | null {
  const r = getSettings().runner;
  if (r.watchdog === false) return null;
  const stallMinutes = Math.min(240, Math.max(3, Math.round(Number(r.stallMinutes) || DEFAULT_STALL_MINUTES)));
  const loopRepeats = Math.min(50, Math.max(3, Math.round(Number(r.loopRepeats) || DEFAULT_LOOP_REPEATS)));
  return { stallMs: stallMsForTests ?? stallMinutes * 60_000, loopRepeats };
}

interface EventRow {
  id: string;
  run_id: string;
  agent_id: string;
  conversation_id: string;
  task_id: string | null;
  task_number: number | null;
  kind: WatchdogKind;
  report: string;
  action: "retry" | "escalated";
  created_at: string;
}

function toEvent(r: EventRow): WatchdogEvent {
  return {
    id: r.id,
    runId: r.run_id,
    agentId: r.agent_id,
    conversationId: r.conversation_id,
    taskId: r.task_id,
    taskNumber: r.task_number,
    kind: r.kind,
    report: r.report,
    action: r.action,
    createdAt: r.created_at,
  };
}

export function listWatchdogEvents(agentId: string, limit = 20): WatchdogEvent[] {
  return all<EventRow>(
    `SELECT w.*, t.number AS task_number FROM watchdog_events w LEFT JOIN tasks t ON t.id = w.task_id
      WHERE w.agent_id = ? ORDER BY w.created_at DESC, w.rowid DESC LIMIT ?`,
    agentId,
    limit,
  ).map(toEvent);
}

/** A board ticket tries a stalled run again once; a second stall in a day, and every other run, goes to the human. */
function actionFor(run: WatchedRun, taskId: string | null): "retry" | "escalated" {
  if (run.trigger === "heartbeat" && !taskId) return "retry";
  if (!taskId) return "escalated";
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  return get("SELECT 1 FROM watchdog_events WHERE task_id = ? AND created_at > ? LIMIT 1", taskId, since) ? "escalated" : "retry";
}

function intervene(run: WatchedRun, verdict: Verdict): void {
  const task = get<{ id: string; number: number }>("SELECT id, number FROM tasks WHERE conversation_id = ?", run.conversationId);
  const action = actionFor(run, task?.id ?? null);
  if (!stopStalledRun(run.runId, verdict.report)) return;
  insert("watchdog_events", {
    id: newId("wdg"),
    run_id: run.runId,
    agent_id: run.agentId,
    conversation_id: run.conversationId,
    task_id: task?.id ?? null,
    kind: verdict.kind,
    report: verdict.report,
    action,
    created_at: now(),
  });
  bus.changed("heartbeats");
  // A ticket that runs out of tries is blocked and reported by the board itself.
  if (action === "escalated" && !task) {
    const agent = get<{ name: string }>("SELECT name FROM agents WHERE id = ?", run.agentId)?.name ?? "An agent";
    const what = verdict.kind === "looping" ? "went in circles" : "stalled";
    notify("warning", `${agent}'s run ${what} — the watchdog stopped it`, verdict.report.slice(RUN_WATCHDOG.length + 2), `/chat/${run.conversationId}`);
  }
}

/** One look at every running run. */
export function checkRuns(at = Date.now()): number {
  const limits = watchdogLimits();
  if (!limits) return 0;
  let stopped = 0;
  for (const run of watchedRuns()) {
    try {
      const verdict = assess(run, at, limits);
      if (!verdict) continue;
      intervene(run, verdict);
      stopped++;
    } catch (err) {
      log.warn(`could not check run ${run.runId}`, err);
    }
  }
  return stopped;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startWatchdog(): void {
  if (timer) return;
  exec("DELETE FROM watchdog_events WHERE created_at < ?", new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString());
  timer = setInterval(() => checkRuns(), TICK_MS);
  timer.unref?.();
}

export function stopWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Tests: a faster tick and stall limit in ms (null = the real ones). */
export function __setWatchdogForTests(opts: { tickMs?: number; stallMs?: number | null }): void {
  if (typeof opts.tickMs === "number") TICK_MS = opts.tickMs;
  if ("stallMs" in opts) stallMsForTests = opts.stallMs ?? null;
  if (timer) {
    stopWatchdog();
    startWatchdog();
  }
}
