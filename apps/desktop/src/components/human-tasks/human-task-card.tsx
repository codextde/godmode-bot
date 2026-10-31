import { forwardRef, type HTMLAttributes } from "react";
import { formatDistanceToNowStrict, type FormatDistanceToken } from "date-fns";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, CircleCheck, CircleSlash, Flag, MessageCircleQuestion, MessagesSquare, ShieldCheck, SquareKanban, Undo2, UserRound } from "lucide-react";
import type { Agent, HumanTask, HumanTaskKind } from "@godmode/shared";
import { humanTaskAnswer, humanTaskRef } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { cn } from "@/lib/utils";
import { dateLocale, t } from "@/i18n";

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

const AGE_KEY = {
  xSeconds: "humanTasks:age.seconds",
  xMinutes: "humanTasks:age.minutes",
  xHours: "humanTasks:age.hours",
  xDays: "humanTasks:age.days",
  xMonths: "humanTasks:age.months",
  xYears: "humanTasks:age.years",
} as const;

export function shortAge(iso: string): string {
  const formatDistance = (token: FormatDistanceToken, n: number) => t(AGE_KEY[token as keyof typeof AGE_KEY] ?? AGE_KEY.xSeconds, { n });
  return formatDistanceToNowStrict(new Date(iso), { roundingMethod: "floor", locale: { ...dateLocale(), formatDistance } });
}

export function humanTaskWords(kind: HumanTaskKind) {
  return {
    done: t(`humanTasks:words.${kind}.done`),
    declined: t(`humanTasks:words.${kind}.declined`),
    wasDone: t(`humanTasks:words.${kind}.wasDone`),
    wasDeclined: t(`humanTasks:words.${kind}.wasDeclined`),
  };
}

const OUTCOME = {
  done: { icon: CircleCheck, tone: "text-emerald-600 dark:text-emerald-400" },
  declined: { icon: CircleSlash, tone: "text-rose-600 dark:text-rose-400" },
  withdrawn: { icon: Undo2, tone: "text-muted-foreground" },
} as const;

/** How a closed task ended, in the words of its kind ("Answered", "Approved", "Couldn't do it"). */
export function outcomeOf(task: HumanTask) {
  if (task.status !== "done" && task.status !== "declined" && task.status !== "withdrawn") return null;
  const words = humanTaskWords(task.kind);
  // A decision nobody answered is muted, not a failure.
  const tone = task.status === "declined" && task.kind === "decision" ? "text-muted-foreground" : OUTCOME[task.status].tone;
  return { icon: OUTCOME[task.status].icon, tone, label: task.status === "done" ? words.wasDone : task.status === "declined" ? words.wasDeclined : t("humanTasks:status.withdrawn") };
}

const KIND = {
  decision: { icon: MessageCircleQuestion, labelKey: "kind.decision" },
  approval: { icon: ShieldCheck, labelKey: "kind.approval" },
} as const;

/** What an agent wants to hear from the human: a decision or an OK. Nothing for a plain task. */
export function KindBadge({ task, className }: { task: HumanTask; className?: string }) {
  const { t } = useTranslation("humanTasks");
  if (task.kind === "task") return null;
  const k = KIND[task.kind];
  return (
    <span className={cn("flex items-center gap-1 rounded-[4px] bg-warning/10 px-1 text-[11px] font-medium text-warning", className)}>
      <k.icon className="size-3" aria-hidden /> {t(k.labelKey)}
    </span>
  );
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
  const { t } = useTranslation("humanTasks");
  const outcome = outcomeOf(task);
  const preview = outcome ? humanTaskAnswer(task) || task.closedReason || "" : plainPreview(task.body);
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
        {!outcome && <KindBadge task={task} />}
        {urgent && (
          <span className="flex items-center gap-0.5 rounded-[4px] bg-rose-500/10 px-1 text-[11px] font-medium text-rose-600 dark:text-rose-400">
            <Flag className="size-2.5 fill-current" /> {t("card.urgent")}
          </span>
        )}
        {task.status === "doing" && <span className="rounded-[4px] bg-brand-soft px-1 text-[11px] font-medium text-brand-strong">{t("card.onIt")}</span>}
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
            <span className="truncate">{own ? t("card.yourOwn") : (task.agentName ?? t("card.agentRemoved"))}</span>
          </span>
        )}
        <OriginLabel task={task} className="ml-auto max-w-[45%] text-[11px] text-muted-foreground" />
      </div>
    </div>
  );
});
