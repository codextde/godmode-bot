import { differenceInCalendarDays, format, isToday, isYesterday } from "date-fns";
import type { Agent, AgentQuestion, Conversation, HumanTask, MissingLogin, Routine, Task, TaskBlockedKind, TaskPriority } from "@godmode/shared";
import type { IconName } from "@/components/icon";
import { dateLocale, t } from "@/lib/i18n";

/** The desktop's greeting: "Working late" before five, "Good night" from ten. */
export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return t("system:greeting.late");
  if (h < 12) return t("system:greeting.morning");
  if (h < 18) return t("system:greeting.afternoon");
  if (h < 22) return t("system:greeting.evening");
  return t("system:greeting.night");
}

export const SUGGESTIONS: { icon: IconName; text: string }[] = [
  {
    icon: "text",
    get text() {
      return t("system:suggestions.emails");
    },
  },
  {
    icon: "doc",
    get text() {
      return t("system:suggestions.invoices");
    },
  },
  {
    icon: "bell",
    get text() {
      return t("system:suggestions.github");
    },
  },
  {
    icon: "search",
    get text() {
      return t("system:suggestions.research");
    },
  },
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
  if (days <= 0) return t("common:words.today");
  if (days === 1) return t("common:words.yesterday");
  if (days < 7) return t("system:days.previous7");
  if (days < 30) return t("system:days.previous30");
  return format(date, date.getFullYear() === now.getFullYear() ? "MMMM" : "MMMM yyyy", { locale: dateLocale() });
}

/** "Today", "Yesterday", "Thursday, Oct 15". */
export function runDayLabel(date: Date): string {
  if (isToday(date)) return t("common:words.today");
  if (isYesterday(date)) return t("common:words.yesterday");
  return format(date, t("system:formats.fullWeekdayDayMonth"), { locale: dateLocale() });
}

/** "45s", "12m", "1h 04m". */
export function formatWork(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  get urgent() {
    return t("system:priority.urgent");
  },
  get high() {
    return t("system:priority.high");
  },
  get medium() {
    return t("system:priority.medium");
  },
  get low() {
    return t("system:priority.low");
  },
  get none() {
    return t("system:priority.none");
  },
};

export const BLOCKED_TITLE: Record<TaskBlockedKind, (agent: string) => string> = {
  needs_input: (agent) => t("system:blocked.needsInput", { agent }),
  failed: () => t("system:blocked.failed"),
  stopped: () => t("system:blocked.stopped"),
  interrupted: () => t("system:blocked.interrupted"),
  publish: () => t("system:blocked.publish"),
  setup: () => t("system:blocked.setup"),
  manual: () => t("system:blocked.manual"),
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
  if (n === 0) return t("common:words.today");
  if (n === 1) return t("system:days.tomorrow");
  if (n === -1) return t("common:words.yesterday");
  const d = dayOf(day);
  return format(d, d.getFullYear() === now.getFullYear() ? t("system:formats.dueThisYear") : t("system:formats.dueOtherYear"), { locale: dateLocale() });
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
      title: q.kind === "approval" ? t("system:needs.needsOk", { agent: nameOf(q.agentId) }) : t("system:needs.asksYou", { agent: nameOf(q.agentId) }),
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
      title: !h.agentId
        ? shorten(h.title)
        : h.kind === "decision"
          ? t("system:needs.leftDecision", { agent: nameOf(h.agentId), title: shorten(h.title, 100) })
          : t("system:needs.needsYouTo", { agent: nameOf(h.agentId), title: shorten(h.title, 100) }),
      detail: h.status === "doing" ? t("system:needs.onIt") : h.taskNumber != null ? t("system:needs.forTask", { number: h.taskNumber }) : (h.conversationTitle ?? ""),
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
      title:
        m.kind === "invalid_credential"
          ? t("system:needs.couldNotLogIn", { agent: nameOf(m.agentId), service: m.service })
          : m.kind === "missing_totp"
            ? t("system:needs.needs2fa", { agent: nameOf(m.agentId), service: m.service })
            : t("system:needs.needsLogin", { agent: nameOf(m.agentId), service: m.service }),
      detail: shorten(m.reason),
      since: m.createdAt,
      workspaceId: m.workspaceId,
    });
  }
  for (const task of input.tasks) {
    if (task.archivedAt || (task.status !== "in_review" && task.status !== "blocked")) continue;
    if (task.status === "blocked" && task.blockedKind === "needs_input" && waitingTickets.has(task.id)) continue;
    const review = task.status === "in_review";
    items.push({
      id: `${review ? "review" : "blocked"}:${task.id}`,
      kind: review ? "review" : "blocked",
      agentId: task.agentId,
      title: review ? t("system:needs.readyForReview", { number: task.number, title: task.title }) : t("system:needs.isBlocked", { number: task.number, title: task.title }),
      detail: review ? (task.agentId ? t("system:needs.delivered", { agent: nameOf(task.agentId) }) : "") : shorten(task.blockedReason ?? ""),
      since: task.updatedAt,
      workspaceId: task.workspaceId,
      task,
    });
  }
  return items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.since.localeCompare(a.since));
}
