/**
 * Routines (cron tasks) CRUD. Scheduling lives in scheduler/scheduler.ts.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import type { Routine, RunStatus, Run } from "@godmode/shared";
import type { RoutineInput } from "@godmode/shared";
import { all, bool, get, insert, int, run, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { getAgent } from "../agents/service";
import * as repo from "../agents/repo";
import { reloadSchedules, triggerRoutine } from "../scheduler/scheduler";
import { badRequest, newId, notFound, now } from "../util";

const log = logger("routines");

interface RoutineRow {
  id: string;
  agent_id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: number;
  reuse_conversation: number;
  conversation_id: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}

function toModel(r: RoutineRow): Routine {
  return {
    id: r.id,
    agentId: r.agent_id,
    name: r.name,
    cron: r.cron,
    timezone: r.timezone,
    prompt: r.prompt,
    enabled: bool(r.enabled),
    reuseConversation: bool(r.reuse_conversation),
    conversationId: r.conversation_id,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    lastStatus: r.last_status as RunStatus | null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* Cron + timezone validation                                           */
/* ------------------------------------------------------------------ */

/** The machine's IANA timezone (fallback UTC). */
export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function validateTimezone(timezone: string): string {
  const tz = timezone.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw badRequest(`Invalid timezone "${timezone}" (expected an IANA name such as "Europe/Berlin")`);
  }
}

function normalizeCron(expr: string): string {
  return expr.trim().replace(/\s+/g, " ");
}

/**
 * Validate a cron expression (5 fields, or 6 with a fixed seconds field; @daily-style nicknames allowed) and
 * return its next run after `from`. Throws 400 "Invalid cron expression" when it can't be parsed or never fires.
 */
export function nextRunFor(expr: string, timezone: string, from?: Date): Date {
  const cron = normalizeCron(expr);
  if (!cron) throw badRequest("Invalid cron expression: it is empty");
  const parts = cron.split(" ");
  if (parts.length === 6 && !/^\d{1,2}$/.test(parts[0]!)) {
    throw badRequest("Invalid cron expression: routines run at most once per minute, so the seconds field must be a single number");
  }
  let job: Cron;
  try {
    job = new Cron(cron, { paused: true, timezone, mode: "5-or-6-parts" });
  } catch (err) {
    const reason = err instanceof Error ? err.message.replace(/^CronPattern:\s*/, "") : String(err);
    throw badRequest(`Invalid cron expression: ${reason}`);
  }
  try {
    const next = job.nextRun(from ?? new Date());
    if (!next) throw badRequest("Invalid cron expression: it never matches a future date");
    return next;
  } finally {
    job.stop();
  }
}

/** Next run as ISO string, or null when the expression is invalid (never throws). */
export function computeNextRunAt(expr: string, timezone: string): string | null {
  try {
    return nextRunFor(expr, timezone).toISOString();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Agent repository snapshot                                            */
/* ------------------------------------------------------------------ */

/** Write state/routines.json into the agent repository and commit (asynchronous, serialized per repo). */
function syncRoutinesFile(agentId: string): void {
  let dir: string;
  try {
    dir = getAgent(agentId).repoPath;
  } catch {
    return; // agent deleted
  }
  if (!existsSync(join(dir, ".git"))) return;
  void repo
    .withRepoLock(dir, async () => {
      const routines = listRoutines({ agentId }).map((r) => ({
        id: r.id,
        name: r.name,
        cron: r.cron,
        timezone: r.timezone,
        prompt: r.prompt,
        enabled: r.enabled,
        reuseConversation: r.reuseConversation,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
      await mkdir(join(dir, "state"), { recursive: true });
      await writeFile(join(dir, "state", "routines.json"), JSON.stringify(routines, null, 2) + "\n", "utf8");
      await repo.commitAllInLock(dir, "Update routines");
    })
    .catch((err) => log.warn(`failed to write routines.json for agent ${agentId}`, err));
}

function changed(routine: Routine) {
  bus.emit({ type: "routine.updated", routine });
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

export function listRoutines(opts: { agentId?: string } = {}): Routine[] {
  const rows = opts.agentId
    ? all<RoutineRow>("SELECT * FROM routines WHERE agent_id = ? ORDER BY name COLLATE NOCASE ASC", opts.agentId)
    : all<RoutineRow>("SELECT * FROM routines ORDER BY name COLLATE NOCASE ASC");
  return rows.map(toModel);
}

export function getRoutine(id: string): Routine {
  const row = get<RoutineRow>("SELECT * FROM routines WHERE id = ?", id);
  if (!row) throw notFound("Routine");
  return toModel(row);
}

function requireText(value: string | undefined, what: string): string {
  const text = (value ?? "").trim();
  if (!text) throw badRequest(`Routine ${what} is required`);
  return text;
}

export function createRoutine(input: RoutineInput): Routine {
  const agent = getAgent(requireText(input.agentId, "agent"));
  const name = requireText(input.name, "name");
  const prompt = requireText(input.prompt, "prompt");
  const cron = normalizeCron(requireText(input.cron, "cron expression"));
  const timezone = validateTimezone(input.timezone?.trim() || defaultTimezone());
  const next = nextRunFor(cron, timezone);
  const enabled = input.enabled !== false;
  const ts = now();
  const row: RoutineRow = {
    id: newId("rtn"),
    agent_id: agent.id,
    name,
    cron,
    timezone,
    prompt,
    enabled: int(enabled)!,
    reuse_conversation: int(input.reuseConversation !== false)!,
    conversation_id: null,
    last_run_at: null,
    next_run_at: enabled && agent.enabled ? next.toISOString() : null,
    last_status: null,
    created_at: ts,
    updated_at: ts,
  };
  insert("routines", { ...row });
  const routine = toModel(row);
  changed(routine);
  syncRoutinesFile(agent.id);
  reloadSchedules();
  return routine;
}

export function updateRoutine(id: string, patch: Partial<RoutineInput>): Routine {
  const current = getRoutine(id);
  const agent = patch.agentId !== undefined ? getAgent(requireText(patch.agentId, "agent")) : getAgent(current.agentId);
  const cron = patch.cron !== undefined ? normalizeCron(requireText(patch.cron, "cron expression")) : current.cron;
  const timezone = patch.timezone !== undefined ? validateTimezone(patch.timezone || defaultTimezone()) : current.timezone;
  const enabled = patch.enabled ?? current.enabled;
  const next = nextRunFor(cron, timezone);
  const agentChanged = agent.id !== current.agentId;
  const reuse = patch.reuseConversation ?? current.reuseConversation;

  update("routines", id, {
    agent_id: agent.id,
    name: patch.name !== undefined ? requireText(patch.name, "name") : undefined,
    prompt: patch.prompt !== undefined ? requireText(patch.prompt, "prompt") : undefined,
    cron,
    timezone,
    enabled: int(enabled),
    reuse_conversation: int(reuse),
    updated_at: now(),
    next_run_at: enabled && agent.enabled ? next.toISOString() : null,
  });
  // A conversation belongs to one agent; a routine that stops reusing its conversation forgets it too.
  if (agentChanged || !reuse) run("UPDATE routines SET conversation_id = NULL WHERE id = ?", id);

  const routine = getRoutine(id);
  changed(routine);
  syncRoutinesFile(agent.id);
  if (agentChanged) syncRoutinesFile(current.agentId);
  reloadSchedules();
  return routine;
}

export function deleteRoutine(id: string): void {
  const routine = getRoutine(id);
  run("DELETE FROM routines WHERE id = ?", id);
  bus.emit({ type: "routine.deleted", id });
  syncRoutinesFile(routine.agentId);
  reloadSchedules();
}

/** Trigger a routine immediately (same path as a cron tick). */
export async function runRoutineNow(id: string): Promise<Run> {
  return triggerRoutine(id);
}
