import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
import { CalendarClock, CircleAlert, Clock, Plus, Search, Sparkles, Zap } from "lucide-react";
import type { Routine } from "@godmode/shared";
import { useAgents, useAllAgents, useRoutines } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AgentAvatar, EmptyState, PageBody, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RoutineDialog } from "@/components/agents/routine-dialog";
import { RoutineItem } from "@/components/agents/routine-item";
import { cronToHuman } from "@/components/agents/cron";

type Filter = "all" | "active" | "paused" | "failing";

const ASK_PROMPT = "Help me set up a new routine. Ask me what should happen and how often, then create it for the right agent.";

export default function RoutinesPage() {
  const navigate = useNavigate();
  const routinesQ = useRoutines();
  const { data: scopedAgents = [] } = useAgents();
  const { data: allAgents = [] } = useAllAgents();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [dialog, setDialog] = useState<{ key: string; open: boolean; routine: Routine | null } | null>(null);

  const agentById = useMemo(() => new Map(allAgents.map((a) => [a.id, a])), [allAgents]);
  const inScope = useMemo(() => new Set(scopedAgents.map((a) => a.id)), [scopedAgents]);

  const scoped = useMemo(() => (routinesQ.data ?? []).filter((r) => inScope.has(r.agentId)), [routinesQ.data, inScope]);

  const counts: Record<Filter, number> = {
    all: scoped.length,
    active: scoped.filter((r) => r.enabled).length,
    paused: scoped.filter((r) => !r.enabled).length,
    failing: scoped.filter((r) => r.lastStatus === "failed").length,
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scoped
      .filter((r) => {
        if (filter === "active" && !r.enabled) return false;
        if (filter === "paused" && r.enabled) return false;
        if (filter === "failing" && r.lastStatus !== "failed") return false;
        if (agentFilter !== "all" && r.agentId !== agentFilter) return false;
        if (!q) return true;
        const agent = agentById.get(r.agentId);
        return `${r.name} ${r.prompt} ${agent?.name ?? ""} ${cronToHuman(r.cron)}`.toLowerCase().includes(q);
      })
      .sort(
        (a, b) =>
          Number(b.enabled) - Number(a.enabled) ||
          (a.nextRunAt ?? "9999").localeCompare(b.nextRunAt ?? "9999") ||
          a.name.localeCompare(b.name),
      );
  }, [scoped, search, filter, agentFilter, agentById]);

  const next = scoped
    .filter((r) => r.enabled && r.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""))[0];
  const nextAgent = next ? agentById.get(next.agentId) : undefined;

  const agentsWithRoutines = scopedAgents.filter((a) => scoped.some((r) => r.agentId === a.id));

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "paused", label: "Paused" },
    { id: "failing", label: "Failing" },
  ];

  return (
    <>
      <PageHeader
        icon={<CalendarClock />}
        title="Routines"
        description="Everything your agents do on a schedule — even while you're away."
        actions={
          <Button onClick={() => setDialog({ key: `new-${Date.now()}`, open: true, routine: null })}>
            <Plus /> New routine
          </Button>
        }
      />
      <PageBody className="space-y-6">
        {scoped.length > 0 && (
          <div className="grid gap-3 md:grid-cols-3">
            <SummaryTile icon={<Zap />} label="Active routines" value={`${counts.active}`} hint={counts.paused ? `${counts.paused} paused` : "All running on schedule"} />
            <SummaryTile
              icon={<Clock />}
              label="Next up"
              value={next?.nextRunAt ? formatDistanceToNowStrict(new Date(next.nextRunAt), { addSuffix: true }) : "—"}
              hint={
                next ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    {nextAgent && <AgentAvatar agent={nextAgent} size="sm" className="size-4 text-[10px]" />}
                    <span className="truncate">{next.name}</span>
                  </span>
                ) : (
                  "Nothing scheduled"
                )
              }
            />
            <SummaryTile
              icon={<CircleAlert />}
              label="Failing"
              value={`${counts.failing}`}
              hint={counts.failing ? "Last run failed — check Activity" : "No failures"}
              tone={counts.failing ? "error" : undefined}
              onClick={counts.failing ? () => setFilter("failing") : undefined}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search routines…" aria-label="Search routines" className="pl-9" />
          </div>
          <div role="tablist" aria-label="Filter routines" className="flex items-center gap-1 rounded-lg border bg-paper-2 p-1">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={cn(
                  "relative rounded-md px-3 py-1 text-sm transition focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  filter === f.id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {filter === f.id && <motion.span layoutId="routines-filter" className="absolute inset-0 rounded-md border bg-card shadow-card" transition={{ type: "spring", bounce: 0.2, duration: 0.4 }} />}
                <span className="relative flex items-center gap-1.5">
                  {f.label}
                  {counts[f.id] > 0 && <span className="text-xs text-muted-foreground tabular-nums">{counts[f.id]}</span>}
                </span>
              </button>
            ))}
          </div>
          {agentsWithRoutines.length > 1 && (
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="w-48" aria-label="Filter by agent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="all">All agents</SelectItem>
                <SelectSeparator />
                {agentsWithRoutines.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span>{a.avatar}</span> {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {routinesQ.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : routinesQ.isError ? (
          <EmptyState
            icon={<CalendarClock />}
            title="Couldn't load routines"
            description={errorMessage(routinesQ.error)}
            action={
              <Button variant="outline" onClick={() => routinesQ.refetch()}>
                Try again
              </Button>
            }
          />
        ) : scoped.length === 0 ? (
          <EmptyState
            icon={<CalendarClock />}
            title="No routines yet"
            description="Routines run an agent on a schedule — like downloading invoices on the 1st or a morning inbox summary."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => setDialog({ key: `new-${Date.now()}`, open: true, routine: null })}>
                  <Plus /> New routine
                </Button>
                <Button variant="outline" onClick={() => navigate(`/?prompt=${encodeURIComponent(ASK_PROMPT)}`)}>
                  <Sparkles /> Ask Godmode to set one up
                </Button>
              </div>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Search />}
            title="No routines match"
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setFilter("all");
                  setAgentFilter("all");
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {visible.map((r, i) => (
              <motion.div key={r.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.03 }}>
                <RoutineItem routine={r} agent={agentById.get(r.agentId)} onEdit={(routine) => setDialog({ key: `${routine.id}-${Date.now()}`, open: true, routine })} />
              </motion.div>
            ))}
          </div>
        )}
      </PageBody>

      {dialog && (
        <RoutineDialog
          key={dialog.key}
          open={dialog.open}
          onOpenChange={(o) => !o && setDialog((d) => d && { ...d, open: false })}
          routine={dialog.routine}
          initial={agentFilter !== "all" ? { agentId: agentFilter } : undefined}
        />
      )}
    </>
  );
}

function SummaryTile({
  icon,
  label,
  value,
  hint,
  tone,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: "error";
  onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "min-w-0 rounded-xl border bg-card p-4 text-left shadow-card",
        onClick && "transition hover:border-foreground/15 hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
      )}
    >
      <div className={cn("eyebrow flex items-center gap-2 [&_svg]:size-3.5", tone === "error" && "text-destructive!")}>
        {icon}
        {label}
      </div>
      <div className={cn("mt-1.5 text-xl font-medium tracking-[-0.02em] tabular-nums", tone === "error" && "text-destructive")}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div>}
    </Comp>
  );
}
