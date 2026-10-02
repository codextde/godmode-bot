/**
 * Paused runs (owner: runner).
 *
 * A run stands still when the human pauses it, or when Claude's usage limit is reached while it works. It has not
 * ended: its chat is frozen — messages wait in the queue, runs behind it wait — and continuing picks the work up where
 * it stopped, in the same run, the same assistant message and the same Claude session (runner.ts: `pauseRun`,
 * `resumeRun`). A run that waits for the limit continues by itself once the limit has reset
 * (settings.runner.autoContinueOnLimit). Pauses survive a restart.
 */
import type { PauseReason, Run, RunPause } from "@godmode/shared";
import { all, bool, get, insert, run as exec } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { HttpError, badRequest, conflict, notFound, now } from "../util";
import { LIMIT_TEXT, type StreamLimit } from "../runner/stream";
import { cancelRun, listActiveRuns, pauseRun, resumeRun } from "../runner/runner";
import { emitConversationUpdated } from "./conversations";
import { notify } from "./notifications";
import { getSettings } from "./settings";

const log = logger("pauses");

/** Claude's servers may need a moment after the reset: continue a little later. */
const RESET_MARGIN_MS = 30_000;
/** The limit should have reset but Claude still refuses: try again after this long. */
const RETRY_MS = 5 * 60_000;
/** Tries in a row that hit the limit again before the run stops continuing by itself. */
export const MAX_RETRIES = 3;
/** The timer looks again at least this often (clock changes, sleep). */
const TICK_MS = 60_000;

/** Claude's keys for its limit windows (`rate_limit_event.rateLimitType`), named the way Claude Code names them. */
const LIMIT_NAMES: Record<string, string> = {
  five_hour: "session limit",
  seven_day: "weekly limit",
  seven_day_opus: "Opus limit",
  seven_day_sonnet: "Sonnet limit",
  overage: "usage credit limit",
};

export interface PausedRow {
  run_id: string;
  conversation_id: string;
  agent_id: string;
  message_id: string;
  user_message_id: string | null;
  also_answers: string;
  reason: PauseReason;
  limit_name: string | null;
  resume_at: string | null;
  auto: number;
  /** What the human chose for this run (the Auto switch); null = the setting decides. */
  choice: number | null;
  /** 0: Claude never got what this stretch of the run sent, so continuing sends it again. */
  delivered: number;
  /** What to send again, with saved secrets masked (what the human typed stays in memory). */
  redo: string | null;
  retries: number;
  depth: number;
  voice: number;
  created_at: string;
}

export function toPause(r: Pick<PausedRow, "run_id" | "reason" | "limit_name" | "resume_at" | "auto" | "created_at">): RunPause {
  return { runId: r.run_id, reason: r.reason, pausedAt: r.created_at, limit: r.limit_name, resumeAt: r.resume_at, auto: bool(r.auto) };
}

/** The chat's paused run, if it has one. */
export function pauseOf(conversationId: string): PausedRow | null {
  return get<PausedRow>("SELECT * FROM paused_runs WHERE conversation_id = ?", conversationId);
}

export function pausedRun(runId: string): PausedRow | null {
  return get<PausedRow>("SELECT * FROM paused_runs WHERE run_id = ?", runId);
}

/** Chats that are frozen by a paused run. */
export function pausedConversations(): Set<string> {
  return new Set(all<{ conversation_id: string }>("SELECT conversation_id FROM paused_runs").map((r) => r.conversation_id));
}

function changed(row: Pick<PausedRow, "conversation_id">) {
  emitConversationUpdated(row.conversation_id);
  // Agents show how many of their runs stand still.
  bus.changed("agents");
  arm();
}

export function savePause(row: PausedRow): void {
  insert("paused_runs", { ...row });
  changed(row);
  if (row.reason === "limit") announceLimit(row);
}

export function dropPause(row: Pick<PausedRow, "run_id" | "conversation_id">): void {
  exec("DELETE FROM paused_runs WHERE run_id = ?", row.run_id);
  changed(row);
}

/* ------------------------------------------------------------------ */
/* Claude's usage limit                                                */
/* ------------------------------------------------------------------ */

export interface LimitPause {
  /** "session limit", "weekly limit", … */
  limit: string;
  /** When to continue; null = Claude didn't say when the limit resets. */
  resumeAt: string | null;
}

/**
 * The run ended because a usage limit was reached: which one, and when it resets. `text` is what Claude Code said
 * when the run ended — null unless it names a limit; `limit` is what Claude last reported (`rate_limit_event`), which
 * alone proves nothing: requests still go through on usage credits or a fallback model.
 */
export function limitReached(limit: StreamLimit | null, text: string): LimitPause | null {
  if (!LIMIT_TEXT.test(text)) return null;
  // Older Claude Code: "Claude AI usage limit reached|1760000000".
  const legacy = /limit reached\|(\d{9,11})\b/.exec(text);
  const resetsAt = limit?.resetsAt ?? (legacy ? Number(legacy[1]) : null);
  const named = /you['’]ve hit your ([\w ]{0,40}?limit)\b/i.exec(text)?.[1];
  let resumeAt: string | null = null;
  if (resetsAt) {
    const at = resetsAt * 1000 + RESET_MARGIN_MS;
    resumeAt = new Date(at > Date.now() ? at : Date.now() + RETRY_MS).toISOString();
  }
  return { limit: (limit?.type && LIMIT_NAMES[limit.type]) || named || "usage limit", resumeAt };
}

/** "at 15:00" today, else "on Thu, Oct 8 at 09:00". */
function whenText(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === new Date().toDateString()) return `at ${time}`;
  return `on ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at ${time}`;
}

let announced: string | null = null;

/** One notification per limit and reset, however many runs it stopped. */
function announceLimit(row: PausedRow) {
  const key = `${row.limit_name}|${row.resume_at?.slice(0, 16) ?? ""}|${row.auto}`;
  if (announced === key) return;
  announced = key;
  const what = `Claude's ${row.limit_name ?? "usage limit"} is reached`;
  const next = bool(row.auto)
    ? `The work is paused and continues by itself ${whenText(row.resume_at!)}.`
    : row.resume_at
      ? `The work is paused. The limit resets ${whenText(row.resume_at)} — continue it then.`
      : "The work is paused. Continue it when the limit has reset.";
  notify("warning", what, next, `/chat/${row.conversation_id}`);
}

/* ------------------------------------------------------------------ */
/* Pause and continue                                                   */
/* ------------------------------------------------------------------ */

/** Pause what the agent is doing in the chat. */
export async function pauseConversation(conversationId: string): Promise<void> {
  if (!get<{ id: string }>("SELECT id FROM conversations WHERE id = ?", conversationId)) throw notFound("Conversation");
  if (pauseOf(conversationId)) throw conflict("This chat is paused already");
  const active = listActiveRuns().filter((r) => r.conversationId === conversationId);
  const target = active.find((r) => r.status === "running") ?? active[0];
  if (!target) throw conflict("Nothing is running in this chat");
  await pauseRun(target.runId);
}

/** Continue the chat's paused run where it stopped. */
export function continueConversation(conversationId: string, by: "user" | "auto" = "user"): Run {
  const row = pauseOf(conversationId);
  if (!row) throw notFound("Paused run");
  return resumeRun(row, by);
}

/** Whether a run that waits for the limit continues by itself when the limit resets. */
export function setAutoContinue(conversationId: string, auto: boolean): RunPause {
  const row = pauseOf(conversationId);
  if (!row) throw notFound("Paused run");
  if (row.reason !== "limit") throw badRequest("Only a run that waits for Claude's usage limit continues by itself");
  if (auto && !row.resume_at) throw badRequest("Claude didn't say when the limit resets — continue the chat yourself");
  exec("UPDATE paused_runs SET auto = ?, choice = ?, retries = 0 WHERE run_id = ?", auto ? 1 : 0, auto ? 1 : 0, row.run_id);
  changed(row);
  return toPause({ ...row, auto: auto ? 1 : 0 });
}

/** Pause everything the agent is working on. Returns how many runs were paused. */
export async function pauseAgent(agentId: string): Promise<number> {
  const frozen = pausedConversations();
  const targets = new Map<string, string>();
  for (const r of listActiveRuns()) {
    if (r.agentId !== agentId || r.trigger === "dream" || r.trigger === "check" || frozen.has(r.conversationId)) continue;
    if (r.status === "running" || !targets.has(r.conversationId)) targets.set(r.conversationId, r.runId);
  }
  let paused = 0;
  for (const runId of targets.values()) {
    try {
      await pauseRun(runId);
      paused++;
    } catch (err) {
      log.warn(`could not pause run ${runId} of agent ${agentId}`, err);
    }
  }
  return paused;
}

/** Continue every paused run of the agent. Returns how many continued. */
export function continueAgent(agentId: string): number {
  const rows = all<PausedRow>("SELECT * FROM paused_runs WHERE agent_id = ? ORDER BY created_at", agentId);
  let continued = 0;
  let failure: unknown = null;
  for (const row of rows) {
    try {
      resumeRun(row, "user");
      continued++;
    } catch (err) {
      failure = err;
      log.warn(`could not continue run ${row.run_id} of agent ${agentId}`, err);
    }
  }
  if (!continued && failure) throw failure;
  return continued;
}

/* ------------------------------------------------------------------ */
/* Continuing by itself                                                 */
/* ------------------------------------------------------------------ */

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** Wake up when the next waiting run is due. */
function arm() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!started) return;
  const next = get<{ resume_at: string }>("SELECT resume_at FROM paused_runs WHERE auto = 1 AND resume_at IS NOT NULL ORDER BY resume_at LIMIT 1");
  if (!next) return;
  timer = setTimeout(sweep, Math.min(Math.max(0, Date.parse(next.resume_at) - Date.now()), TICK_MS));
}

/** Continue every run whose limit has reset. */
export function sweep(): void {
  timer = null;
  for (const row of all<PausedRow>("SELECT * FROM paused_runs WHERE auto = 1 AND resume_at IS NOT NULL AND resume_at <= ? ORDER BY created_at", now())) {
    try {
      resumeRun(row, "auto");
      log.info(`run ${row.run_id} continues: the limit has reset`);
    } catch (err) {
      if (err instanceof HttpError && err.code === "shutting_down") continue;
      stopContinuing(row, err instanceof Error ? err.message : String(err));
    }
  }
  arm();
}

/** The run can't continue by itself anymore: it waits for the human, who is told why. */
export function stopContinuing(row: Pick<PausedRow, "run_id" | "conversation_id" | "agent_id">, why: string): void {
  exec("UPDATE paused_runs SET auto = 0 WHERE run_id = ?", row.run_id);
  const agentName = get<{ name: string }>("SELECT name FROM agents WHERE id = ?", row.agent_id)?.name ?? "An agent";
  const title = get<{ title: string }>("SELECT title FROM conversations WHERE id = ?", row.conversation_id)?.title ?? "a chat";
  notify("warning", `${agentName} couldn't continue “${title}”`, why, `/chat/${row.conversation_id}`);
  changed(row);
}

export function startPauses(): void {
  if (started) return;
  started = true;
  // A pause without its run, or a paused run without its pause (a restored backup): nothing could continue it.
  exec("DELETE FROM paused_runs WHERE run_id NOT IN (SELECT id FROM runs WHERE status = 'paused')");
  const lost = all<{ id: string }>("SELECT id FROM runs WHERE status = 'paused' AND id NOT IN (SELECT run_id FROM paused_runs)");
  for (const { id } of lost) void cancelRun(id, "Paused, but what it needed to continue is gone").catch((err) => log.warn(`could not close run ${id}`, err));
  if (lost.length) log.warn(`closed ${lost.length} paused run(s) that couldn't be continued`);
  const waiting = get<{ n: number }>("SELECT COUNT(*) AS n FROM paused_runs")?.n ?? 0;
  if (waiting) log.info(`${waiting} paused run(s)`);
  arm();
}

export function stopPauses(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
