/**
 * Cron scheduler for automations: one croner job per enabled schedule or condition automation of an enabled agent
 * (timezone aware). A schedule tick sends the automation's prompt into its conversation, exactly like a user message;
 * a condition tick starts a condition check (automations/conditions.ts). Schedules with a random start window get a
 * one-off job at the start drawn for their next time slot, replaced by the next one when it fires.
 */
import { Cron } from "croner";
import type { Routine, Run } from "@godmode/shared";
import { MAX_START_WINDOW_MINUTES } from "@godmode/shared";
import { all, run as exec } from "../db";
import { logger } from "../log";
import { getAgent } from "../agents/service";
import { computeNextRunAt, emitRoutine, getRoutine, lastScheduledStart, nextRandomStart, startWindowOf } from "../services/routines";
import { sendMessage } from "../services/conversations";
import { notify } from "../services/notifications";
import { automationConversation } from "../automations/conversation";
import { runConditionCheck } from "../automations/conditions";
import { activeMainRun, ensureRunListener, recordEvent, settleIfFinished } from "../automations/events";
import { HttpError, badRequest, conflict, now } from "../util";

const log = logger("scheduler");

interface ScheduledJob {
  job: Cron;
  signature: string;
}

const jobs = new Map<string, ScheduledJob>();
/** Routines between "tick accepted" and "run created" — guards against double triggers. */
const triggering = new Set<string>();
/** Time slot a random start last fired for, until its schedule event is stored. */
const firedSlots = new Map<string, number>();
let started = false;

interface WantedRoutine {
  id: string;
  cron: string;
  timezone: string;
  type: string;
  start_window: number | null;
}

function signature(r: WantedRoutine): string {
  return `${r.type}\u0000${r.cron}\u0000${r.timezone}\u0000${r.start_window ?? 0}`;
}

function cronJob(r: WantedRoutine): Cron {
  return new Cron(
    r.cron,
    {
      timezone: r.timezone,
      mode: "5-or-6-parts",
      protect: true,
      catch: (err) => log.error(`routine ${r.id} tick crashed`, err),
    },
    () => onTick(r.id),
  );
}

function randomStartJob(r: WantedRoutine, windowMinutes: number, handledUntil: number): Cron {
  const { slot, at } = nextRandomStart(r.id, r.cron, r.timezone, windowMinutes, new Date(), handledUntil);
  const job: Cron = new Cron(at, { catch: (err) => log.error(`routine ${r.id} tick crashed`, err) }, () => {
    const current = jobs.get(r.id);
    if (current?.job !== job) return;
    firedSlots.set(r.id, slot.getTime());
    // Plan the next slot first: the run's next_run_at is read from the job.
    try {
      jobs.set(r.id, { job: randomStartJob(r, windowMinutes, slot.getTime()), signature: current.signature });
    } catch (err) {
      jobs.delete(r.id);
      log.warn(`routine ${r.id} has no next start`, err);
    }
    return onTick(r.id);
  });
  return job;
}

function handledUntil(id: string): number {
  return Math.max(lastScheduledStart(id), firedSlots.get(id) ?? 0);
}

function nextRunAt(routine: Routine): string | null {
  const scheduled = jobs.get(routine.id)?.job.nextRun();
  if (scheduled) return scheduled.toISOString();
  if (!routine.enabled) return null;
  const minutes = startWindowOf(routine.trigger);
  if (!minutes) return computeNextRunAt(routine.cron, routine.timezone);
  try {
    return nextRandomStart(routine.id, routine.cron, routine.timezone, minutes, new Date(), handledUntil(routine.id)).at.toISOString();
  } catch {
    return null;
  }
}

/**
 * Run a schedule automation now: same path as a cron tick. Throws 409 when the agent is disabled or the routine is
 * already running. `scheduled` ticks additionally skip routines that were disabled meanwhile.
 */
export async function triggerRoutine(id: string, opts: { scheduled?: boolean } = {}): Promise<Run> {
  ensureRunListener();
  const routine = getRoutine(id);
  if (routine.trigger.type !== "schedule") throw badRequest(`“${routine.name}” is not a scheduled automation`);
  const agent = getAgent(routine.agentId);
  if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
  if (opts.scheduled && !routine.enabled) throw conflict(`Routine "${routine.name}" is disabled`);
  if (triggering.has(id) || activeMainRun(id)) {
    if (opts.scheduled) {
      recordEvent(id, { source: "schedule", title: "Scheduled time reached", status: "skipped", note: "The previous run was still in progress" });
    }
    throw conflict(`Routine "${routine.name}" is already running`);
  }

  triggering.add(id);
  try {
    const conversationId = automationConversation(routine);
    exec(
      "UPDATE routines SET last_run_at = ?, next_run_at = ?, last_status = 'queued' WHERE id = ?",
      now(),
      nextRunAt(routine),
      id,
    );
    const { run } = await sendMessage(conversationId, { content: routine.prompt, trigger: "routine", routineId: routine.id });
    recordEvent(id, {
      source: opts.scheduled ? "schedule" : "manual",
      title: opts.scheduled ? "Scheduled time reached" : "Started manually",
      status: "running",
      runId: run.id,
    });
    settleIfFinished(run.id);
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
  let routine: Routine;
  try {
    routine = getRoutine(routineId);
  } catch {
    reloadSchedules();
    return;
  }
  try {
    const run =
      routine.trigger.type === "condition"
        ? await runConditionCheck(routineId, { scheduled: true })
        : await triggerRoutine(routineId, { scheduled: true });
    log.info(`routine ${routineId} started ${run.trigger === "check" ? "a check" : "run"} ${run.id}`);
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
    notify(
      "error",
      `Automation “${routine.name}” could not start`,
      err instanceof Error ? err.message : String(err),
      `/agents/${routine.agentId}`,
    );
  } finally {
    const next = jobs.get(routineId)?.job.nextRun()?.toISOString() ?? null;
    if (exec("UPDATE routines SET next_run_at = ? WHERE id = ? AND next_run_at IS NOT ?", next, routineId, next).changes > 0) emitRoutine(routineId);
  }
}

/** Re-read routines from DB and reschedule (after CRUD). Unchanged jobs keep running. */
export function reloadSchedules(): void {
  if (!started) return;
  const wanted = all<WantedRoutine>(
    `SELECT id, cron, timezone, type, start_window FROM (
       SELECT r.id, r.cron, r.timezone,
         CASE WHEN json_valid(r.trigger) THEN json_extract(r.trigger, '$.type') END AS type,
         CASE WHEN json_valid(r.trigger) THEN json_extract(r.trigger, '$.startWindowMinutes') END AS start_window
       FROM routines r JOIN agents a ON a.id = r.agent_id WHERE r.enabled = 1 AND a.enabled = 1)
     WHERE type IN ('schedule', 'condition')`,
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
      const w = r.type === "schedule" ? r.start_window : null;
      const windowMinutes = typeof w === "number" && Number.isInteger(w) && w > 0 && w <= MAX_START_WINDOW_MINUTES ? w : 0;
      const job = windowMinutes > 0 ? randomStartJob(r, windowMinutes, handledUntil(r.id)) : cronJob(r);
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

/**
 * Routines left "queued"/"running" by a previous process take the status of their latest run (or failed) — "paused"
 * while that run still stands still.
 */
function repairStaleStatuses() {
  exec(
    `UPDATE routines SET last_status = COALESCE(
       (SELECT status FROM runs WHERE runs.routine_id = routines.id AND runs.trigger = 'routine' ORDER BY created_at DESC LIMIT 1), 'failed')
     WHERE last_status IN ('queued', 'running', 'paused')
       AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.routine_id = routines.id AND runs.trigger = 'routine' AND runs.status IN ('queued', 'running'))`,
  );
}

export function startScheduler(): void {
  if (started) return;
  started = true;
  ensureRunListener();
  repairStaleStatuses();
  reloadSchedules();
  log.info(`scheduler started with ${jobs.size} routine(s)`);
}

export function stopScheduler(): void {
  started = false;
  firedSlots.clear();
  for (const { job } of jobs.values()) job.stop();
  jobs.clear();
}

/** Currently scheduled routines (for diagnostics and tests). */
export function scheduledRoutines(): { routineId: string; nextRunAt: string | null }[] {
  return [...jobs].map(([routineId, { job }]) => ({ routineId, nextRunAt: job.nextRun()?.toISOString() ?? null }));
}
