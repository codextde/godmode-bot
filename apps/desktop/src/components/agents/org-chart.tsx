import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Plus, Users } from "lucide-react";
import type { Agent, TeamNode } from "@godmode/shared";
import { leadOf, presenceLabel, teamTree } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { useWorkspaces } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { AgentStatus, useAgentMood, useAgentPresence } from "./agent-actions";
import { WorkspaceSection, type AgentGroup } from "./agent-groups";

interface Panel {
  group: AgentGroup;
  roots: TeamNode<Agent>[];
  /** Title and face for a team panel (one workspace, split by lead). */
  lead?: Agent;
}

/**
 * The team as a chart: the built-in agent on top, then a panel per workspace (or, inside one workspace, per team) with
 * everyone under their lead. Nested lists, so the hierarchy reads the same to a screen reader and every control on a
 * node is a normal tab stop. Agents that don't match the search stay in place, dimmed, so the shape doesn't jump.
 */
export function OrgChart({
  shown,
  all,
  byWorkspace,
  matches,
  stats,
  forceOpen,
}: {
  /** The agents of the current scope and filter. */
  shown: Agent[];
  /** Every agent, to name leads that aren't shown. */
  all: Agent[];
  byWorkspace: boolean;
  /** Search hits; null = no search. */
  matches: Set<string> | null;
  stats: (agents: Agent[]) => { working: number; needsYou: number };
  forceOpen?: boolean;
}) {
  const { data: workspaces = [] } = useWorkspaces();
  const groups = teamTree(shown, all, { byWorkspace });
  let hub: TeamNode<Agent> | null = null;
  for (const g of groups) {
    const i = g.roots.findIndex((n) => n.agent.isDefault);
    if (i < 0) continue;
    hub = g.roots[i]!;
    g.roots = [...hub.reports, ...g.roots.filter((_, j) => j !== i)];
  }

  const order = new Map(workspaces.map((w, i) => [w.id, i]));
  const panels: Panel[] = [];
  if (byWorkspace) {
    for (const g of groups) {
      if (!g.roots.length) continue;
      const key = g.workspaceId ?? "global";
      panels.push({ group: { key, workspace: workspaces.find((w) => w.id === g.workspaceId) ?? null, agents: g.roots.flatMap(flatten) }, roots: g.roots });
    }
    panels.sort((a, b) => rank(a, order) - rank(b, order));
  } else {
    const roots = groups.flatMap((g) => g.roots);
    const direct = new Set(hub?.reports.map((n) => n.agent.id));
    const loose = roots.filter((n) => !n.reports.length && direct.has(n.agent.id));
    // Their lead is filtered out, or they lead each other in a loop.
    const others = roots.filter((n) => !n.reports.length && !direct.has(n.agent.id));
    const teams = roots.filter((n) => n.reports.length);
    if (loose.length) panels.push({ group: { key: "org:direct", workspace: null, agents: loose.map((n) => n.agent) }, roots: loose });
    if (others.length) panels.push({ group: { key: "org:others", workspace: null, agents: others.map((n) => n.agent) }, roots: others });
    for (const t of teams) panels.push({ group: { key: `org:team:${t.agent.id}`, workspace: null, agents: flatten(t) }, roots: [t], lead: t.agent });
  }

  const onlyBuiltin = all.length === 1 && all[0]!.isDefault;
  const [ref, width] = useWidth<HTMLDivElement>();
  const columns = balance(panels, Math.min(panels.length, width >= 1100 ? 3 : width >= 720 ? 2 : 1));
  return (
    <div ref={ref} className="space-y-5">
      {hub && <Hub agent={hub.agent} dim={!!matches && !matches.has(hub.agent.id)} reports={shown.filter((a) => leadOf(a, all)?.id === hub!.agent.id)} />}
      {panels.length > 0 && (
        <div className={cn("grid items-start gap-4", columns.length === 1 && "max-w-2xl")} style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
          {columns.map((col, c) => (
            <div key={c} className="flex min-w-0 flex-col gap-4">
              {col.map((p) => {
                const s = stats(p.group.agents);
                return (
                  <WorkspaceSection
                    key={p.group.key}
                    group={p.group}
                    working={s.working}
                    needsYou={s.needsYou}
                    panel
                    forceOpen={forceOpen}
                    label={p.lead ? `${p.lead.name}’s team` : byWorkspace ? undefined : p.group.key === "org:direct" && hub ? `Reports to ${hub.agent.name}` : hub ? "Other agents" : "Agents"}
                    icon={p.lead ? <AgentAvatar agent={p.lead} size="sm" still /> : byWorkspace ? undefined : p.group.key === "org:direct" && hub ? <AgentAvatar agent={hub.agent} size="sm" still /> : <Users className="size-4 text-muted-foreground" aria-hidden />}
                  >
                    <ul className="space-y-0.5 p-1.5">
                      {p.roots.map((n) => (
                        <Branch key={n.agent.id} node={n} depth={0} all={all} matches={matches} />
                      ))}
                    </ul>
                  </WorkspaceSection>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {onlyBuiltin && (
        <Link
          to="/agents/new"
          className="flex max-w-sm items-center gap-3 rounded-xl border border-dashed p-3 text-sm text-muted-foreground transition hover:border-foreground/25 hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="grid size-9 place-items-center rounded-lg border bg-card text-foreground shadow-card">
            <Plus className="size-4" />
          </span>
          <span>
            <span className="block font-medium text-foreground">Hire your first agent</span>
            It reports to {all[0]!.name} until you give it another lead.
          </span>
        </Link>
      )}
      <p className="text-xs text-muted-foreground">Change who an agent reports to in its settings, under Team.</p>
    </div>
  );
}

/** Panels into columns, each to the shortest so far, in order. Folding a panel doesn't move the others. */
function balance(panels: Panel[], n: number): Panel[][] {
  const cols: Panel[][] = Array.from({ length: Math.max(1, n) }, () => []);
  const heights = cols.map(() => 0);
  for (const p of panels) {
    const i = heights.indexOf(Math.min(...heights));
    cols[i]!.push(p);
    heights[i]! += 1.5 + p.group.agents.length;
  }
  return cols.filter((c) => c.length);
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function flatten(n: TeamNode<Agent>): Agent[] {
  return [n.agent, ...n.reports.flatMap(flatten)];
}

function rank(p: Panel, order: Map<string, number>) {
  return p.group.key === "global" ? -1 : (order.get(p.group.key) ?? Number.MAX_SAFE_INTEGER);
}

/** The built-in agent: everyone without a lead of their own reports to it. */
function Hub({ agent, dim, reports }: { agent: Agent; dim: boolean; reports: Agent[] }) {
  const mood = useAgentMood(agent);
  const presence = useAgentPresence(agent);
  const direct = reports.length;
  const global = reports.some((a) => !a.workspaceId);
  const workspaces = new Set(reports.flatMap((a) => (a.workspaceId ? [a.workspaceId] : []))).size;
  const where = [global && "Global", workspaces > 0 && `${workspaces} workspace${workspaces === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
  const label = `${agent.name}, ${agent.role || "no role yet"}, ${presenceLabel(presence)}, reports to you`;
  return (
    <div className="flex flex-col items-start gap-3 @2xl:flex-row @2xl:items-center">
      <div
        className={cn(
          "group relative flex w-full max-w-sm items-center gap-3 rounded-xl border bg-card p-3 pr-4 shadow-card transition-[box-shadow,border-color,opacity] hover:border-foreground/15 hover:shadow-float",
          presence.state === "working" && "glow-border",
          dim && "opacity-40",
        )}
      >
        <AgentAvatar agent={agent} size="lg" mood={mood} still={dim} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Link
              to={`/agents/${agent.id}`}
              aria-label={label}
              className="truncate text-[15px] font-medium tracking-[-0.01em] after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
            >
              {agent.name}
            </Link>
            <span className="shrink-0 rounded-[5px] border bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground">Built-in</span>
          </div>
          {agent.role && <p className="truncate text-xs text-muted-foreground">{agent.role}</p>}
          <AgentStatus agent={agent} interactive className="mt-0.5 max-w-full" />
        </div>
      </div>
      {direct > 0 && (
        <p className="text-sm text-muted-foreground">
          Leads <span className="font-medium text-foreground tabular-nums">{direct}</span> agent{direct === 1 ? "" : "s"} directly
          {(workspaces > 1 || (global && workspaces > 0)) && <>, across {where}</>}
          . Everyone without a lead of their own reports here.
        </p>
      )}
    </div>
  );
}

function Branch({ node, depth, all, matches, last }: { node: TeamNode<Agent>; depth: number; all: Agent[]; matches: Set<string> | null; last?: boolean }) {
  return (
    <li className="relative">
      {depth > 0 && (
        <>
          {/* Elbow into the row, and the line on to the next sibling. */}
          <span aria-hidden className="absolute top-0 -left-3 h-[1.375rem] w-3 rounded-bl-md border-b border-l border-border" />
          {!last && <span aria-hidden className="absolute top-0 -bottom-0.5 -left-3 w-px bg-border" />}
        </>
      )}
      <Row node={node} all={all} dim={!!matches && !matches.has(node.agent.id)} />
      {node.reports.length > 0 && (
        <ul className="relative ml-[1.375rem] space-y-0.5 pl-3">
          {node.reports.map((r, i) => (
            <Branch key={r.agent.id} node={r} depth={depth + 1} all={all} matches={matches} last={i === node.reports.length - 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Row({ node, all, dim }: { node: TeamNode<Agent>; all: Agent[]; dim: boolean }) {
  const agent = node.agent;
  const mood = useAgentMood(agent);
  const presence = useAgentPresence(agent);
  const lead = leadOf(agent, all);
  const label = `${agent.name}, ${agent.role || "no role yet"}, ${presenceLabel(presence)}, reports to ${lead?.name ?? "Godmode"}`;
  const team = node.reports.length;
  return (
    <div
      className={cn(
        "group relative flex items-start gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-foreground/[0.035]",
        presence.state === "working" && "bg-brand/[0.05]",
        !agent.enabled && "[&>:not([data-line])]:opacity-60",
        dim && "[&>:not([data-line])]:opacity-35",
        "[&>*]:transition-opacity",
      )}
    >
      {team > 0 && <span aria-hidden data-line className="absolute top-[2.375rem] -bottom-px left-[1.375rem] w-px bg-border" />}
      <AgentAvatar agent={agent} size="md" mood={mood} still={dim} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <Link
            to={`/agents/${agent.id}`}
            aria-label={label}
            title={agent.name}
            className="truncate text-sm font-medium tracking-[-0.01em] after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring/50"
          >
            {agent.name}
          </Link>
          {team > 0 && (
            <span className="shrink-0 rounded-[5px] bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground tabular-nums" title={`Leads ${team}`}>
              Lead · {team}
            </span>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground" title={agent.role || undefined}>
          {agent.role || <span className="italic opacity-70">No role yet</span>}
        </p>
        {node.leadElsewhere && (
          <Link
            to={`/agents/${node.leadElsewhere.id}`}
            className="relative z-10 mt-1 inline-flex max-w-full items-center gap-1 rounded-[5px] border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:border-foreground/25 hover:text-foreground"
          >
            Reports to <AgentAvatar agent={node.leadElsewhere} size="sm" still className="size-3.5 rounded-[3px] text-[8px]" />
            <span className="truncate">{node.leadElsewhere.name}</span>
          </Link>
        )}
      </div>
      {/* Idle is the norm: just the dot, so whoever is working or needs you stands out. */}
      {presence.state === "idle" ? (
        <span className="mt-[0.8125rem] mr-1 size-1.5 shrink-0 rounded-full bg-success/70" title="Idle">
          <span className="sr-only">Idle</span>
        </span>
      ) : (
        <AgentStatus agent={agent} interactive className="mt-2 max-w-[45%] shrink-0" />
      )}
    </div>
  );
}
