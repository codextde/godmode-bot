/**
 * "While you were away": what the team did since the human was last at the computer — computed from what is stored
 * (runs that ended, the spend ledger, ticket events), so it is right however long they were gone.
 */
import type { AwayHighlight, AwaySummary } from "@godmode/shared";
import { all, get } from "../db";
import { badRequest } from "../util";

/** Chats the human talks in, and turns started for them (the same as unread chats). */
const HUMAN_ORIGINS = ["chat", "api"];
const HUMAN_TRIGGERS = ["chat", "manual", "api", "followup"];
const MAX_HIGHLIGHTS = 6;
const RANK: Record<AwayHighlight["kind"], number> = { delivered: 0, failed: 1, automation: 1, replied: 2 };

export function awaySummary(since: string): AwaySummary {
  const t = Date.parse(since);
  if (!Number.isFinite(t) || t >= Date.now()) throw badRequest("since must be a date and time in the past");
  const from = new Date(t).toISOString();
  const names = new Map(all<{ id: string; name: string }>("SELECT id, name FROM agents").map((a) => [a.id, a.name]));
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? "An agent") : "An agent");

  const runs = all<{
    id: string;
    agent_id: string;
    status: string;
    trigger: string;
    finished_at: string;
    conversation_id: string;
    title: string | null;
    origin: string | null;
    routine: string | null;
    task_id: string | null;
  }>(
    `SELECT r.id, r.agent_id, r.status, r.trigger, r.finished_at, r.conversation_id, c.title, c.origin, rt.name AS routine, t.id AS task_id
     FROM runs r LEFT JOIN conversations c ON c.id = r.conversation_id LEFT JOIN routines rt ON rt.id = r.routine_id
     LEFT JOIN tasks t ON t.conversation_id = r.conversation_id
     WHERE r.finished_at >= ? AND r.status IN ('succeeded', 'failed') AND r.trigger != 'check'
     ORDER BY r.finished_at DESC`,
    from,
  );

  const highlights: AwayHighlight[] = [];
  // One line per chat (its latest turn) and per automation, so a busy chat doesn't fill the list.
  const seen = new Set<string>();
  for (const r of runs) {
    if (r.trigger === "routine" && r.routine) {
      if (r.status !== "failed" || seen.has(`routine:${r.routine}`)) continue;
      seen.add(`routine:${r.routine}`);
      highlights.push({ kind: "automation", agentId: r.agent_id, text: `“${r.routine}” failed`, link: `/chat/${r.conversation_id}`, at: r.finished_at });
      continue;
    }
    // Tickets show as delivered (below); dreams, delegated and platform chats aren't the human's conversations.
    if (r.task_id || !r.origin || !HUMAN_ORIGINS.includes(r.origin) || !HUMAN_TRIGGERS.includes(r.trigger) || seen.has(r.conversation_id)) continue;
    seen.add(r.conversation_id);
    const failed = r.status === "failed";
    highlights.push({
      kind: failed ? "failed" : "replied",
      agentId: r.agent_id,
      text: `${nameOf(r.agent_id)} ${failed ? "ran into a problem in" : "replied in"} “${r.title ?? "a chat"}”`,
      link: `/chat/${r.conversation_id}`,
      at: r.finished_at,
    });
  }

  // The latest delivery per ticket (SQLite takes the other columns from the row with the MAX).
  const delivered = all<{ task_id: string; number: number; title: string; agent_id: string | null; actor_name: string; created_at: string }>(
    `SELECT e.task_id, t.number, t.title, t.agent_id, e.actor_name, MAX(e.created_at) AS created_at FROM task_events e JOIN tasks t ON t.id = e.task_id
     WHERE e.kind = 'delivered' AND e.created_at >= ? GROUP BY e.task_id ORDER BY created_at DESC`,
    from,
  );
  for (const d of delivered) {
    const who = d.agent_id ? nameOf(d.agent_id) : d.actor_name || "An agent";
    highlights.push({ kind: "delivered", agentId: d.agent_id, text: `${who} delivered #${d.number} ${d.title}`, link: `/tasks?task=${d.task_id}`, at: d.created_at });
  }

  // Who worked: the runs that ended (as counted above) and what each agent's work cost since (also unfinished work).
  const byAgent = new Map<string, { name: string; runs: number; cost: number }>();
  for (const r of runs) {
    const a = byAgent.get(r.agent_id) ?? { name: nameOf(r.agent_id), runs: 0, cost: 0 };
    a.runs++;
    byAgent.set(r.agent_id, a);
  }
  for (const row of all<{ agent_id: string; agent_name: string; cost: number }>(
    "SELECT agent_id, MAX(agent_name) AS agent_name, SUM(cost_usd) AS cost FROM spend WHERE at >= ? AND trigger != 'check' GROUP BY agent_id",
    from,
  )) {
    const a = byAgent.get(row.agent_id) ?? { name: names.get(row.agent_id) ?? row.agent_name, runs: 0, cost: 0 };
    a.cost = row.cost ?? 0;
    byAgent.set(row.agent_id, a);
  }
  const cost = get<{ cost: number | null }>("SELECT SUM(cost_usd) AS cost FROM spend WHERE at >= ?", from)?.cost ?? 0;
  const round = (usd: number) => Math.round(usd * 10_000) / 10_000;

  return {
    since: from,
    finished: runs.length,
    failed: runs.filter((r) => r.status === "failed").length,
    delivered: delivered.length,
    costUsd: round(cost),
    agents: [...byAgent]
      .map(([agentId, a]) => ({ agentId, name: a.name, runs: a.runs, costUsd: round(a.cost) }))
      .sort((a, b) => b.runs - a.runs || b.costUsd - a.costUsd),
    highlights: highlights.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.at.localeCompare(a.at)).slice(0, MAX_HIGHLIGHTS),
  };
}
