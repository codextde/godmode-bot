import type { Agent, ID } from "./models";

/** The longest job title an agent can have. */
export const MAX_AGENT_ROLE_LENGTH = 60;

/**
 * A job title as stored: one line, whitespace collapsed, control characters and angle brackets dropped (a title never
 * needs them, and it reaches other agents' prompts), cut at MAX_AGENT_ROLE_LENGTH.
 */
export function normalizeRole(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AGENT_ROLE_LENGTH)
    .trim();
}

export type TeamAgent = Pick<Agent, "id" | "workspaceId" | "isDefault" | "reportsTo">;

/**
 * The agent's lead: its `reportsTo`, or the built-in agent when that is null. null for the built-in agent (it reports
 * to the human); undefined when the lead isn't in `agents` (pass every agent, not a filtered list).
 */
export function leadOf<T extends TeamAgent>(agent: TeamAgent, agents: readonly T[]): T | null | undefined {
  if (agent.isDefault) return null;
  if (agent.reportsTo) return agents.find((a) => a.id === agent.reportsTo);
  return agents.find((a) => a.isDefault) ?? undefined;
}

/** Its direct reports (for the built-in agent: everyone without a lead of their own). */
export function reportsOf<T extends TeamAgent>(agent: TeamAgent, agents: readonly T[]): T[] {
  return agents.filter((a) => a.id !== agent.id && !a.isDefault && (a.reportsTo ? a.reportsTo === agent.id : !!agent.isDefault));
}

/** Lead, its lead, … up to the built-in agent. Stops at a loop or an unknown lead, at most 16. */
export function chainOf<T extends TeamAgent>(agent: TeamAgent, agents: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set([agent.id]);
  let at: TeamAgent = agent;
  while (out.length < 16) {
    const lead = leadOf(at, agents);
    if (!lead || seen.has(lead.id)) break;
    seen.add(lead.id);
    out.push(lead);
    at = lead;
  }
  return out;
}

/**
 * Why `lead` can't lead `agent`, or null when it can: "builtin" (the agent is the built-in one, which reports to the
 * human), "self", "workspace" (the lead is neither global nor in the agent's workspace), "cycle" (the lead reports to
 * the agent, directly or through others).
 */
export function leadProblem(agent: TeamAgent, lead: TeamAgent, agents: readonly TeamAgent[]): "builtin" | "self" | "workspace" | "cycle" | null {
  if (agent.isDefault) return "builtin";
  if (lead.id === agent.id) return "self";
  if (lead.workspaceId && lead.workspaceId !== agent.workspaceId) return "workspace";
  if (chainOf(lead, agents).some((a) => a.id === agent.id)) return "cycle";
  return null;
}

/** Whether `agent` may hand work to `target` by scope: global agents and its own workspace; managers reach everyone. Enabled state and the allow-list come on top. */
export function withinReach(agent: { id: ID; workspaceId: ID | null; canManageAgents: boolean }, target: { id: ID; workspaceId: ID | null }): boolean {
  if (target.id === agent.id) return false;
  if (agent.canManageAgents) return true;
  return !target.workspaceId || target.workspaceId === agent.workspaceId;
}

export interface TeamNode<T> {
  agent: T;
  reports: TeamNode<T>[];
  /** Its lead when that isn't its parent here (filtered out, or in another group) and isn't the built-in agent. */
  leadElsewhere: T | null;
}

export interface TeamGroup<T> {
  /** null = global agents (and the built-in agent). */
  workspaceId: ID | null;
  roots: TeamNode<T>[];
  count: number;
}

/**
 * The org chart of `shown` (a subset of `all`). With `byWorkspace` there is one group per workspace (global first)
 * and lines across groups are cut; the built-in agent then sits on top of the global group. Siblings: built-in first,
 * then by name. Loop-safe.
 */
export function teamTree<T extends TeamAgent & { name: string }>(shown: readonly T[], all: readonly T[], opts: { byWorkspace?: boolean } = {}): TeamGroup<T>[] {
  const ids = new Set(shown.map((a) => a.id));
  const groupOf = (a: T): ID | null => (opts.byWorkspace ? a.workspaceId : null);
  const order = (a: T, b: T) => Number(!!b.isDefault) - Number(!!a.isDefault) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const children = new Map<ID, T[]>();
  const roots = new Map<ID | null, T[]>();
  for (const a of shown) {
    const lead = leadOf(a, all);
    const parent = lead && ids.has(lead.id) && groupOf(lead) === groupOf(a) ? lead : null;
    if (parent) children.set(parent.id, [...(children.get(parent.id) ?? []), a]);
    else roots.set(groupOf(a), [...(roots.get(groupOf(a)) ?? []), a]);
  }
  const seen = new Set<ID>();
  const node = (a: T, parent: T | null): TeamNode<T> => {
    seen.add(a.id);
    const lead = leadOf(a, all);
    return {
      agent: a,
      reports: (children.get(a.id) ?? [])
        .filter((c) => !seen.has(c.id))
        .sort(order)
        .map((c) => node(c, a)),
      leadElsewhere: lead && !lead.isDefault && lead.id !== parent?.id ? lead : null,
    };
  };
  // Agents in a loop never reach a root; they become roots of their own group so nobody disappears.
  const groups = new Map<ID | null, TeamNode<T>[]>();
  for (const [g, list] of roots) groups.set(g, list.sort(order).map((a) => node(a, null)));
  for (const a of [...shown].sort(order)) {
    if (seen.has(a.id)) continue;
    const g = groupOf(a);
    groups.set(g, [...(groups.get(g) ?? []), node(a, null)]);
  }
  const size = (n: TeamNode<T>): number => 1 + n.reports.reduce((s, r) => s + size(r), 0);
  return [...groups.entries()]
    .map(([workspaceId, list]) => ({ workspaceId, roots: list, count: list.reduce((s, n) => s + size(n), 0) }))
    .sort((a, b) => Number(a.workspaceId !== null) - Number(b.workspaceId !== null));
}

export type AgentPresenceState = "off" | "working" | "waiting" | "failed" | "paused" | "queued" | "idle";

export interface AgentPresence {
  state: AgentPresenceState;
  running: number;
  queued: number;
  /** Runs waiting for the human's answer or approval. */
  waiting: number;
  /** Runs paused by the human or waiting for Claude's usage limit. */
  paused: number;
  needsLogin: boolean;
  failed: boolean;
  /** Waiting for an answer, missing a login, or its last run failed. */
  needsYou: boolean;
}

/**
 * What an agent is doing right now, from its stored state and the live runs the app knows about. One place decides
 * it, so the card, the chart, the header and the phone say the same. Queued never counts as working.
 */
export function agentPresence(
  agent: Pick<Agent, "enabled" | "status" | "pausedRuns" | "openQuestions" | "failedRunId">,
  live: { running?: number; queued?: number; needsLogin?: boolean } = {},
): AgentPresence {
  const running = Math.max(live.running ?? 0, agent.status === "running" ? 1 : 0);
  const queued = live.queued ?? 0;
  const waiting = agent.openQuestions ?? 0;
  const paused = agent.pausedRuns ?? 0;
  const needsLogin = !!live.needsLogin;
  const failed = !!agent.failedRunId;
  const state: AgentPresenceState = !agent.enabled
    ? "off"
    : running > 0
      ? "working"
      : waiting > 0 || needsLogin
        ? "waiting"
        : failed
          ? "failed"
          : paused > 0
            ? "paused"
            : queued > 0
              ? "queued"
              : "idle";
  return { state, running, queued, waiting, paused, needsLogin, failed, needsYou: agent.enabled && (waiting > 0 || needsLogin || failed) };
}

export function presenceLabel(p: AgentPresence): string {
  switch (p.state) {
    case "off":
      return "Switched off";
    case "working":
      return p.running > 1 ? `Working in ${p.running} chats` : "Working…";
    case "waiting":
      if (!p.waiting) return "Needs a login";
      return p.waiting > 1 ? `Needs you · ${p.waiting} questions` : "Needs your answer";
    case "failed":
      return "Last run failed";
    case "paused":
      return p.paused > 1 ? `Paused · ${p.paused} chats` : "Paused";
    case "queued":
      return p.queued > 1 ? `Queued · ${p.queued}` : "Queued";
    default:
      return "Idle";
  }
}
