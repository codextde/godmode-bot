import { useRef, type KeyboardEvent } from "react";
import { RefreshCw } from "lucide-react";
import type { Agent, SpendPeriod, SpendTotals } from "@godmode/shared";
import { SPEND_KIND_LABELS, formatUsd } from "@godmode/shared";
import { useBudgets, useSpend } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BudgetMeter } from "@/components/budgets/budget-meter";
import { formatDuration } from "./run-status";

const PERIODS: { id: SpendPeriod; label: string; none: string }[] = [
  { id: "today", label: "Today", none: "No runs yet today" },
  { id: "week", label: "This week", none: "No runs this week yet" },
  { id: "month", label: "This month", none: "No runs this month yet" },
  { id: "all", label: "All time", none: "No runs yet" },
];

const line = (t: SpendTotals) => [`${t.runs.toLocaleString()} run${t.runs === 1 ? "" : "s"}`, t.failed ? `${t.failed} failed` : null, t.durationMs ? `${formatDuration(t.durationMs)} working` : null].filter(Boolean).join(" · ");

/**
 * What the team (or the agent in view) cost: today, this week, this month and all time, booked when it was spent — and
 * for the chosen period, who and what kind of work it went to. Chooses with arrow keys like a radio group.
 */
export function SpendStrip({
  period,
  onPeriod,
  agentId,
  agentById,
  onAgent,
}: {
  period: SpendPeriod;
  onPeriod: (p: SpendPeriod) => void;
  agentId: string | null;
  agentById: Map<string, Agent>;
  onAgent: (id: string) => void;
}) {
  const report = useSpend(period, agentId);
  const budgets = useBudgets();
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const data = report.data;
  const budget = agentId ? budgets.data?.agents.find((b) => b.agentId === agentId) : budgets.data?.team;
  const agentName = agentId ? (agentById.get(agentId)?.name ?? "This agent") : null;

  const onKey = (e: KeyboardEvent, i: number) => {
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const p = PERIODS[(next + PERIODS.length) % PERIODS.length]!;
    onPeriod(p.id);
    tiles.current[(next + PERIODS.length) % PERIODS.length]?.focus();
  };

  const maxAgent = Math.max(0.000001, ...(data?.byAgent ?? []).map((a) => a.costUsd));
  const maxKind = Math.max(0.000001, ...(data?.byKind ?? []).map((k) => k.costUsd));

  return (
    <section aria-label="Spend" className="space-y-3">
      <div role="radiogroup" aria-label="Period" className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        {PERIODS.map((p, i) => {
          const t = data?.periods[p.id];
          const selected = p.id === period;
          const showBudget = p.id === "month" && budget && budget.budgetUsd !== null;
          return (
            <button
              key={p.id}
              ref={(el) => {
                tiles.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onPeriod(p.id)}
              onKeyDown={(e) => onKey(e, i)}
              aria-label={t ? `${p.label}: ${formatUsd(t.costUsd)}, ${line(t) || p.none}` : p.label}
              className={cn(
                "rounded-xl border bg-card p-3.5 text-left shadow-card transition-[border-color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                selected ? "border-foreground/30 ring-1 ring-foreground/10" : "hover:border-foreground/15",
              )}
            >
              <div className="eyebrow text-[10.5px]">{p.label}</div>
              {report.isLoading ? (
                <>
                  <Skeleton className="mt-2 h-6 w-20" />
                  <Skeleton className="mt-1.5 h-3 w-28" />
                </>
              ) : (
                <>
                  <div className="mt-1 text-xl font-medium tracking-[-0.02em] tabular-nums">
                    {t ? formatUsd(t.costUsd) : "—"}
                    {showBudget && <span className="text-sm font-normal text-muted-foreground"> of {formatUsd(budget!.budgetUsd!)}</span>}
                  </div>
                  {showBudget && (
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div
                        className={cn("h-full rounded-full", budget!.state === "exhausted" ? "bg-destructive" : budget!.state === "warning" ? "bg-warning" : "bg-foreground/60")}
                        style={{ width: `${Math.max(2, Math.min(1, budget!.spentUsd / budget!.budgetUsd!) * 100)}%` }}
                      />
                    </div>
                  )}
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {t && t.runs ? line(t) : p.none}
                    {p.id === "today" && data?.active ? ` · ${data.active} not finished yet` : ""}
                  </div>
                </>
              )}
            </button>
          );
        })}
      </div>
      {report.isError && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          Couldn't load totals: {errorMessage(report.error)}
          <Button size="xs" variant="ghost" onClick={() => report.refetch()}>
            <RefreshCw /> Try again
          </Button>
        </p>
      )}

      {budget && budget.budgetUsd !== null && budget.state === "exhausted" && budgets.data && (
        <div className="rounded-xl border border-destructive/25 bg-card p-3.5 shadow-card" role="status">
          <BudgetMeter
            status={budget}
            resetsAt={budgets.data.resetsAt}
            whose={agentName ? `${agentName}'s` : "the team's"}
            setLink={agentId ? `/agents/${agentId}/settings#permissions` : "/settings/ai"}
            release={agentId ? { scope: "agent", agentId } : { scope: "team" }}
          />
        </div>
      )}

      {data && (data.byAgent.length > 0 || data.byKind.length > 0) && (
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-xl border bg-card p-4 shadow-card @3xl:grid-cols-2">
          {!agentId && (
            <div>
              <h3 className="eyebrow mb-2 text-[10.5px]">By agent</h3>
              <ul className="space-y-1.5">
                {data.byAgent.slice(0, 8).map((a) => {
                  const agent = agentById.get(a.agentId);
                  return (
                    <li key={a.agentId}>
                      <button
                        type="button"
                        disabled={a.deleted}
                        onClick={() => onAgent(a.agentId)}
                        className="group flex w-full items-center gap-2.5 rounded-md text-left text-[13px] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default"
                        title={a.deleted ? undefined : `Show only ${a.name}`}
                      >
                        {agent ? (
                          <AgentAvatar agent={agent} size="sm" still className="size-5 rounded-[5px] text-[10px]" />
                        ) : (
                          <span className="size-5 shrink-0 rounded-[5px] bg-muted" aria-hidden />
                        )}
                        <span className={cn("w-28 shrink-0 truncate", !a.deleted && "group-hover:underline")}>{a.deleted ? `${a.name} (deleted)` : a.name}</span>
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <span className="block h-full rounded-full bg-foreground/50" style={{ width: `${Math.max(2, (a.costUsd / maxAgent) * 100)}%` }} />
                        </span>
                        <span className="w-32 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                          <span className="text-foreground">{formatUsd(a.costUsd)}</span> · {a.runs} run{a.runs === 1 ? "" : "s"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {data.byAgent.length > 8 && <p className="mt-1.5 text-xs text-muted-foreground">and {data.byAgent.length - 8} more</p>}
            </div>
          )}
          <div>
            <h3 className="eyebrow mb-2 text-[10.5px]">By kind of work</h3>
            <ul className="space-y-1.5">
              {data.byKind.map((k) => (
                <li key={k.kind} className="flex items-center gap-2.5 text-[13px]" title={k.kind === "automation" ? "Includes condition checks" : undefined}>
                  <span className="w-36 shrink-0 truncate">{SPEND_KIND_LABELS[k.kind]}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <span className="block h-full rounded-full bg-foreground/50" style={{ width: `${Math.max(2, (k.costUsd / maxKind) * 100)}%` }} />
                  </span>
                  <span className="w-32 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    <span className="text-foreground">{formatUsd(k.costUsd)}</span> · {k.runs} run{k.runs === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {data && data.byAgent.length === 0 && !report.isLoading && <p className="text-[13px] text-muted-foreground">Nothing ran in this period.</p>}
    </section>
  );
}
