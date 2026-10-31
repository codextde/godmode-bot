import type { ComponentType } from "react";
import { ClipboardList, CodeXml, Telescope } from "lucide-react";
import type { Task, TaskBlockedKind, TaskPriority, TaskStatus, TaskType, Workspace, WorkspaceSource } from "@godmode/shared";
import { isWaiting, waitsForSubtasks } from "@godmode/shared";
import { followupWhen } from "@/components/chat/followup";
import { cn } from "@/lib/utils";
import { currentLanguage, intlLocale, t } from "@/i18n";

export const BOARD_COLUMNS: TaskStatus[] = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];

const statusMeta = (status: TaskStatus, tone: string) => ({
  get label() {
    return t(`tasks:status.${status}.label`);
  },
  get hint() {
    return t(`tasks:status.${status}.hint`);
  },
  tone,
});

export const STATUS_META: Record<TaskStatus, { readonly label: string; readonly hint: string; tone: string }> = {
  backlog: statusMeta("backlog", "text-muted-foreground"),
  todo: statusMeta("todo", "text-foreground/70"),
  in_progress: statusMeta("in_progress", "text-amber-500"),
  in_review: statusMeta("in_review", "text-emerald-500"),
  blocked: statusMeta("blocked", "text-rose-500"),
  done: statusMeta("done", "text-sky-500"),
  cancelled: statusMeta("cancelled", "text-muted-foreground"),
};

const typeMeta = (type: TaskType, icon: ComponentType<{ className?: string }>) => ({
  get label() {
    return t(`tasks:type.${type}.label`);
  },
  get hint() {
    return t(`tasks:type.${type}.hint`);
  },
  icon,
});

export const TYPE_META: Record<TaskType, { readonly label: string; readonly hint: string; icon: ComponentType<{ className?: string }> }> = {
  general: typeMeta("general", ClipboardList),
  coding: typeMeta("coding", CodeXml),
  research: typeMeta("research", Telescope),
};

/** Linear-style status glyph: dashed ring, ring, half, three quarters, ban, check, cross. */
export function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const tone = STATUS_META[status].tone;
  const common = { viewBox: "0 0 16 16", fill: "none", className: cn("size-3.5 shrink-0", tone, className), "aria-hidden": true } as const;
  switch (status) {
    case "backlog":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.4 2.1" />
        </svg>
      );
    case "todo":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "in_progress":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
        </svg>
      );
    case "in_review":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5a3.5 3.5 0 1 1-3.5 3.5H8z" fill="currentColor" />
        </svg>
      );
    case "blocked":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="m4 4 8 8" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "done":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="m5 8.2 2 2 4-4.2" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="m6 6 4 4m0-4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
  }
}

export function TypeIcon({ type, className }: { type: TaskType; className?: string }) {
  const Icon = TYPE_META[type].icon;
  return <Icon className={cn("size-3.5 shrink-0", className)} />;
}

/** The run is queued or running (the agent is on it). */
export function isWorking(task: Task): boolean {
  return task.status === "in_progress" && !task.pause && (task.runStatus === "queued" || task.runStatus === "running" || !!task.activity);
}

/** The agent's work stands still: "Paused", or what it waits for. */
export function pauseLabel(task: Task): string | null {
  if (task.status !== "in_progress" || !task.pause) return null;
  if (task.pause.reason === "question") {
    const title = task.pause.question?.title ?? "";
    if (task.pause.question?.kind === "approval") return title ? t("tasks:pause.needsOkTitle", { title }) : t("tasks:pause.needsOk");
    return title ? t("tasks:pause.needsAnswerTitle", { title }) : t("tasks:pause.needsAnswer");
  }
  return task.pause.reason === "limit" ? t("tasks:pause.limit", { limit: task.pause.limit ?? t("tasks:pause.usageLimit") }) : t("tasks:pause.paused");
}

/** "owner/repo" of a clone URL (https, ssh or git@host:owner/repo), or its last path segment. */
export function repoLabel(url: string): string {
  const u = url.trim();
  const path = /^[\w.-]+@[\w.-]+:(?!\/\/)(.+)$/.exec(u)?.[1] ?? u.replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, "");
  const parts = path.replace(/\.git\/?$/i, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || u;
}

/**
 * The workspace's git repositories: clones and folders that are repositories. Tasks work in their own worktree of the
 * first unless they name another.
 */
export function workspaceRepos(workspace: Workspace | null | undefined, projectId: string | null = null): WorkspaceSource[] {
  const project = projectId ? workspace?.projects.find((p) => p.id === projectId) : undefined;
  return [...(project?.sources ?? []), ...(workspace?.sources ?? [])].filter((s) => s.git && (s.kind === "folder" || !!s.url));
}

/** How a repository reads: "owner/repo" of a clone, the name of a folder. */
export function sourceLabel(source: WorkspaceSource): string {
  return source.kind === "git" && source.url ? repoLabel(source.url) : source.name;
}

/** The repository a task works in: its folder's name, else "owner/repo" of its remote. */
export function taskRepoLabel(task: Task, fallback: WorkspaceSource | undefined): string {
  if (task.repoPath) return task.repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? task.repoPath;
  if (task.repoUrl) return repoLabel(task.repoUrl);
  return fallback ? sourceLabel(fallback) : "";
}

const priorityMeta = (priority: TaskPriority, tone: string) => ({
  get label() {
    return t(`tasks:priority.${priority}`);
  },
  tone,
});

export const PRIORITY_META: Record<TaskPriority, { readonly label: string; tone: string }> = {
  urgent: priorityMeta("urgent", "text-rose-600 dark:text-rose-400"),
  high: priorityMeta("high", "text-foreground/80"),
  medium: priorityMeta("medium", "text-foreground/70"),
  low: priorityMeta("low", "text-muted-foreground"),
  none: priorityMeta("none", "text-muted-foreground"),
};

/** Linear-style priority glyph: a filled square with "!" for urgent, three / two / one bars, three dots for none. */
export function PriorityIcon({ priority, className }: { priority: TaskPriority; className?: string }) {
  const common = { viewBox: "0 0 16 16", className: cn("size-3.5 shrink-0", PRIORITY_META[priority].tone, className), "aria-hidden": true } as const;
  if (priority === "urgent") {
    return (
      <svg {...common} fill="currentColor">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" />
        <path d="M8 4.5v4.5" stroke="var(--background, white)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="11.4" r="1" fill="var(--background, white)" />
      </svg>
    );
  }
  if (priority === "none") {
    return (
      <svg {...common} fill="currentColor">
        <circle cx="3.5" cy="8" r="1.2" />
        <circle cx="8" cy="8" r="1.2" />
        <circle cx="12.5" cy="8" r="1.2" />
      </svg>
    );
  }
  const bars = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <svg {...common} fill="currentColor">
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2 + i * 4.5} y={10 - i * 3.5} width="3" height={4 + i * 3.5} rx="1" opacity={i < bars ? 1 : 0.25} />
      ))}
    </svg>
  );
}

/** What each kind of block tells the human, and the way on it offers. */
const blockedMeta = (kind: Exclude<TaskBlockedKind, "manual">) => ({
  title: (agent: string) => t(`tasks:blocked.${kind}.title`, { agent }),
  get cardPrefix() {
    return t(`tasks:blocked.${kind}.cardPrefix`);
  },
});

export const BLOCKED_META: Record<TaskBlockedKind, { title: (agent: string) => string; readonly cardPrefix: string }> = {
  needs_input: blockedMeta("needs_input"),
  failed: blockedMeta("failed"),
  stopped: blockedMeta("stopped"),
  interrupted: blockedMeta("interrupted"),
  publish: blockedMeta("publish"),
  setup: blockedMeta("setup"),
  manual: { title: () => t("tasks:blocked.manual.title"), cardPrefix: "" },
};

/** "Waiting — continues tomorrow at 10:00" for a ticket that waits for the time its agent set. */
export function waitingLabel(task: Task): string | null {
  if (waitsForSubtasks(task)) {
    const { open, blocked } = task.subtasks!;
    return blocked ? t("tasks:waiting.partsBlocked", { count: open, blocked }) : t("tasks:waiting.parts", { count: open });
  }
  return isWaiting(task) && task.followup ? t("tasks:waiting.continues", { when: followupWhen(task.followup.dueAt) }) : null;
}

/** The approve mutation (tasks page); its variables are the ticket being approved. */
export const APPROVE_KEY = ["tasks", "approve"] as const;

/** Moving the ticket away from In progress would end something: a run working, standing still, or a follow-up. */
export function needsConfirm(task: Task): boolean {
  return task.status === "in_progress" && (isWorking(task) || !!task.pause || !!task.followup);
}

const DAY = 86_400_000;

function dayOf(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Days from today to a YYYY-MM-DD day (negative = past). */
export function daysUntil(day: string, now = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((dayOf(day).getTime() - today.getTime()) / DAY);
}

/** "Today", "Tomorrow", "Yesterday", "Fri 9 Oct", "9 Oct 2027". */
export function dueLabel(day: string, now = new Date()): string {
  const n = daysUntil(day, now);
  if (n === 0) return t("common:words.today");
  if (n === 1) return t("tasks:due.tomorrow");
  if (n === -1) return t("common:words.yesterday");
  const d = dayOf(day);
  const locale = currentLanguage() === "de" ? intlLocale() : "en-GB";
  return d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" }).replace(",", "")
    : d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

const LABEL_TONES = [
  "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  "bg-teal-500/10 text-teal-700 dark:text-teal-300",
];

/** A label's colour: always the same for the same word. */
export function labelTone(label: string): string {
  let h = 0;
  for (const c of label.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return LABEL_TONES[h % LABEL_TONES.length]!;
}

/** "45s", "12m", "1h 04m". */
export function formatWork(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return t("tasks:work.seconds", { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t("tasks:work.minutes", { n: m });
  return t("tasks:work.hours", { h: Math.floor(m / 60), m: String(m % 60).padStart(2, "0") });
}
