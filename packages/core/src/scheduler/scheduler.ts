/**
 * Cron scheduler for automations: one croner job per enabled schedule or condition automation of an enabled agent
 * (timezone aware). A schedule tick sends the automation's prompt into its conversation, exactly like a user message;
 * a condition tick starts a condition check (automations/conditions.ts). Schedules with a random start window get a
 * one-off job at the start drawn for their next time slot, replaced by the next one when it fires; with several runs per
 * window every part of the window is such a slot. A slot that fell while the scheduler wasn't running (Godmode was off,
 * the computer slept) runs once when it is back (catchUpMissed). In a device group an automation pinned to one computer
 * (`run_on`) fires there only, also while another computer stands in for the primary; the rest fire where the group's
 * schedules run (remote/group.ts `runsRoutineHere`).
 */
import { Cron } from "croner";
import type { Routine, Run } from "@godmode/shared";
import { MAX_RUNS_PER_WINDOW, MAX_START_WINDOW_MINUTES } from "@godmode/shared";
import { all, get, getMeta, run as exec, setMeta } from "../db";
import { logger } from "../log";
import { getAgent } from "../agents/service";
import { computeNextRunAt, drawnStart, emitRoutine, getRoutine, lastScheduledStart, nextRandomStart, runsOf, startWindowOf, windowPartMs } from "../services/routines";
import { sendMessage } from "../services/conversations";
import { notify } from "../services/notifications";
import { automationConversation } from "../automations/conversation";
import { runConditionCheck } from "../automations/conditions";
import { activeMainRun, ensureRunListener, recordEvent, settleIfFinished } from "../automations/events";
import { HttpError, badRequest, conflict, now, parseJson } from "../util";
import { pausedRun } from "../services/pauses";
import { remindWaitingAutomation } from "../services/questions";
import { exhaustedBudget } from "../services/budgets";
import { isLicenseRequired, noteLicenseRefusal } from "../license/license";
import { localizePaths } from "../remote/localPaths";
import { standInHold } from "../remote/standIn";
import { runsRoutineHere } from "../remote/group";
import { runOnName } from "../remote/routinePins";

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
/** Time slot a catch-up last ran per routine: a late tick or random start for it is skipped. */
const caughtUp = new Map<string, number>();
let started = false;
/** Changes with every start and stop: a catch-up of an earlier one stops starting runs. */
let generation = 0;

interface WantedRoutine {
  id: string;
  cron: string;
  timezone: string;
  type: string;
  start_window: number | null;
  runs: number | null;
  run_on: string | null;
}

/** A schedule's start window and runs per window as the scheduler uses them: out-of-range values count as none. */
function windowOf(startWindow: unknown, runsPerWindow: unknown): { minutes: number; runs: number } {
  const minutes = typeof startWindow === "number" && Number.isInteger(startWindow) && startWindow > 0 && startWindow <= MAX_START_WINDOW_MINUTES ? startWindow : 0;
  const runs = typeof runsPerWindow === "number" && Number.isInteger(runsPerWindow) && runsPerWindow > 1 && runsPerWindow <= MAX_RUNS_PER_WINDOW ? runsPerWindow : 1;
  return { minutes, runs };
}

function signature(r: WantedRoutine): string {
  return `${r.type}\u0000${r.cron}\u0000${r.timezone}\u0000${r.start_window ?? 0}\u0000${r.runs ?? 1}`;
}

/**
 * The time a cron tick was due (croner tells when it fired): a Mac that slept fires it late. Looked up two seconds
 * ahead: at fire time croner counts the current slot as still to come, and it compares whole seconds.
 */
export function dueSlot(job: Cron, firedAt: Date): Date | null {
  return job.previousRuns(1, new Date(firedAt.getTime() + 2_000))[0] ?? null;
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
    (self: Cron) => {
      const slot = dueSlot(self, new Date());
      return onTick(r.id, slot, slot);
    },
  );
}

function randomStartJob(r: WantedRoutine, windowMinutes: number, runs: number, handledUntil: number): Cron {
  const { slot, at } = nextRandomStart(r.id, r.cron, r.timezone, windowMinutes, new Date(), handledUntil, runs);
  const job: Cron = new Cron(at, { catch: (err) => log.error(`routine ${r.id} tick crashed`, err) }, () => {
    const current = jobs.get(r.id);
    if (current?.job !== job) return;
    firedSlots.set(r.id, slot.getTime());
    // Plan the next slot first: the run's next_run_at is read from the job.
    try {
      jobs.set(r.id, { job: randomStartJob(r, windowMinutes, runs, slot.getTime()), signature: current.signature });
    } catch (err) {
      jobs.delete(r.id);
      log.warn(`routine ${r.id} has no next start`, err);
    }
    return onTick(r.id, at, slot);
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
    return nextRandomStart(routine.id, routine.cron, routine.timezone, minutes, new Date(), handledUntil(routine.id), runsOf(routine.trigger)).at.toISOString();
  } catch {
    return null;
  }
}

/**
 * Run a schedule automation now: same path as a cron tick. Throws 409 when the agent is disabled or the routine is
 * already running. `scheduled` ticks additionally skip routines that were disabled meanwhile.
 */
export async function triggerRoutine(id: string, opts: { scheduled?: boolean; byHuman?: boolean; title?: string; note?: string } = {}): Promise<Run> {
  ensureRunListener();
  const routine = getRoutine(id);
  if (routine.trigger.type !== "schedule") throw badRequest(`“${routine.name}” is not a scheduled automation`);
  const agent = getAgent(routine.agentId);
  if (!agent.enabled) throw conflict(`Agent "${agent.name}" is disabled`);
  if (opts.scheduled && !routine.enabled) throw conflict(`Routine "${routine.name}" is disabled`);
  if (opts.scheduled && !runsRoutineHere(routine.runOn)) {
    throw conflict(`Routine "${routine.name}" runs on ${routine.runOn ? runOnName(routine.runOn) : "the computer that runs the group's schedules"}`);
  }
  const held = opts.scheduled ? standInHold(agent.id, routine.prompt) : null;
  if (held) {
    recordEvent(id, { source: "schedule", title: opts.title ?? "Scheduled time reached", status: "skipped", note: held });
    throw conflict(`Routine "${routine.name}": ${held}`);
  }
  const active = triggering.has(id) ? null : activeMainRun(id);
  if (triggering.has(id) || active) {
    if (opts.scheduled) {
      const reason = active ? pausedRun(active)?.reason : undefined;
      const waits = reason === "question";
      const note = waits ? "The previous run is waiting for your answer" : reason === "budget" ? "The previous run is held — a monthly budget is used up" : "The previous run was still in progress";
      // A held run skips every tick until the budget has room: once on the list is enough.
      const last = get<{ note: string | null }>("SELECT note FROM automation_events WHERE routine_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", id);
      if (reason !== "budget" || last?.note !== note) recordEvent(id, { source: "schedule", title: "Scheduled time reached", status: "skipped", note });
      if (waits) remindWaitingAutomation(id);
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
    const { run } = await sendMessage(conversationId, { content: localizePaths(routine.prompt), trigger: "routine", routineId: routine.id, source: "automation", byHuman: opts.byHuman });
    recordEvent(id, {
      source: opts.scheduled ? "schedule" : "manual",
      title: opts.title ?? (opts.scheduled ? "Scheduled time reached" : "Started manually"),
      status: "running",
      runId: run.id,
      note: opts.note,
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

/**
 * In a device group (remote/devices.ts): late ticks (this computer slept or was away) wait until the group's copies are
 * in, and are skipped when another computer ran that time already (it stood in).
 */
interface ScheduleGroup {
  active: () => boolean;
  settle: () => Promise<void>;
  /**
   * A secondary: what came due for the group while it stood in is runMissedSince's; it catches up only automations
   * pinned to it.
   */
  standingIn?: () => boolean;
}

let group: ScheduleGroup | null = null;

export function setScheduleGroup(hooks: ScheduleGroup | null): void {
  group = hooks;
}

const LATE_MS = 60_000;

/** A scheduled start that didn't happen: skipped (409) is logged, anything else is told. */
function startFailed(routine: Routine, err: unknown): void {
  if (err instanceof HttpError && err.status === 409) {
    log.info(`routine ${routine.id} skipped: ${err.message}`);
    return;
  }
  if (err instanceof HttpError && err.status === 404) {
    reloadSchedules();
    return;
  }
  if (isLicenseRequired(err)) {
    if (routine.trigger.type !== "condition") recordEvent(routine.id, { source: "schedule", title: "Scheduled time reached", status: "failed", note: err.message });
    noteLicenseRefusal(`Automation “${routine.name}”`, err);
    return;
  }
  log.error(`routine ${routine.id} failed to start`, err);
  notify("error", `Automation “${routine.name}” could not start`, err instanceof Error ? err.message : String(err), `/agents/${routine.agentId}`);
}

async function onTick(routineId: string, scheduledAt: Date | null = null, slot: Date | null = null) {
  const late = !!group?.active() && !!scheduledAt && Date.now() - scheduledAt.getTime() > LATE_MS;
  if (late) await group!.settle().catch(() => undefined);
  let routine: Routine;
  try {
    routine = getRoutine(routineId);
  } catch {
    reloadSchedules();
    return;
  }
  if (!runsRoutineHere(routine.runOn)) {
    reloadSchedules();
    return;
  }
  // Another computer of the group ran this time already (it stood in while this one was away).
  if (late && routine.lastRunAt && Date.parse(routine.lastRunAt) >= scheduledAt!.getTime() - LATE_MS) {
    log.info(`routine ${routineId} already ran at ${routine.lastRunAt}; this late tick is skipped`);
    return;
  }
  try {
    if (slot && (caughtUp.get(routineId) ?? 0) >= slot.getTime()) {
      log.info(`routine ${routineId} caught up its ${slot.toISOString()} slot already; this tick is skipped`);
      return;
    }
    // A condition check costs money each time: none while the agent's or the team's monthly budget is used up.
    if (routine.trigger.type === "condition" && exhaustedBudget(getAgent(routine.agentId))) {
      log.info(`routine ${routineId} skipped its check: a monthly budget is used up`);
      return;
    }
    const run =
      routine.trigger.type === "condition"
        ? await runConditionCheck(routineId, { scheduled: true })
        : await triggerRoutine(routineId, { scheduled: true });
    log.info(`routine ${routineId} started ${run.trigger === "check" ? "a check" : "run"} ${run.id}`);
  } catch (err) {
    startFailed(routine, err);
  } finally {
    const next = jobs.get(routineId)?.job.nextRun()?.toISOString() ?? null;
    if (exec("UPDATE routines SET next_run_at = ? WHERE id = ? AND next_run_at IS NOT ?", next, routineId, next).changes > 0) emitRoutine(routineId);
  }
}

interface ScheduleRow {
  id: string;
  cron: string;
  timezone: string;
  trigger: string;
  run_on: string | null;
  created_at: string;
}

/** Enabled schedules this computer fires. */
function scheduleRows(): ScheduleRow[] {
  return all<ScheduleRow>(
    `SELECT r.id, r.cron, r.timezone, r.trigger, r.run_on, r.created_at FROM routines r JOIN agents a ON a.id = r.agent_id
      WHERE r.enabled = 1 AND a.enabled = 1 AND CASE WHEN json_valid(r.trigger) THEN json_extract(r.trigger, '$.type') END = 'schedule'`,
  ).filter((r) => runsRoutineHere(r.run_on));
}

/**
 * The latest time slot of a schedule up to `at` (with several runs per window: the latest part), when it was to start
 * (its drawn start in a random start window) and when the slot after it comes. The slot comes from the schedule itself.
 */
function lastSlot(r: ScheduleRow, at: number): { slot: number; start: number; next: number } | null {
  const trigger = parseJson(r.trigger, { type: "schedule" }) as Routine["trigger"];
  const { minutes, runs } = windowOf(startWindowOf(trigger), runsOf(trigger));
  let base: Date | null;
  let cron: Cron;
  try {
    cron = new Cron(r.cron, { timezone: r.timezone, mode: "5-or-6-parts", paused: true });
    base = dueSlot(cron, new Date(at));
  } catch {
    return null;
  }
  if (!base) return null;
  const following = cron.nextRun(base)?.getTime() ?? Infinity;
  if (!minutes) return { slot: base.getTime(), start: base.getTime(), next: following };
  const part = windowPartMs(minutes, runs);
  const k = runs > 1 ? Math.min(runs - 1, Math.max(0, Math.floor((at - base.getTime()) / part))) : 0;
  const slot = base.getTime() + k * part;
  return { slot, start: drawnStart(r.id, new Date(slot), minutes, runs).getTime(), next: k < runs - 1 ? slot + part : following };
}

/** Whether a time slot of a routine was started already: here (a tick, a catch-up) or by another computer of the group. */
function slotTaken(id: string, slot: number): boolean {
  if ((caughtUp.get(id) ?? 0) >= slot || (firedSlots.get(id) ?? 0) >= slot) return true;
  const last = get<{ last_run_at: string | null }>("SELECT last_run_at FROM routines WHERE id = ?", id)?.last_run_at;
  return (!!last && Date.parse(last) >= slot - LATE_MS) || lastScheduledStart(id) >= slot - LATE_MS;
}

/**
 * A computer that starts standing in for its primary: scheduled automations whose last time slot came since the primary
 * was last seen and that didn't run since (anywhere in the group) run now, once each. The stored next run is rewritten
 * as soon as the scheduler starts here, so the slot comes from the schedule.
 */
export async function runMissedSince(since: string): Promise<number> {
  const from = Date.parse(since);
  if (!Number.isFinite(from)) return 0;
  const gen = generation;
  let ran = 0;
  for (const r of scheduleRows()) {
    if (gen !== generation) break;
    // Pinned here: this computer's own, caught up like any of its schedules (catchUpMissed).
    if (r.run_on || !runsRoutineHere(null)) continue;
    const due = lastSlot(r, Date.now());
    // A drawn start still to come: this computer's own random start runs it.
    if (!due || due.slot < from - LATE_MS || due.start > Date.now() || slotTaken(r.id, due.slot)) continue;
    caughtUp.set(r.id, due.slot);
    try {
      await triggerRoutine(r.id, { scheduled: true });
      ran++;
    } catch (err) {
      log.info(`routine ${r.id} didn't catch up`, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return ran;
}

const ALIVE_KEY = "scheduler.alive_at";
const BEAT_MS = 60_000;
/** The wall clock jumped this much more than a heartbeat: the computer slept (Node's timers stand still meanwhile). */
const WAKE_GAP_MS = 2 * 60_000;
/** After a wake: croner's late ticks come first, and a device group notices the wake before it settles. */
const WAKE_CATCH_UP_DELAY_MS = 10_000;
const CATCH_UP_MAX_AGE_MS = 12 * 3_600_000;
const CATCH_UP_MIN_LEAD_MS = 2 * 3_600_000;
let beatTimer: ReturnType<typeof setInterval> | null = null;
/** Last heartbeat of this process; 0 = none yet (the stored one is from an earlier process). */
let lastBeat = 0;

function beat(): void {
  lastBeat = Date.now();
  try {
    setMeta(ALIVE_KEY, new Date(lastBeat).toISOString());
  } catch (err) {
    log.debug("could not store the scheduler heartbeat", err);
  }
}

/**
 * Scheduled automations whose time slot fell while the scheduler wasn't running — Godmode was off or the computer
 * slept since `aliveAt` (its last heartbeat) — run now, once each: only the latest slot, at most 12 h old, and not when
 * the next one comes within 2 h. Slots the running scheduler skipped on purpose (still running, budget) stay skipped.
 */
export async function catchUpMissed(reason: "start" | "wake", aliveAt: number): Promise<number> {
  if (!Number.isFinite(aliveAt) || aliveAt <= 0) return 0;
  const gen = generation;
  if (group?.active()) await group.settle().catch(() => undefined);
  if (!started) return 0;
  let ran = 0;
  for (const r of scheduleRows()) {
    if (gen !== generation) break;
    if (!r.run_on && group?.standingIn?.()) continue;
    const t = Date.now();
    const due = lastSlot(r, t);
    if (!due || due.start > t || due.start <= aliveAt - LATE_MS || Date.parse(r.created_at) >= due.slot || slotTaken(r.id, due.slot)) continue;
    const slot = new Date(due.slot).toISOString();
    if (due.slot < t - CATCH_UP_MAX_AGE_MS || due.next < t + CATCH_UP_MIN_LEAD_MS) {
      const why = due.slot < t - CATCH_UP_MAX_AGE_MS ? "it is older than 12 h" : "its next slot comes within 2 h";
      log.info(`routine ${r.id} doesn't catch up its missed ${slot} slot (${reason}): ${why}`);
      continue;
    }
    caughtUp.set(r.id, due.slot);
    try {
      const note = reason === "start" ? "Caught up: Godmode wasn't running at the scheduled time" : "Caught up: the computer was asleep at the scheduled time";
      const run = await triggerRoutine(r.id, { scheduled: true, note });
      ran++;
      log.info(`routine ${r.id} caught up its missed ${slot} slot (${reason}): run ${run.id}`);
    } catch (err) {
      try {
        startFailed(getRoutine(r.id), err);
      } catch {
        log.info(`routine ${r.id} didn't catch up its missed ${slot} slot (${reason})`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return ran;
}

/** Re-read routines from DB and reschedule (after CRUD). Unchanged jobs keep running. */
export function reloadSchedules(): void {
  if (!started) return;
  const wanted = all<WantedRoutine>(
    `SELECT id, cron, timezone, type, start_window, runs, run_on FROM (
       SELECT r.id, r.cron, r.timezone, r.run_on,
         CASE WHEN json_valid(r.trigger) THEN json_extract(r.trigger, '$.type') END AS type,
         CASE WHEN json_valid(r.trigger) THEN json_extract(r.trigger, '$.startWindowMinutes') END AS start_window,
         CASE WHEN json_valid(r.trigger) THEN json_extract(r.trigger, '$.runsPerWindow') END AS runs
       FROM routines r JOIN agents a ON a.id = r.agent_id WHERE r.enabled = 1 AND a.enabled = 1)
      WHERE type IN ('schedule', 'condition')`,
  ).filter((r) => runsRoutineHere(r.run_on));
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
      const { minutes: windowMinutes, runs } = windowOf(r.type === "schedule" ? r.start_window : null, r.runs);
      const job = windowMinutes > 0 ? randomStartJob(r, windowMinutes, runs, handledUntil(r.id)) : cronJob(r);
      jobs.set(r.id, { job, signature: signature(r) });
    } catch (err) {
      log.warn(`routine ${r.id} has an invalid schedule (${r.cron} ${r.timezone})`, err);
    }
  }

  // Persist next run times so the UI shows when each routine fires next. Another computer's pinned ones are its own.
  for (const row of all<{ id: string; next_run_at: string | null; run_on: string | null }>("SELECT id, next_run_at, run_on FROM routines")) {
    if (!runsRoutineHere(row.run_on)) continue;
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
  const here = all<{ id: string; run_on: string | null }>("SELECT id, run_on FROM routines WHERE last_status IN ('queued', 'running', 'paused')")
    .filter((r) => runsRoutineHere(r.run_on))
    .map((r) => r.id);
  if (!here.length) return;
  exec(
    `UPDATE routines SET last_status = COALESCE(
       (SELECT status FROM runs WHERE runs.routine_id = routines.id AND runs.trigger = 'routine' ORDER BY created_at DESC LIMIT 1), 'failed')
     WHERE last_status IN ('queued', 'running', 'paused') AND id IN (SELECT value FROM json_each(?))
       AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.routine_id = routines.id AND runs.trigger = 'routine' AND runs.status IN ('queued', 'running'))`,
    JSON.stringify(here),
  );
}

export function startScheduler(): void {
  if (started) return;
  started = true;
  ensureRunListener();
  repairStaleStatuses();
  reloadSchedules();
  log.info(`scheduler started with ${jobs.size} routine(s)`);
  generation++;
  const aliveAt = lastBeat || Date.parse(getMeta(ALIVE_KEY) ?? "");
  beat();
  beatTimer = setInterval(() => {
    const before = lastBeat;
    beat();
    if (lastBeat - before > BEAT_MS + WAKE_GAP_MS) setTimeout(() => void catchUpMissed("wake", before), WAKE_CATCH_UP_DELAY_MS).unref?.();
  }, BEAT_MS);
  beatTimer.unref?.();
  // After the services that start next: runs started now are told and counted like any other.
  setTimeout(() => void catchUpMissed("start", aliveAt), 0);
}

export function stopScheduler(): void {
  if (started) beat();
  started = false;
  generation++;
  if (beatTimer) clearInterval(beatTimer);
  beatTimer = null;
  firedSlots.clear();
  caughtUp.clear();
  for (const { job } of jobs.values()) job.stop();
  jobs.clear();
}

/** Currently scheduled routines (for diagnostics and tests). */
export function scheduledRoutines(): { routineId: string; nextRunAt: string | null }[] {
  return [...jobs].map(([routineId, { job }]) => ({ routineId, nextRunAt: job.nextRun()?.toISOString() ?? null }));
}
