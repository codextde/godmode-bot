import { useMemo } from "react";
import type { Agent, Project, Workspace } from "@godmode/shared";
import { useWorkspaces } from "@/lib/hooks";

export interface ProjectEntry {
  project: Project;
  workspace: Workspace;
}

/** Every project by id, with its workspace. */
export function useProjectIndex(): Map<string, ProjectEntry> {
  const { data: workspaces } = useWorkspaces();
  return useMemo(() => {
    const out = new Map<string, ProjectEntry>();
    for (const workspace of workspaces ?? []) for (const project of workspace.projects ?? []) out.set(project.id, { project, workspace });
    return out;
  }, [workspaces]);
}

/** Projects an agent may work on: its workspace's, or every workspace's for a global agent. */
export function projectsFor(agent: Pick<Agent, "workspaceId"> | undefined, workspaces: Workspace[]): Workspace[] {
  if (!agent) return [];
  return workspaces.filter((w) => (w.projects?.length ?? 0) > 0 && (!agent.workspaceId || w.id === agent.workspaceId));
}

/** The project a chat works on: its own when the agent may work on it, else the agent's. */
export function effectiveProject(
  agent: Pick<Agent, "workspaceId" | "projectId"> | undefined,
  chatProjectId: string | null,
  index: Map<string, ProjectEntry>,
): ProjectEntry | null {
  for (const id of [chatProjectId, agent?.projectId]) {
    const entry = id ? index.get(id) : undefined;
    if (entry && agent && (!agent.workspaceId || entry.workspace.id === agent.workspaceId)) return entry;
  }
  return null;
}
