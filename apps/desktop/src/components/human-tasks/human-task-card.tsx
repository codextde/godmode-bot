import { forwardRef, type HTMLAttributes } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { ArrowUpRight, CircleCheck, CircleSlash, Flag, MessagesSquare, SquareKanban, Undo2, UserRound } from "lucide-react";
import type { Agent, HumanTask } from "@godmode/shared";
import { humanTaskRef } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { cn } from "@/lib/utils";

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The first lines of the instructions, without Markdown marks. */
export function plainPreview(body: string, max = 160): string {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/[#>*_`~]/g, "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i, all) => (i < all.length - 1 && !/[.!?:;,]$/.test(l) ? `${l}.` : l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function shortAge(iso: string): string {
  return formatDistanceToNowStrict(new Date(iso), { roundingMethod: "floor" }).replace(/ (\w)\w*$/, "$1");
}

const OUTCOME = {
  done: { icon: CircleCheck, label: "Done", tone: "text-emerald-600 dark:text-emerald-400" },
  declined: { icon: CircleSlash, label: "Couldn't do it", tone: "text-rose-600 dark:text-rose-400" },
  withdrawn: { icon: Undo2, label: "Taken back", tone: "text-muted-foreground" },
} as const;

export function outcomeOf(task: HumanTask) {
  return task.status === "done" || task.status === "declined" || task.status === "withdrawn" ? OUTCOME[task.status] : null;
}

/** Where the task came from: the ticket or chat it is for, or the human's own list. */
export function OriginLabel({ task, className }: { task: HumanTask; className?: string }) {
  if (task.taskNumber != null) {
    return (
      <span className={cn("flex min-w-0 items-center gap-1", className)}>
        <SquareKanban className="size-3 shrink-0" />
        <span className="font-mono tabular-nums">#{task.taskNumber}</span>
      </span>
    );
  }
  if (task.conversationTitle) {
    return (
      <span className={cn("flex min-w-0 items-center gap-1", className)} title={task.conversationTitle}>
        <MessagesSquare className="size-3 shrink-0" />
        <span className="truncate">{task.conversationTitle}</span>
      </span>
    );
  }
  return null;
}

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  task: HumanTask;
  agent?: Agent;
  overlay?: boolean;
  ghost?: boolean;
}

export const HumanTaskCard = forwardRef<HTMLDivElement, CardProps>(function HumanTaskCard({ task, agent, overlay, ghost, className, ...rest }, ref) {
  const outcome = outcomeOf(task);
  const preview = outcome ? task.response?.text || task.closedReason || "" : plainPreview(task.body);
  const urgent = task.priority === "high" && !outcome;
  const own = !task.agentId && !task.runId;
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={`${humanTaskRef(task)} ${task.title}`}
      className={cn(
        "group/card relative rounded-lg border bg-card p-3 text-left shadow-card outline-none select-none",
        "transition-[border-color,box-shadow,transform,opacity] duration-150 hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        outcome ? "cursor-pointer" : "cursor-grab touch-none",
        task.status === "doing" && "border-brand/30",
        overlay && "rotate-[1.5deg] cursor-grabbing border-foreground/25 shadow-xl",
        ghost && "opacity-40",
        className,
      )}
      {...rest}
    >
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        {outcome ? <outcome.icon className={cn("size-3.5", outcome.tone)} aria-label={outcome.label} /> : null}
        <span className="font-mono tabular-nums">{humanTaskRef(task)}</span>
        {urgent && (
          <span className="flex items-center gap-0.5 rounded-[4px] bg-rose-500/10 px-1 text-[11px] font-medium text-rose-600 dark:text-rose-400">
            <Flag className="size-2.5 fill-current" /> Urgent
          </span>
        )}
        {task.status === "doing" && <span className="rounded-[4px] bg-brand-soft px-1 text-[11px] font-medium text-brand-strong">On it</span>}
        <span className="ml-auto font-mono text-[11px] tabular-nums">{shortAge(task.closedAt ?? task.createdAt)}</span>
      </div>

      <p className={cn("mt-1.5 line-clamp-3 text-[13.5px] leading-snug font-medium tracking-[-0.01em]", outcome ? "text-foreground/70" : "text-foreground")}>{task.title}</p>
      {preview && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{preview}</p>}

      {task.url && !outcome && (
        <span className="mt-2 inline-flex max-w-full items-center gap-1 rounded-[5px] border bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
          <span className="truncate">{hostOf(task.url)}</span>
          <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
        </span>
      )}

      <div className="mt-3 flex items-center gap-2 text-xs">
        {agent ? (
          <span className="flex min-w-0 items-center gap-1.5 text-foreground/80">
            <AgentAvatar agent={agent} size="sm" still className="size-5 rounded-[5px] text-[11px]" />
            <span className="truncate">{agent.name}</span>
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <span className="grid size-5 place-items-center rounded-[5px] border bg-secondary">
              <UserRound className="size-3" />
            </span>
            <span className="truncate">{own ? "Your own" : (task.agentName ?? "Agent removed")}</span>
          </span>
        )}
        <OriginLabel task={task} className="ml-auto max-w-[45%] text-[11px] text-muted-foreground" />
      </div>
    </div>
  );
});
