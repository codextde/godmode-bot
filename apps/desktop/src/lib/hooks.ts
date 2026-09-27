import { useQuery } from "@tanstack/react-query";
import { api, type ScopeFilter } from "./api";
import { qk } from "./queryKeys";
import { useUi } from "@/stores/ui";

/** Shared, frequently used queries. Page-specific queries live next to their pages. */

export function useBootstrap() {
  return useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap, staleTime: 5_000 });
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
}

export function useWorkspaces() {
  return useQuery({ queryKey: qk.workspaces, queryFn: api.workspaces.list });
}

export function useAgents(workspaceId?: ScopeFilter) {
  const scope = useUi((s) => s.workspace);
  const ws = workspaceId ?? scope;
  return useQuery({ queryKey: qk.agentList(ws), queryFn: () => api.agents.list({ workspaceId: ws }) });
}

export function useAllAgents() {
  return useQuery({ queryKey: qk.agentList("all"), queryFn: () => api.agents.list({ workspaceId: "all" }) });
}

export function useAgent(id: string | undefined) {
  return useQuery({ queryKey: qk.agent(id ?? ""), queryFn: () => api.agents.get(id!), enabled: !!id });
}

export function useConversations(agentId?: string, search = "") {
  return useQuery({
    queryKey: qk.conversations(agentId ?? "all", search),
    queryFn: () => api.conversations.list({ agentId, search, limit: 100 }),
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({ queryKey: qk.conversation(id ?? ""), queryFn: () => api.conversations.get(id!), enabled: !!id });
}

export function useVaultStatus() {
  return useQuery({ queryKey: qk.vaultStatus, queryFn: api.vault.status });
}

export function useMissingLogins(status = "open") {
  return useQuery({ queryKey: [...qk.missingLogins, status], queryFn: () => api.missingLogins.list({ status }) });
}

/** Resolve the workspace name for display. */
export function useWorkspaceName(id: string | null | undefined): string {
  const { data } = useWorkspaces();
  if (!id) return "Global";
  return data?.find((w) => w.id === id)?.name ?? "Workspace";
}
