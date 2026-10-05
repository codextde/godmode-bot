/**
 * Follow-ups: an agent that has to wait — for a reply, a delivery, a build, office hours — sets a time to continue the
 * chat on its own, like a coworker who says "I'll check back tomorrow at 10". Then Godmode marks the spot in the chat
 * and resumes the same Claude session with the agent's note. One per chat: setting another one moves it. Follow-ups
 * that came due while Godmode was off or the computer slept run as soon as it is back; one that comes due while its
 * chat is busy — or whose run is paused — waits for that turn to finish.
 */
import type { Followup, FollowupReason, Run } from "@godmode/shared";
import { all, get, insert, run as exec } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { badRequest, conflict, notFound, now } from "../util";
import { redact } from "../vault/vault";
import { describeNow } from "../runner/prompt";
import { activeRunForConversation, waitForRun } from "../runner/runner";
import { pauseOf } from "./pauses";
import { deliverFollowup } from "../messaging/bridge";
import { emitConversationUpdated, sendMessage } from "./conversations";
import { notify, runNotifiedUser } from "./notifications";
import { getSettings } from "./settings";
import { isLicenseRequired, licenseBlocks, noteLicenseRefusal, requireLicense } from "../license/license";

const log = logger("followups");

export const MIN_DELAY_MS = 60_000;
export const MAX_DELAY_MS = 366 * 24 * 3_600_000;
export const NOTE_MAX = 2000;
/** Follow-up runs in a row, without new input from the human, an automation or another agent, before the agent has to ask. */
export const MAX_UNATTENDED = 20;
/** Chats that can't have follow-ups: a delegated task reports back to the agent that handed it over. */
const NO_FOLLOWUPS = new Set(["dream", "delegation"]);
/** The timer looks again at least this often (clock changes, sleep). */
const TICK_MS = 60_000;
/** Started later than this after its time: the run is told it was overdue. */
const LATE_MS = 2 * 60_000;
/** "In 1 minute" is computed before the check runs. */
const SLACK_MS = 5_000;

interface FollowupRow {
  conversation_id: string;
  agent_id: string;
  note: string;
  due_at: string;
  run_id: string | null;
  created_at: string;
  updated_at: string;
  title: string;
}

const SELECT = "SELECT f.*, c.title AS title FROM followups f JOIN conversations c ON c.id = f.conversation_id";

function toFollowup(r: FollowupRow): Followup {
  return {
    conversationId: r.conversation_id,
    agentId: r.agent_id,
    title: r.title,
    note: r.note,
    dueAt: r.due_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function row(conversationId: string): FollowupRow | null {
  return get<FollowupRow>(`${SELECT} WHERE f.conversation_id = ?`, conversationId);
}

export function getFollowup(conversationId: string): Followup | null {
  const r = row(conversationId);
  return r ? toFollowup(r) : null;
}

export function listFollowups(opts: { agentId?: string } = {}): Followup[] {
  const rows = opts.agentId
    ? all<FollowupRow>(`${SELECT} WHERE f.agent_id = ? ORDER BY f.due_at`, opts.agentId)
    : all<FollowupRow>(`${SELECT} ORDER BY f.due_at`);
  return rows.map(toFollowup);
}

/** The chat can have a follow-up (not a dream, not a task delegated by another agent). */
export function followupsAllowed(conversationId: string): boolean {
  const origin = get<{ origin: string }>("SELECT origin FROM conversations WHERE id = ?", conversationId)?.origin;
  return !!origin && !NO_FOLLOWUPS.has(origin);
}

/** "in 5 minutes", "in 3 hours", "in 2 days" — for tool results. */
export function inWords(dueAt: string, from = Date.now()): string {
  const minutes = Math.max(1, Math.round((Date.parse(dueAt) - from) / 60_000));
  if (minutes < 90) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hours`;
  return `in ${Math.round(hours / 24)} days`;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

/** When to continue: `at` (ISO 8601 date and time; without an offset it is this computer's time zone) or `inMinutes`. */
export function parseDueAt(input: { at?: string; inMinutes?: number }, from = new Date()): Date {
  const at = input.at?.trim();
  if (at && input.inMinutes !== undefined) throw badRequest("Pass either `at` or `inMinutes`, not both.");
  if (input.inMinutes !== undefined) return new Date(from.getTime() + input.inMinutes * 60_000);
  if (!at) throw badRequest("Say when to continue: pass `at` (a date and time) or `inMinutes`.");
  const invalid = () => badRequest(`"${at}" is not a date and time — use ISO 8601, e.g. "2026-10-01T09:00".`);
  const m = DATE_TIME.exec(at);
  if (!m) throw invalid();
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  // Date() rolls impossible dates over ("2026-02-30" → March 2) instead of refusing them.
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59) throw invalid();
  const d = new Date(at.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) throw invalid();
  return d;
}

function checkDue(due: Date) {
  const delta = due.getTime() - Date.now();
  if (delta < 0) throw badRequest(`That time has passed — it is ${describeNow()} now.`);
  if (delta < MIN_DELAY_MS - SLACK_MS) throw badRequest("Pick a time at least a minute from now.");
  if (delta > MAX_DELAY_MS) throw badRequest("A follow-up can be at most a year ahead.");
}

/**
 * Follow-up runs of the chat since anything else (the human, an automation) last started one, or the human last
 * answered a question in it.
 */
export function unattendedRuns(conversationId: string): number {
  return (
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM runs WHERE conversation_id = ? AND trigger = 'followup'
         AND created_at > MAX(
           COALESCE((SELECT MAX(created_at) FROM runs WHERE conversation_id = ? AND trigger NOT IN ('followup', 'check', 'dream')), ''),
           COALESCE((SELECT MAX(answered_at) FROM questions WHERE conversation_id = ?), ''))`,
      conversationId,
      conversationId,
      conversationId,
    )?.n ?? 0
  );
}

function humanName(): string {
  return getSettings().general.userName.trim() || "the user";
}

function changed(conversationId: string) {
  emitConversationUpdated(conversationId);
  bus.changed("followups");
  arm();
}

/** Set (or move) the chat's follow-up. */
export function scheduleFollowup(input: { conversationId: string; agentId: string; dueAt: Date; note: string; runId?: string | null }): Followup {
  const conv = get<{ agent_id: string; origin: string }>("SELECT agent_id, origin FROM conversations WHERE id = ?", input.conversationId);
  if (!conv) throw notFound("Conversation");
  if (conv.agent_id !== input.agentId) throw badRequest("The conversation belongs to another agent");
  if (conv.origin === "delegation") {
    throw badRequest("This is a task another agent handed you: say in your answer when it should check back — it can schedule its own follow-up.");
  }
  if (NO_FOLLOWUPS.has(conv.origin)) throw badRequest("This chat can't have follow-ups");
  // The note comes back as part of Godmode's own follow-up prompt: no tags that could pass for it.
  const note = redact(input.note.trim())
    .replace(/<\/?godmode[\w-]*[^>]*>/gi, "")
    .trim()
    .slice(0, NOTE_MAX);
  if (!note) throw badRequest("Say what you'll do when you continue (note).");
  checkDue(input.dueAt);
  if (unattendedRuns(input.conversationId) >= MAX_UNATTENDED) {
    const human = humanName();
    throw conflict(`This chat continued ${MAX_UNATTENDED} times in a row without ${human}. Ask ${human} whether to keep going instead of scheduling another follow-up.`);
  }
  const ts = now();
  exec(
    `INSERT INTO followups (conversation_id, agent_id, note, due_at, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET note = excluded.note, due_at = excluded.due_at, run_id = excluded.run_id,
       created_at = excluded.created_at, updated_at = excluded.updated_at`,
    input.conversationId,
    input.agentId,
    note,
    input.dueAt.toISOString(),
    input.runId ?? null,
    ts,
    ts,
  );
  changed(input.conversationId);
  return getFollowup(input.conversationId)!;
}

/** The human moves a follow-up to another time. */
export function rescheduleFollowup(conversationId: string, dueAt: Date): Followup {
  if (!row(conversationId)) throw notFound("Follow-up");
  if (Number.isNaN(dueAt.getTime())) throw badRequest("Invalid time");
  checkDue(dueAt);
  exec("UPDATE followups SET due_at = ?, updated_at = ? WHERE conversation_id = ?", dueAt.toISOString(), now(), conversationId);
  changed(conversationId);
  return getFollowup(conversationId)!;
}

export function cancelFollowup(conversationId: string): boolean {
  const removed = exec("DELETE FROM followups WHERE conversation_id = ?", conversationId).changes > 0;
  if (removed) changed(conversationId);
  return removed;
}

/** The human's "Continue now". */
export async function runFollowupNow(conversationId: string): Promise<Run> {
  const r = row(conversationId);
  if (!r) throw notFound("Follow-up");
  const run = await start(r, "now");
  if (!run) throw conflict("The follow-up just changed — try again.");
  return run;
}

function followupPrompt(r: FollowupRow, reason: FollowupReason): string {
  const human = humanName();
  const due = describeNow(new Date(r.due_at));
  const when =
    reason === "now"
      ? `${human} asked you to continue now instead of at ${due}.`
      : reason === "late"
        ? `It was due ${due}; Godmode wasn't running then, so you continue now.`
        : "It is due now.";
  return `<godmode-followup>
You scheduled this follow-up on ${describeNow(new Date(r.created_at))}. ${when} This turn was started by your follow-up, not by a new message.
Your note to yourself: ${r.note}

Pick the task up where you left off. If you still have to wait, schedule another follow-up with \`followup_schedule\`; otherwise finish the work and end with your summary for ${human}.
</godmode-followup>`;
}

/** Null when the follow-up was moved or removed meanwhile. */
async function start(r: FollowupRow, reason: FollowupReason): Promise<Run | null> {
  // Removed before the run starts, so the run can schedule the next one.
  if (exec("DELETE FROM followups WHERE conversation_id = ? AND due_at = ?", r.conversation_id, r.due_at).changes === 0) return null;
  try {
    const { run } = await sendMessage(r.conversation_id, {
      content: r.note,
      prompt: followupPrompt(r, reason),
      marker: [{ type: "followup", note: r.note, dueAt: r.due_at, setAt: r.created_at, reason }],
      trigger: "followup",
      // "Continue now" is the human's click: a used-up budget doesn't hold it.
      byHuman: reason === "now",
    });
    void report(r, run.id);
    return run;
  } catch (err) {
    // "Continue now" failed: the human still has the follow-up. A due one that can't start is reported instead.
    if (reason === "now") {
      const { title: _title, ...restored } = r;
      insert("followups", restored);
    }
    throw err;
  } finally {
    changed(r.conversation_id);
  }
}

/** The human wasn't watching: tell them the agent got back to the chat (in a platform chat, the answer goes there). */
async function report(r: FollowupRow, runId: string): Promise<void> {
  try {
    if (await deliverFollowup(r.conversation_id, runId)) return;
    const run = await waitForRun(runId);
    if (run.status === "cancelled") return;
    // A board ticket reports its own outcome ("ready for review", "blocked", or waiting again).
    if (get<{ id: string }>("SELECT id FROM tasks WHERE conversation_id = ?", r.conversation_id)) return;
    if (runNotifiedUser(runId)) return;
    const agentName = get<{ name: string }>("SELECT name FROM agents WHERE id = ?", r.agent_id)?.name ?? "An agent";
    const text = (run.status === "succeeded" ? run.result : run.error)?.replace(/\s+/g, " ").trim() ?? "";
    notify(
      run.status === "succeeded" ? "run" : "error",
      run.status === "succeeded" ? `${agentName} got back to “${r.title}”` : `${agentName} couldn't finish “${r.title}”`,
      text.length > 280 ? `${text.slice(0, 279)}…` : text,
      `/chat/${r.conversation_id}`,
    );
  } catch (err) {
    log.warn(`could not report the follow-up of ${r.conversation_id}`, err);
  }
}

/* ------------------------------------------------------------------ */
/* Timer                                                               */
/* ------------------------------------------------------------------ */

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let sweeping: Promise<void> | null = null;
let offBus: (() => void) | null = null;

/** A run works in the chat, or stands still there (paused): the follow-up comes after it. */
function busy(conversationId: string): boolean {
  return activeRunForConversation(conversationId) !== null || pauseOf(conversationId) !== null;
}

/** Wake up for the next follow-up whose chat is free; busy chats are picked up when their run finishes. */
function arm() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!started) return;
  const next = all<{ conversation_id: string; due_at: string }>("SELECT conversation_id, due_at FROM followups ORDER BY due_at").find(
    (f) => !busy(f.conversation_id),
  );
  if (!next) return;
  // Due ones wait in place while the licence refuses runs: look again a tick later, not right away.
  const wait = licenseBlocks() ? TICK_MS : Math.min(Math.max(0, Date.parse(next.due_at) - Date.now()), TICK_MS);
  timer = setTimeout(() => {
    timer = null;
    void sweep();
  }, wait);
}

/** Start every follow-up that is due and whose chat isn't busy. */
export function sweep(): Promise<void> {
  // `.finally` runs after the assignment even when nothing is due (the sweep then finishes synchronously).
  sweeping ??= startDue().finally(() => {
    sweeping = null;
    arm();
  });
  return sweeping;
}

async function startDue() {
  if (licenseBlocks()) {
    const due = get<{ n: number }>("SELECT COUNT(*) AS n FROM followups WHERE due_at <= ?", now())?.n ?? 0;
    if (!due) return;
    try {
      requireLicense();
    } catch (err) {
      if (isLicenseRequired(err)) noteLicenseRefusal(due === 1 ? "A follow-up" : `${due} follow-ups`, err);
    }
    return;
  }
  for (const r of all<FollowupRow>(`${SELECT} WHERE f.due_at <= ? ORDER BY f.due_at`, now())) {
    if (busy(r.conversation_id)) continue;
    const reason: FollowupReason = Date.now() - Date.parse(r.due_at) > LATE_MS ? "late" : "due";
    try {
      const run = await start(r, reason);
      if (run) log.info(`follow-up of ${r.conversation_id} started run ${run.id}`);
    } catch (err) {
      log.warn(`follow-up of ${r.conversation_id} could not start`, err);
      const agentName = get<{ name: string }>("SELECT name FROM agents WHERE id = ?", r.agent_id)?.name ?? "An agent";
      notify("warning", `${agentName} couldn't continue “${r.title}”`, err instanceof Error ? err.message : String(err), `/chat/${r.conversation_id}`);
    }
  }
}

export function startFollowups(): void {
  if (started) return;
  started = true;
  offBus = bus.on((e) => {
    if (e.type === "run.finished" && get<{ n: number }>("SELECT 1 AS n FROM followups WHERE conversation_id = ?", e.run.conversationId)) arm();
  });
  const waiting = get<{ n: number }>("SELECT COUNT(*) AS n FROM followups")?.n ?? 0;
  if (waiting) log.info(`${waiting} follow-up(s) waiting`);
  arm();
}

export function stopFollowups(): void {
  started = false;
  offBus?.();
  offBus = null;
  if (timer) clearTimeout(timer);
  timer = null;
}
