import { useQuery } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { Agent, Conversation, Project, Task, Workspace } from "@godmode/shared";
import { api } from "./api";
import { useAgents } from "./hooks";
import { type LiveRun, useLive } from "./live";
import { qk } from "./query";

const KEY = "godmode.workspace";
const PROJECT_KEY = "godmode.project";

interface WorkspaceState {
  /** The workspace picked on this phone; null = all workspaces. */
  id: string | null;
  /** A project of that workspace; null = the whole workspace. */
  projectId: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  select: (id: string | null, projectId?: string | null) => void;
}

const save = (key: string, value: string | null) =>
  void (value ? SecureStore.setItemAsync(key, value) : SecureStore.deleteItemAsync(key)).catch(() => undefined);

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  id: null,
  projectId: null,
  loaded: false,
  load: async () => {
    const [id, projectId] = await Promise.all([
      SecureStore.getItemAsync(KEY).catch(() => null),
      SecureStore.getItemAsync(PROJECT_KEY).catch(() => null),
    ]);
    set({ id: id || null, projectId: (id && projectId) || null, loaded: true });
  },
  select: (id, projectId = null) => {
    const project = id ? projectId : null;
    set({ id, projectId: project });
    save(KEY, id);
    save(PROJECT_KEY, project);
  },
}));

/**
 * The picked workspace (null for all of them), its picked project (null for the whole workspace) and the list to pick
 * from. A workspace or project deleted on the computer falls back to the next wider scope.
 */
export function useWorkspace() {
  const picked = useWorkspaceStore((s) => s.id);
  const pickedProject = useWorkspaceStore((s) => s.projectId);
  const loaded = useWorkspaceStore((s) => s.loaded);
  const list = useQuery({ queryKey: qk.workspaces, queryFn: api.workspaces });
  const workspaces = useMemo(() => list.data ?? [], [list.data]);
  const workspace: Workspace | null = workspaces.find((w) => w.id === picked) ?? null;
  const project: Project | null = (pickedProject && workspace?.projects?.find((p) => p.id === pickedProject)) || null;

  useEffect(() => {
    if (!loaded) void useWorkspaceStore.getState().load();
  }, [loaded]);

  useEffect(() => {
    if (!picked || !list.isSuccess) return;
    if (!workspace) useWorkspaceStore.getState().select(null);
    else if (pickedProject && !project) useWorkspaceStore.getState().select(workspace.id);
  }, [picked, pickedProject, list.isSuccess, workspace, project]);

  // Until the list confirms it, keep scoping to the saved workspace so nothing flashes unscoped.
  const id = list.isSuccess ? (workspace?.id ?? null) : picked;
  const projectId = list.isSuccess ? (project?.id ?? null) : pickedProject;
  return { id, projectId, workspace, project, workspaces, loading: list.isLoading, select: useWorkspaceStore.getState().select };
}

/** Every project by id, with its workspace. */
export function useProjectIndex() {
  const { workspaces } = useWorkspace();
  return useMemo(() => {
    const out = new Map<string, { project: Project; workspace: Workspace }>();
    for (const workspace of workspaces) for (const project of workspace.projects ?? []) out.set(project.id, { project, workspace });
    return out;
  }, [workspaces]);
}

/** Projects an agent may work on: its workspace's, or every workspace's for a global agent (only the picked one's then). */
export function projectsFor(agent: Pick<Agent, "workspaceId"> | undefined, workspaces: Workspace[], workspaceId: string | null): Project[] {
  if (!agent) return [];
  const home = agent.workspaceId ?? workspaceId;
  return workspaces.filter((w) => !home || w.id === home).flatMap((w) => w.projects ?? []);
}

/** The project a chat works on: its own, else its agent's. */
export function chatProject(conversation: Pick<Conversation, "projectId" | "agentId">, agents: Map<string, Agent>): string | null {
  return conversation.projectId ?? agents.get(conversation.agentId)?.projectId ?? null;
}

/** Chats of the picked project only, when one is picked. */
export function inProject<T extends Pick<Conversation, "projectId" | "agentId">>(list: T[], projectId: string | null, agents: Map<string, Agent>): T[] {
  return projectId ? list.filter((conv) => chatProject(conv, agents) === projectId) : list;
}

/** Tickets of the picked project only, when one is picked. */
export function tasksInProject(list: Task[], projectId: string | null): Task[] {
  return projectId ? list.filter((t) => t.projectId === projectId) : list;
}

/**
 * Agents that can work in the workspace: its own first, then the global ones (their chats and tasks then belong to the
 * workspace). All agents when no workspace is picked.
 */
export function agentsFor(agents: Agent[], workspaceId: string | null): Agent[] {
  if (!workspaceId) return agents;
  return [...agents.filter((a) => a.workspaceId === workspaceId), ...agents.filter((a) => !a.workspaceId)];
}

/** Live runs of the picked workspace (and project), newest first: its chats', and its agents' anywhere. All runs when none is picked. */
export function useWorkspaceRuns(): LiveRun[] {
  const { id, projectId } = useWorkspace();
  const runs = useLive((s) => s.runs);
  const { byId } = useAgents();
  const chats = useQuery({
    queryKey: qk.conversationList("", id),
    queryFn: () => api.conversations.list({ limit: 100, workspaceId: id }),
    enabled: !!id,
  });
  return useMemo(() => {
    const ids = new Set(inProject(chats.data ?? [], projectId, byId).map((c) => c.id));
    return Object.values(runs)
      .filter(({ run }) => {
        if (!id || ids.has(run.conversationId)) return true;
        const agent = byId.get(run.agentId);
        return agent?.workspaceId === id && (!projectId || agent.projectId === projectId);
      })
      .sort((a, b) => (a.run.createdAt < b.run.createdAt ? 1 : -1));
  }, [runs, id, projectId, chats.data, byId]);
}
