/**
 * Scheduled automations that failed because Claude was signed out run once more when it works again. The outage of a
 * computer (this one or a runner) ends with the first run there that Claude answers; then every automation whose latest
 * run failed over the sign-in gets one more run — unless its next time slot is less than two hours away, it is turned
 * off now, or that run was itself such a second try (never more than once).
 */
import type { Run } from "@godmode/shared";
import { modelProvider, runEndOf } from "@godmode/shared";
import { all, get, getMeta, setMeta } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { triggerRoutine } from "../scheduler/scheduler";
import { getRoutine } from "../services/routines";
import { parseJson } from "../util";
import { activeMainRun } from "./events";

const log = logger("sign-in-retry");

/** Failed runs looked at after an outage, and the runs that tried them again (newest last). */
const HANDLED_META = "automations.signInRetried";
/** Failed longer ago than this, the automation waits for its next time slot. */
const MAX_AGE_MS = 24 * 3_600_000;
/** Its next time slot is this close: it runs then anyway. */
const NEXT_SLOT_MS = 2 * 3_600_000;
const KEEP_HANDLED = 300;

interface FailedRun {
  id: string;
  routine_id: string;
  error: string;
  runner_id: string | null;
}

function failedSignedOut(error: string | null | undefined): boolean {
  return !!error && runEndOf(error)?.kind === "auth";
}

/** The automations' latest runs that failed over Claude's sign-in, on any computer. */
function signedOutFailures(): FailedRun[] {
  return all<FailedRun>(
    `SELECT r.id, r.routine_id, r.error, c.runner_id FROM runs r JOIN conversations c ON c.id = r.conversation_id
     WHERE r.status = 'failed' AND r.trigger = 'routine' AND r.routine_id IS NOT NULL AND r.error IS NOT NULL AND r.finished_at > ?
       AND r.id = (SELECT l.id FROM runs l WHERE l.routine_id = r.routine_id AND l.trigger = 'routine' ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1)
     ORDER BY +r.created_at, r.rowid`,
    new Date(Date.now() - MAX_AGE_MS).toISOString(),
  ).filter((r) => failedSignedOut(r.error));
}

function handled(): string[] {
  return parseJson<string[]>(getMeta(HANDLED_META), []);
}

function markHandled(runIds: string[]): void {
  setMeta(HANDLED_META, JSON.stringify([...handled(), ...runIds].slice(-KEEP_HANDLED)));
}

/** Why the automation doesn't run again now, or null. */
function skipReason(routineId: string): string | null {
  let routine: ReturnType<typeof getRoutine>;
  try {
    routine = getRoutine(routineId);
  } catch {
    return "deleted";
  }
  if (routine.trigger.type !== "schedule") return "not scheduled";
  if (!routine.enabled) return "turned off";
  if (get<{ enabled: number }>("SELECT enabled FROM agents WHERE id = ?", routine.agentId)?.enabled !== 1) return "agent turned off";
  if (activeMainRun(routineId)) return "already running";
  const next = routine.nextRunAt ? Date.parse(routine.nextRunAt) : Number.NaN;
  if (Number.isFinite(next) && next - Date.now() < NEXT_SLOT_MS) return "next run soon";
  return null;
}

/**
 * Claude answered a run on `runnerId` (null: this computer): run the automations once more that failed there while it
 * was signed out. Returns the runs it started.
 */
export async function retryAfterSignIn(runnerId: string | null): Promise<Run[]> {
  const done = new Set(handled());
  // Each failure is looked at once: a second try that failed again waits for the automation's next time slot.
  const failed = signedOutFailures().filter((r) => r.runner_id === runnerId && !done.has(r.id));
  if (!failed.length) return [];
  markHandled(failed.map((r) => r.id));
  const started: Run[] = [];
  const skipped: Record<string, string> = {};
  for (const r of failed) {
    const reason = skipReason(r.routine_id);
    if (reason) {
      skipped[r.routine_id] = reason;
      continue;
    }
    try {
      const run = await triggerRoutine(r.routine_id, { scheduled: true, title: "Ran again once Claude was signed in" });
      started.push(run);
      markHandled([run.id]);
    } catch (err) {
      skipped[r.routine_id] = err instanceof Error ? err.message : String(err);
    }
  }
  log.info(`ran ${started.length} automation(s) again that failed while Claude was signed out, skipped ${Object.keys(skipped).length}`, {
    ...(runnerId ? { runnerId } : {}),
    runs: started.map((r) => r.id),
    skipped,
  });
  return started;
}

let unsubscribe: (() => void) | null = null;
/** An automation may wait for Claude to work again: set at the start and by every one that fails over the sign-in. */
let watching = false;
let queue: Promise<unknown> = Promise.resolve();

function runnerOf(conversationId: string): string | null {
  return get<{ runner_id: string | null }>("SELECT runner_id FROM conversations WHERE id = ?", conversationId)?.runner_id ?? null;
}

function onFinished(run: Run): void {
  if (run.status === "failed" && run.trigger === "routine" && failedSignedOut(run.error)) {
    watching = true;
    return;
  }
  // A run on Z.ai says nothing about Claude's sign-in.
  if (run.status !== "succeeded" || !watching || modelProvider(run.model) === "zai") return;
  const runnerId = runnerOf(run.conversationId);
  queue = queue
    .then(async () => {
      if (!watching) return;
      await retryAfterSignIn(runnerId);
      const done = new Set(handled());
      if (!signedOutFailures().some((r) => !done.has(r.id))) watching = false;
    })
    .catch((err) => log.warn("could not run the automations again that failed while Claude was signed out", err));
}

export function startSignInRetry(): void {
  if (unsubscribe) return;
  // What failed before this version ran is old news: it isn't started again hours later.
  if (getMeta(HANDLED_META) === null) markHandled(signedOutFailures().map((r) => r.id));
  watching = true;
  unsubscribe = bus.on((e) => {
    if (e.type === "run.finished") onFinished(e.run);
  });
}

export function stopSignInRetry(): void {
  unsubscribe?.();
  unsubscribe = null;
  watching = false;
}

/** Tests: until the retries the last answered run started are through. */
export function signInRetryIdle(): Promise<unknown> {
  return queue;
}
