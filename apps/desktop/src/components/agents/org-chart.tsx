import { Link } from "react-router";
import { Globe, Plus } from "lucide-react";
import type { Agent, TeamGroup, TeamNode } from "@godmode/shared";
import { leadOf, presenceLabel, teamTree } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { useWorkspaces } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { AgentStatus, useAgentMood, useAgentPresence } from "./agent-actions";

/**
 * The team as a tree: the built-in agent on top, everyone under their lead, with role and live status. Nested lists,
 * so the hierarchy reads the same to a screen reader and every control on a node is a normal tab stop. Agents that
 * don't match the search stay in place, dimmed, so the shape of the team doesn't jump around.
 */
export function OrgChart({
  shown,
  all,
  byWorkspace,
  matches,
}: {
  /** The agents of the current scope and filter. */
  shown: Agent[];
  /** Every agent, to name leads that aren't shown. */
  all: Agent[];
  byWorkspace: boolean;
  /** Search hits; null = no search. */
  matches: Set<string> | null;
}) {
  const groups = teamTree(shown, all, { byWorkspace });
  const onlyBuiltin = all.length === 1 && all[0]!.isDefault;
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <Group key={g.workspaceId ?? "global"} group={g} titled={groups.length > 1} all={all} matches={matches} />
      ))}
      {onlyBuiltin && (
        <Link
          to="/agents/new"
          className="ml-10 flex max-w-sm items-center gap-3 rounded-xl border border-dashed p-3 text-sm text-muted-foreground transition hover:border-foreground/25 hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
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

function Group({ group, titled, all, matches }: { group: TeamGroup<Agent>; titled: boolean; all: Agent[]; matches: Set<string> | null }) {
  const { data: workspaces = [] } = useWorkspaces();
  const ws = group.workspaceId ? workspaces.find((w) => w.id === group.workspaceId) : null;
  const label = group.workspaceId ? (ws?.name ?? "Workspace") : "Global";
  const headingId = `org-${group.workspaceId ?? "global"}`;
  return (
    <section aria-labelledby={titled ? headingId : undefined} aria-label={titled ? undefined : "Org chart"} className="@container/org">
      {titled && (
        <h2 id={headingId} className="mb-3 flex items-center gap-2 text-sm font-medium">
          {ws ? <span aria-hidden>{ws.icon}</span> : <Globe className="size-4 text-muted-foreground" aria-hidden />}
          {label}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {group.count} agent{group.count === 1 ? "" : "s"}
          </span>
        </h2>
      )}
      <ul className="space-y-3">
        {group.roots.map((n) => (
          <Branch key={n.agent.id} node={n} depth={0} all={all} matches={matches} spread />
        ))}
      </ul>
    </section>
  );
}

function Branch({
  node,
  depth,
  all,
  matches,
  spread,
  inColumns,
}: {
  node: TeamNode<Agent>;
  depth: number;
  all: Agent[];
  matches: Set<string> | null;
  spread?: boolean;
  /** Laid out as a column of its lead's team: no connector on a wide screen. */
  inColumns?: boolean;
}) {
  const reports = node.reports;
  // On a wide screen the top of a team reads like a chart: each report with a team of its own gets a column, the
  // others stack in one more column.
  const branches = reports.filter((r) => r.reports.length > 0);
  const leaves = reports.filter((r) => r.reports.length === 0);
  const columns = !!spread && depth === 0 && branches.length > 0 && reports.length > 1;
  const sub = (r: TeamNode<Agent>) => <Branch key={r.agent.id} node={r} depth={depth + 1} all={all} matches={matches} inColumns={columns} />;
  return (
    <li className="relative">
      {depth > 0 && <span aria-hidden className={cn("absolute top-7 -left-4 h-px w-4 bg-border", inColumns && "@4xl/org:hidden")} />}
      <NodeCard node={node} all={all} dim={!!matches && !matches.has(node.agent.id)} />
      {reports.length > 0 &&
        (columns ? (
          <ul className={cn("relative mt-3 ml-7 space-y-3 border-l pl-4 @4xl/org:ml-0 @4xl/org:border-l-0 @4xl/org:border-t @4xl/org:pt-3 @4xl/org:pl-0 @4xl/org:grid @4xl/org:gap-x-6 @4xl/org:space-y-0", branches.length + (leaves.length ? 1 : 0) > 2 ? "@4xl/org:grid-cols-3" : "@4xl/org:grid-cols-2")}>
            {branches.map(sub)}
            {leaves.length > 0 && (
              <li>
                <ul className="space-y-3">{leaves.map(sub)}</ul>
              </li>
            )}
          </ul>
        ) : (
          <ul className={cn("relative mt-3 space-y-3 border-l pl-4", depth < 6 ? "ml-7" : "ml-0")}>{reports.map(sub)}</ul>
        ))}
    </li>
  );
}

function NodeCard({ node, all, dim }: { node: TeamNode<Agent>; all: Agent[]; dim: boolean }) {
  const agent = node.agent;
  const mood = useAgentMood(agent);
  const presence = useAgentPresence(agent);
  const lead = leadOf(agent, all);
  const label = `${agent.name}, ${agent.role || "no role yet"}, ${presenceLabel(presence)}, reports to ${agent.isDefault ? "you" : (lead?.name ?? "Godmode")}`;
  return (
    <div
      className={cn(
        "group relative flex max-w-sm items-start gap-3 rounded-xl border bg-card p-3 shadow-card transition-[box-shadow,border-color,opacity] hover:border-foreground/15 hover:shadow-float",
        presence.state === "working" && "glow-border",
        !agent.enabled && "opacity-65",
        dim && "opacity-40",
      )}
    >
      <AgentAvatar agent={agent} size="md" mood={mood} still={dim} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <Link
            to={`/agents/${agent.id}`}
            aria-label={label}
            title={agent.name}
            className="truncate text-sm font-medium tracking-[-0.01em] after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
          >
            {agent.name}
          </Link>
          {agent.isDefault && <span className="shrink-0 rounded-[5px] border bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground">Built-in</span>}
        </div>
        {agent.role && (
          <p className="truncate text-xs text-muted-foreground" title={agent.role}>
            {agent.role}
          </p>
        )}
        <AgentStatus agent={agent} interactive className="mt-0.5 max-w-full" />
        {node.leadElsewhere && (
          <Link
            to={`/agents/${node.leadElsewhere.id}`}
            className="relative z-10 mt-1.5 inline-flex max-w-full items-center gap-1 rounded-[5px] border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:border-foreground/25 hover:text-foreground"
          >
            Reports to <AgentAvatar agent={node.leadElsewhere} size="sm" still className="size-3.5 rounded-[3px] text-[8px]" />
            <span className="truncate">{node.leadElsewhere.name}</span>
          </Link>
        )}
      </div>
    </div>
  );
}
