import { forwardRef, type HTMLAttributes } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { AlarmClock, CalendarDays, CornerDownRight, GitMerge, GitPullRequest, GitPullRequestArrow, GitPullRequestClosed, Hourglass, ListTree, MessageCircleQuestion, OctagonAlert, Paperclip, Pause } from "lucide-react";
import type { Agent, Task, Workspace } from "@godmode/shared";
import { isOverdue, taskAttachmentIds } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { LiveDot } from "@/components/aicss/Motion";
import { useLive } from "@/stores/live";
import { cn } from "@/lib/utils";
import { useNow } from "@/components/vault/use-now";
import { LabelChip } from "./task-fields";
import { BLOCKED_META, PRIORITY_META, PriorityIcon, STATUS_META, TYPE_META, TypeIcon, daysUntil, dueLabel, isWorking, pauseLabel, waitingLabel } from "./task-meta";

export function useTaskActivity(task: Task): string | null {
  const live = useLive((s) => (task.runId ? s.runs[task.runId] : undefined));
  if (task.activity) return task.activity;
  if (!isWorking(task)) return null;
  if (live?.status === "queued" || task.runStatus === "queued") return "Queued — waiting for a free slot";
  return live?.activity && live.activity !== "Starting…" ? live.activity : "Working…";
}

export function PullRequestChip({ task, className }: { task: Task; className?: string }) {
  const pr = task.pullRequest;
  if (!pr) return null;
  const meta = !pr.number
    ? { icon: GitPullRequestArrow, label: "Open pull request", tone: "text-foreground/80" }
    : pr.state === "merged"
      ? { icon: GitMerge, label: `#${pr.number} merged`, tone: "text-violet-600 dark:text-violet-400" }
      : pr.state === "closed"
        ? { icon: GitPullRequestClosed, label: `#${pr.number} closed`, tone: "text-muted-foreground" }
        : { icon: GitPullRequest, label: `#${pr.number} open`, tone: "text-emerald-600 dark:text-emerald-400" };
  const Icon = meta.icon;
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-[5px] border bg-background px-1.5 font-mono text-[11px] font-medium transition hover:border-foreground/25",
        meta.tone,
        className,
      )}
    >
      <Icon className="size-3" />
      {meta.label}
    </a>
  );
}

interface TaskCardProps extends HTMLAttributes<HTMLDivElement> {
  task: Task;
  agent?: Agent;
  workspace?: Workspace | null;
  /** Rendered under the pointer while dragging. */
  overlay?: boolean;
  /** The placeholder left in the column while its card is dragged. */
  ghost?: boolean;
}

export const TaskCard = forwardRef<HTMLDivElement, TaskCardProps>(function TaskCard(
  { task, agent, workspace, overlay, ghost, className, ...rest },
  ref,
) {
  const activity = useTaskActivity(task);
  const working = isWorking(task);
  const paused = pauseLabel(task);
  const waiting = waitingLabel(task);
  const files = taskAttachmentIds(task.description).length;
  const overdue = isOverdue(task);
  const closed = task.status === "done" || task.status === "cancelled";
  const due = task.dueDate ? (overdue ? `Overdue · ${-daysUntil(task.dueDate)}d` : dueLabel(task.dueDate)) : null;
  const label = [
    `#${task.number} ${task.title}`,
    STATUS_META[task.status].label,
    task.priority !== "none" ? PRIORITY_META[task.priority].label.toLowerCase() : null,
    task.dueDate ? `due ${dueLabel(task.dueDate)}` : null,
    overdue ? "overdue" : null,
    task.parentNumber ? `part of #${task.parentNumber}` : null,
    task.subtasks ? `${task.subtasks.total - task.subtasks.open} of ${task.subtasks.total} parts finished` : null,
    waiting,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={label}
      className={cn(
        "group/card relative cursor-grab touch-none rounded-lg border bg-card p-3 text-left shadow-card outline-none select-none",
        "transition-[border-color,box-shadow,transform,opacity] duration-150 hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        working && "border-amber-500/35 dark:border-amber-400/30",
        overlay && "rotate-[1.5deg] cursor-grabbing border-foreground/25 shadow-xl",
        ghost && "opacity-40",
        className,
      )}
      {...rest}
    >
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span title={TYPE_META[task.type].label} className="grid size-4 place-items-center">
          <TypeIcon type={task.type} className="size-3.5" />
        </span>
        <span className="font-mono tabular-nums">#{task.number}</span>
        {task.parentNumber && (
          <span className="flex items-center gap-0.5 font-mono tabular-nums" title={`Part of #${task.parentNumber}`} aria-label={`part of #${task.parentNumber}`}>
            <CornerDownRight className="size-3" aria-hidden />#{task.parentNumber}
          </span>
        )}
        {task.priority !== "none" && (
          <span title={PRIORITY_META[task.priority].label} aria-label={PRIORITY_META[task.priority].label}>
            <PriorityIcon priority={task.priority} />
          </span>
        )}
        {workspace !== undefined && (
          <span className="ml-auto flex min-w-0 items-center gap-1 truncate">
            <span className="text-[11px]">{workspace?.icon ?? "🌐"}</span>
            <span className="truncate">{workspace?.name ?? "Global"}</span>
          </span>
        )}
      </div>

      <p className="mt-1.5 line-clamp-3 text-[13.5px] leading-snug font-medium tracking-[-0.01em] text-foreground">{task.title}</p>

      {activity && (
        <p className="mt-2 flex min-w-0 items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
          <LiveDot className="bg-amber-500" />
          <span className="truncate">{activity}</span>
          {task.runStatus === "running" && task.runStartedAt && <CardElapsed since={task.runStartedAt} />}
        </p>
      )}
      {waiting && !activity && !paused && (
        <p className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={task.followup?.note}>
          {task.subtasks?.open && !task.followup ? <ListTree className="size-3 shrink-0 text-brand-strong" /> : <AlarmClock className="size-3 shrink-0 text-brand-strong" />}
          <span className="truncate">{waiting}</span>
        </p>
      )}
      {paused && !activity && (
        <p className={cn("mt-2 flex min-w-0 items-center gap-1.5 text-xs", task.pause?.reason === "question" ? "font-medium text-foreground" : "text-muted-foreground")}>
          {task.pause?.reason === "question" ? (
            <MessageCircleQuestion className="size-3 shrink-0 text-warning" />
          ) : task.pause?.reason === "limit" ? (
            <Hourglass className="size-3 shrink-0 text-warning" />
          ) : (
            <Pause className="size-3 shrink-0 fill-current" />
          )}
          <span className="truncate">{paused}</span>
        </p>
      )}
      {task.status === "blocked" && (task.blockedReason || task.blockedKind) && (
        <p className="mt-2 flex gap-1.5 text-xs text-rose-600 dark:text-rose-400">
          <OctagonAlert className="mt-px size-3.5 shrink-0" />
          <span className="line-clamp-2">
            {task.blockedKind && BLOCKED_META[task.blockedKind].cardPrefix && <span className="font-medium">{BLOCKED_META[task.blockedKind].cardPrefix} </span>}
            {task.blockedReason ?? (task.blockedKind === "interrupted" ? "Godmode restarted mid-run." : "")}
          </span>
        </p>
      )}
      {task.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {task.labels.slice(0, 2).map((l) => (
            <LabelChip key={l} label={l} />
          ))}
          {task.labels.length > 2 && <span className="text-[11px] text-muted-foreground">+{task.labels.length - 2}</span>}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        {agent ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground/80">
            <AgentAvatar agent={agent} size="sm" className="size-5 rounded-[5px] text-[11px]" />
            <span className="truncate">{agent.name}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-5 rounded-[5px] border border-dashed border-muted-foreground/40" />
            Unassigned
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {due && (
            <span
              className={cn(
                "flex items-center gap-0.5 rounded-[4px] px-1 text-[11px] tabular-nums",
                closed ? "text-muted-foreground" : overdue ? "bg-rose-500/10 font-medium text-rose-600 dark:text-rose-400" : daysUntil(task.dueDate!) === 0 ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
              )}
              title={`Due ${task.dueDate}`}
            >
              <CalendarDays className="size-3" />
              {closed ? dueLabel(task.dueDate!) : due}
            </span>
          )}
          {task.subtasks && (
            <span
              className="flex items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums"
              title={`${task.subtasks.total - task.subtasks.open} of ${task.subtasks.total} parts finished`}
            >
              <ListTree className="size-3" />
              {task.subtasks.total - task.subtasks.open}/{task.subtasks.total}
            </span>
          )}
          {files > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums" title={`${files} attached file${files === 1 ? "" : "s"}`}>
              <Paperclip className="size-3" />
              {files}
            </span>
          )}
          <PullRequestChip task={task} />
          {!task.pullRequest && !working && (
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              {formatDistanceToNowStrict(new Date(task.updatedAt), { roundingMethod: "floor" }).replace(/ (\w)\w*$/, "$1")}
            </span>
          )}
        </span>
      </div>
    </div>
  );
});

/** "4m 12s" on a working card, ticking every second. */
function CardElapsed({ since }: { since: string }) {
  const now = useNow(1000);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return (
    <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums opacity-80">
      {s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`}
    </span>
  );
}
