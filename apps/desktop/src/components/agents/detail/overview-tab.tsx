import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Activity, ArrowRight, Coins, Gauge, Pencil, Timer } from "lucide-react";
import type { Agent, Run } from "@godmode/shared";
import { useRuns } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RunRow } from "@/components/runs/run-row";
import { RunDetailSheet } from "@/components/runs/run-detail-sheet";
import { formatCost, formatDuration } from "@/components/runs/run-status";
import { RunTaskDialog } from "../agent-actions";
import { Plate } from "./plate";

export function OverviewTab({ agent }: { agent: Agent }) {
  const runsQ = useRuns(agent.id);
  const [selected, setSelected] = useState<Run | null>(null);
  const [runTask, setRunTask] = useState(false);
  const runs = runsQ.data ?? [];

  const stats = useMemo(() => {
    const succeeded = runs.filter((r) => r.status === "succeeded").length;
    const failed = runs.filter((r) => r.status === "failed").length;
    const cost = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const durations = runs.map((r) => r.durationMs).filter((d): d is number => d != null && d > 0);
    const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    // Runs per day over the last 14 days
    const days = 14;
    const buckets = Array.from({ length: days }, () => 0);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const startMs = start.getTime() - (days - 1) * 86_400_000;
    for (const r of runs) {
      const t = new Date(r.startedAt ?? r.createdAt).getTime();
      const idx = Math.floor((t - startMs) / 86_400_000);
      if (idx >= 0 && idx < days) buckets[idx]++;
    }
    return {
      total: runs.length,
      successRate: succeeded + failed > 0 ? succeeded / (succeeded + failed) : null,
      failed,
      cost,
      avg,
      buckets,
    };
  }, [runs]);

  return (
    <div className="space-y-6">
      <Plate agent={agent} onRunTask={() => setRunTask(true)} />
      <RunTaskDialog agent={agent} open={runTask} onOpenChange={setRunTask} />

      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
        <Kpi
          icon={<Activity />}
          label={runs.length >= 200 ? "Runs (last 200)" : "Total runs"}
          value={runsQ.isLoading ? null : String(stats.total)}
          extra={<Sparkbars values={stats.buckets} />}
        />
        <Kpi
          icon={<Gauge />}
          label="Success rate"
          value={runsQ.isLoading ? null : stats.successRate == null ? "—" : `${Math.round(stats.successRate * 100)}%`}
          hint={stats.failed ? `${stats.failed} failed` : undefined}
          tone={stats.successRate != null && stats.successRate < 0.8 ? "warn" : undefined}
        />
        <Kpi icon={<Coins />} label="Total cost" value={runsQ.isLoading ? null : formatCost(stats.cost)} />
        <Kpi icon={<Timer />} label="Avg duration" value={runsQ.isLoading ? null : formatDuration(stats.avg)} />
      </div>

      <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0 rounded-xl border bg-card p-2 shadow-card">
          <div className="flex items-center justify-between px-3 pt-2 pb-1">
            <h2 className="text-sm font-medium tracking-[-0.01em]">Recent runs</h2>
            <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
              <Link to={`/activity?agent=${agent.id}`}>
                All activity <ArrowRight />
              </Link>
            </Button>
          </div>
          {runsQ.isLoading ? (
            <div className="space-y-1 p-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          ) : runsQ.isError ? (
            <p className="p-4 text-sm text-muted-foreground">Couldn't load runs: {errorMessage(runsQ.error)}</p>
          ) : runs.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No runs yet. Start a chat or give it a task — every run shows up here.
            </div>
          ) : (
            <div className="space-y-0.5">
              {runs.slice(0, 8).map((r) => (
                <RunRow key={r.id} run={r} showAgent={false} onSelect={setSelected} selected={selected?.id === r.id} />
              ))}
            </div>
          )}
        </section>

        <div className="space-y-6">
          <section className="rounded-xl border bg-card p-4 shadow-card">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium tracking-[-0.01em]">Instructions</h2>
              <Button variant="ghost" size="icon-xs" asChild className="text-muted-foreground">
                <Link to={`/agents/${agent.id}/settings`} aria-label="Edit instructions">
                  <Pencil />
                </Link>
              </Button>
            </div>
            {agent.instructions.trim() ? (
              <div className="relative max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,#000_calc(100%-3rem),transparent)]">
                <Markdown className="text-[13px] text-muted-foreground">{agent.instructions}</Markdown>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No instructions yet — it works from your messages alone.</p>
            )}
          </section>
        </div>
      </div>

      <RunDetailSheet runId={selected?.id ?? null} run={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  hint,
  extra,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string | null;
  hint?: string;
  extra?: ReactNode;
  tone?: "warn";
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-card p-4 shadow-card">
      <div className="eyebrow flex items-center gap-2 [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        {value == null ? (
          <Skeleton className="h-7 w-16" />
        ) : (
          <span className={cn("text-2xl font-medium tracking-[-0.03em] tabular-nums", tone === "warn" && "text-warning")}>{value}</span>
        )}
        {extra}
      </div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Sparkbars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  if (values.every((v) => v === 0)) return null;
  return (
    <div className="flex h-8 items-end gap-[3px]" aria-hidden>
      {values.map((v, i) => (
        <span
          key={i}
          className={cn("w-1.5 rounded-[2px]", v ? "bg-foreground" : "bg-muted")}
          style={{ height: `${Math.max(12, (v / max) * 100)}%`, opacity: v ? 0.35 + 0.5 * (v / max) : 1 }}
        />
      ))}
    </div>
  );
}
