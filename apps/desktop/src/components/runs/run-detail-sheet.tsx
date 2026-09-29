import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format, formatDistanceToNowStrict } from "date-fns";
import { motion } from "motion/react";
import {
  ArrowUpRight,
  CalendarClock,
  ChevronRight,
  CircleStop,
  Coins,
  Cpu,
  Hash,
  MessageSquare,
  Repeat,
  ScrollText,
  Share2,
  Timer,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import type { Run } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useAgent } from "@/lib/hooks";
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
import { formatCost, formatDuration, formatElapsed, formatTokens, RunStatusBadge, TriggerBadge, useModelLabel } from "./run-status";
import { useRunLiveState } from "./run-row";
import { RunLogViewer } from "./run-log-viewer";

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.runs.cancel(runId),
    onSuccess: (_, runId) => {
      qc.invalidateQueries({ queryKey: qk.run(runId) });
      qc.invalidateQueries({ queryKey: qk.runs });
      toast.success("Stopping the run…");
    },
    onError: (err) => toast.error("Couldn't cancel the run", { description: errorMessage(err) }),
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
            <SheetTitle>Run</SheetTitle>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

function RunDetail({ runId, placeholder, onOpenRun }: { runId: string; placeholder?: Run; onOpenRun: (id: string) => void }) {
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
          <SheetTitle>Run details</SheetTitle>
          <SheetDescription>{q.isError ? errorMessage(q.error) : "Loading…"}</SheetDescription>
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
  const modelLabel = useModelLabel();
  const { data: agent } = useAgent(run.agentId);
  const { live, status, running, elapsed } = useRunLiveState(run);
  const cancel = useCancelRun();
  const [logOpen, setLogOpen] = useState(false);
  const cancellable = running || status === "queued";
  const when = run.startedAt ?? run.createdAt;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="gap-3 border-b bg-paper-2 p-5 pr-12">
        <div className="flex items-center gap-3">
          {agent ? <AgentAvatar agent={agent} size="lg" /> : <Skeleton className="size-12 rounded-xl" />}
          <div className="min-w-0">
            <SheetTitle className="truncate text-lg font-medium tracking-[-0.02em]">{agent?.name ?? "Run"}</SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-1.5">
              <RunStatusBadge status={status} />
              <TriggerBadge trigger={run.trigger} />
              <span className="tabular-nums" title={format(new Date(when), "PPpp")}>{formatDistanceToNowStrict(new Date(when), { addSuffix: true })}</span>
            </SheetDescription>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to={`/chat/${run.conversationId}`}>
              <MessageSquare /> Open conversation
            </Link>
          </Button>
          {agent && (
            <Button asChild size="sm" variant="ghost">
              <Link to={`/agents/${agent.id}`}>
                Agent <ArrowUpRight />
              </Link>
            </Button>
          )}
          {cancellable && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => cancel.mutate(run.id)}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? <Spinner /> : <CircleStop />} Cancel run
            </Button>
          )}
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        {running && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="glow-border flex items-center gap-3 rounded-xl border bg-card p-4 shadow-card"
          >
            <Orb variant="S3" size={28} label="Working" />
            <div className="min-w-0 flex-1">
              <div className="text-shimmer truncate text-sm font-medium">{live?.activity ?? "Working…"}</div>
              <div className="font-mono text-xs text-muted-foreground tabular-nums">{elapsed != null ? formatElapsed(elapsed) : "Starting…"} elapsed</div>
            </div>
            <WorkingTicks count={8} className="shrink-0 text-brand-strong" />
          </motion.div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat icon={<Timer />} label="Duration" value={elapsed != null ? formatElapsed(elapsed) : formatDuration(run.durationMs)} />
          <Stat icon={<Coins />} label="Cost" value={formatCost(run.costUsd)} />
          <Stat icon={<Repeat />} label="Turns" value={run.numTurns != null ? String(run.numTurns) : "—"} />
          <Stat icon={<Cpu />} label="Model" value={modelLabel(run.model)} />
          <Stat
            icon={<Hash />}
            label="Tokens in / out"
            value={run.usage ? `${formatTokens(run.usage.inputTokens + run.usage.cacheReadTokens + run.usage.cacheWriteTokens)} / ${formatTokens(run.usage.outputTokens)}` : "—"}
            hint={run.usage ? `${formatTokens(run.usage.cacheReadTokens)} cache read · ${formatTokens(run.usage.cacheWriteTokens)} cache write` : undefined}
          />
          <Stat
            icon={<CalendarClock />}
            label="Started"
            value={run.startedAt ? format(new Date(run.startedAt), "p") : "—"}
            hint={run.startedAt ? format(new Date(run.startedAt), "PP") : undefined}
          />
        </div>

        {(run.parentRunId || run.routineId) && (
          <div className="flex flex-wrap gap-2 text-xs">
            {run.parentRunId && (
              <button
                type="button"
                onClick={() => onOpenRun(run.parentRunId!)}
                className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-muted-foreground shadow-card transition hover:border-foreground/15 hover:text-foreground"
              >
                <Share2 className="size-3" /> Delegated from another run <ChevronRight className="size-3" />
              </button>
            )}
            {run.routineId && (
              <Link
                to={`/agents/${run.agentId}/routines`}
                className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-muted-foreground shadow-card transition hover:border-foreground/15 hover:text-foreground"
              >
                <Workflow className="size-3" /> Started by an automation <ChevronRight className="size-3" />
              </Link>
            )}
          </div>
        )}

        <Block title="Prompt" actions={<CopyButton text={run.prompt} label="Copy prompt" />}>
          <p className="max-h-60 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">{run.prompt || <span className="text-muted-foreground">(empty)</span>}</p>
        </Block>

        {run.error && (
          <div className="rounded-xl border border-destructive/25 bg-destructive/[0.06] p-4">
            <div className="mb-1.5 flex items-center gap-2 text-sm font-medium text-destructive">
              <TriangleAlert className="size-4" /> Error
            </div>
            <pre className="max-h-60 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-destructive/90">{run.error}</pre>
          </div>
        )}

        {run.result ? (
          <Block
            title={
              <>
                {status === "succeeded" && <DrawCheck className="size-3.5 text-success" />}
                Result
              </>
            }
            actions={<CopyButton text={run.result} label="Copy result" />}
          >
            <div className="max-h-[28rem] overflow-y-auto">
              <Markdown>{run.result}</Markdown>
            </div>
          </Block>
        ) : (
          !running &&
          !run.error && (
            <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">This run didn't produce a final answer.</p>
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
            Raw log
            <span className="text-xs font-normal text-muted-foreground">stream-json events</span>
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
          <CopyButton text={run.id} label="Copy run ID" />
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3 shadow-card" title={hint}>
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
