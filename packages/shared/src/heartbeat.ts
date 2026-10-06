/**
 * Heartbeats: an agent with real work wakes up on its own rhythm, between the human's prompts. Every beat looks at the
 * agent's tickets — what changed since the last beat, what stalled, what failed — wakes it on the ones it can move
 * forward (with the delta, so it doesn't re-read history), runs its standing checklist, and leaves a trail.
 *
 * The watchdog supervises every run while it works: a run that shows no sign of life, or calls the same tool with the
 * same input over and over, is stopped with a precise report. Board tickets then try again on their own; anything
 * else is escalated to the human.
 */
import type { ID, ISODate } from "./models";

export interface AgentHeartbeat {
  enabled: boolean;
  /** Minutes between two beats (one of HEARTBEAT_INTERVALS). */
  intervalMinutes: number;
  /** Local hours it may wake in, `from` inclusive to `to` exclusive (wraps past midnight when from > to). null = any time. */
  hours: { from: number; to: number } | null;
  /** Monday to Friday only. */
  weekdays: boolean;
  /** Standing duties for every beat ("Check Stripe for unpaid orders"). "" = only the board. */
  checklist: string;
  /** When it was switched on: the first beat comes one interval later. */
  since: ISODate | null;
}

export type AgentHeartbeatInput = Partial<Omit<AgentHeartbeat, "since">>;

export const HEARTBEAT_INTERVALS: readonly number[] = [15, 30, 60, 120, 240, 480, 1440];
export const MAX_HEARTBEAT_CHECKLIST_LENGTH = 4000;
/** Tickets one beat wakes the agent on, most urgent first. The rest waits for the next beat. */
export const MAX_HEARTBEAT_WAKES = 3;

export const DEFAULT_HEARTBEAT: AgentHeartbeat = {
  enabled: false,
  intervalMinutes: 60,
  hours: null,
  weekdays: false,
  checklist: "",
  since: null,
};

/** A clean heartbeat from stored or sent values: unknown intervals snap to the nearest one, hours to 0–24. */
export function normalizeHeartbeat(value: Partial<AgentHeartbeat> | null | void): AgentHeartbeat {
  const v = { ...DEFAULT_HEARTBEAT, ...(value ?? {}) };
  const minutes = Number(v.intervalMinutes) || DEFAULT_HEARTBEAT.intervalMinutes;
  const interval = HEARTBEAT_INTERVALS.reduce((best, n) => (Math.abs(n - minutes) < Math.abs(best - minutes) ? n : best), HEARTBEAT_INTERVALS[0]!);
  const hour = (n: unknown, max: number) => Math.min(max, Math.max(0, Math.round(Number(n) || 0)));
  const hours = v.hours && typeof v.hours === "object" ? { from: hour(v.hours.from, 23), to: hour(v.hours.to, 24) } : null;
  return {
    enabled: !!v.enabled,
    intervalMinutes: interval,
    hours: hours && hours.from !== hours.to % 24 ? hours : null,
    weekdays: !!v.weekdays,
    checklist: String(v.checklist ?? "").slice(0, MAX_HEARTBEAT_CHECKLIST_LENGTH),
    since: typeof v.since === "string" ? v.since : null,
  };
}

/** The beat may happen at this moment (local time): inside its hours, and on a weekday when it only works those. */
export function heartbeatAllowedAt(hb: Pick<AgentHeartbeat, "hours" | "weekdays">, at: Date): boolean {
  const day = at.getDay();
  if (hb.weekdays && (day === 0 || day === 6)) return false;
  if (!hb.hours) return true;
  const h = at.getHours();
  const { from, to } = hb.hours;
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/** The first moment at or after `from` the beat may happen; null when no hour within 8 days is allowed. */
export function nextAllowedAt(hb: Pick<AgentHeartbeat, "hours" | "weekdays">, from: Date): Date | null {
  if (heartbeatAllowedAt(hb, from)) return from;
  const t = new Date(from);
  t.setMinutes(0, 0, 0);
  for (let i = 0; i < 8 * 24; i++) {
    t.setHours(t.getHours() + 1);
    if (heartbeatAllowedAt(hb, t)) return t;
  }
  return null;
}

/** When the next beat is due: one interval after the last beat (or after it was switched on), inside its hours. */
export function nextHeartbeatAt(hb: AgentHeartbeat, lastBeatAt: ISODate | null): Date | null {
  if (!hb.enabled) return null;
  const base = Math.max(lastBeatAt ? Date.parse(lastBeatAt) : 0, hb.since ? Date.parse(hb.since) : 0) || Date.now();
  return nextAllowedAt(hb, new Date(base + hb.intervalMinutes * 60_000));
}

/** "every 15 minutes", "every hour", "every 4 hours", "once a day". */
export function heartbeatIntervalText(minutes: number): string {
  if (minutes >= 1440) return "once a day";
  if (minutes === 60) return "every hour";
  if (minutes > 60) return `every ${Math.round(minutes / 60)} hours`;
  return `every ${minutes} minutes`;
}

/** "15 min", "1 h", "4 h", "Daily" — the interval picker's labels. */
export function heartbeatIntervalLabel(minutes: number): string {
  if (minutes >= 1440) return "Daily";
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/**
 * - `quiet`: nothing to move forward and no checklist — no run, no cost.
 * - `woke`: it woke the agent on tickets and/or ran its checklist.
 * - `skipped`: the last beat's run was still working, the agent was off, a budget or the licence held it.
 * - `failed`: the beat couldn't start what it wanted to.
 */
export type HeartbeatOutcome = "quiet" | "woke" | "skipped" | "failed";

/** Why a beat woke the agent on a ticket. */
export type HeartbeatWakeReason = "stalled" | "unstarted" | "retry";

export interface HeartbeatWake {
  taskId: ID;
  number: number;
  title: string;
  why: HeartbeatWakeReason;
  /** Changes on the ticket since the agent last worked on it, as the agent was told. */
  changes: number;
}

export interface HeartbeatBeat {
  id: ID;
  agentId: ID;
  /** `now`: the human's "Wake now". */
  reason: "scheduled" | "now";
  outcome: HeartbeatOutcome;
  /** One line on what the beat did ("Woke on #12 and #14 · ran the checklist"). */
  summary: string;
  wakes: HeartbeatWake[];
  /** Tickets waiting for the human (review, an answer, a fix only they can make) at the time of the beat. */
  waitingOnYou: { taskId: ID; number: number; title: string }[];
  /** Changes on the agent's tickets since the last beat. */
  changes: number;
  /** The checklist's run, its status and its answer (once it finished). */
  runId: ID | null;
  conversationId: ID | null;
  runStatus: string | null;
  result: string | null;
  costUsd: number | null;
  createdAt: ISODate;
}

export type WatchdogKind = "stalled" | "looping";

/** The watchdog stopped a run. */
export interface WatchdogEvent {
  id: ID;
  runId: ID;
  agentId: ID;
  conversationId: ID;
  /** The board ticket the run worked on, if any (it tries again on its own). */
  taskId: ID | null;
  taskNumber: number | null;
  kind: WatchdogKind;
  /** Exactly where it stopped and why, in one or two sentences. */
  report: string;
  /** `retry`: the ticket (or the heartbeat) tries again by itself. `escalated`: the human was told. */
  action: "retry" | "escalated";
  createdAt: ISODate;
}

export interface AgentHeartbeatState {
  heartbeat: AgentHeartbeat;
  /** When the next beat is due; null when it is off (or no hour is allowed). */
  nextAt: ISODate | null;
  beats: HeartbeatBeat[];
  watchdog: WatchdogEvent[];
  /** The agent's open tickets right now, by where they stand. */
  board: { working: number; waiting: number; waitingOnYou: number; blocked: number };
}

/** The watchdog's own sentence at the start of a run's error (runEndOf recognises it). */
export const RUN_WATCHDOG = "Watchdog stopped the run";
export const DEFAULT_STALL_MINUTES = 20;
export const DEFAULT_LOOP_REPEATS = 6;
