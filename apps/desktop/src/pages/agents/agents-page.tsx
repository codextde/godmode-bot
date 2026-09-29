import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { motion } from "motion/react";
import { Bot, Plus, Search, Sparkles } from "lucide-react";
import type { Agent } from "@godmode/shared";
import { useAgents, useRoutines, useWorkspaces } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { useLive } from "@/stores/live";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { EmptyState, Kbd, PageBody, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentCard } from "@/components/agents/agent-card";
import { DeleteAgentDialog, RunTaskDialog } from "@/components/agents/agent-actions";

type Filter = "all" | "running" | "scheduled" | "disabled";

const CREATE_PROMPT =
  "Create a new agent for me. Ask me what it should do, then configure sensible instructions and an automation if it should work on its own (on a schedule or when something happens).";

export default function AgentsPage() {
  const navigate = useNavigate();
  const scope = useUi((s) => s.workspace);
  const { data: workspaces = [] } = useWorkspaces();
  const agentsQ = useAgents();
  const { data: routines = [] } = useRoutines();
  const liveAgentIds = useLive((s) => Object.values(s.runs).map((r) => r.agentId).join(","));
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

  const counts = {
    all: agents.length,
    running: agents.filter(isRunning).length,
    scheduled: agents.filter((a) => (routineCounts.get(a.id) ?? 0) > 0).length,
    disabled: agents.filter((a) => !a.enabled).length,
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents
      .filter((a) => {
        if (filter === "running" && !isRunning(a)) return false;
        if (filter === "scheduled" && !(routineCounts.get(a.id) ?? 0)) return false;
        if (filter === "disabled" && a.enabled) return false;
        if (!q) return true;
        return `${a.name} ${a.description} ${a.instructions}`.toLowerCase().includes(q);
      })
      .sort(
        (a, b) =>
          Number(b.isDefault) - Number(a.isDefault) ||
          Number(isRunning(b)) - Number(isRunning(a)) ||
          Number(b.enabled) - Number(a.enabled) ||
          (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "") ||
          a.name.localeCompare(b.name),
      );
  }, [agents, search, filter, routineCounts, running]);

  const scopeName =
    scope === "all" ? "all workspaces" : scope === "global" ? "the global scope" : (workspaces.find((w) => w.id === scope)?.name ?? "this workspace");

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "running", label: "Working" },
    { id: "scheduled", label: "Automated" },
    { id: "disabled", label: "Disabled" },
  ];

  return (
    <>
      <PageHeader
        icon={<Bot />}
        title="Agents"
        description={`Your AI coworkers in ${scopeName}. Each has its own memory, automations and tools.`}
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
          <div className="relative w-full max-w-sm">
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
            icon={<Bot />}
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
        ) : (
          <motion.div layout className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {visible.map((agent, i) => (
              <motion.div
                key={agent.id}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i, 12) * 0.035, duration: 0.25 }}
              >
                <AgentCard
                  agent={agent}
                  routineCount={routineCounts.get(agent.id) ?? 0}
                  onRunTask={setRunTaskFor}
                  onDelete={setDeleteFor}
                />
              </motion.div>
            ))}
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
          </motion.div>
        )}
      </PageBody>

      <RunTaskDialog agent={runTaskFor} open={!!runTaskFor} onOpenChange={(o) => !o && setRunTaskFor(null)} />
      <DeleteAgentDialog agent={deleteFor} open={!!deleteFor} onOpenChange={(o) => !o && setDeleteFor(null)} />
    </>
  );
}
