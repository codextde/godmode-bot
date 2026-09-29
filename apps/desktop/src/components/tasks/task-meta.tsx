import type { ComponentType } from "react";
import { ClipboardList, CodeXml, Telescope } from "lucide-react";
import type { Task, TaskStatus, TaskType, Workspace, WorkspaceSource } from "@godmode/shared";
import { cn } from "@/lib/utils";

export const BOARD_COLUMNS: TaskStatus[] = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];

export const STATUS_META: Record<TaskStatus, { label: string; hint: string; tone: string }> = {
  backlog: { label: "Backlog", hint: "Parked. Assigning an agent here never starts it.", tone: "text-muted-foreground" },
  todo: { label: "Todo", hint: "Queued. A task here with an agent starts that agent.", tone: "text-foreground/70" },
  in_progress: { label: "In progress", hint: "The agent is working on it.", tone: "text-amber-500" },
  in_review: { label: "In review", hint: "Delivered — waiting for your review.", tone: "text-emerald-500" },
  blocked: { label: "Blocked", hint: "Stalled: the run failed, was stopped, or the agent needs something.", tone: "text-rose-500" },
  done: { label: "Done", hint: "Completed. Set automatically when the pull request merges.", tone: "text-sky-500" },
  cancelled: { label: "Cancelled", hint: "Decided not to do it.", tone: "text-muted-foreground" },
};

export const TYPE_META: Record<TaskType, { label: string; hint: string; icon: ComponentType<{ className?: string }> }> = {
  general: { label: "Task", hint: "The agent does it and reports back.", icon: ClipboardList },
  coding: { label: "Coding", hint: "Clones the repository, works on a branch, opens a pull request.", icon: CodeXml },
  research: { label: "Research", hint: "The agent investigates and writes a report.", icon: Telescope },
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
  return task.status === "in_progress" && (task.runStatus === "queued" || task.runStatus === "running" || !!task.activity);
}

/** "owner/repo" of a clone URL (https, ssh or git@host:owner/repo), or its last path segment. */
export function repoLabel(url: string): string {
  const u = url.trim();
  const path = /^[\w.-]+@[\w.-]+:(?!\/\/)(.+)$/.exec(u)?.[1] ?? u.replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, "");
  const parts = path.replace(/\.git\/?$/i, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || u;
}

/** The workspace's git repositories; coding tasks use the first unless they name another. */
export function workspaceRepos(workspace: Workspace | null | undefined): (WorkspaceSource & { url: string })[] {
  return (workspace?.sources ?? []).filter((s): s is WorkspaceSource & { url: string } => s.kind === "git" && !!s.url);
}
