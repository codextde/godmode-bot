/**
 * The archive: workspaces, projects, agents and automations put away without deleting them. What is archived (itself, or
 * through its workspace, project or agent) never runs, and no list, prompt, team, dream or schedule names it until it is
 * restored. Restoring brings back exactly what the archive covered.
 */
import type { ArchiveKind, ArchiveList } from "@godmode/shared";
import { all, run } from "../db";
import { agentParentArchivedSql } from "../db/archived";
import { bus } from "../events/bus";
import { logger } from "../log";
import { getAgent, listAgents, stopAgentRuns } from "../agents/service";
import { reloadSchedules } from "../scheduler/scheduler";
import { requestAppTriggerSync } from "../integrations/composioTriggers";
import { cancelPendingEvents } from "../automations/events";
import { badRequest, now } from "../util";
import { getWorkspace, listWorkspaces } from "./workspaces";
import { archivedProjects, getProject } from "./projects";
import { archivedRoutines, getRoutine, syncRoutinesFile } from "./routines";
import { startTodoTickets } from "../tasks/service";
import { sweep as sweepFollowups } from "./followups";

const log = logger("archive");

const TABLES: Record<ArchiveKind, string> = { workspace: "workspaces", project: "projects", agent: "agents", routine: "routines" };

/** The name of what `kind` + `id` points at (404 when it doesn't exist). */
function nameOf(kind: ArchiveKind, id: string): string {
  switch (kind) {
    case "workspace":
      return getWorkspace(id).name;
    case "project":
      return getProject(id).name;
    case "agent": {
      const agent = getAgent(id);
      if (agent.isDefault) throw badRequest("The built-in agent can't be archived");
      return agent.name;
    }
    case "routine":
      return getRoutine(id).name;
  }
}

/** Agents the archive of `kind` + `id` covers. */
export function coveredAgents(kind: ArchiveKind, id: string): string[] {
  const column = kind === "workspace" ? "workspace_id" : kind === "project" ? "project_id" : kind === "agent" ? "id" : null;
  if (!column) return [];
  return all<{ id: string }>(`SELECT id FROM agents WHERE ${column} = ? AND is_default = 0`, id).map((r) => r.id);
}

/** False when there was nothing to change (already so, or archived only through its workspace, project or agent). */
export async function setArchived(kind: ArchiveKind, id: string, archived: boolean): Promise<boolean> {
  const name = nameOf(kind, id);
  const ts = now();
  const changes = run(`UPDATE ${TABLES[kind]} SET archived_at = ?, updated_at = ? WHERE id = ? AND (archived_at IS NULL) = ?`, archived ? ts : null, ts, id, archived ? 1 : 0).changes;
  if (!changes) return false;
  const agents = kind === "routine" ? [getRoutine(id).agentId] : coveredAgents(kind, id);
  log.info(`${archived ? "archived" : "restored"} ${kind} "${name}" (${id})`);
  if (archived) {
    if (kind === "routine") cancelPendingEvents(id, "The automation was archived");
    for (const agentId of kind === "routine" ? [] : agents) {
      for (const r of all<{ id: string }>("SELECT id FROM routines WHERE agent_id = ?", agentId)) cancelPendingEvents(r.id, "The agent was archived");
      await stopAgentRuns(agentId).catch((err) => log.warn(`could not stop the runs of archived agent ${agentId}`, err));
    }
  }
  for (const agentId of agents) syncRoutinesFile(agentId);
  reloadSchedules();
  requestAppTriggerSync();
  if (!archived) {
    // What waited in place goes on: follow-ups that came due, tickets in Todo.
    void sweepFollowups();
    startTodoTickets();
  }
  bus.changed("archive");
  bus.changed(kind === "routine" ? "routines" : kind === "project" || kind === "workspace" ? "workspaces" : "agents");
  if (kind !== "routine") {
    bus.changed("agents");
    bus.changed("routines");
  }
  return true;
}

/**
 * Everything archived by itself, newest first. What its workspace, project or agent took along shows with that one, and
 * comes back with it.
 */
export function listArchive(): ArchiveList {
  const newest = <T extends { archivedAt: string | null }>(list: T[]) => list.sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  const agentIds = new Set(
    all<{ id: string }>(`SELECT a.id FROM agents a WHERE a.archived_at IS NOT NULL AND NOT ${agentParentArchivedSql("a")}`).map((r) => r.id),
  );
  return {
    workspaces: newest(listWorkspaces({ archived: true })),
    projects: newest(archivedProjects()),
    agents: newest(listAgents({ includeArchived: true }).filter((a) => agentIds.has(a.id))),
    routines: newest(archivedRoutines()),
  };
}
