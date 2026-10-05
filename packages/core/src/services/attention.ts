/**
 * "Needs you": everything that waits for the human, computed from live state on every read (never from
 * notifications), so an item leaves the moment the thing is handled — answered, reviewed, continued, fixed.
 */
import type { AttentionItem, RunPause } from "@godmode/shared";
import { formatUsd, monthName } from "@godmode/shared";
import { all, get } from "../db";
import { parseJson } from "../util";
import { listQuestions } from "./questions";
import { listTasks } from "../tasks/service";
import { listRoutines } from "./routines";
import { toPause, type PausedRow } from "./pauses";

const shorten = (s: string, max = 140) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Group order: waiting, review, blocked, went wrong, people; newest first within a group. */
const RANK: Record<AttentionItem["kind"], number> = { question: 0, login: 0, paused: 0, held: 0, review: 1, blocked: 2, failed: 3, automation: 3, access: 4 };

export function listAttention(): AttentionItem[] {
  const items: AttentionItem[] = [];
  const agentNames = new Map(all<{ id: string; name: string }>("SELECT id, name FROM agents").map((a) => [a.id, a.name]));
  const nameOf = (id: string | null) => (id ? (agentNames.get(id) ?? "An agent") : "An agent");

  for (const q of listQuestions({ status: "open", limit: 200 })) {
    items.push({
      id: `question:${q.id}`,
      kind: "question",
      agentId: q.agentId,
      title: q.kind === "approval" ? `${nameOf(q.agentId)} needs your OK` : `${nameOf(q.agentId)} asks you`,
      detail: shorten(q.title),
      since: q.createdAt,
      link: q.taskId ? `/tasks?task=${q.taskId}` : `/chat/${q.conversationId}`,
      action: q.kind === "approval" ? "Review" : "Answer",
      question: q,
      conversationId: q.conversationId,
    });
  }

  // A missing login leads back to the work it stopped: the chat or ticket of the run that reported it.
  for (const m of all<{ id: string; agent_id: string | null; service: string; reason: string; kind: string; updated_at: string; conversation_id: string | null; task_id: string | null }>(
    `SELECT m.id, m.agent_id, m.service, m.reason, m.kind, m.updated_at, c.id AS conversation_id, t.id AS task_id
     FROM missing_logins m LEFT JOIN runs r ON r.id = m.run_id LEFT JOIN conversations c ON c.id = r.conversation_id
     LEFT JOIN tasks t ON t.conversation_id = c.id
     WHERE m.status = 'open' ORDER BY m.updated_at DESC LIMIT 200`,
  )) {
    items.push({
      id: `login:${m.id}`,
      kind: "login",
      agentId: m.agent_id,
      title: `${nameOf(m.agent_id)} ${m.kind === "invalid_credential" ? "couldn't log in to" : m.kind === "missing_totp" ? "needs a 2FA code for" : "needs a login for"} ${m.service}`,
      detail: shorten(m.reason),
      since: m.updated_at,
      // Without its chat (deleted), the Inbox card adds the login.
      link: m.task_id ? `/tasks?task=${m.task_id}` : m.conversation_id ? `/chat/${m.conversation_id}` : "/inbox",
      action: "Add login",
      conversationId: m.conversation_id,
    });
  }

  for (const t of listTasks({ archived: false })) {
    if (t.status !== "in_review" && t.status !== "blocked") continue;
    const review = t.status === "in_review";
    items.push({
      id: `${review ? "review" : "blocked"}:${t.id}`,
      kind: review ? "review" : "blocked",
      agentId: t.agentId,
      title: review ? `#${t.number} ${t.title} is ready for review` : `#${t.number} ${t.title} is blocked`,
      detail: review ? (t.agentId ? `${nameOf(t.agentId)} delivered it` : "") : shorten(t.blockedReason ?? ""),
      since: t.updatedAt,
      link: `/tasks?task=${t.id}`,
      action: review ? "Review" : "Open",
      task: t,
      conversationId: t.conversationId,
    });
  }

  // Standing still until the human acts: paused by them, or past a usage limit with nothing continuing it by itself.
  const pausedRows = all<PausedRow & { title: string; task_id: string | null }>(
    `SELECT p.*, c.title, t.id AS task_id FROM paused_runs p JOIN conversations c ON c.id = p.conversation_id
     LEFT JOIN tasks t ON t.conversation_id = c.id
     WHERE p.reason = 'user' OR (p.reason = 'limit' AND p.auto = 0) ORDER BY p.created_at DESC`,
  );
  for (const p of pausedRows) {
    const pause: RunPause = toPause(p);
    items.push({
      id: `paused:${p.run_id}`,
      kind: "paused",
      agentId: p.agent_id,
      title: p.reason === "limit" ? `${nameOf(p.agent_id)} waits for you after Claude's ${p.limit_name ?? "usage limit"}` : `${nameOf(p.agent_id)} is paused`,
      detail: shorten(p.title),
      since: p.created_at,
      link: p.task_id ? `/tasks?task=${p.task_id}` : `/chat/${p.conversation_id}`,
      action: "Continue",
      pause,
      conversationId: p.conversation_id,
    });
  }

  // Chats on a runner stand still there: this computer knows it from what the runner last said (`runner_state`).
  for (const c of all<{ id: string; agent_id: string; title: string; runner_state: string | null }>(
    `SELECT id, agent_id, title, runner_state FROM conversations
     WHERE runner_id IS NOT NULL AND archived = 0 AND json_extract(runner_state, '$.paused.reason') IN ('user', 'limit')`,
  )) {
    const pause = parseJson<{ paused?: RunPause | null }>(c.runner_state, {}).paused;
    if (!pause || (pause.reason === "limit" && pause.auto)) continue;
    items.push({
      id: `paused:${pause.runId}`,
      kind: "paused",
      agentId: c.agent_id,
      title: pause.reason === "limit" ? `${nameOf(c.agent_id)} waits for you after Claude's ${pause.limit ?? "usage limit"}` : `${nameOf(c.agent_id)} is paused`,
      detail: shorten(c.title),
      since: pause.pausedAt,
      link: `/chat/${c.id}`,
      action: "Continue",
      pause,
      conversationId: c.id,
    });
  }

  // Held for a monthly budget: one row per budget, not one per run.
  for (const h of all<{ scope: string | null; agent_id: string; n: number; budget: number | null; since: string; resume_at: string | null }>(
    `SELECT budget_scope AS scope, CASE WHEN budget_scope = 'team' THEN '' ELSE agent_id END AS agent_id, COUNT(*) AS n,
       MAX(budget_usd) AS budget, MIN(created_at) AS since, MIN(resume_at) AS resume_at
     FROM paused_runs WHERE reason = 'budget' GROUP BY 1, 2`,
  )) {
    const team = h.scope === "team";
    const runs = h.n === 1 ? "1 run waits" : `${h.n} runs wait`;
    items.push({
      id: team ? "held:team" : `held:agent:${h.agent_id}`,
      kind: "held",
      agentId: team ? null : h.agent_id,
      title: team ? `The team's ${monthName(new Date())} budget is used up` : `${nameOf(h.agent_id)}'s ${monthName(new Date())} budget is used up`,
      detail: `${runs}${h.budget ? ` · budget ${formatUsd(h.budget)}` : ""} — raise it or let them run.`,
      since: h.since,
      link: team ? "/settings/ai" : `/agents/${h.agent_id}`,
      action: "Open",
    });
  }

  // A chat whose latest run failed while nobody had it open (automation chats show as the automation instead).
  for (const f of all<{ id: string; agent_id: string; title: string; run_id: string; error: string | null; at: string }>(
    `SELECT c.id, c.agent_id, c.title, r.id AS run_id, r.error, COALESCE(r.finished_at, r.created_at) AS at
     FROM conversations c JOIN runs r ON r.id = c.unread_run_id
     WHERE r.status = 'failed' AND r.trigger != 'routine' AND c.archived = 0 AND c.origin NOT IN ('task', 'dream')
       AND c.id NOT IN (SELECT conversation_id FROM paused_runs)`,
  )) {
    items.push({
      id: `failed:${f.id}`,
      kind: "failed",
      agentId: f.agent_id,
      title: `${nameOf(f.agent_id)} ran into a problem`,
      detail: shorten(`${f.title}${f.error ? ` — ${f.error}` : ""}`),
      since: f.at,
      link: `/chat/${f.id}`,
      action: "Open chat",
      conversationId: f.id,
    });
  }

  // Automations whose own last run failed (or couldn't start), or whose own trigger is broken. Not the shared app-event
  // connection: a blip there would list every app automation at once.
  for (const r of listRoutines()) {
    if (!r.enabled) continue;
    const agentOn = get<{ enabled: number }>("SELECT enabled FROM agents WHERE id = ?", r.agentId)?.enabled === 1;
    if (!agentOn) continue;
    const ownError = r.trigger.type !== "app" && r.triggerStatus.state === "error";
    // Its last outcome: a failed run, or a failed start (that leaves no run). While a newer run is still on its way,
    // the latest finished run decides.
    const pending = r.lastStatus === "queued" || r.lastStatus === "running" || r.lastStatus === "paused";
    const latest = pending
      ? get<{ status: string }>(
          "SELECT status FROM runs WHERE routine_id = ? AND trigger = 'routine' AND status IN ('succeeded', 'failed') ORDER BY created_at DESC LIMIT 1",
          r.id,
        )
      : undefined;
    const failing = r.lastStatus === "failed" || latest?.status === "failed";
    if (!failing && !ownError) continue;
    items.push({
      id: `automation:${r.id}`,
      kind: "automation",
      agentId: r.agentId,
      title: `“${r.name}” isn't working`,
      detail: shorten(ownError ? (r.triggerStatus.message ?? "Its trigger has a problem") : "Its last run failed"),
      since: r.lastRunAt ?? r.updatedAt,
      link: r.conversationId ? `/chat/${r.conversationId}` : `/agents/${r.agentId}/routines`,
      action: "Open",
      conversationId: r.conversationId,
    });
  }

  for (const u of all<{ id: string; name: string; username: string | null; connection: string; created_at: string }>(
    `SELECT u.id, u.name, u.username, m.name AS connection, u.created_at FROM messaging_users u
     JOIN messaging_connections m ON m.id = u.connection_id WHERE u.status = 'pending' AND m.access = 'approved' ORDER BY u.created_at DESC`,
  )) {
    items.push({
      id: `access:${u.id}`,
      kind: "access",
      agentId: null,
      title: `${u.name || u.username || "Someone"} asks to talk to your agents`,
      detail: `On ${u.connection}`,
      since: u.created_at,
      link: "/messaging",
      action: "Decide",
    });
  }

  return items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.since.localeCompare(a.since) || a.id.localeCompare(b.id));
}
