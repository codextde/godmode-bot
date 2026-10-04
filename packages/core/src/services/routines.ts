/**
 * Routines = automations: CRUD, trigger validation and trigger state.
 * Scheduling lives in scheduler/scheduler.ts, event handling in automations/, app triggers in integrations/composioTriggers.ts.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import type { Agent, Routine, RoutineInput, RoutineTrigger, RoutineTriggerStatus, RunStatus, Run } from "@godmode/shared";
import { isModelId, MAX_START_WINDOW_MINUTES, startWindowLimit, startWindowTooLong } from "@godmode/shared";
import { all, bool, get, insert, int, run, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { getAgent } from "../agents/service";
import * as repo from "../agents/repo";
import { reloadSchedules, triggerRoutine } from "../scheduler/scheduler";
import { runConditionCheck } from "../automations/conditions";
import { cancelPendingEvents, sendTestEvent } from "../automations/events";
import { clearWebhookToken, issueWebhookToken, webhookPathOf } from "../automations/webhooks";
import { appTriggerHealth, getTriggerType, missingConfigFields, requestAppTriggerSync } from "../integrations/composioTriggers";
import { badRequest, conflict, newId, notFound, now, parseJson } from "../util";

const log = logger("routines");

export interface RoutineRow {
  id: string;
  agent_id: string;
  name: string;
  trigger: string;
  cron: string;
  timezone: string;
  prompt: string;
  filter: string;
  enabled: number;
  reuse_conversation: number;
  notify?: string | null;
  conversation_id: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
  trigger_state: string;
  webhook_token_hash: string | null;
  webhook_token_enc: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Runtime state of a trigger (JSON column `trigger_state`). Absent keys mean null/false.
 * Updated with SQLite's json_patch (RFC 7396): a null value removes the key.
 */
export interface TriggerState {
  /** App triggers: Composio trigger instance (`ti_…`) and the setup it was created for. */
  composioTriggerId?: string;
  composioSignature?: string;
  /** Last successful upsert (instances are re-upserted hourly in case Composio lost them). */
  composioVerifiedAt?: string;
  /** App triggers: the instance was disabled on Composio because the automation is off. */
  remoteDisabled?: boolean;
  /** Setup problem (app triggers) or failed last check (conditions). */
  error?: string;
  lastEventAt?: string;
  /** Condition triggers */
  lastCheckAt?: string;
  observation?: string;
  /** When `observation` was made (it only moves on once a met condition's task succeeded). */
  observedAt?: string;
  /** Failed task runs in a row after the condition was met. */
  taskFailures?: number;
  checkConversationId?: string;
  checkRunId?: string;
  /** Too many runs in the last hour: events wait until then. */
  limitedUntil?: string;
}

export const TRIGGER_TYPES = ["schedule", "app", "condition", "webhook"] as const;
/** Condition checks start an agent run: not more often than this. */
export const MIN_CHECK_INTERVAL_MS = 5 * 60_000;
const MAX_FILTER = 2000;
const MAX_CONDITION = 2000;
const MAX_CONFIG_BYTES = 16_000;

export function parseTrigger(raw: string | null | undefined): RoutineTrigger {
  const t = parseJson<RoutineTrigger | null>(raw, null);
  return t && typeof t === "object" && TRIGGER_TYPES.includes(t.type) ? t : { type: "schedule" };
}

export function readTriggerState(id: string): TriggerState {
  return parseJson<TriggerState>(get<{ trigger_state: string }>("SELECT trigger_state FROM routines WHERE id = ?", id)?.trigger_state, {});
}

/** Merge `patch` into the trigger state (null removes a key). Returns false when the routine is gone. */
export function patchTriggerState(id: string, patch: { [K in keyof TriggerState]?: TriggerState[K] | null }): boolean {
  return (
    run(
      "UPDATE routines SET trigger_state = json_patch(CASE WHEN json_valid(trigger_state) THEN trigger_state ELSE '{}' END, ?) WHERE id = ?",
      JSON.stringify(patch),
      id,
    ).changes > 0
  );
}

function agentEnabled(agentId: string): boolean {
  return bool(get<{ enabled: number }>("SELECT enabled FROM agents WHERE id = ?", agentId)?.enabled);
}

function triggerStatusOf(r: RoutineRow, trigger: RoutineTrigger, state: TriggerState): RoutineTriggerStatus {
  const base = { lastEventAt: state.lastEventAt ?? null, lastCheckAt: state.lastCheckAt ?? null, observation: state.observation ?? null };
  if (!bool(r.enabled)) return { ...base, state: "off", message: "Paused" };
  if (!agentEnabled(r.agent_id)) return { ...base, state: "off", message: "The agent is disabled" };
  if (state.limitedUntil && Date.parse(state.limitedUntil) > Date.now()) {
    return { ...base, state: "pending", message: "Too many runs in the last hour — new events wait a little" };
  }
  switch (trigger.type) {
    case "app": {
      if (state.error) return { ...base, state: "error", message: state.error };
      if (!state.composioTriggerId) return { ...base, state: "pending", message: "Setting up the app trigger…" };
      const health = appTriggerHealth();
      return { ...base, ...health };
    }
    case "condition":
      return state.error ? { ...base, state: "error", message: state.error } : { ...base, state: "ok", message: null };
    case "webhook":
      return r.webhook_token_hash
        ? { ...base, state: "ok", message: null }
        : { ...base, state: "error", message: "No webhook URL yet — rotate the URL to create one" };
    default:
      return { ...base, state: "ok", message: null };
  }
}

function toModel(r: RoutineRow, pending = 0): Routine {
  const trigger = parseTrigger(r.trigger);
  const state = parseJson<TriggerState>(r.trigger_state, {});
  return {
    id: r.id,
    agentId: r.agent_id,
    name: r.name,
    trigger,
    cron: r.cron,
    timezone: r.timezone,
    prompt: r.prompt,
    filter: r.filter,
    enabled: bool(r.enabled),
    reuseConversation: bool(r.reuse_conversation),
    notify: r.notify === "always" || r.notify === "never" ? r.notify : "failures",
    conversationId: r.conversation_id,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    lastStatus: r.last_status as RunStatus | null,
    triggerStatus: triggerStatusOf(r, trigger, state),
    webhookPath: trigger.type === "webhook" ? webhookPathOf(r) : null,
    pendingEvents: pending,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function pendingCounts(): Map<string, number> {
  return new Map(
    all<{ routine_id: string; n: number }>("SELECT routine_id, COUNT(*) AS n FROM automation_events WHERE status = 'pending' GROUP BY routine_id").map(
      (r) => [r.routine_id, r.n],
    ),
  );
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

/** Condition checks are agent runs: refuse schedules that would check more often than every 5 minutes. */
function assertCheckInterval(cron: string, timezone: string) {
  let at = nextRunFor(cron, timezone);
  for (let i = 0; i < 12; i++) {
    const next = nextRunFor(cron, timezone, at);
    if (next.getTime() - at.getTime() < MIN_CHECK_INTERVAL_MS) {
      throw badRequest("Conditions can be checked at most every 5 minutes — every check is an agent run");
    }
    at = next;
  }
}

/** Minutes of the random start window of a schedule; 0 = on time. */
export function startWindowOf(trigger: RoutineTrigger): number {
  return trigger.type === "schedule" ? (trigger.startWindowMinutes ?? 0) : 0;
}

function assertStartWindow(cron: string, timezone: string, minutes: number) {
  const limit = startWindowLimit((after) => nextRunFor(cron, timezone, after), timezone);
  if (minutes > limit) throw badRequest(startWindowTooLong(limit));
}

/** Offset into the window, fixed per routine and time slot so a restart or an unrelated edit keeps the drawn start. */
function startOffsetMs(routineId: string, slot: Date, windowMinutes: number): number {
  const hash = createHash("sha256").update(`${routineId}:${slot.toISOString()}`).digest();
  return Math.floor((hash.readUInt32BE(0) / 2 ** 32) * windowMinutes * 60) * 1000;
}

/**
 * Next start of a schedule with a random start window: the first time slot after `handledUntil` (ms) whose drawn
 * start lies after `after`. Slots whose window is still open count, so a start drawn late in the window survives a restart.
 */
export function nextRandomStart(
  routineId: string,
  cron: string,
  timezone: string,
  windowMinutes: number,
  after = new Date(),
  handledUntil = 0,
): { slot: Date; at: Date } {
  let from = Math.max(after.getTime() - windowMinutes * 60_000, handledUntil);
  for (let i = 0; i < 100; i++) {
    const slot = nextRunFor(cron, timezone, new Date(from));
    const at = new Date(slot.getTime() + startOffsetMs(routineId, slot, windowMinutes));
    if (at > after) return { slot, at };
    from = slot.getTime();
  }
  throw badRequest("Invalid cron expression: it never matches a future date");
}

/** When the scheduler last started this routine on its own (its latest schedule event); 0 = never. */
export function lastScheduledStart(routineId: string): number {
  const at = get<{ at: string | null }>(
    "SELECT MAX(created_at) AS at FROM automation_events WHERE routine_id = ? AND source = 'schedule'",
    routineId,
  )?.at;
  return at ? Date.parse(at) : 0;
}

/** Whether the trigger runs on the cron schedule (schedule: runs, condition: checks). */
export function usesCron(trigger: RoutineTrigger): boolean {
  return trigger.type === "schedule" || trigger.type === "condition";
}

/* ------------------------------------------------------------------ */
/* Trigger validation                                                   */
/* ------------------------------------------------------------------ */

interface ConnectionRow {
  id: string;
  connected_account_id: string;
  toolkit: string;
  workspace_id: string | null;
  agent_id: string | null;
  status: string;
}

/** An automation may only watch accounts its agent could use: its own, its workspace's or a global one. */
export function accountInScope(
  connection: { agent_id: string | null; workspace_id: string | null },
  agent: { id: string; workspaceId: string | null },
): boolean {
  return connection.agent_id ? connection.agent_id === agent.id : !connection.workspace_id || connection.workspace_id === agent.workspaceId;
}

/** The Composio connection (by Godmode or Composio id) an automation of this agent may watch. */
export function connectionForAgent(connectionId: string, agent: Pick<Agent, "id" | "workspaceId">): ConnectionRow {
  const row =
    get<ConnectionRow>("SELECT * FROM composio_connections WHERE id = ?", connectionId) ??
    (connectionId ? get<ConnectionRow>("SELECT * FROM composio_connections WHERE connected_account_id = ?", connectionId) : null);
  if (!row) throw badRequest("That connected app account does not exist (anymore)");
  if (!accountInScope(row, agent)) throw badRequest("That connected account belongs to another agent or workspace — this agent can't be triggered by it");
  if (!row.connected_account_id) throw badRequest(`${row.toolkit} needs no account, so it has no events to watch`);
  return row;
}

/** Human name for a trigger slug when the catalog's name is unknown: "GMAIL_NEW_GMAIL_MESSAGE" → "Gmail new gmail message". */
export function humanizeSlug(slug: string): string {
  const words = slug.toLowerCase().split(/[_\s]+/).filter(Boolean).join(" ");
  return words ? words[0]!.toUpperCase() + words.slice(1) : slug;
}

function text(value: unknown, what: string, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw badRequest(`${what} is required`);
  if (s.length > max) throw badRequest(`${what} is too long (max ${max} characters)`);
  return s;
}

/** Validate and normalize a trigger for an agent. */
export function normalizeTrigger(input: RoutineTrigger | undefined, agent: Pick<Agent, "id" | "workspaceId">): RoutineTrigger {
  const t = input ?? { type: "schedule" };
  switch (t?.type) {
    case "schedule": {
      const minutes = t.startWindowMinutes ?? 0;
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_START_WINDOW_MINUTES) {
        throw badRequest(`The random start window must be a whole number of minutes between 0 and ${MAX_START_WINDOW_MINUTES}`);
      }
      return minutes ? { type: "schedule", startWindowMinutes: minutes } : { type: "schedule" };
    }
    case "webhook":
      return { type: t.type };
    case "condition": {
      const checkModel = typeof t.checkModel === "string" && t.checkModel.trim() ? t.checkModel.trim() : null;
      if (checkModel && !isModelId(checkModel)) throw badRequest(`Invalid model "${checkModel}"`);
      return { type: "condition", condition: text(t.condition, "The condition", MAX_CONDITION), checkModel };
    }
    case "app": {
      const connection = connectionForAgent(text(t.connectionId, "The connected account", 200), agent);
      const triggerSlug = text(t.triggerSlug, "The app event", 200).toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_]*$/.test(triggerSlug)) throw badRequest(`Invalid app event "${t.triggerSlug}"`);
      const config = t.config ?? {};
      if (typeof config !== "object" || Array.isArray(config)) throw badRequest("The app event settings must be an object");
      if (JSON.stringify(config).length > MAX_CONFIG_BYTES) throw badRequest("The app event settings are too large");
      const triggerName = typeof t.triggerName === "string" && t.triggerName.trim() ? t.triggerName.trim().slice(0, 200) : humanizeSlug(triggerSlug);
      return { type: "app", connectionId: connection.id, toolkit: connection.toolkit, triggerSlug, triggerName, config };
    }
    default:
      throw badRequest(`Unknown trigger type "${(t as { type?: unknown })?.type}" (expected schedule, app, condition or webhook)`);
  }
}

/**
 * Check an app trigger against Composio's catalog before saving it: the event exists, belongs to the account's app
 * and has its required settings; fills in the event's display name. Other triggers pass through.
 */
export async function resolveAppTrigger(trigger: RoutineTrigger | undefined, agentId: string): Promise<RoutineTrigger | undefined> {
  if (trigger?.type !== "app") return trigger;
  const connection = connectionForAgent(text(trigger.connectionId, "The connected account", 200), getAgent(agentId));
  const type = await getTriggerType(text(trigger.triggerSlug, "The app event", 200));
  if (type.toolkit && type.toolkit !== connection.toolkit) {
    throw badRequest(`“${type.name}” is a ${type.toolkit} event, but the chosen account is ${connection.toolkit}`);
  }
  const config = trigger.config ?? {};
  const missing = missingConfigFields(type, config);
  if (missing.length) throw badRequest(`“${type.name}” needs these settings: ${missing.join(", ")}`);
  return { type: "app", connectionId: connection.id, toolkit: connection.toolkit, triggerSlug: type.slug, triggerName: type.name, config };
}

function sameTrigger(a: RoutineTrigger, b: RoutineTrigger): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
        trigger: r.trigger,
        cron: r.cron,
        timezone: r.timezone,
        prompt: r.prompt,
        filter: r.filter,
        enabled: r.enabled,
        reuseConversation: r.reuseConversation,
        notify: r.notify,
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

/** Push the routine's current state to the UIs (after trigger state or event changes). */
export function emitRoutine(id: string) {
  try {
    changed(getRoutine(id));
  } catch {
    /* routine deleted meanwhile */
  }
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

export function listRoutines(opts: { agentId?: string } = {}): Routine[] {
  const rows = opts.agentId
    ? all<RoutineRow>("SELECT * FROM routines WHERE agent_id = ? ORDER BY name COLLATE NOCASE ASC", opts.agentId)
    : all<RoutineRow>("SELECT * FROM routines ORDER BY name COLLATE NOCASE ASC");
  const pending = pendingCounts();
  return rows.map((r) => toModel(r, pending.get(r.id) ?? 0));
}

export function getRoutineRow(id: string): RoutineRow {
  const row = get<RoutineRow>("SELECT * FROM routines WHERE id = ?", id);
  if (!row) throw notFound("Routine");
  return row;
}

export function getRoutine(id: string): Routine {
  const row = getRoutineRow(id);
  const pending = get<{ n: number }>("SELECT COUNT(*) AS n FROM automation_events WHERE routine_id = ? AND status = 'pending'", id)?.n ?? 0;
  return toModel(row, pending);
}

function requireText(value: string | undefined, what: string): string {
  const text = (value ?? "").trim();
  if (!text) throw badRequest(`Routine ${what} is required`);
  return text;
}

function normalizeFilter(value: string | undefined): string {
  const f = (value ?? "").trim();
  if (f.length > MAX_FILTER) throw badRequest(`The filter is too long (max ${MAX_FILTER} characters)`);
  return f;
}

/** Cron + next run for a trigger; "" / null for event triggers. `checkWindow: false` keeps a saved start window as it is. */
function scheduleFor(
  id: string,
  trigger: RoutineTrigger,
  cronInput: string | undefined,
  timezone: string,
  checkWindow = true,
): { cron: string; next: Date | null } {
  if (!usesCron(trigger)) return { cron: "", next: null };
  const cron = normalizeCron(requireText(cronInput, trigger.type === "condition" ? "check frequency (cron expression)" : "cron expression"));
  let next = nextRunFor(cron, timezone);
  if (trigger.type === "condition") assertCheckInterval(cron, timezone);
  const startWindow = startWindowOf(trigger);
  if (startWindow) {
    if (checkWindow) assertStartWindow(cron, timezone, startWindow);
    next = nextRandomStart(id, cron, timezone, startWindow, new Date(), lastScheduledStart(id)).at;
  }
  return { cron, next };
}

export function createRoutine(input: RoutineInput): Routine {
  const agent = getAgent(requireText(input.agentId, "agent"));
  const name = requireText(input.name, "name");
  const prompt = requireText(input.prompt, "prompt");
  const trigger = normalizeTrigger(input.trigger, agent);
  const timezone = validateTimezone(input.timezone?.trim() || defaultTimezone());
  const id = newId("rtn");
  const { cron, next } = scheduleFor(id, trigger, input.cron, timezone);
  const filter = trigger.type === "app" || trigger.type === "webhook" ? normalizeFilter(input.filter) : "";
  const enabled = input.enabled !== false;
  // The webhook secret is sealed with the vault key: fail before anything is stored when the vault is locked.
  const webhook = trigger.type === "webhook" ? issueWebhookToken(id) : null;
  const ts = now();
  const row: RoutineRow = {
    id,
    agent_id: agent.id,
    name,
    trigger: JSON.stringify(trigger),
    cron,
    timezone,
    prompt,
    filter,
    enabled: int(enabled)!,
    // Event runs get a conversation each by default: untrusted event data doesn't pile up in one long session.
    reuse_conversation: int(input.reuseConversation ?? usesCron(trigger))!,
    notify: input.notify ?? "failures",
    conversation_id: null,
    last_run_at: null,
    next_run_at: enabled && agent.enabled && next ? next.toISOString() : null,
    last_status: null,
    trigger_state: "{}",
    webhook_token_hash: webhook?.hash ?? null,
    webhook_token_enc: webhook?.enc ?? null,
    created_at: ts,
    updated_at: ts,
  };
  insert("routines", { ...row });
  const routine = getRoutine(id);
  changed(routine);
  syncRoutinesFile(agent.id);
  reloadSchedules();
  if (trigger.type === "app") requestAppTriggerSync();
  return routine;
}

export function updateRoutine(id: string, patch: Partial<RoutineInput>): Routine {
  const current = getRoutine(id);
  const row = getRoutineRow(id);
  const agent = patch.agentId !== undefined ? getAgent(requireText(patch.agentId, "agent")) : getAgent(current.agentId);
  const agentChanged = agent.id !== current.agentId;
  const trigger =
    patch.trigger !== undefined || agentChanged ? normalizeTrigger(patch.trigger ?? current.trigger, agent) : current.trigger;
  const triggerChanged = !sameTrigger(trigger, current.trigger);
  const timezone = patch.timezone !== undefined ? validateTimezone(patch.timezone || defaultTimezone()) : current.timezone;
  const cronInput = patch.cron !== undefined ? patch.cron : current.cron;
  const scheduleChanged =
    normalizeCron(cronInput ?? "") !== current.cron || timezone !== current.timezone || startWindowOf(trigger) !== startWindowOf(current.trigger);
  const { cron, next } = scheduleFor(id, trigger, cronInput, timezone, scheduleChanged);
  const filter =
    trigger.type === "app" || trigger.type === "webhook" ? normalizeFilter(patch.filter !== undefined ? patch.filter : current.filter) : "";
  const enabled = patch.enabled ?? current.enabled;
  const reuse = patch.reuseConversation ?? current.reuseConversation;
  const webhook = trigger.type === "webhook" && !row.webhook_token_hash ? issueWebhookToken(id) : null;

  update("routines", id, {
    agent_id: agent.id,
    name: patch.name !== undefined ? requireText(patch.name, "name") : undefined,
    prompt: patch.prompt !== undefined ? requireText(patch.prompt, "prompt") : undefined,
    trigger: JSON.stringify(trigger),
    cron,
    timezone,
    filter,
    enabled: int(enabled),
    reuse_conversation: int(reuse),
    notify: patch.notify,
    updated_at: now(),
    next_run_at: enabled && agent.enabled && next ? next.toISOString() : null,
    webhook_token_hash: webhook?.hash,
    webhook_token_enc: webhook?.enc,
  });
  // A conversation belongs to one agent; a routine that stops reusing its conversation forgets it too.
  if (agentChanged || !reuse) run("UPDATE routines SET conversation_id = NULL WHERE id = ?", id);
  if (trigger.type !== "webhook" && row.webhook_token_hash) clearWebhookToken(id);

  if (triggerChanged) {
    // What was observed or set up for the old trigger means nothing for the new one (the app trigger sync deletes a
    // Composio instance nothing references anymore).
    patchTriggerState(id, {
      composioTriggerId: null,
      composioSignature: null,
      composioVerifiedAt: null,
      remoteDisabled: null,
      error: null,
      observation: null,
      observedAt: null,
      taskFailures: null,
      lastCheckAt: null,
      ...(agentChanged ? { checkConversationId: null } : {}),
    });
  } else if (agentChanged) {
    patchTriggerState(id, { checkConversationId: null });
  }
  if (!enabled && current.enabled) cancelPendingEvents(id, "The automation was paused");

  const routine = getRoutine(id);
  changed(routine);
  syncRoutinesFile(agent.id);
  if (agentChanged) syncRoutinesFile(current.agentId);
  reloadSchedules();
  if (trigger.type === "app" || current.trigger.type === "app") requestAppTriggerSync();
  return routine;
}

export function deleteRoutine(id: string): void {
  const routine = getRoutine(id);
  run("DELETE FROM routines WHERE id = ?", id);
  bus.emit({ type: "routine.deleted", id });
  syncRoutinesFile(routine.agentId);
  reloadSchedules();
  // Deletes the Composio trigger instance when no other automation uses it.
  if (routine.trigger.type === "app") requestAppTriggerSync();
}

/**
 * Run an automation now: a schedule runs its prompt, a condition is checked, app and webhook automations get a
 * test event. Throws 409 when it is already running.
 */
/** `byHuman`: the human clicked Run now (a scheduled automation then runs although a monthly budget is used up). */
export async function runRoutineNow(id: string, opts: { byHuman?: boolean } = {}): Promise<Run> {
  const routine = getRoutine(id);
  switch (routine.trigger.type) {
    case "condition":
      return runConditionCheck(id, { manual: true });
    case "app":
    case "webhook": {
      const { run: started } = await sendTestEvent(id, undefined, { byHuman: opts.byHuman });
      if (!started) throw conflict(`"${routine.name}" is busy — the test event will run after the current run`);
      return started;
    }
    default:
      return triggerRoutine(id, { byHuman: opts.byHuman });
  }
}
