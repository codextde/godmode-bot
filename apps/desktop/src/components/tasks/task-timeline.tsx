import { useState, type ComponentType } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import {
  ArchiveRestore,
  ArrowRightLeft,
  CircleCheck,
  CircleDot,
  Clock,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessageCircleQuestion,
  MessageSquareReply,
  NotebookPen,
  OctagonAlert,
  PackageCheck,
  Play,
  RefreshCw,
  UserRound,
} from "lucide-react";
import type { Agent, Task, TaskEvent } from "@godmode/shared";
import { fileNameSummary, taskEventText } from "@godmode/shared";
import { Markdown } from "@/components/chat/markdown";
import { ChatFilesScope } from "@/components/chat/local-files";
import { followupWhen } from "@/components/chat/followup";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTaskEvents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { formatCost, formatWork } from "./task-meta";

const ICONS: Record<TaskEvent["kind"], ComponentType<{ className?: string }>> = {
  status: ArrowRightLeft,
  assigned: UserRound,
  archived: ArchiveRestore,
  started: Play,
  waiting: Clock,
  delivered: PackageCheck,
  blocked: OctagonAlert,
  feedback: MessageSquareReply,
  note: NotebookPen,
  pr_opened: GitPullRequest,
  pr_merged: GitMerge,
  pr_closed: GitPullRequestClosed,
  asked: MessageCircleQuestion,
  answered: CircleCheck,
};

const SHOWN = 50;

/**
 * What happened on a ticket, oldest first: who filed it, moves, starts, every delivery with its result, blocks with
 * their reason, the human's feedback, notes agents left, pull requests, questions and answers.
 */
export function TaskTimeline({ task, agents, userName }: { task: Task; agents: Agent[]; userName?: string }) {
  const events = useTaskEvents(task.id);
  const [all, setAll] = useState(false);
  const filer = task.createdBy === "user" ? "You" : (agents.find((a) => `agent:${a.id}` === task.createdBy)?.name ?? "An agent that no longer exists");
  const list = events.data ?? [];
  const hidden = all ? 0 : Math.max(0, list.length - SHOWN);
  const shown = list.slice(hidden);
  void userName;

  return (
    <section aria-labelledby={`activity-${task.id}`} className="space-y-2">
      <h3 id={`activity-${task.id}`} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Activity
      </h3>
      {events.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-5 w-3/4 rounded-md" />
          ))}
        </div>
      ) : events.isError ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          Couldn't load the activity.
          <Button size="xs" variant="ghost" onClick={() => events.refetch()}>
            <RefreshCw /> Try again
          </Button>
        </div>
      ) : (
        <ol className="relative space-y-3 border-l pl-4" aria-live="polite" aria-relevant="additions">
          <Row icon={CircleDot} at={task.createdAt}>
            {filer === "You" ? "You filed this" : `${filer} filed this`}
          </Row>
          {hidden > 0 && (
            <li>
              <Button size="xs" variant="ghost" className="-ml-2 text-muted-foreground" onClick={() => setAll(true)}>
                Show earlier activity ({hidden})
              </Button>
            </li>
          )}
          {shown.map((e) => (
            <EventRow key={e.id} event={e} task={task} />
          ))}
        </ol>
      )}
    </section>
  );
}

function Row({
  icon: Icon,
  at,
  children,
  below,
  pending,
}: {
  icon: ComponentType<{ className?: string }>;
  at: string;
  children: React.ReactNode;
  /** What goes under the line: a message, a note, a reason, an earlier result. */
  below?: React.ReactNode;
  pending?: boolean;
}) {
  return (
    <li className={cn("relative", pending && "opacity-60")}>
      <span className="absolute top-0.5 -left-[1.4rem] grid size-4 place-items-center rounded-full bg-background">
        <Icon className="size-3.5 text-muted-foreground" />
      </span>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px]">
        <span className="min-w-0">{children}</span>
        <time dateTime={at} title={format(new Date(at), "PPpp")} className="text-xs text-muted-foreground tabular-nums">
          {pending ? "Sending…" : formatDistanceToNowStrict(new Date(at), { addSuffix: true })}
        </time>
      </div>
      {below}
    </li>
  );
}

function EventRow({ event: e, task }: { event: TaskEvent; task: Task }) {
  const [open, setOpen] = useState(false);
  const pending = e.id.startsWith("pending-");
  const text = taskEventText(e, { you: "You", youObject: "you", when: followupWhen });
  const Icon = ICONS[e.kind] ?? CircleDot;
  const quiet = "mt-1.5 rounded-lg bg-muted/60 px-3 py-2 text-[13px]";

  if (e.kind === "delivered") {
    // The latest result is the one shown above; earlier ones open here.
    const current = e.body === task.summary;
    const meta = [e.data.durationMs ? formatWork(e.data.durationMs) : null, e.data.costUsd ? formatCost(e.data.costUsd) : null].filter(Boolean).join(" · ");
    return (
      <Row
        icon={Icon}
        at={e.createdAt}
        below={
          !current && e.body && open ? (
            <div className={cn(quiet, "bg-card shadow-card")}>
              <ChatFilesScope conversationId={task.conversationId}>
                <Markdown>{e.body}</Markdown>
              </ChatFilesScope>
            </div>
          ) : null
        }
      >
        <span className="font-medium">{text}</span>
        {meta && <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{meta}</span>}
        {current ? (
          <span className="ml-1.5 text-xs text-muted-foreground">— the result above</span>
        ) : e.body ? (
          <Button size="xs" variant="ghost" className="ml-1 h-6 px-1.5 text-xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide this result" : "Show this result"}
          </Button>
        ) : null}
      </Row>
    );
  }

  const bodied = ["feedback", "note", "asked", "answered", "blocked", "waiting"].includes(e.kind) || (e.kind === "status" && !!e.body);
  return (
    <Row
      icon={Icon}
      at={e.createdAt}
      pending={pending}
      below={
        bodied && e.body ? (
          <div className={cn(quiet, "w-fit max-w-full", e.kind === "waiting" && "line-clamp-3")}>
            <Markdown className="text-[13px]">{e.body}</Markdown>
            {e.kind === "feedback" && e.data.files.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Files: {fileNameSummary(e.data.files)}</p>}
          </div>
        ) : null
      }
    >
      <span className={cn(e.kind === "blocked" && "text-rose-600 dark:text-rose-400", (e.kind === "feedback" || e.kind === "asked") && "font-medium")}>{text}</span>
    </Row>
  );
}
