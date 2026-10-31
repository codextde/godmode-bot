import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { format, formatDistanceToNowStrict } from "date-fns";
import { motion } from "motion/react";
import {
  ArrowUpRight,
  CalendarClock,
  ChevronRight,
  CircleStop,
  Cpu,
  Hash,
  MessageSquare,
  Play,
  Repeat,
  ScrollText,
  Share2,
  Timer,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import type { Run } from "@godmode/shared";
import { useLocale } from "@/i18n/language";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAgent, useQuestions } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/common";
import { Orb } from "@/components/aicss/Orb";
import { DrawCheck, WorkingTicks } from "@/components/aicss/Motion";
import { Markdown } from "@/components/chat/markdown";
import { CopyButton } from "@/components/chat/copy-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatDuration, formatElapsed, formatTokens, RunStatusBadge, TriggerBadge, useModelLabel } from "./run-status";
import { RunRow, useRunLiveState } from "./run-row";
import { RunLogViewer } from "./run-log-viewer";

export function useCancelRun() {
  const { t } = useTranslation("runs");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.runs.cancel(runId),
    onSuccess: (_, runId) => {
      qc.invalidateQueries({ queryKey: qk.run(runId) });
      qc.invalidateQueries({ queryKey: qk.runs });
      toast.success(t("detail.stopping"));
    },
    onError: (err) => toast.error(t("detail.cancelFailed"), { description: errorMessage(err) }),
  });
}

/**
 * Right-hand sheet with everything about one run.
 * `run` may be passed as a placeholder while the fresh copy loads.
 */
export function RunDetailSheet({
  runId,
  run: initialRun,
  onOpenChange,
}: {
  runId: string | null;
  run?: Run | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("runs");
  const [currentId, setCurrentId] = useState(runId);
  // Keep showing the last run while the sheet animates out
  useEffect(() => {
    if (runId) setCurrentId(runId);
  }, [runId]);
  const open = !!runId;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-hidden p-0 sm:max-w-xl">
        {currentId ? (
          <RunDetail
            key={currentId}
            runId={currentId}
            placeholder={initialRun?.id === currentId ? initialRun : undefined}
            onOpenRun={setCurrentId}
          />
        ) : (
          <SheetHeader>
            <SheetTitle>{t("detail.run")}</SheetTitle>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

function RunDetail({ runId, placeholder, onOpenRun }: { runId: string; placeholder?: Run; onOpenRun: (id: string) => void }) {
  const { t } = useTranslation(["runs", "common"]);
  const q = useQuery({
    queryKey: qk.run(runId),
    queryFn: () => api.runs.get(runId),
    placeholderData: placeholder,
  });
  const run = q.data;

  if (!run) {
    return (
      <>
        <SheetHeader className="border-b p-5">
          <SheetTitle>{t("detail.title")}</SheetTitle>
          <SheetDescription>{q.isError ? errorMessage(q.error) : t("common:status.loading")}</SheetDescription>
        </SheetHeader>
        {!q.isError && (
          <div className="space-y-3 p-5">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-48 w-full rounded-xl" />
          </div>
        )}
      </>
    );
  }
  return <RunDetailBody run={run} onOpenRun={onOpenRun} />;
}

function RunDetailBody({ run, onOpenRun }: { run: Run; onOpenRun: (id: string) => void }) {
  const { t } = useTranslation(["runs", "common"]);
  const { dateLocale } = useLocale();
  const modelLabel = useModelLabel();
  const { data: agent } = useAgent(run.agentId);
  const { live, status, running, elapsed } = useRunLiveState(run);
  const cancel = useCancelRun();
  const [logOpen, setLogOpen] = useState(false);
  const cancellable = running || status === "queued" || status === "paused";
  const qc = useQueryClient();
  const resume = useMutation({
    mutationFn: () => api.conversations.continue(run.conversationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.run(run.id) });
      qc.invalidateQueries({ queryKey: qk.runs });
    },
    onError: (err) => toast.error(t("detail.continueFailed"), { description: errorMessage(err) }),
  });
  const when = run.startedAt ?? run.createdAt;
  // A paused run may wait for the human's answer: that, not Continue, is the way on.
  const { data: open = [] } = useQuestions("open");
  const asked = status === "paused" ? open.find((q) => q.runId === run.id) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="gap-3 border-b bg-paper-2 p-5 pr-12">
        <div className="flex items-center gap-3">
          {agent ? <AgentAvatar agent={agent} size="lg" /> : <Skeleton className="size-12 rounded-xl" />}
          <div className="min-w-0">
            <SheetTitle className="truncate text-lg font-medium tracking-[-0.02em]">{agent?.name ?? t("detail.run")}</SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-1.5">
              <RunStatusBadge status={status} waitingFor={asked ? (asked.kind === "approval" ? "approval" : "answer") : null} />
              <TriggerBadge trigger={run.trigger} />
              <span className="tabular-nums" title={format(new Date(when), "PPpp", { locale: dateLocale })}>
                {formatDistanceToNowStrict(new Date(when), { addSuffix: true, locale: dateLocale })}
              </span>
            </SheetDescription>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to={`/chat/${run.conversationId}`}>
              <MessageSquare /> {t("detail.openConversation")}
            </Link>
          </Button>
          {agent && (
            <Button asChild size="sm" variant="ghost">
              <Link to={`/agents/${agent.id}`}>
                {t("common:words.agent")} <ArrowUpRight />
              </Link>
            </Button>
          )}
          {status === "paused" &&
            (asked ? (
              <Button asChild size="sm" className="ml-auto">
                <Link to={asked.taskId ? `/tasks?task=${asked.taskId}` : `/chat/${run.conversationId}`}>{asked.taskId ? t("detail.answerInTask") : t("detail.answerInChat")}</Link>
              </Button>
            ) : (
              <Button size="sm" className="ml-auto" onClick={() => resume.mutate()} disabled={resume.isPending}>
                {resume.isPending ? <Spinner /> : <Play className="fill-current" />} {t("common:actions.continue")}
              </Button>
            ))}
          {cancellable && (
            <Button
              size="sm"
              variant="outline"
              className={cn("border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive", status !== "paused" && "ml-auto")}
              onClick={() => cancel.mutate(run.id)}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? <Spinner /> : <CircleStop />} {t("detail.cancelRun")}
            </Button>
          )}
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        {agent?.failedRunId === run.id && <FailureNotice agentId={agent.id} agentName={agent.name} />}
        {running && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="glow-border flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card"
          >
            <Orb variant="S3" size={28} label={t("detail.working")} />
            <div className="min-w-0 flex-1">
              <div className="text-shimmer truncate text-sm font-medium">{live?.activity ?? t("detail.workingEllipsis")}</div>
              <div className="font-mono text-xs text-muted-foreground tabular-nums">{t("detail.elapsed", { time: elapsed != null ? formatElapsed(elapsed) : t("detail.starting") })}</div>
            </div>
            <WorkingTicks count={8} className="shrink-0 text-brand-strong" />
          </motion.div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat icon={<Timer />} label={t("row.duration")} value={elapsed != null ? formatElapsed(elapsed) : formatDuration(run.durationMs)} />
          <Stat icon={<Repeat />} label={t("detail.turns")} value={run.numTurns != null ? String(run.numTurns) : "—"} />
          <Stat icon={<Cpu />} label={t("detail.model")} value={modelLabel(run.model)} />
          <Stat
            icon={<Hash />}
            label={t("detail.tokens")}
            value={run.usage ? `${formatTokens(run.usage.inputTokens + run.usage.cacheReadTokens + run.usage.cacheWriteTokens)} / ${formatTokens(run.usage.outputTokens)}` : "—"}
            hint={run.usage ? t("detail.cacheHint", { read: formatTokens(run.usage.cacheReadTokens), write: formatTokens(run.usage.cacheWriteTokens) }) : undefined}
          />
          <Stat
            icon={<CalendarClock />}
            label={t("detail.started")}
            value={run.startedAt ? format(new Date(run.startedAt), "p", { locale: dateLocale }) : "—"}
            hint={run.startedAt ? format(new Date(run.startedAt), "PP", { locale: dateLocale }) : undefined}
            className="col-span-2"
          />
        </div>

        {(run.parentRunId || run.routineId) && (
          <div className="flex flex-wrap gap-2 text-xs">
            {run.parentRunId && <HandedOverBy parentRunId={run.parentRunId} onOpenRun={onOpenRun} />}
            {run.routineId && (
              <Link
                to={`/agents/${run.agentId}/routines`}
                className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-muted-foreground shadow-card transition hover:border-foreground/15 hover:text-foreground"
              >
                <Workflow className="size-3" /> {t("detail.startedByAutomation")} <ChevronRight className="size-3" />
              </Link>
            )}
          </div>
        )}

        <HandedOn runId={run.id} onOpenRun={onOpenRun} />

        <Block title={t("detail.prompt")} actions={<CopyButton text={run.prompt} label={t("detail.copyPrompt")} />}>
          <p className="max-h-60 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">{run.prompt || <span className="text-muted-foreground">{t("detail.empty")}</span>}</p>
        </Block>

        {run.error && (
          <div className="rounded-xl border border-destructive/25 bg-destructive/[0.06] p-4">
            <div className="mb-1.5 flex items-center gap-2 text-sm font-medium text-destructive">
              <TriangleAlert className="size-4" /> {t("detail.error")}
            </div>
            <pre className="max-h-60 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-destructive/90">{run.error}</pre>
          </div>
        )}

        {run.result ? (
          <Block
            title={
              <>
                {status === "succeeded" && <DrawCheck className="size-3.5 text-success" />}
                {t("detail.result")}
              </>
            }
            actions={<CopyButton text={run.result} label={t("detail.copyResult")} />}
          >
            <div className="max-h-[28rem] overflow-y-auto">
              <Markdown>{run.result}</Markdown>
            </div>
          </Block>
        ) : (
          !running &&
          !run.error && (
            <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{t("detail.noResult")}</p>
          )
        )}

        <div className="rounded-xl border bg-card shadow-card">
          <button
            type="button"
            onClick={() => setLogOpen((o) => !o)}
            aria-expanded={logOpen}
            className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left text-sm font-medium transition hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ScrollText className="size-4 text-muted-foreground" />
            {t("detail.rawLog")}
            <span className="text-xs font-normal text-muted-foreground">{t("detail.rawLogHint")}</span>
            <ChevronRight className={cn("ml-auto size-4 text-muted-foreground transition-transform", logOpen && "rotate-90")} />
          </button>
          {logOpen && (
            <div className="border-t p-4">
              <RunLogViewer runId={run.id} live={running} />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono">{run.id}</span>
          <CopyButton text={run.id} label={t("detail.copyId")} />
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, hint, className }: { icon: ReactNode; label: string; value: string; hint?: string; className?: string }) {
  return (
    <div className={cn("rounded-lg border bg-card p-3 shadow-card", className)} title={hint}>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium tracking-[-0.01em] tabular-nums">{value}</div>
    </div>
  );
}

function Block({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4 shadow-card">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="eyebrow flex items-center gap-1.5">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** "Handed over by [face] Lena" — opens the run that handed this one over. */
function HandedOverBy({ parentRunId, onOpenRun }: { parentRunId: string; onOpenRun: (id: string) => void }) {
  const { t } = useTranslation("runs");
  const parent = useQuery({ queryKey: qk.run(parentRunId), queryFn: () => api.runs.get(parentRunId), retry: false });
  const { data: from } = useAgent(parent.data?.agentId);
  const chip = "inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-muted-foreground shadow-card";
  if (parent.isLoading) return <Skeleton className="h-7 w-44 rounded-md" />;
  if (!parent.data) {
    return (
      <span className={chip}>
        <Share2 className="size-3" /> {t("detail.handedOverByGone")}
      </span>
    );
  }
  return (
    <button type="button" onClick={() => onOpenRun(parentRunId)} className={cn(chip, "transition hover:border-foreground/15 hover:text-foreground")}>
      <Share2 className="size-3" /> {t("detail.handedOverBy")}
      {from ? (
        <>
          <AgentAvatar agent={from} size="sm" still className="size-4 rounded-[4px] text-[9px]" />
          <span className="font-medium text-foreground">{from.name}</span>
        </>
      ) : (
        t("detail.anotherAgent")
      )}
      <ChevronRight className="size-3" />
    </button>
  );
}

/** The runs this one handed over to teammates, oldest first. */
function HandedOn({ runId, onOpenRun }: { runId: string; onOpenRun: (id: string) => void }) {
  const { t } = useTranslation("runs");
  const children = useQuery({ queryKey: qk.runChildren(runId), queryFn: () => api.runs.list({ parentRunId: runId, limit: 100 }) });
  if (children.isLoading) return <Skeleton className="h-12 w-full rounded-lg" />;
  if (children.isError) return <p className="text-xs text-muted-foreground">{t("detail.handedOnFailed", { error: errorMessage(children.error) })}</p>;
  const list = [...(children.data ?? [])].reverse();
  if (!list.length) return null;
  return (
    <section aria-label={t("detail.handedOn")} className="space-y-1.5">
      <h3 className="eyebrow text-[10.5px]">{t("detail.handedOn")}</h3>
      <div className="space-y-0.5 rounded-xl border bg-card p-1 shadow-card">
        {list.map((r) => (
          <RunRow key={r.id} run={r} onSelect={(x) => onOpenRun(x.id)} />
        ))}
      </div>
    </section>
  );
}

/** This run is why the agent says "Last run failed": the human can let that go. */
function FailureNotice({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { t } = useTranslation("runs");
  const qc = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => api.agents.dismissFailure(agentId),
    onSuccess: (agent) => {
      qc.setQueryData(qk.agent(agent.id), agent);
      qc.invalidateQueries({ queryKey: qk.agents });
    },
    onError: (err) => toast.error(t("detail.dismissFailed"), { description: errorMessage(err) }),
  });
  return (
    <div className="flex items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/[0.04] px-4 py-2.5 text-[13px]">
      <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1">{t("detail.failureNotice", { name: agentName })}</span>
      <Button size="xs" variant="ghost" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
        {dismiss.isPending && <Spinner />} {t("detail.dismiss")}
      </Button>
    </div>
  );
}
