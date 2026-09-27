import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { format, isToday, isYesterday } from "date-fns";
import { Activity, RefreshCw, Search } from "lucide-react";
import type { Agent, Run, RunStatus, RunTrigger } from "@godmode/shared";
import { useAllAgents, useRuns } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { useLive, type LiveRun } from "@/stores/live";
import { cn } from "@/lib/utils";
import { AgentAvatar, EmptyState, PageBody, PageHeader } from "@/components/common";
import { Orb } from "@/components/aicss/Orb";
import { LiveDot, WorkingTicks } from "@/components/aicss/Motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RunRow, useNow } from "@/components/runs/run-row";
import { RunDetailSheet } from "@/components/runs/run-detail-sheet";
import { formatCost, formatElapsed } from "@/components/runs/run-status";

const STATUSES: { id: "all" | RunStatus; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "succeeded", label: "Succeeded" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
  { id: "queued", label: "Queued" },
];

const TRIGGERS: { id: "all" | RunTrigger; label: string }[] = [
  { id: "all", label: "Any trigger" },
  { id: "chat", label: "Chat" },
  { id: "routine", label: "Routine" },
  { id: "delegation", label: "Delegation" },
  { id: "manual", label: "Manual" },
  { id: "api", label: "API" },
];

function dayLabel(d: Date) {
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEEE, MMM d");
}

export default function ActivityPage() {
  const [params, setParams] = useSearchParams();
  const agentFilter = params.get("agent") ?? "all";
  const statusFilter = params.get("status") ?? "all";
  const selectedId = params.get("run");
  const [trigger, setTrigger] = useState<"all" | RunTrigger>("all");
  const [search, setSearch] = useState("");

  const runsQ = useRuns(agentFilter, statusFilter);
  const { data: agents = [] } = useAllAgents();
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const liveRuns = useLive((s) => s.runs);
  const liveList = useMemo(
    () => Object.values(liveRuns).filter((r) => agentFilter === "all" || r.agentId === agentFilter),
    [liveRuns, agentFilter],
  );

  const setParam = (key: string, value: string | null) => {
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value === null || value === "all") next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: key !== "run" },
    );
  };

  const runs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...(runsQ.data ?? [])]
      .filter((r) => (trigger === "all" || r.trigger === trigger) && (!q || `${r.prompt} ${r.result ?? ""} ${r.error ?? ""}`.toLowerCase().includes(q)))
      .sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
  }, [runsQ.data, trigger, search]);

  const groups = useMemo(() => {
    const out: { label: string; runs: Run[] }[] = [];
    for (const r of runs) {
      const label = dayLabel(new Date(r.startedAt ?? r.createdAt));
      const last = out[out.length - 1];
      if (last?.label === label) last.runs.push(r);
      else out.push({ label, runs: [r] });
    }
    return out;
  }, [runs]);

  const summary = useMemo(() => {
    const finished = runs.filter((r) => r.status === "succeeded" || r.status === "failed");
    const ok = finished.filter((r) => r.status === "succeeded").length;
    return {
      cost: runs.reduce((s, r) => s + (r.costUsd ?? 0), 0),
      rate: finished.length ? Math.round((ok / finished.length) * 100) : null,
    };
  }, [runs]);

  const selectedRun = runs.find((r) => r.id === selectedId) ?? null;
  const filtered = agentFilter !== "all" || statusFilter !== "all" || trigger !== "all" || !!search.trim();
  const agentsWithAvatar = [...agents].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader
        icon={<Activity />}
        title="Activity"
        description="Every run across your agents — live, scheduled and delegated."
        actions={
          <Button variant="outline" size="icon" onClick={() => runsQ.refetch()} aria-label="Refresh" disabled={runsQ.isFetching}>
            <RefreshCw className={cn(runsQ.isFetching && "animate-spin")} />
          </Button>
        }
      />
      <PageBody className="space-y-6">
        <AnimatePresence>
          {liveList.length > 0 && statusFilter !== "succeeded" && statusFilter !== "failed" && statusFilter !== "cancelled" && (
            <motion.section
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-visible"
              aria-label="Running now"
            >
              <h2 className="eyebrow mb-3 flex items-center gap-2">
                <LiveDot /> Live now
                <span className="rounded-[4px] border bg-card px-1 font-mono text-[10px] tabular-nums">{liveList.length}</span>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {liveList.map((r) => (
                  <LiveCard key={r.runId} live={r} agent={agentById.get(r.agentId)} onOpen={() => setParam("run", r.runId)} />
                ))}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search prompts & results…" aria-label="Search runs" className="pl-9" />
          </div>
          <Select value={agentFilter} onValueChange={(v) => setParam("agent", v)}>
            <SelectTrigger className="w-48" aria-label="Filter by agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="all">All agents</SelectItem>
              {agentsWithAvatar.length > 0 && <SelectSeparator />}
              {agentsWithAvatar.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <span>{a.avatar}</span> {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={trigger} onValueChange={(v) => setTrigger(v as "all" | RunTrigger)}>
            <SelectTrigger className="w-40" aria-label="Filter by trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {TRIGGERS.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div role="tablist" aria-label="Filter by status" className="-mt-2 flex flex-wrap gap-1.5">
          {STATUSES.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={statusFilter === s.id}
              onClick={() => setParam("status", s.id)}
              className={cn(
                "rounded-md border px-3 py-1 text-xs font-medium transition focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                statusFilter === s.id
                  ? "border-foreground/25 bg-card text-foreground shadow-card"
                  : "text-muted-foreground hover:border-foreground/15 hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
          {runs.length > 0 && (
            <span className="ml-auto self-center text-xs text-muted-foreground tabular-nums">
              {runs.length} run{runs.length === 1 ? "" : "s"} · {formatCost(summary.cost)}
              {summary.rate != null && ` · ${summary.rate}% success`}
            </span>
          )}
        </div>

        {runsQ.isLoading ? (
          <div className="space-y-1 rounded-xl border bg-card p-2 shadow-card">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2.5">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="size-6 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        ) : runsQ.isError ? (
          <EmptyState
            icon={<Activity />}
            title="Couldn't load activity"
            description={errorMessage(runsQ.error)}
            action={
              <Button variant="outline" onClick={() => runsQ.refetch()}>
                Try again
              </Button>
            }
          />
        ) : runs.length === 0 ? (
          <EmptyState
            icon={<Activity />}
            title={filtered ? "No runs match these filters" : "No activity yet"}
            description={filtered ? undefined : "When your agents chat, run routines or delegate work, every run shows up here — live."}
            action={
              filtered ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setParams({});
                    setTrigger("all");
                    setSearch("");
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-6">
            {groups.map((g) => (
              <section key={g.label}>
                <h2 className="eyebrow mb-2 px-1">{g.label}</h2>
                <div className="space-y-0.5 rounded-xl border bg-card p-1.5 shadow-card">
                  {g.runs.map((r, i) => (
                    <motion.div key={r.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i, 15) * 0.015 }}>
                      <RunRow run={r} agent={agentById.get(r.agentId)} selected={r.id === selectedId} onSelect={(run) => setParam("run", run.id)} />
                    </motion.div>
                  ))}
                </div>
              </section>
            ))}
            {(runsQ.data?.length ?? 0) >= 200 && (
              <p className="text-center text-xs text-muted-foreground">Showing the latest 200 runs. Narrow the filters to look further back.</p>
            )}
          </div>
        )}
      </PageBody>

      <RunDetailSheet runId={selectedId} run={selectedRun} onOpenChange={(o) => !o && setParam("run", null)} />
    </>
  );
}

function LiveCard({ live, agent, onOpen }: { live: LiveRun; agent?: Agent; onOpen: () => void }) {
  const now = useNow(true);
  return (
    <motion.button
      type="button"
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      onClick={onOpen}
      className="glow-border flex items-center gap-3 rounded-xl border bg-card p-3.5 text-left shadow-card transition hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {agent ? <AgentAvatar agent={agent} size="md" /> : <Orb variant="S3" size={24} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{agent?.name ?? "Agent"}</span>
          <Orb variant="S3" size={14} label="Running" />
        </div>
        <div className="text-shimmer truncate text-xs font-medium">{live.activity ?? "Thinking…"}</div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <WorkingTicks count={6} className="h-3 text-brand-strong" />
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{formatElapsed(now - live.startedAt)}</span>
      </div>
    </motion.button>
  );
}
