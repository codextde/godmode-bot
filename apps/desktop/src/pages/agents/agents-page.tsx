import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { motion } from "motion/react";
import { Bot, LayoutGrid, List, Network, Plus, Search, Sparkles } from "lucide-react";
import type { Agent } from "@godmode/shared";
import { MASCOT_CHARACTER, MASCOT_COLOR } from "@godmode/shared";
import { useAgents, useAllAgents, useMissingLogins, useRoutines, useWorkspaces } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { useLive } from "@/stores/live";
import { useUi, type AgentsView } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { AgentAvatar, EmptyState, Kbd, PageBody, PageHeader } from "@/components/common";
import { Character } from "@/components/character";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentCard } from "@/components/agents/agent-card";
import { DeleteAgentDialog, RunTaskDialog } from "@/components/agents/agent-actions";
import { OrgChart } from "@/components/agents/org-chart";
import { AgentList } from "@/components/agents/agent-list";
import { groupByWorkspace, WorkspaceSection } from "@/components/agents/agent-groups";
import { TeamTemplates } from "@/components/agents/team-templates";

type Filter = "all" | "running" | "needs" | "scheduled" | "disabled";

const CREATE_PROMPT =
  "Create a new agent for me. Ask me what it should do, then configure sensible instructions and an automation if it should work on its own (on a schedule or when something happens).";

export default function AgentsPage() {
  const navigate = useNavigate();
  const scope = useUi((s) => s.workspace);
  const { data: workspaces = [] } = useWorkspaces();
  const agentsQ = useAgents();
  const { data: allAgents = [] } = useAllAgents();
  const { data: missing = [] } = useMissingLogins("open");
  const [params, setParams] = useSearchParams();
  const storedView = useUi((s) => s.agentsView);
  const setStoredView = useUi((s) => s.setAgentsView);
  const asked = params.get("view");
  const view: AgentsView = asked === "chart" || asked === "grid" || asked === "list" ? asked : storedView;
  const setView = (v: AgentsView) => {
    setStoredView(v);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("view");
      return next;
    }, { replace: true });
  };
  const { data: routines = [] } = useRoutines();
  const liveAgentIds = useLive((s) => Object.values(s.runs).flatMap((r) => (r.status === "running" ? [r.agentId] : [])).join(","));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [runTaskFor, setRunTaskFor] = useState<Agent | null>(null);
  const [deleteFor, setDeleteFor] = useState<Agent | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && t?.tagName !== "INPUT" && t?.tagName !== "TEXTAREA" && !t?.isContentEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const routineCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of routines) m.set(r.agentId, (m.get(r.agentId) ?? 0) + 1);
    return m;
  }, [routines]);

  const agents = agentsQ.data ?? [];
  const running = useMemo(() => new Set(liveAgentIds.split(",").filter(Boolean)), [liveAgentIds]);
  const isRunning = (a: Agent) => running.has(a.id) || a.status === "running";
  const missingFor = useMemo(() => new Set(missing.map((m) => m.agentId)), [missing]);
  const needsYou = (a: Agent) => a.enabled && ((a.openQuestions ?? 0) > 0 || !!a.failedRunId || missingFor.has(a.id));

  const counts = {
    all: agents.length,
    running: agents.filter(isRunning).length,
    needs: agents.filter(needsYou).length,
    scheduled: agents.filter((a) => (routineCounts.get(a.id) ?? 0) > 0).length,
    disabled: agents.filter((a) => !a.enabled).length,
  };

  const passesFilter = (a: Agent) =>
    filter === "running" ? isRunning(a) : filter === "needs" ? needsYou(a) : filter === "scheduled" ? (routineCounts.get(a.id) ?? 0) > 0 : filter === "disabled" ? !a.enabled : true;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents
      .filter((a) => {
        if (!passesFilter(a)) return false;
        if (!q) return true;
        return `${a.name} ${a.role} ${a.description} ${a.instructions}`.toLowerCase().includes(q);
      })
      .sort(
        (a, b) =>
          Number(b.isDefault) - Number(a.isDefault) ||
          Number(isRunning(b)) - Number(isRunning(a)) ||
          Number(b.enabled) - Number(a.enabled) ||
          (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "") ||
          a.name.localeCompare(b.name),
      );
  }, [agents, search, filter, routineCounts, running, missingFor]);

  // The chart keeps everyone of the filter in place and dims what the search doesn't match.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const chartAgents = useMemo(() => agents.filter(passesFilter), [agents, filter, routineCounts, running, missingFor]);
  const matches = useMemo(() => (search.trim() ? new Set(visible.map((a) => a.id)) : null), [visible, search]);

  const stats = (list: Agent[]) => ({ working: list.filter(isRunning).length, needsYou: list.filter(needsYou).length });
  // In "All workspaces" every view sorts agents under their workspace.
  const byWorkspace = scope === "all" && agents.some((a) => a.workspaceId);
  const narrowed = !!search.trim() || filter !== "all";
  const groups = useMemo(() => (byWorkspace ? groupByWorkspace(visible, workspaces) : []), [byWorkspace, visible, workspaces]);

  const scopeName =
    scope === "all" ? "all workspaces" : scope === "global" ? "the global scope" : (workspaces.find((w) => w.id === scope)?.name ?? "this workspace");

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "running", label: "Working" },
    { id: "needs", label: "Needs you" },
    { id: "scheduled", label: "Automated" },
    { id: "disabled", label: "Off" },
  ];

  return (
    <>
      <PageHeader
        icon={<Bot />}
        title="Agents"
        description={`Your team in ${scopeName}: who does what, who leads whom and what each is busy with.`}
        actions={
          <>
            <Button variant="outline" onClick={() => navigate(`/?prompt=${encodeURIComponent(CREATE_PROMPT)}`)} className="hidden @md:inline-flex">
              <Sparkles /> Ask Godmode
            </Button>
            <Button asChild>
              <Link to="/agents/new">
                <Plus /> New agent
              </Link>
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-sm min-w-48 @3xl:w-auto @3xl:flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setSearch("")}
              placeholder="Search agents…"
              aria-label="Search agents"
              className="pr-10 pl-9"
            />
            <span className="absolute top-1/2 right-2.5 -translate-y-1/2">
              <Kbd>/</Kbd>
            </span>
          </div>
          <div role="tablist" aria-label="Filter agents" className="flex items-center gap-1 rounded-lg border bg-paper-2 p-1">
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
                {filter === f.id && (
                  <motion.span layoutId="agents-filter" className="absolute inset-0 rounded-md border bg-card shadow-card" transition={{ type: "spring", bounce: 0.2, duration: 0.4 }} />
                )}
                <span className="relative flex items-center gap-1.5">
                  {f.label}
                  {counts[f.id] > 0 && <span className="text-xs text-muted-foreground tabular-nums">{counts[f.id]}</span>}
                </span>
              </button>
            ))}
          </div>
          {agents.length > 1 && view === "grid" && <Crew agents={agents} />}
          <div role="group" aria-label="View" className={cn("flex items-center gap-1 rounded-lg border bg-paper-2 p-1", !(agents.length > 1 && view === "grid") && "ml-auto", "@max-3xl:ml-auto")}>
            {(
              [
                { id: "grid", label: "Grid", icon: LayoutGrid },
                { id: "list", label: "List", icon: List },
                { id: "chart", label: "Org chart", icon: Network },
              ] as const
            ).map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={view === v.id}
                aria-label={v.label}
                title={v.label}
                onClick={() => setView(v.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm @7xl:px-2.5 @7xl:py-1 transition focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5",
                  view === v.id ? "border bg-card text-foreground shadow-card" : "border border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <v.icon aria-hidden /> <span className="hidden @7xl:inline">{v.label}</span>
              </button>
            ))}
          </div>
        </div>

        {agentsQ.isLoading ? (
          <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="rounded-xl border bg-card p-4 shadow-card">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-12 rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
                <Skeleton className="mt-4 h-10 w-full" />
                <Skeleton className="mt-4 h-8 w-full" />
              </div>
            ))}
          </div>
        ) : agentsQ.isError ? (
          <EmptyState
            icon={<Bot />}
            title="Couldn't load agents"
            description={errorMessage(agentsQ.error)}
            action={
              <Button variant="outline" onClick={() => agentsQ.refetch()}>
                Try again
              </Button>
            }
          />
        ) : agents.length === 0 ? (
          <EmptyState
            art={<Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={88} follow title="Godmode" />}
            title="Create your first agent"
            description="Agents are coworkers with their own instructions, memory and schedule — e.g. one that downloads your invoices every month."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild>
                  <Link to="/agents/new">
                    <Plus /> New agent
                  </Link>
                </Button>
                <Button variant="outline" onClick={() => navigate(`/?prompt=${encodeURIComponent(CREATE_PROMPT)}`)}>
                  <Sparkles /> Ask Godmode to create one
                </Button>
              </div>
            }
          />
        ) : view === "chart" && chartAgents.length > 0 ? (
          <>
            {matches && matches.size === 0 && (
              <p className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
                No agents match “{search.trim()}”.
                <Button size="xs" variant="ghost" onClick={() => setSearch("")}>
                  Clear
                </Button>
              </p>
            )}
            <OrgChart shown={chartAgents} all={allAgents.length ? allAgents : agents} byWorkspace={byWorkspace} matches={matches} stats={stats} forceOpen={narrowed} />
          </>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Search />}
            title="No agents match"
            description={search ? `Nothing found for “${search}”.` : "No agents in this view."}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setSearch("");
                  setFilter("all");
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : view === "list" ? (
          byWorkspace ? (
            <div className="space-y-6">
              {groups.map((g) => {
                const st = stats(g.agents);
                return (
                  <WorkspaceSection key={g.key} group={g} working={st.working} needsYou={st.needsYou} forceOpen={narrowed}>
                    <AgentList agents={g.agents} all={allAgents.length ? allAgents : agents} routineCounts={routineCounts} onRunTask={setRunTaskFor} onDelete={setDeleteFor} />
                  </WorkspaceSection>
                );
              })}
            </div>
          ) : (
            <AgentList agents={visible} all={allAgents.length ? allAgents : agents} routineCounts={routineCounts} onRunTask={setRunTaskFor} onDelete={setDeleteFor} />
          )
        ) : byWorkspace ? (
          <div className="space-y-8">
            {groups.map((g) => {
              const st = stats(g.agents);
              return (
                <WorkspaceSection key={g.key} group={g} working={st.working} needsYou={st.needsYou} forceOpen={narrowed}>
                  <CardGrid agents={g.agents} routineCounts={routineCounts} grouped onRunTask={setRunTaskFor} onDelete={setDeleteFor} />
                </WorkspaceSection>
              );
            })}
          </div>
        ) : (
          <CardGrid agents={visible} routineCounts={routineCounts} onRunTask={setRunTaskFor} onDelete={setDeleteFor} />
        )}
        {/* Just the built-in agent so far: offer a whole team to start with. */}
        {!agentsQ.isLoading && allAgents.length > 0 && allAgents.every((a) => a.isDefault) && (
          <section className="mt-10" aria-labelledby="start-team">
            <h2 id="start-team" className="text-lg font-medium tracking-[-0.02em]">
              Start a team
            </h2>
            <p className="mb-4 text-sm text-muted-foreground">A lead and its reports in one go — the lead hands out the work, reviews it and tells you what needs you.</p>
            <TeamTemplates />
          </section>
        )}
      </PageBody>

      <RunTaskDialog agent={runTaskFor} open={!!runTaskFor} onOpenChange={(o) => !o && setRunTaskFor(null)} />
      <DeleteAgentDialog agent={deleteFor} open={!!deleteFor} onOpenChange={(o) => !o && setDeleteFor(null)} />
    </>
  );
}

function CardGrid({
  agents,
  routineCounts,
  grouped,
  onRunTask,
  onDelete,
}: {
  agents: Agent[];
  routineCounts: Map<string, number>;
  /** Under a workspace heading: the card doesn't repeat the workspace, and "New agent" sits in the page header. */
  grouped?: boolean;
  onRunTask: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
}) {
  return (
    <motion.div layout className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3 @[96rem]:grid-cols-4">
      {agents.map((agent, i) => (
        <motion.div key={agent.id} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.035, duration: 0.25 }}>
          <AgentCard agent={agent} routineCount={routineCounts.get(agent.id) ?? 0} showScope={!grouped} onRunTask={onRunTask} onDelete={onDelete} />
        </motion.div>
      ))}
      {!grouped && (
        <motion.div layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
          <Link
            to="/agents/new"
            className="flex h-full min-h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground transition hover:border-foreground/25 hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span className="grid size-9 place-items-center rounded-lg border bg-card text-foreground shadow-card">
              <Plus className="size-4" />
            </span>
            New agent
          </Link>
        </motion.div>
      )}
    </motion.div>
  );
}

/** The team at a glance: every agent's face in a row, watching the pointer. */
function Crew({ agents }: { agents: Agent[] }) {
  const shown = agents.slice(0, 8);
  return (
    <div aria-label="Your crew" className="ml-auto hidden items-end @7xl:flex">
      {shown.map((a, i) => (
        <Tooltip key={a.id}>
          <TooltipTrigger asChild>
            <Link
              to={`/agents/${a.id}`}
              aria-label={a.name}
              className={cn(
                "rounded-full transition-transform duration-200 hover:z-10 hover:-translate-y-1 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                i > 0 && "-ml-1.5",
              )}
            >
              <AgentAvatar agent={a} size="md" follow />
            </Link>
          </TooltipTrigger>
          <TooltipContent>{[a.name, a.role].filter(Boolean).join(" · ")}</TooltipContent>
        </Tooltip>
      ))}
      {agents.length > shown.length && (
        <span className="ml-1.5 self-center rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground tabular-nums">+{agents.length - shown.length}</span>
      )}
    </div>
  );
}
