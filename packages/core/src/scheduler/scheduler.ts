/**
 * Cron routines scheduler: one croner job per enabled routine of an enabled agent (timezone aware).
 * A tick sends the routine prompt into a conversation of the agent, exactly like a user message.
 */
import { Cron } from "croner";
import type { Routine, Run, ServerEvent } from "@godmode/shared";
import { all, get, run as exec } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { getAgent } from "../agents/service";
import { computeNextRunAt, getRoutine } from "../services/routines";
import { createConversation, sendMessage } from "../services/conversations";
import { notify } from "../services/notifications";
import { getSettings } from "../services/settings";
import { HttpError, conflict, now } from "../util";

const log = logger("scheduler");

interface ScheduledJob {
  job: Cron;
  signature: string;
}

const jobs = new Map<string, ScheduledJob>();
/** Routines between "tick accepted" and "run created" — guards against double triggers. */
const triggering = new Set<string>();
let started = false;
let unsubscribe: (() => void) | null = null;

function emitRoutine(id: string) {
  try {
    bus.emit({ type: "routine.updated", routine: getRoutine(id) });
  } catch {
    /* routine deleted meanwhile */
  }
}

function onBusEvent(event: ServerEvent) {
  if (event.type !== "run.finished" || !event.run.routineId) return;
  const result = exec("UPDATE routines SET last_status = ? WHERE id = ?", event.run.status, event.run.routineId);
  if (result.changes > 0) emitRoutine(event.run.routineId);
}

function ensureListener() {
  if (!unsubscribe) unsubscribe = bus.on(onBusEvent);
}

function signature(r: { cron: string; timezone: string }): string {
  return `${r.cron}\u0000${r.timezone}`;
}

function formatDate(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(getSettings().general.language || "en", {
      timeZone: timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function activeRunId(routineId: string): string | null {
  return (
    get<{ id: string }>("SELECT id FROM runs WHERE routine_id = ? AND status IN ('queued', 'running') LIMIT 1", routineId)?.id ??
    null
  );
}

function nextRunAt(routine: Routine): string | null {
  const scheduled = jobs.get(routine.id)?.job.nextRun();
  if (scheduled) return scheduled.toISOString();
  return routine.enabled ? computeNextRunAt(routine.cron, routine.timezone) : null;
}

/** Reuse the routine's conversation when configured (and still present), otherwise start a new one. */
function resolveConversation(routine: Routine): string {
  if (routine.reuseConversation && routine.conversationId) {
    const existing = get<{ id: string }>(
      "SELECT id FROM conversations WHERE id = ? AND agent_id = ?",
      routine.conversationId,
      routine.agentId,
    );
    if (existing) return existing.id;
  }
  // A reused conversation spans many runs, so only per-run conversations carry the date.
  const title = routine.reuseConversation ? routine.name : `${routine.name} · ${formatDate(new Date(), routine.timezone)}`;
  const conversation = createConversation({ agentId: routine.agentId, title, origin: "routine" });
  if (routine.reuseConversation) exec("UPDATE routines SET conversation_id = ? WHERE id = ?", conversation.id, routine.id);
  return conversation.id;
}

/**
 * Run a routine now: same path as a cron tick. Throws 409 when the agent is disabled or the routine is
 * already running. `scheduled` ticks additionally skip routines that were disabled meanwhile.
 */
export async function triggerRoutine(id: string, opts: { scheduled?: boolean } = {}): Promise<Run> {
  ensureListener();
  const routine = getRoutine(id);
  const agent = getAgent(routine.agentId);
  if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
  if (opts.scheduled && !routine.enabled) throw conflict(`Routine "${routine.name}" is disabled`);
  if (triggering.has(id) || activeRunId(id)) throw conflict(`Routine "${routine.name}" is already running`);

  triggering.add(id);
  try {
    const conversationId = resolveConversation(routine);
    exec(
      "UPDATE routines SET last_run_at = ?, next_run_at = ?, last_status = 'queued' WHERE id = ?",
      now(),
      nextRunAt(routine),
      id,
    );
    const { run } = await sendMessage(conversationId, { content: routine.prompt, trigger: "routine", routineId: routine.id });
    // Don't clobber a final status if the run already finished (run.finished handler wrote it).
    exec("UPDATE routines SET last_status = ? WHERE id = ? AND last_status = 'queued'", run.status, id);
    emitRoutine(id);
    return run;
  } catch (err) {
    exec("UPDATE routines SET last_status = 'failed' WHERE id = ?", id);
    emitRoutine(id);
    throw err;
  } finally {
    triggering.delete(id);
  }
}

async function onTick(routineId: string) {
  try {
    const run = await triggerRoutine(routineId, { scheduled: true });
    log.info(`routine ${routineId} started run ${run.id}`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      log.info(`routine ${routineId} skipped: ${err.message}`);
      return;
    }
    if (err instanceof HttpError && err.status === 404) {
      reloadSchedules();
      return;
    }
    log.error(`routine ${routineId} failed to start`, err);
    try {
      const routine = getRoutine(routineId);
      notify(
        "error",
        `Routine "${routine.name}" could not start`,
        err instanceof Error ? err.message : String(err),
        `/agents/${routine.agentId}`,
      );
    } catch {
      /* routine deleted meanwhile */
    }
  }
}

/** Re-read routines from DB and reschedule (after CRUD). Unchanged jobs keep running. */
export function reloadSchedules(): void {
  if (!started) return;
  const wanted = all<{ id: string; cron: string; timezone: string }>(
    `SELECT r.id, r.cron, r.timezone FROM routines r JOIN agents a ON a.id = r.agent_id
     WHERE r.enabled = 1 AND a.enabled = 1`,
  );
  const byId = new Map(wanted.map((r) => [r.id, r]));

  for (const [id, scheduled] of jobs) {
    const w = byId.get(id);
    if (!w || signature(w) !== scheduled.signature) {
      scheduled.job.stop();
      jobs.delete(id);
    }
  }
  for (const r of wanted) {
    if (jobs.has(r.id)) continue;
    try {
      const job = new Cron(
        r.cron,
        {
          timezone: r.timezone,
          mode: "5-or-6-parts",
          protect: true,
          catch: (err) => log.error(`routine ${r.id} tick crashed`, err),
        },
        () => onTick(r.id),
      );
      jobs.set(r.id, { job, signature: signature(r) });
    } catch (err) {
      log.warn(`routine ${r.id} has an invalid schedule (${r.cron} ${r.timezone})`, err);
    }
  }

  // Persist next run times so the UI shows when each routine fires next.
  for (const row of all<{ id: string; next_run_at: string | null }>("SELECT id, next_run_at FROM routines")) {
    const next = jobs.get(row.id)?.job.nextRun()?.toISOString() ?? null;
    if (next === row.next_run_at) continue;
    exec("UPDATE routines SET next_run_at = ? WHERE id = ?", next, row.id);
    emitRoutine(row.id);
  }
}

/** Routines left "queued"/"running" by a previous process take the status of their latest run (or failed). */
function repairStaleStatuses() {
  exec(
    `UPDATE routines SET last_status = COALESCE(
       (SELECT status FROM runs WHERE runs.routine_id = routines.id ORDER BY created_at DESC LIMIT 1), 'failed')
     WHERE last_status IN ('queued', 'running')
       AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.routine_id = routines.id AND runs.status IN ('queued', 'running'))`,
  );
}

export function startScheduler(): void {
  if (started) return;
  started = true;
  ensureListener();
  repairStaleStatuses();
  reloadSchedules();
  log.info(`scheduler started with ${jobs.size} routine(s)`);
}

export function stopScheduler(): void {
  started = false;
  for (const { job } of jobs.values()) job.stop();
  jobs.clear();
  unsubscribe?.();
  unsubscribe = null;
}

/** Currently scheduled routines (for diagnostics and tests). */
export function scheduledRoutines(): { routineId: string; nextRunAt: string | null }[] {
  return [...jobs].map(([routineId, { job }]) => ({ routineId, nextRunAt: job.nextRun()?.toISOString() ?? null }));
}
