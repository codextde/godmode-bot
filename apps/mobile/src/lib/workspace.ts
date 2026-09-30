import { useQuery } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { Agent, Workspace } from "@godmode/shared";
import { api } from "./api";
import { qk } from "./query";

const KEY = "godmode.workspace";

interface WorkspaceState {
  /** The workspace picked on this phone; null = all workspaces. */
  id: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  select: (id: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  id: null,
  loaded: false,
  load: async () => {
    const id = await SecureStore.getItemAsync(KEY).catch(() => null);
    set({ id: id || null, loaded: true });
  },
  select: (id) => {
    set({ id });
    void (id ? SecureStore.setItemAsync(KEY, id) : SecureStore.deleteItemAsync(KEY)).catch(() => undefined);
  },
}));

/** The picked workspace (null for all of them) and the list to pick from. A workspace deleted on the computer falls back to all. */
export function useWorkspace() {
  const picked = useWorkspaceStore((s) => s.id);
  const loaded = useWorkspaceStore((s) => s.loaded);
  const list = useQuery({ queryKey: qk.workspaces, queryFn: api.workspaces });
  const workspaces = useMemo(() => list.data ?? [], [list.data]);
  const workspace: Workspace | null = workspaces.find((w) => w.id === picked) ?? null;

  useEffect(() => {
    if (!loaded) void useWorkspaceStore.getState().load();
  }, [loaded]);

  useEffect(() => {
    if (picked && list.isSuccess && !workspace) useWorkspaceStore.getState().select(null);
  }, [picked, list.isSuccess, workspace]);

  // Until the list confirms it, keep scoping to the saved workspace so nothing flashes unscoped.
  const id = list.isSuccess ? (workspace?.id ?? null) : picked;
  return { id, workspace, workspaces, select: useWorkspaceStore.getState().select };
}

/**
 * Agents that can work in the workspace: its own first, then the global ones (their chats and tasks then belong to the
 * workspace). All agents when no workspace is picked.
 */
export function agentsFor(agents: Agent[], workspaceId: string | null): Agent[] {
  if (!workspaceId) return agents;
  return [...agents.filter((a) => a.workspaceId === workspaceId), ...agents.filter((a) => !a.workspaceId)];
}
