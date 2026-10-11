/**
 * Work that was going on when Godmode stopped (quit, update, crash) continues by itself after the next start: a chat,
 * an automation, a follow-up or a task handed to another agent gets a new turn in the same chat and Claude session that
 * picks the work up where it stopped, or gets its prompt again when the turn never got going. Board tickets do that on
 * their own (tasks/service.ts); dreams, condition checks and heartbeats simply come again.
 *
 * A turn that broke off because Claude's API couldn't be reached (no internet, DNS down) continues the same way once
 * the API answers again.
 */
import type { AutomationEventSource, MessageBlock, RetryMode, Run, RunTrigger } from "@godmode/shared";
import { RUN_INTERRUPTED, RUN_SHUT_DOWN, retryModeOf } from "@godmode/shared";
import { all, get, getMeta, run as exec, setMeta } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { HttpError, newId, now, parseJson } from "../util";
import { activeMainRun, recordEvent, settleIfFinished } from "../automations/events";
import { deliverFollowup } from "../messaging/bridge";
import { restartAgainNote, restartContext, type CutOffCause, type CutOffHandoff } from "../runner/prompt";
import { activeRunForConversation } from "../runner/runner";
import { taskForConversation } from "../tasks/service";
import { audit } from "./audit";
import { getConversationSummary, sendMessage } from "./conversations";
import { pauseOf } from "./pauses";
import { emitRoutine } from "./routines";
import { getSettings } from "./settings";

const log = logger("resume");

const CHECKED_KEY = "runs.resumeCheckedAt";
/** Cut off longer ago than this, the work waits for someone to continue it. */
const MAX_AGE_MS = 24 * 3_600_000;
/** No start checked before: what the restart that brought this cut off. */
const FIRST_LOOK_BACK_MS = 15 * 60_000;
/** Continued by itself this often in a row (a turn that restarts Godmode itself), it is left alone. */
const MAX_IN_A_ROW = 3;
const RESUMABLE: ReadonlySet<RunTrigger> = new Set(["chat", "manual", "api", "followup", "delegation", "routine"]);
const PLATFORMS = new Set(["slack", "telegram", "teams"]);
/**
 * Claude Code's answer when Claude's API couldn't be reached at all, after its own retries. Handed-over work isn't in
 * the list: the run that handed it over got the failure and decides.
 */
const NO_CONNECTION = /^API Error: [^\n]*(Can't reach the API server|Unable to connect|Connection error|Request timed out|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT)/i;
const OFFLINE_RESUMABLE: ReadonlySet<RunTrigger> = new Set(["chat", "manual", "api", "followup", "routine"]);
/** Broke off longer ago than this, the turn waits for someone to continue it. */
const OFFLINE_MAX_AGE_MS = 12 * 3_600_000;
const OFFLINE_CHECK_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const LABELS: Record<CutOffCause, string> = { restart: "Continued after Godmode restarted", offline: "Continued once Claude could be reached again" };

interface RunRow {
  id: string;
  agent_id: string;
  conversation_id: string;
  routine_id: string | null;
  parent_run_id: string | null;
  trigger: RunTrigger;
  status: Run["status"];
  prompt: string;
  error: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface InterruptedWork {
  /** When this start looked: the next one looks at what was cut off after it. */
  at: string;
  runs: RunRow[];
}

const CUT_OFF = `((r.status = 'cancelled' AND r.error = ?) OR (r.status = 'failed' AND r.error = ?))`;
const LATEST = `r.id = (SELECT l.id FROM runs l WHERE l.conversation_id = r.conversation_id ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1)`;

function cutOffByRestart(r: Pick<RunRow, "status" | "error">): boolean {
  return (r.status === "cancelled" && r.error === RUN_SHUT_DOWN) || (r.status === "failed" && r.error === RUN_INTERRUPTED);
}

/**
 * What the last stop cut off: the last turn of its chat, not on a runner (its own runs go on there), not a ticket's.
 * Read right after the interrupted runs are marked, before the scheduler, follow-ups or automations start new ones.
 */
export function interruptedWork(): InterruptedWork {
  const at = now();
  if (!getSettings().runner.resumeAfterRestart) return { at, runs: [] };
  const checked = Date.parse(getMeta(CHECKED_KEY) ?? "");
  const since = new Date(Math.max(Number.isNaN(checked) ? Date.now() - FIRST_LOOK_BACK_MS : checked, Date.now() - MAX_AGE_MS)).toISOString();
  try {
    const runs = all<RunRow>(
      `SELECT r.* FROM runs r JOIN conversations c ON c.id = r.conversation_id
       WHERE ${CUT_OFF} AND r.finished_at > ? AND c.runner_id IS NULL AND ${LATEST}
       ORDER BY r.created_at, r.rowid`,
      RUN_SHUT_DOWN,
      RUN_INTERRUPTED,
      since,
    ).filter((r) => RESUMABLE.has(r.trigger) && !taskForConversation(r.conversation_id) && continuedInARow(r) < MAX_IN_A_ROW);
    return { at, runs };
  } catch (err) {
    log.warn("could not look for the work the restart cut off", err);
    return { at, runs: [] };
  }
}

/** Continue what the last stop cut off: who handed work over first, so it learns which handoffs go on. */
export async function resumeInterruptedWork(work: InterruptedWork): Promise<void> {
  try {
    const started = await continueAll(work.runs);
    if (started.length) log.info(`continued ${started.length} run(s) that the restart cut off`);
  } finally {
    setMeta(CHECKED_KEY, work.at);
  }
}

/** What is cut off now stays for the human (a restored backup's runs): later starts don't continue it by themselves. */
export function leaveInterruptedWork(): void {
  setMeta(CHECKED_KEY, now());
}

/**
 * Continue one run a restart cut off, with the work it had handed to other agents — for an agent looking after the
 * team (work older than a day, or with continuing after a restart turned off). Throws when it can't be continued.
 */
export async function continueCutOffRun(runId: string): Promise<Run> {
  const r = get<RunRow>("SELECT * FROM runs WHERE id = ?", runId);
  if (!r) throw new HttpError(404, "Run not found", "not_found");
  if (!cutOffByRestart(r)) throw new HttpError(409, "That run wasn't cut off by a restart of Godmode.", "not_cut_off");
  if (!RESUMABLE.has(r.trigger)) throw new HttpError(409, "This kind of run comes again by itself — it isn't continued.", "not_resumable");
  const task = taskForConversation(r.conversation_id);
  if (task) throw new HttpError(409, `This run belongs to task #${task.number} — continue it from the board.`, "task_chat");
  if (get("SELECT 1 FROM conversations WHERE id = ? AND runner_id IS NOT NULL", r.conversation_id)) {
    throw new HttpError(409, "This chat works on a runner — its runs go on there.", "runner_chat");
  }
  const refusal = blocked(r);
  if (refusal) throw new HttpError(409, refusal, "busy");
  const [started] = await continueAll([r, ...cutOffHandoffs(r.id)], true);
  if (!started) throw new HttpError(409, "The run could not be continued.", "failed");
  return started;
}

/** The latest turn that picked up `runId` (by the human or after a restart), or `runId` itself. */
export function latestContinuation(runId: string): string {
  let id = runId;
  for (let hops = 0; hops < 20; hops++) {
    const conv = get<{ conversation_id: string }>("SELECT conversation_id FROM runs WHERE id = ?", id)?.conversation_id;
    const next = conv
      ? get<{ run_id: string }>(
          `SELECT m.run_id FROM messages m, json_each(m.blocks) b
           WHERE m.conversation_id = ? AND m.role = 'system' AND m.run_id IS NOT NULL
             AND json_extract(b.value, '$.type') = 'retry' AND json_extract(b.value, '$.runId') = ?
           ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
          conv,
          id,
        )?.run_id
      : null;
    if (!next) return id;
    id = next;
  }
  return id;
}

async function continueAll(runs: RunRow[], strict = false, cause: CutOffCause = "restart"): Promise<Run[]> {
  const ids = new Set(runs.map((r) => r.id));
  const requested = strict ? runs[0] : null;
  const ordered = runs.map((r) => ({ r, depth: depthOf(r.parent_run_id) })).sort((a, b) => a.depth - b.depth);
  // Handed-over work gets its new run id up front, so the run that handed it over is told where to wait for it.
  const planned = new Map<string, string>();
  for (const { r } of ordered) {
    if (r.trigger === "delegation" && r.parent_run_id && ids.has(r.parent_run_id) && !blocked(r) && agentEnabled(r.agent_id)) planned.set(r.id, newId("run"));
  }
  const continued = new Set<string>();
  const started: Run[] = [];
  for (const { r } of ordered) {
    const refusal = blocked(r) ?? (r === requested ? null : orphaned(r, continued));
    if (refusal) {
      if (r === requested) throw new HttpError(409, refusal, "busy");
      continue;
    }
    const handoffs = ordered
      .filter(({ r: c }) => c.parent_run_id === r.id && planned.has(c.id))
      .map(({ r: c }) => ({ agentName: agentName(c.agent_id), runId: planned.get(c.id)! }));
    try {
      started.push(await continueOne(r, handoffs, planned.get(r.id), cause));
      continued.add(r.id);
    } catch (err) {
      if (r === requested) throw err;
      log.warn(`could not continue run ${r.id} (${cause})`, err);
    }
  }
  return started;
}

/**
 * Handed-over work goes on only for a run that goes on too, or one that had already finished (it handed the work over
 * without waiting): else whatever picks that run up again (the board, the human) would hand it over a second time.
 */
function orphaned(r: RunRow, continued: Set<string>): string | null {
  if (r.trigger !== "delegation" || !r.parent_run_id || continued.has(r.parent_run_id)) return null;
  const parent = get<Pick<RunRow, "status" | "error">>("SELECT status, error FROM runs WHERE id = ?", r.parent_run_id);
  if (!parent || cutOffByRestart(parent) || !["succeeded", "failed", "cancelled"].includes(parent.status)) return "The run that handed this over doesn't go on.";
  return null;
}

async function continueOne(r: RunRow, handoffs: CutOffHandoff[], runId: string | undefined, cause: CutOffCause): Promise<Run> {
  const conv = getConversationSummary(r.conversation_id);
  const blocks = parseJson<MessageBlock[]>(get<{ blocks: string }>("SELECT blocks FROM messages WHERE run_id = ? AND role = 'assistant'", r.id)?.blocks, []);
  let mode: RetryMode = retryModeOf(blocks);
  if (mode === "continue" && !conv.claudeSessionId) mode = "again";
  const endedAt = r.finished_at ?? r.created_at;
  const prompt =
    mode === "continue"
      ? restartContext({ userName: getSettings().general.userName, endedAt, startedBy: r.trigger, handoffs, cause })
      : restartAgainNote({ endedAt, cause }) + r.prompt;
  const masked = mode === "again" && /•{4,}/.test(r.prompt);
  // The work it hands on waits for the turn that continues the one that handed it over.
  const parentRunId = r.parent_run_id ? latestContinuation(r.parent_run_id) : null;
  const { run } = await sendMessage(r.conversation_id, {
    content: LABELS[cause],
    prompt,
    marker: [{ type: "retry", mode, runId: r.id, at: now(), auto: true, ...(masked ? { masked: true } : {}) }],
    trigger: r.trigger,
    routineId: r.routine_id,
    parentRunId,
    depth: depthOf(parentRunId),
    runId,
  });
  if (r.trigger === "routine" && r.routine_id) followAutomation(r, run, LABELS[cause]);
  // In a Slack, Telegram or Teams chat the answer goes back there.
  if (PLATFORMS.has(conv.origin)) void deliverFollowup(r.conversation_id, run.id).catch((err) => log.warn(`could not deliver run ${run.id}`, err));
  audit("godmode", "run.resume", r.conversation_id, { runId: r.id, newRunId: run.id, mode, cause });
  return run;
}

/** The automation's activity shows the turn that goes on, and its status follows it. */
function followAutomation(r: RunRow, run: Run, title: string) {
  const routineId = r.routine_id!;
  try {
    const source = get<{ source: AutomationEventSource }>("SELECT source FROM automation_events WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", r.id)?.source;
    recordEvent(routineId, { source: source ?? "schedule", title, status: "running", runId: run.id });
    settleIfFinished(run.id);
    exec("UPDATE routines SET last_status = ? WHERE id = ?", run.status, routineId);
    emitRoutine(routineId);
  } catch (err) {
    log.warn(`could not link automation ${routineId} to run ${run.id}`, err);
  }
}

/** Why a cut-off run can't be continued now (something happened in its chat since), or null. */
function blocked(r: RunRow): string | null {
  const latest = get<{ id: string }>("SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", r.conversation_id)?.id;
  if (latest !== r.id) return "Something new happened in this chat since — the work already went on.";
  if (activeRunForConversation(r.conversation_id)) return "The agent is already working in this chat.";
  if (pauseOf(r.conversation_id)) return "This chat stands still — it continues from the bar above the message box.";
  // An automation that runs each event in a chat of its own may have started again meanwhile.
  if (r.trigger === "routine" && r.routine_id && activeMainRun(r.routine_id)) return "The automation is already running again.";
  return null;
}

/** Work `runId` had handed to other agents that the same restart cut off, and what those handed on. */
function cutOffHandoffs(runId: string, depth = 0): RunRow[] {
  if (depth > 5) return [];
  return all<RunRow>(
    `SELECT r.* FROM runs r WHERE r.parent_run_id = ? AND r.trigger = 'delegation' AND ${CUT_OFF} AND ${LATEST}`,
    runId,
    RUN_SHUT_DOWN,
    RUN_INTERRUPTED,
  ).flatMap((c) => [c, ...cutOffHandoffs(c.id, depth + 1)]);
}

/** How many turns before this one Godmode continued by itself, one after the other. */
function continuedInARow(r: RunRow): number {
  let n = 0;
  let id = r.id;
  while (n < MAX_IN_A_ROW) {
    const previous = get<{ run_id: string }>(
      `SELECT json_extract(b.value, '$.runId') AS run_id FROM messages m, json_each(m.blocks) b
       WHERE m.conversation_id = ? AND m.run_id = ? AND m.role = 'system'
         AND json_extract(b.value, '$.type') = 'retry' AND json_extract(b.value, '$.auto') = 1 LIMIT 1`,
      r.conversation_id,
      id,
    )?.run_id;
    if (!previous) break;
    n++;
    id = previous;
  }
  return n;
}

function depthOf(parentRunId: string | null): number {
  let depth = 0;
  let id = parentRunId;
  while (id && depth < 10) {
    depth++;
    id = get<{ parent_run_id: string | null }>("SELECT parent_run_id FROM runs WHERE id = ?", id)?.parent_run_id ?? null;
  }
  return depth;
}

function agentEnabled(agentId: string): boolean {
  return get<{ enabled: number }>("SELECT enabled FROM agents WHERE id = ?", agentId)?.enabled === 1;
}

function agentName(agentId: string): string {
  return get<{ name: string }>("SELECT name FROM agents WHERE id = ?", agentId)?.name ?? "another agent";
}

/* ------------------------------------------------------------------ */
/* Turns that broke off without a connection to Claude                  */
/* ------------------------------------------------------------------ */

export function brokeOffOffline(error: string | null | undefined): boolean {
  return !!error && NO_CONNECTION.test(error);
}

/** Turns that failed because Claude's API couldn't be reached and nothing went on in their chat since. */
function offlineFailures(): RunRow[] {
  const since = new Date(Date.now() - OFFLINE_MAX_AGE_MS).toISOString();
  return all<RunRow>(
    `SELECT r.* FROM runs r JOIN conversations c ON c.id = r.conversation_id
     WHERE r.status = 'failed' AND r.error LIKE 'API Error:%' AND r.finished_at > ? AND c.runner_id IS NULL AND ${LATEST}
     ORDER BY r.created_at, r.rowid`,
    since,
  ).filter(
    (r) =>
      OFFLINE_RESUMABLE.has(r.trigger) &&
      brokeOffOffline(r.error) &&
      !taskForConversation(r.conversation_id) &&
      // An automation that came round again meanwhile did the work already.
      !(r.trigger === "routine" && r.routine_id && get("SELECT 1 FROM runs WHERE routine_id = ? AND created_at > ? LIMIT 1", r.routine_id, r.created_at)) &&
      continuedInARow(r) < MAX_IN_A_ROW &&
      !blocked(r),
  );
}

/** Any answer from the API's host counts: only a connection that can't be made means it is still out of reach. */
async function apiReachable(): Promise<boolean> {
  try {
    await fetch(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com", { method: "HEAD", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

let offlineTimer: ReturnType<typeof setInterval> | null = null;
let stopListening: (() => void) | null = null;
/** A turn may be waiting for the connection: set at the start and by every turn that broke off offline. */
let watching = false;
let checking = false;

/** Continue what broke off offline, once Claude's API answers again. Returns how many turns went on. */
export async function continueAfterOutage(probe: () => Promise<boolean> = apiReachable): Promise<number> {
  if (checking || !getSettings().runner.resumeAfterRestart) return 0;
  checking = true;
  try {
    const runs = offlineFailures();
    if (!runs.length) {
      watching = false;
      return 0;
    }
    if (!(await probe())) return 0;
    const started = await continueAll(runs, false, "offline");
    if (started.length) log.info(`continued ${started.length} run(s) that broke off without a connection to Claude`);
    return started.length;
  } finally {
    checking = false;
  }
}

export function startOutageRecovery(): void {
  if (offlineTimer) return;
  watching = true;
  stopListening = bus.on((e) => {
    if (e.type === "run.finished" && e.run.status === "failed" && brokeOffOffline(e.run.error)) watching = true;
  });
  offlineTimer = setInterval(() => {
    if (watching) void continueAfterOutage().catch((err) => log.warn("could not continue the work a lost connection cut off", err));
  }, OFFLINE_CHECK_MS);
  offlineTimer.unref?.();
}

export function stopOutageRecovery(): void {
  if (offlineTimer) clearInterval(offlineTimer);
  offlineTimer = null;
  stopListening?.();
  stopListening = null;
  watching = false;
}
