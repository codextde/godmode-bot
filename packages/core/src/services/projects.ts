/**
 * Projects: an optional level inside a workspace with its own context, folders, repositories and browser profile.
 * Chats, tickets and agents may belong to one; their runs get the workspace's setup plus the project's.
 */
import type { Agent, Project, ProjectInput, WorkspaceSource } from "@godmode/shared";
import { all, get, insert, run, tx, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { badRequest, newId, notFound, now, slugify } from "../util";
import { gitSourceRows, listSources, setSources, trashClones } from "./workspaceSources";

const log = logger("projects");

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string;
  color: string;
  icon: string;
  instructions: string;
  browser_profile_id: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_ICON = "📁";

function toModel(r: ProjectRow, sources: WorkspaceSource[] = listSources(r.workspace_id, r.id)): Project {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    color: r.color,
    icon: r.icon,
    instructions: r.instructions,
    browserProfileId: r.browser_profile_id ?? null,
    sources,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function uniqueSlug(workspaceId: string, name: string, selfId?: string): string {
  const base = slugify(name);
  let candidate = base;
  for (let i = 2; get("SELECT id FROM projects WHERE workspace_id = ? AND slug = ? AND id IS NOT ?", workspaceId, candidate, selfId ?? null); i++) {
    candidate = `${base}-${i}`;
  }
  return candidate;
}

function cleanName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw badRequest("Project name is required");
  return trimmed;
}

/** A global profile or one of the project's workspace; null/"" = the workspace's default. */
function cleanProfile(workspaceId: string, value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const id = value?.trim() || null;
  if (!id) return null;
  const profile = get<{ workspace_id: string | null }>("SELECT workspace_id FROM browser_profiles WHERE id = ?", id);
  if (!profile) throw badRequest("That browser profile doesn't exist anymore");
  if (profile.workspace_id && profile.workspace_id !== workspaceId) throw badRequest("Pick a global browser profile or one of this workspace's");
  return id;
}

/** Projects by workspace id, A–Z, with their sources (`sources` by project id). */
export function projectsByWorkspace(sources: Map<string, WorkspaceSource[]>): Map<string, Project[]> {
  const out = new Map<string, Project[]>();
  for (const r of all<ProjectRow>("SELECT * FROM projects ORDER BY name COLLATE NOCASE ASC")) {
    const list = out.get(r.workspace_id) ?? [];
    list.push(toModel(r, sources.get(r.id) ?? []));
    out.set(r.workspace_id, list);
  }
  return out;
}

export function listProjects(workspaceId?: string): Project[] {
  const rows = workspaceId
    ? all<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? ORDER BY name COLLATE NOCASE ASC", workspaceId)
    : all<ProjectRow>("SELECT * FROM projects ORDER BY name COLLATE NOCASE ASC");
  return rows.map((r) => toModel(r));
}

export function getProject(id: string): Project {
  const row = get<ProjectRow>("SELECT * FROM projects WHERE id = ?", id);
  if (!row) throw notFound("Project");
  return toModel(row);
}

function changed() {
  // Projects travel with their workspace (Workspace.projects).
  bus.changed("workspaces");
}

export function createProject(input: ProjectInput): Project {
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId || !get("SELECT id FROM workspaces WHERE id = ?", workspaceId)) throw badRequest("Workspace not found");
  const name = cleanName(input.name);
  const ts = now();
  const row: ProjectRow = {
    id: newId("prj"),
    workspace_id: workspaceId,
    name,
    slug: uniqueSlug(workspaceId, name),
    description: input.description?.trim() ?? "",
    color: input.color?.trim() || "violet",
    icon: input.icon?.trim() || DEFAULT_ICON,
    instructions: input.instructions?.trim() ?? "",
    browser_profile_id: cleanProfile(workspaceId, input.browserProfileId) ?? null,
    created_at: ts,
    updated_at: ts,
  };
  const apply = tx(() => {
    insert("projects", { ...row });
    return input.sources ? setSources(workspaceId, input.sources, row.id) : undefined;
  });
  apply?.();
  changed();
  return getProject(row.id);
}

export function updateProject(id: string, patch: Partial<Omit<ProjectInput, "workspaceId">>): Project {
  const current = getProject(id);
  const name = patch.name !== undefined ? cleanName(patch.name) : undefined;
  const apply = tx(() => {
    update("projects", id, {
      name,
      slug: name !== undefined && name !== current.name ? uniqueSlug(current.workspaceId, name, id) : undefined,
      description: patch.description?.trim(),
      color: patch.color !== undefined ? patch.color.trim() || "violet" : undefined,
      icon: patch.icon !== undefined ? patch.icon.trim() || DEFAULT_ICON : undefined,
      instructions: patch.instructions?.trim(),
      browser_profile_id: cleanProfile(current.workspaceId, patch.browserProfileId),
      updated_at: now(),
    });
    return patch.sources ? setSources(current.workspaceId, patch.sources, id) : undefined;
  });
  apply?.();
  changed();
  return getProject(id);
}

/** Delete a project. Its chats, tickets and agents stay in the workspace; its clones go to the trash. */
export async function deleteProject(id: string): Promise<void> {
  const project = getProject(id);
  const clones = gitSourceRows(project.workspaceId, id);
  let moved = { agents: 0, tasks: 0 };
  tx(() => {
    moved = {
      agents: run("UPDATE agents SET project_id = NULL WHERE project_id = ?", id).changes,
      tasks: run("UPDATE tasks SET project_id = NULL WHERE project_id = ?", id).changes,
    };
    run("UPDATE conversations SET project_id = NULL WHERE project_id = ?", id);
    run("DELETE FROM workspace_sources WHERE project_id = ?", id);
    run("DELETE FROM projects WHERE id = ?", id);
  });
  await trashClones(clones);
  log.info(`deleted project ${project.slug}`);
  changed();
  if (moved.agents) bus.changed("agents");
  if (moved.tasks) bus.changed("tasks");
}

/** Validate a project id for something in `workspaceId` (null = global, which can't have one). */
export function checkProject(projectId: string | null | undefined, workspaceId: string | null): string | null {
  const id = projectId?.trim() || null;
  if (!id) return null;
  const row = get<{ workspace_id: string }>("SELECT workspace_id FROM projects WHERE id = ?", id);
  if (!row) throw badRequest("That project doesn't exist anymore");
  if (row.workspace_id !== workspaceId) throw badRequest("Pick a project of the same workspace");
  return id;
}

/** What a run needs to know about its project. */
export interface RunProject {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  browserProfileId: string | null;
}

/**
 * The project a chat works on: its own (one of the agent's workspace — any for a global agent), else the agent's.
 * null = none.
 */
export function projectOfChat(conversationId: string | null | undefined, agent: Pick<Agent, "workspaceId" | "projectId">): RunProject | null {
  const chosen = conversationId ? get<{ project_id: string | null }>("SELECT project_id FROM conversations WHERE id = ?", conversationId)?.project_id : null;
  for (const id of [chosen, agent.projectId]) {
    if (!id) continue;
    const row = get<ProjectRow>("SELECT * FROM projects WHERE id = ?", id);
    if (!row || (agent.workspaceId && row.workspace_id !== agent.workspaceId)) continue;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      browserProfileId: row.browser_profile_id ?? null,
    };
  }
  return null;
}

/** Folders and repositories a chat's runs work with: its workspace's and its project's. */
export function chatSources(conversationId: string | null | undefined, agent: Pick<Agent, "workspaceId" | "projectId">): WorkspaceSource[] {
  const project = projectOfChat(conversationId, agent);
  return [...(agent.workspaceId ? listSources(agent.workspaceId) : []), ...(project ? listSources(project.workspaceId, project.id) : [])];
}

export function chatSourcePaths(conversationId: string | null | undefined, agent: Pick<Agent, "workspaceId" | "projectId">): string[] {
  return chatSources(conversationId, agent).map((s) => s.path);
}
