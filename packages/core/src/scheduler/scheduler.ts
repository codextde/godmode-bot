/**
 * Cron scheduler for automations: one croner job per enabled schedule or condition automation of an enabled agent
 * (timezone aware). A schedule tick sends the automation's prompt into its conversation, exactly like a user message;
 * a condition tick starts a condition check (automations/conditions.ts).
 */
import { Cron } from "croner";
import type { Routine, Run } from "@godmode/shared";
import { all, run as exec } from "../db";
import { logger } from "../log";
import { getAgent } from "../agents/service";
import { computeNextRunAt, emitRoutine, getRoutine } from "../services/routines";
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
let started = false;

function signature(r: { cron: string; timezone: string; type: string }): string {
  return `${r.type}\u0000${r.cron}\u0000${r.timezone}`;
}

function nextRunAt(routine: Routine): string | null {
  const scheduled = jobs.get(routine.id)?.job.nextRun();
  if (scheduled) return scheduled.toISOString();
  return routine.enabled ? computeNextRunAt(routine.cron, routine.timezone) : null;
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
    if (routine.trigger.type === "condition") {
      const next = jobs.get(routineId)?.job.nextRun()?.toISOString() ?? null;
      if (exec("UPDATE routines SET next_run_at = ? WHERE id = ?", next, routineId).changes > 0) emitRoutine(routineId);
    }
  }
}

/** Re-read routines from DB and reschedule (after CRUD). Unchanged jobs keep running. */
export function reloadSchedules(): void {
  if (!started) return;
  const wanted = all<{ id: string; cron: string; timezone: string; type: string }>(
    `SELECT id, cron, timezone, type FROM (
       SELECT r.id, r.cron, r.timezone, CASE WHEN json_valid(r.trigger) THEN json_extract(r.trigger, '$.type') END AS type
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
       (SELECT status FROM runs WHERE runs.routine_id = routines.id AND runs.trigger = 'routine' ORDER BY created_at DESC LIMIT 1), 'failed')
     WHERE last_status IN ('queued', 'running')
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
  for (const { job } of jobs.values()) job.stop();
  jobs.clear();
}

/** Currently scheduled routines (for diagnostics and tests). */
export function scheduledRoutines(): { routineId: string; nextRunAt: string | null }[] {
  return [...jobs].map(([routineId, { job }]) => ({ routineId, nextRunAt: job.nextRun()?.toISOString() ?? null }));
}
