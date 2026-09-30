import { useMemo, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { formatDistanceToNowStrict } from "date-fns";
import { CircleAlert, Clock, Plus, Search, Workflow, Zap } from "lucide-react";
import type { Routine, RoutineTriggerType } from "@godmode/shared";
import { useAgents, useAllAgents, useAutomationEvents, useFollowups, useRoutines } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AgentAvatar, EmptyState, PageBody, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RoutineDialog } from "@/components/agents/routine-dialog";
import { RoutineItem } from "@/components/agents/routine-item";
import { OnePromptCard } from "@/components/automations/one-prompt-card";
import { FollowupsSection } from "@/components/automations/followups-section";
import { TRIGGER_ORDER, TRIGGER_TYPES, triggerText } from "@/components/automations/trigger-meta";

type Filter = "all" | "active" | "paused" | "failing";
type TriggerFilter = "all" | RoutineTriggerType;

/** From this many automations on, the setup box shrinks to a slim bar so the list stays in view. */
const COMPACT_FROM = 3;

const isFailing = (r: Routine) => r.lastStatus === "failed" || r.triggerStatus.state === "error";

export default function AutomationsPage() {
  const routinesQ = useRoutines();
  const eventsQ = useAutomationEvents(20);
  const followupsQ = useFollowups();
  const agentsQ = useAgents();
  const scopedAgents = useMemo(() => agentsQ.data ?? [], [agentsQ.data]);
  const { data: allAgents = [] } = useAllAgents();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [dialog, setDialog] = useState<{ key: string; open: boolean; routine: Routine | null } | null>(null);

  const agentById = useMemo(() => new Map(allAgents.map((a) => [a.id, a])), [allAgents]);
  const inScope = useMemo(() => new Set(scopedAgents.map((a) => a.id)), [scopedAgents]);

  const scoped = useMemo(() => (routinesQ.data ?? []).filter((r) => inScope.has(r.agentId)), [routinesQ.data, inScope]);
  const followups = useMemo(() => (followupsQ.data ?? []).filter((f) => inScope.has(f.agentId)), [followupsQ.data, inScope]);
  const routineById = useMemo(() => new Map(scoped.map((r) => [r.id, r])), [scoped]);

  const counts: Record<Filter, number> = {
    all: scoped.length,
    active: scoped.filter((r) => r.enabled).length,
    paused: scoped.filter((r) => !r.enabled).length,
    failing: scoped.filter(isFailing).length,
  };
  const triggerCounts = useMemo(() => {
    const m = new Map<RoutineTriggerType, number>();
    for (const r of scoped) m.set(r.trigger.type, (m.get(r.trigger.type) ?? 0) + 1);
    return m;
  }, [scoped]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scoped
      .filter((r) => {
        if (filter === "active" && !r.enabled) return false;
        if (filter === "paused" && r.enabled) return false;
        if (filter === "failing" && !isFailing(r)) return false;
        if (triggerFilter !== "all" && r.trigger.type !== triggerFilter) return false;
        if (agentFilter !== "all" && r.agentId !== agentFilter) return false;
        if (!q) return true;
        const agent = agentById.get(r.agentId);
        return `${r.name} ${r.prompt} ${agent?.name ?? ""} ${triggerText(r)} ${r.filter}`.toLowerCase().includes(q);
      })
      .sort(
        (a, b) =>
          Number(b.enabled) - Number(a.enabled) ||
          (a.nextRunAt ?? "9999").localeCompare(b.nextRunAt ?? "9999") ||
          a.name.localeCompare(b.name),
      );
  }, [scoped, search, filter, triggerFilter, agentFilter, agentById]);

  const next = scoped
    .filter((r) => r.enabled && r.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""))[0];
  const nextAgent = next ? agentById.get(next.agentId) : undefined;
  const lastEvent = (eventsQ.data ?? []).find((e) => routineById.has(e.routineId));
  const lastEventRoutine = lastEvent ? routineById.get(lastEvent.routineId) : undefined;

  const agentsWithAutomations = scopedAgents.filter((a) => scoped.some((r) => r.agentId === a.id));
  const openNew = () => setDialog({ key: `new-${Date.now()}`, open: true, routine: null });
  const clearFilters = () => {
    setSearch("");
    setFilter("all");
    setTriggerFilter("all");
    setAgentFilter("all");
  };

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "paused", label: "Paused" },
    { id: "failing", label: "Failing" },
  ];

  return (
    <>
      <PageHeader
        icon={<Workflow />}
        title="Automations"
        description="Your agents get to work on a schedule, when something happens in your apps, when a condition is met, or when a webhook is called."
        actions={
          <Button onClick={openNew}>
            <Plus /> New automation
          </Button>
        }
      />
      <PageBody className="space-y-6">
        {/* Compact while loading: most visits come from people who already have automations. */}
        <OnePromptCard compact={routinesQ.isPending || agentsQ.isPending || scoped.length >= COMPACT_FROM} />

        {scoped.length > 0 && (
          <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
            <SummaryTile
              icon={<Zap />}
              label="Active"
              value={`${counts.active}`}
              hint={counts.paused ? `${counts.paused} paused` : "None paused"}
            />
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
              icon={<Workflow />}
              label="Last event"
              value={lastEvent ? formatDistanceToNowStrict(new Date(lastEvent.createdAt), { addSuffix: true }) : "—"}
              hint={lastEvent ? (lastEventRoutine?.name ?? lastEvent.title) : "No events yet"}
            />
            <SummaryTile
              icon={<CircleAlert />}
              label="Failing"
              value={`${counts.failing}`}
              hint={counts.failing ? "A run or trigger failed — have a look" : "No failures"}
              tone={counts.failing ? "error" : undefined}
              onClick={counts.failing ? () => setFilter("failing") : undefined}
            />
          </div>
        )}

        <FollowupsSection followups={followups} agentById={agentById} />

        {scoped.length > 0 && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative w-full max-w-xs">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search automations…" aria-label="Search automations" className="pl-9" />
              </div>
              <div role="tablist" aria-label="Filter by status" className="flex items-center gap-1 rounded-lg border bg-paper-2 p-1">
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
                    {filter === f.id && <motion.span layoutId="automations-filter" className="absolute inset-0 rounded-md border bg-card shadow-card" transition={{ type: "spring", bounce: 0.2, duration: 0.4 }} />}
                    <span className="relative flex items-center gap-1.5">
                      {f.label}
                      {counts[f.id] > 0 && <span className="text-xs text-muted-foreground tabular-nums">{counts[f.id]}</span>}
                    </span>
                  </button>
                ))}
              </div>
              {agentsWithAutomations.length > 1 && (
                <Select value={agentFilter} onValueChange={setAgentFilter}>
                  <SelectTrigger className="w-48" aria-label="Filter by agent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="all">All agents</SelectItem>
                    <SelectSeparator />
                    {agentsWithAutomations.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <AgentAvatar agent={a} size="sm" still className="size-4" /> {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div role="tablist" aria-label="Filter by trigger" className="flex flex-wrap gap-1.5">
              <TriggerChip active={triggerFilter === "all"} onClick={() => setTriggerFilter("all")} label="All triggers" />
              {TRIGGER_ORDER.map((type) => {
                const meta = TRIGGER_TYPES[type];
                return (
                  <TriggerChip
                    key={type}
                    active={triggerFilter === type}
                    onClick={() => setTriggerFilter(type)}
                    icon={<meta.icon />}
                    label={meta.plural}
                    count={triggerCounts.get(type) ?? 0}
                  />
                );
              })}
            </div>
          </div>
        )}

        {routinesQ.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ) : routinesQ.isError ? (
          <EmptyState
            icon={<Workflow />}
            title="Couldn't load automations"
            description={errorMessage(routinesQ.error)}
            action={
              <Button variant="outline" onClick={() => routinesQ.refetch()}>
                Try again
              </Button>
            }
          />
        ) : scoped.length === 0 ? (
          <EmptyState
            icon={<Workflow />}
            title="No automations yet"
            description="Describe one above, or set it up yourself — a morning inbox summary, a reply draft for every customer email, a watch on competitor pricing."
            action={
              <Button variant="outline" onClick={openNew}>
                <Plus /> New automation
              </Button>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Search />}
            title="No automations match"
            action={
              <Button variant="outline" onClick={clearFilters}>
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
          initial={{
            ...(agentFilter !== "all" ? { agentId: agentFilter } : {}),
            ...(triggerFilter !== "all" ? { triggerType: triggerFilter } : {}),
          }}
        />
      )}
    </>
  );
}

function TriggerChip({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon?: ReactNode; label: string; count?: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5",
        active ? "border-foreground/25 bg-card text-foreground shadow-card" : "text-muted-foreground hover:border-foreground/15 hover:text-foreground",
      )}
    >
      {icon}
      {label}
      {count !== undefined && count > 0 && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
    </button>
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
