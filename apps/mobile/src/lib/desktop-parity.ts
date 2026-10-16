import { differenceInCalendarDays, format, isToday, isYesterday } from "date-fns";
import type { Agent, AgentQuestion, Conversation, HumanTask, MissingLogin, Routine, Task, TaskBlockedKind, TaskPriority } from "@godmode/shared";
import type { IconName } from "@/components/icon";

/** The desktop's greeting: "Working late" before five, "Good night" from ten. */
export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Good night";
}

export const SUGGESTIONS: { icon: IconName; text: string }[] = [
  { icon: "text", text: "Summarize my unread emails" },
  { icon: "doc", text: "Create an agent that downloads my invoices every month" },
  { icon: "bell", text: "Log into GitHub and check my notifications" },
  { icon: "search", text: "Research competitors and write a report" },
];

/** Who a new chat goes to: the picked agent, else the main assistant (Godmode), else the first. */
export function pickAgent(enabled: Agent[], picked?: string): Agent | undefined {
  return enabled.find((a) => a.id === picked) ?? enabled.find((a) => a.isDefault) ?? enabled[0];
}

export type ChatBucket = "running" | "scheduled" | "done";

/** Running: working, queued or standing still until someone acts. Scheduled: continues by itself later. Done: the rest. */
export function chatBucket(c: Conversation, live: boolean): ChatBucket {
  if (c.paused) return c.paused.auto && c.paused.resumeAt ? "scheduled" : "running";
  if (live || c.running) return "running";
  return c.followup ? "scheduled" : "done";
}

export function continuesAt(c: Conversation): string {
  return c.followup?.dueAt ?? c.paused?.resumeAt ?? "9999";
}

/** "Today", "Yesterday", "Previous 7 days", "Previous 30 days", then the month. */
export function chatDayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const days = differenceInCalendarDays(now, date);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return format(date, date.getFullYear() === now.getFullYear() ? "MMMM" : "MMMM yyyy");
}

/** "Today", "Yesterday", "Thursday, Oct 15". */
export function runDayLabel(date: Date): string {
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "EEEE, MMM d");
}

/** "45s", "12m", "1h 04m". */
export function formatWork(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "$0.84", "<$0.01". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export const PRIORITY_LABEL: Record<TaskPriority, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" };

export const BLOCKED_TITLE: Record<TaskBlockedKind, (agent: string) => string> = {
  needs_input: (agent) => `${agent} needs something from you`,
  failed: () => "The run failed",
  stopped: () => "Stopped",
  interrupted: () => "Interrupted by a restart",
  publish: () => "Couldn't publish the work",
  setup: () => "Couldn't set it up",
  manual: () => "Blocked",
};

function dayOf(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Days from today to a YYYY-MM-DD day (negative = past). */
export function daysUntil(day: string, now = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((dayOf(day).getTime() - today.getTime()) / 86_400_000);
}

/** "Today", "Tomorrow", "Yesterday", "Fri 9 Oct", "9 Oct 2027". */
export function dueLabel(day: string, now = new Date()): string {
  const n = daysUntil(day, now);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  const d = dayOf(day);
  return format(d, d.getFullYear() === now.getFullYear() ? "EEE d MMM" : "d MMM yyyy");
}

/** "owner/repo" of a clone URL (https, ssh or git@host:owner/repo), or its last path segment. */
export function repoLabel(url: string): string {
  const u = url.trim();
  const path = /^[\w.-]+@[\w.-]+:(?!\/\/)(.+)$/.exec(u)?.[1] ?? u.replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, "");
  const parts = path.replace(/\.git\/?$/i, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || u;
}

/** The repository a task works in: its folder's name, else "owner/repo" of its remote ("" = the workspace's). */
export function taskRepoLabel(task: Pick<Task, "repoPath" | "repoUrl">): string {
  if (task.repoPath) return task.repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? task.repoPath;
  return task.repoUrl ? repoLabel(task.repoUrl) : "";
}

/** The run is queued or running (the agent is on it). */
export function isWorking(task: Task): boolean {
  return task.status === "in_progress" && !task.pause && (task.runStatus === "queued" || task.runStatus === "running" || !!task.activity);
}

export const isFailingRoutine = (r: Routine) => r.lastStatus === "failed" || r.triggerStatus.state === "error";

export type NeedKind = "question" | "todo" | "login" | "review" | "blocked";

export interface Need {
  id: string;
  kind: NeedKind;
  agentId: string | null;
  title: string;
  detail: string;
  since: string;
  workspaceId: string | null;
  question?: AgentQuestion;
  humanTask?: HumanTask;
  task?: Task;
}

const RANK: Record<NeedKind, number> = { question: 0, todo: 0, login: 0, review: 1, blocked: 2 };
const shorten = (s: string, max = 140) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * What waits for the human, in the words of the desktop's Needs you (the core's attention list), from what the phone
 * may read: questions, tasks agents handed over, missing logins, tickets in review and blocked ones. Waiting first,
 * then review, then blocked; newest first within.
 */
export function needsYou(input: {
  questions: AgentQuestion[];
  humanTasks: HumanTask[];
  missing: MissingLogin[];
  tasks: Task[];
  nameOf: (agentId: string | null) => string;
}): Need[] {
  const { nameOf } = input;
  const items: Need[] = [];
  for (const q of input.questions) {
    items.push({
      id: `question:${q.id}`,
      kind: "question",
      agentId: q.agentId,
      title: q.kind === "approval" ? `${nameOf(q.agentId)} needs your OK` : `${nameOf(q.agentId)} asks you`,
      detail: shorten(q.title),
      since: q.createdAt,
      workspaceId: q.workspaceId,
      question: q,
    });
  }
  const waitingTickets = new Set<string>();
  for (const h of input.humanTasks) {
    if (h.questionId) continue;
    if (h.taskId && !h.fromAnswer) waitingTickets.add(h.taskId);
    if (h.status === "backlog") continue;
    items.push({
      id: `todo:${h.id}`,
      kind: "todo",
      agentId: h.agentId,
      title: !h.agentId ? shorten(h.title) : h.kind === "decision" ? `${nameOf(h.agentId)} left you a decision: ${shorten(h.title, 100)}` : `${nameOf(h.agentId)} needs you to: ${shorten(h.title, 100)}`,
      detail: h.status === "doing" ? "You're on it" : h.taskNumber != null ? `For task #${h.taskNumber}` : (h.conversationTitle ?? ""),
      since: h.createdAt,
      workspaceId: h.workspaceId,
      humanTask: h,
    });
  }
  for (const m of input.missing) {
    items.push({
      id: `login:${m.id}`,
      kind: "login",
      agentId: m.agentId,
      title: `${nameOf(m.agentId)} ${m.kind === "invalid_credential" ? "couldn't log in to" : m.kind === "missing_totp" ? "needs a 2FA code for" : "needs a login for"} ${m.service}`,
      detail: shorten(m.reason),
      since: m.createdAt,
      workspaceId: m.workspaceId,
    });
  }
  for (const t of input.tasks) {
    if (t.archivedAt || (t.status !== "in_review" && t.status !== "blocked")) continue;
    if (t.status === "blocked" && t.blockedKind === "needs_input" && waitingTickets.has(t.id)) continue;
    const review = t.status === "in_review";
    items.push({
      id: `${review ? "review" : "blocked"}:${t.id}`,
      kind: review ? "review" : "blocked",
      agentId: t.agentId,
      title: review ? `#${t.number} ${t.title} is ready for review` : `#${t.number} ${t.title} is blocked`,
      detail: review ? (t.agentId ? `${nameOf(t.agentId)} delivered it` : "") : shorten(t.blockedReason ?? ""),
      since: t.updatedAt,
      workspaceId: t.workspaceId,
      task: t,
    });
  }
  return items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.since.localeCompare(a.since));
}
