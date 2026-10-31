import { useState, type ComponentType } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { fileNameSummary } from "@godmode/shared";
import { Markdown } from "@/components/chat/markdown";
import { ChatFilesScope } from "@/components/chat/local-files";
import { followupWhen } from "@/components/chat/followup";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTaskEvents } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { currentLanguage } from "@/i18n";
import { useLocale } from "@/i18n/language";
import { STATUS_META, formatWork } from "./task-meta";

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

const ticketList = (numbers: readonly number[]) =>
  new Intl.ListFormat(currentLanguage() === "de" ? "de-DE" : "en-GB", { type: "conjunction" }).format(numbers.map((n) => `#${n}`));

function eventText(e: TaskEvent, t: TFunction<["tasks", "common"]>): string {
  const who = e.actor === "user" ? "you" : "other";
  const a = e.actor === "user" ? t("event.actor.you") : e.actor === "system" ? "Godmode" : e.actorName || t("event.actor.agent");
  const label = (s: keyof typeof STATUS_META) => STATUS_META[s]?.label ?? s;
  switch (e.kind) {
    case "status": {
      const { from, to } = e.data;
      if (to === "done") return from === "in_review" ? t(`event.approved.${who}`, { a }) : t(`event.markedDone.${who}`, { a });
      if (to === "cancelled") return t(`event.cancelled.${who}`, { a });
      if (from === "done" || from === "cancelled") return t(`event.reopened.${who}`, { a });
      if (to === "blocked") return t(`event.movedBlocked.${who}`, { a });
      if (from === "blocked" && to === "todo") return t(`event.restarted.${who}`, { a });
      if (from === "in_progress" && to === "backlog") return t(`event.stopped.${who}`, { a });
      return t(`event.moved.${who}`, { a, from: label(from), to: label(to) });
    }
    case "assigned": {
      const { from, to, fromName, toName } = e.data;
      if (!from) return t(`event.assignedTo.${who}`, { a, name: toName || t("event.fallback.anAgent") });
      if (!to) return t(`event.tookOff.${who}`, { a, name: fromName || t("event.fallback.theAgent") });
      return t(`event.handed.${who}`, { a, from: fromName || t("event.fallback.anAgent"), to: toName || t("event.fallback.anotherAgent") });
    }
    case "archived":
      return e.data.archived ? t(`event.archived.${who}`, { a }) : t(`event.restored.${who}`, { a });
    case "started":
      if (e.data.subtasks?.length) return t(`event.pickedUpSubtasks.${who}`, { a, list: ticketList(e.data.subtasks), count: e.data.subtasks.length });
      if (e.data.retry) return e.data.retry > 1 ? t(`event.retryMore.${who}`, { a }) : t(`event.retry.${who}`, { a });
      if (!e.data.again) return t(`event.started.${who}`, { a });
      if (e.data.trigger === "followup") return t(`event.continuedPlanned.${who}`, { a });
      if (e.data.trigger === "heartbeat") return t(`event.heartbeat.${who}`, { a });
      if (e.data.trigger === "task") return t(`event.startedOver.${who}`, { a });
      return t(`event.pickedUp.${who}`, { a });
    case "waiting":
      if (e.data.subtasks?.length) return t(`event.waitingFor.${who}`, { a, list: ticketList(e.data.subtasks) });
      return t(`event.waitingContinues.${who}`, { a, when: e.data.dueAt ? followupWhen(e.data.dueAt) : t("event.later") });
    case "delivered":
      return e.data.pullRequest ? t(`event.deliveredPr.${who}`, { a, number: e.data.pullRequest }) : t(`event.delivered.${who}`, { a });
    case "blocked":
      switch (e.data.kind) {
        case "needs_input":
          return t(`event.needsInput.${who}`, { a });
        case "failed":
          return t("blocked.failed.title");
        case "stopped":
          return t("event.stoppedEarly");
        case "interrupted":
          return t("blocked.interrupted.title");
        case "publish":
          return t("blocked.publish.title");
        case "setup":
          return t("blocked.setup.title");
        default:
          return t(`event.movedBlocked.${who}`, { a });
      }
    case "feedback":
      if (e.data.on === "in_review") return t(`event.requestedChanges.${who}`, { a });
      if (e.data.on === "blocked") return t(`event.answered.${who}`, { a });
      if (e.data.on === "done" || e.data.on === "cancelled") return t(`event.reopenedMessage.${who}`, { a });
      return t(`event.wrote.${who}`, { a });
    case "note":
      return t(`event.noted.${who}`, { a });
    case "pr_opened":
      return e.data.number ? t("event.prOpened", { number: e.data.number }) : t("event.branchPushed");
    case "pr_merged":
      if (e.data.auto) return t("event.prMergedAuto", { number: e.data.number });
      return e.actor === "user" ? t(`event.mergedPr.${who}`, { a, number: e.data.number }) : t("event.prMerged", { number: e.data.number });
    case "pr_closed":
      return t("event.prClosed", { number: e.data.number });
    case "asked":
      if (e.data.kind === "task") return t(`event.askedTask.${who}`, { a });
      return e.data.kind === "approval" ? t(`event.askedOk.${who}`, { a }) : t(`event.asked.${who}`, { a });
    case "answered":
      if (e.data.kind === "task") return e.data.status === "declined" ? t(`event.taskDeclined.${who}`, { a }) : t(`event.taskDone.${who}`, { a });
      return e.data.status === "approved" ? t(`event.approvedPlain.${who}`, { a }) : e.data.status === "declined" ? t(`event.declined.${who}`, { a }) : t(`event.answered.${who}`, { a });
  }
}

/**
 * What happened on a ticket, oldest first: who filed it, moves, starts, every delivery with its result, blocks with
 * their reason, the human's feedback, notes agents left, pull requests, questions and answers.
 */
export function TaskTimeline({ task, agents, userName }: { task: Task; agents: Agent[]; userName?: string }) {
  const { t } = useTranslation(["tasks", "common"]);
  const events = useTaskEvents(task.id);
  const [all, setAll] = useState(false);
  const filer = task.createdBy === "user" ? null : (agents.find((a) => `agent:${a.id}` === task.createdBy)?.name ?? t("timeline.goneAgent"));
  const list = events.data ?? [];
  const hidden = all ? 0 : Math.max(0, list.length - SHOWN);
  const shown = list.slice(hidden);
  void userName;

  return (
    <section aria-labelledby={`activity-${task.id}`} className="space-y-2">
      <h3 id={`activity-${task.id}`} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("timeline.title")}
      </h3>
      {events.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-5 w-3/4 rounded-md" />
          ))}
        </div>
      ) : events.isError ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          {t("timeline.loadError")}
          <Button size="xs" variant="ghost" onClick={() => events.refetch()}>
            <RefreshCw /> {t("common:actions.tryAgain")}
          </Button>
        </div>
      ) : (
        <ol className="relative space-y-3 border-l pl-4" aria-live="polite" aria-relevant="additions">
          <Row icon={CircleDot} at={task.createdAt}>
            {filer === null ? t("timeline.youFiled") : t("timeline.filed", { name: filer })}
          </Row>
          {hidden > 0 && (
            <li>
              <Button size="xs" variant="ghost" className="-ml-2 text-muted-foreground" onClick={() => setAll(true)}>
                {t("timeline.showEarlier", { count: hidden })}
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
  const { t } = useTranslation("tasks");
  const { dateLocale } = useLocale();
  return (
    <li className={cn("relative", pending && "opacity-60")}>
      <span className="absolute top-0.5 -left-[1.4rem] grid size-4 place-items-center rounded-full bg-background">
        <Icon className="size-3.5 text-muted-foreground" />
      </span>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px]">
        <span className="min-w-0">{children}</span>
        <time dateTime={at} title={format(new Date(at), "PPpp", { locale: dateLocale })} className="text-xs text-muted-foreground tabular-nums">
          {pending ? t("timeline.sending") : formatDistanceToNowStrict(new Date(at), { addSuffix: true, locale: dateLocale })}
        </time>
      </div>
      {below}
    </li>
  );
}

function EventRow({ event: e, task }: { event: TaskEvent; task: Task }) {
  const { t } = useTranslation(["tasks", "common"]);
  const [open, setOpen] = useState(false);
  const pending = e.id.startsWith("pending-");
  const text = eventText(e, t);
  const Icon = ICONS[e.kind] ?? CircleDot;
  const quiet = "mt-1.5 rounded-lg bg-muted/60 px-3 py-2 text-[13px]";

  if (e.kind === "delivered") {
    // The latest result is the one shown above; earlier ones open here.
    const current = e.body === task.summary;
    const meta = e.data.durationMs ? formatWork(e.data.durationMs) : "";
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
          <span className="ml-1.5 text-xs text-muted-foreground">{t("timeline.resultAbove")}</span>
        ) : e.body ? (
          <Button size="xs" variant="ghost" className="ml-1 h-6 px-1.5 text-xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? t("timeline.hideResult") : t("timeline.showResult")}
          </Button>
        ) : null}
      </Row>
    );
  }

  const bodied = ["feedback", "note", "asked", "answered", "blocked", "waiting"].includes(e.kind) || ((e.kind === "status" || e.kind === "started") && !!e.body);
  return (
    <Row
      icon={Icon}
      at={e.createdAt}
      pending={pending}
      below={
        bodied && e.body ? (
          <div className={cn(quiet, "w-fit max-w-full", e.kind === "waiting" && "line-clamp-3")}>
            <Markdown className="text-[13px]">{e.body}</Markdown>
            {e.kind === "feedback" && e.data.files.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{t("timeline.files", { list: fileNameSummary(e.data.files) })}</p>}
          </div>
        ) : null
      }
    >
      <span className={cn(e.kind === "blocked" && "text-rose-600 dark:text-rose-400", (e.kind === "feedback" || e.kind === "asked") && "font-medium")}>{text}</span>
    </Row>
  );
}
