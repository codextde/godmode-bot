/**
 * SQL for what is archived (services/archive.ts). An agent is archived itself or through its workspace or project, an
 * automation itself or through its agent, a project itself or through its workspace.
 */

const workspaceArchived = (col: string) => `EXISTS (SELECT 1 FROM workspaces xw WHERE xw.id = ${col} AND xw.archived_at IS NOT NULL)`;

export function archivedProjectSql(p: string): string {
  return `(${p}.archived_at IS NOT NULL OR ${workspaceArchived(`${p}.workspace_id`)})`;
}

/** The agent's workspace or project is archived (whatever the agent's own flag says). */
export function agentParentArchivedSql(a: string): string {
  return `(${workspaceArchived(`${a}.workspace_id`)} OR EXISTS (SELECT 1 FROM projects xp WHERE xp.id = ${a}.project_id AND ${archivedProjectSql("xp")}))`;
}

export function archivedAgentSql(a: string): string {
  return `(${a}.archived_at IS NOT NULL OR ${agentParentArchivedSql(a)})`;
}

export function archivedRoutineSql(r: string): string {
  return `(${r}.archived_at IS NOT NULL OR EXISTS (SELECT 1 FROM agents xa WHERE xa.id = ${r}.agent_id AND ${archivedAgentSql("xa")}))`;
}

/** A chat whose agent, workspace or project is archived. */
export function archivedChatSql(c: string): string {
  return `(EXISTS (SELECT 1 FROM agents ca WHERE ca.id = ${c}.agent_id AND ${archivedAgentSql("ca")}) OR ${workspaceArchived(`${c}.workspace_id`)} OR EXISTS (SELECT 1 FROM projects cp WHERE cp.id = ${c}.project_id AND ${archivedProjectSql("cp")}))`;
}

/** Agents that may run: switched on and not archived. */
export function activeAgentSql(a: string): string {
  return `(${a}.enabled = 1 AND NOT ${archivedAgentSql(a)})`;
}

/** A row (ticket, chat…) in an archived workspace or project, by its workspace and project columns. */
export function archivedScopeSql(workspaceCol: string, projectCol: string): string {
  return `(${workspaceArchived(workspaceCol)} OR EXISTS (SELECT 1 FROM projects sp WHERE sp.id = ${projectCol} AND ${archivedProjectSql("sp")}))`;
}
