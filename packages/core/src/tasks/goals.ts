/**
 * Goals: what the work is for. Tickets serve a goal — its agent is told why with every ticket — and the board shows how
 * far each goal is (tickets done of all, what the work cost).
 */
import type { Goal, GoalInput, GoalStatus } from "@godmode/shared";
import { MAX_GOAL_TITLE_LENGTH, MAX_GOAL_WHY_LENGTH } from "@godmode/shared";
import { all, get, insert, run as sql, update } from "../db";
import { bus } from "../events/bus";
import { redact } from "../vault/vault";
import { badRequest, newId, notFound, now } from "../util";

interface GoalRow {
  id: string;
  workspace_id: string | null;
  title: string;
  why: string;
  status: GoalStatus;
  target_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  total: number;
  done: number;
  open: number;
  cost: number | null;
}

const STATUSES: readonly GoalStatus[] = ["active", "achieved", "dropped"];

const SELECT = `SELECT g.*,
    (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.archived_at IS NULL) AS total,
    (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.archived_at IS NULL AND t.status = 'done') AS done,
    (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.archived_at IS NULL AND t.status NOT IN ('done', 'cancelled')) AS open,
    (SELECT SUM(t.cost_usd) FROM tasks t WHERE t.goal_id = g.id) AS cost
  FROM goals g`;

function toModel(r: GoalRow): Goal {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    why: r.why,
    status: r.status,
    targetDate: r.target_date,
    tickets: { total: r.total ?? 0, done: r.done ?? 0, open: r.open ?? 0 },
    costUsd: Math.round((r.cost ?? 0) * 100) / 100,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function changed() {
  bus.emit({ type: "entity.changed", entity: "goals" });
}

/** Goals of a scope ("all", "global" or a workspace id; a workspace sees the global goals too), active first. */
export function listGoals(opts: { workspaceId?: string } = {}): Goal[] {
  const ws = opts.workspaceId ?? "all";
  const where = ws === "all" ? "" : ws === "global" ? "WHERE g.workspace_id IS NULL" : "WHERE (g.workspace_id = ? OR g.workspace_id IS NULL)";
  const rows = all<GoalRow>(
    `${SELECT} ${where} ORDER BY CASE g.status WHEN 'active' THEN 0 WHEN 'achieved' THEN 1 ELSE 2 END, g.target_date IS NULL, g.target_date, g.created_at`,
    ...(ws === "all" || ws === "global" ? [] : [ws]),
  );
  return rows.map(toModel);
}

export function getGoal(id: string): Goal {
  const r = get<GoalRow>(`${SELECT} WHERE g.id = ?`, id);
  if (!r) throw notFound("Goal");
  return toModel(r);
}

function cleanTitle(title: string | undefined): string {
  const t = redact((title ?? "").trim()).slice(0, MAX_GOAL_TITLE_LENGTH);
  if (!t) throw badRequest("Give the goal a title");
  return t;
}

function cleanDate(d: string | null | undefined): string | null {
  if (!d) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw badRequest("A target date is a day, YYYY-MM-DD");
  return d;
}

function cleanWorkspace(id: string | null | undefined): string | null {
  if (!id) return null;
  if (!get("SELECT 1 FROM workspaces WHERE id = ?", id)) throw badRequest("That workspace doesn't exist");
  return id;
}

export function createGoal(input: GoalInput): Goal {
  const id = newId("gol");
  const ts = now();
  insert("goals", {
    id,
    workspace_id: cleanWorkspace(input.workspaceId),
    title: cleanTitle(input.title),
    why: redact((input.why ?? "").trim()).slice(0, MAX_GOAL_WHY_LENGTH),
    status: input.status && STATUSES.includes(input.status) ? input.status : "active",
    target_date: cleanDate(input.targetDate),
    position: 0,
    created_at: ts,
    updated_at: ts,
  });
  changed();
  return getGoal(id);
}

export function updateGoal(id: string, patch: Partial<GoalInput>): Goal {
  getGoal(id);
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw badRequest("Unknown goal status");
  update("goals", id, {
    title: patch.title !== undefined ? cleanTitle(patch.title) : undefined,
    why: patch.why !== undefined ? redact(patch.why.trim()).slice(0, MAX_GOAL_WHY_LENGTH) : undefined,
    status: patch.status,
    target_date: patch.targetDate !== undefined ? cleanDate(patch.targetDate) : undefined,
    workspace_id: patch.workspaceId !== undefined ? cleanWorkspace(patch.workspaceId) : undefined,
    updated_at: now(),
  });
  changed();
  return getGoal(id);
}

/** Deleting a goal leaves its tickets as they are, serving no goal. */
export function deleteGoal(id: string): void {
  getGoal(id);
  sql("UPDATE tasks SET goal_id = NULL WHERE goal_id = ?", id);
  sql("DELETE FROM goals WHERE id = ?", id);
  changed();
  bus.emit({ type: "entity.changed", entity: "tasks" });
}

/** A ticket may serve this goal: it exists and is in the ticket's workspace or global. */
export function checkGoal(goalId: string | null | undefined, workspaceId: string | null): string | null {
  if (!goalId) return null;
  const g = get<{ workspace_id: string | null }>("SELECT workspace_id FROM goals WHERE id = ?", goalId);
  if (!g) throw badRequest("That goal doesn't exist");
  if (g.workspace_id && g.workspace_id !== workspaceId) throw badRequest("That goal belongs to another workspace");
  return goalId;
}

/** The lines a ticket's agent gets about the goal it serves. */
export function goalBrief(goalId: string | null): string[] {
  if (!goalId) return [];
  const g = get<{ title: string; why: string; target_date: string | null }>("SELECT title, why, target_date FROM goals WHERE id = ?", goalId);
  if (!g) return [];
  return [
    `This ticket serves the goal “${g.title}”${g.target_date ? ` (target: ${g.target_date})` : ""}.${g.why ? ` Why it matters: ${g.why.trim()}${/[.!?]$/.test(g.why.trim()) ? "" : "."}` : ""} Let it guide the choices the ticket leaves open.`,
  ];
}
