import type { SpendPeriod } from "@godmode/shared";
import { useQuery } from "@tanstack/react-query";
import { BUILTIN_MODELS, type ModelCatalog } from "@godmode/shared";
import { api, type ScopeFilter } from "./api";
import { withPending } from "./pending-queue";
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

/** The workspace picked in the sidebar; null for "All workspaces" and "Global". */
export function useScopeWorkspace() {
  const scope = useUi((s) => s.workspace);
  const { data } = useWorkspaces();
  return data?.find((w) => w.id === scope) ?? null;
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

export function useArchivedConversations(agentId?: string, search = "", { enabled = true, limit = 200 } = {}) {
  return useQuery({
    queryKey: [...qk.archivedConversations(agentId ?? "all", search), limit],
    queryFn: () => api.conversations.list({ agentId, search, limit, archived: true }),
    enabled,
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: qk.conversation(id ?? ""),
    queryFn: async () => {
      const conversation = await api.conversations.get(id!);
      return { ...conversation, queue: withPending(conversation.id, conversation.queue) };
    },
    enabled: !!id,
  });
}

const BUILTIN_CATALOG: ModelCatalog = { models: BUILTIN_MODELS, source: "builtin", claudeVersion: null, fetchedAt: "", error: null };

/** Models offered by the installed Claude Code; the built-in list until it answers. */
export function useModelCatalog() {
  const { data, isPending } = useQuery({ queryKey: qk.models, queryFn: () => api.models.get(), staleTime: 5 * 60_000 });
  return { catalog: data ?? BUILTIN_CATALOG, isPending };
}

export function useVaultStatus() {
  return useQuery({ queryKey: qk.vaultStatus, queryFn: api.vault.status });
}

/** What agents asked the human; "open" ones keep a run standing still until they are answered. */
export function useSpend(period: SpendPeriod, agentId?: string | null) {
  return useQuery({ queryKey: qk.spendReport(period, agentId ?? null), queryFn: () => api.spend.report(period, agentId) });
}

export function useAttention() {
  return useQuery({ queryKey: qk.attention, queryFn: api.attention, staleTime: 2_000 });
}

/** What the team did while the human was away (null = not asked). */
export function useAway(away: { since: string; until: string } | null) {
  return useQuery({
    queryKey: qk.away(away?.since ?? "", away?.until ?? ""),
    queryFn: () => api.away(away!.since, away!.until),
    enabled: !!away,
    staleTime: 60_000,
  });
}

export function useBudgets() {
  return useQuery({ queryKey: qk.budgets, queryFn: api.budgets.get });
}

export function useQuestions(status = "open") {
  return useQuery({ queryKey: [...qk.questions, status], queryFn: () => api.questions.list({ status }) });
}

export function useMissingLogins(status = "open") {
  return useQuery({ queryKey: [...qk.missingLogins, status], queryFn: () => api.missingLogins.list({ status }) });
}

/** Tasks of the board in the sidebar scope (or the given one). */
export function useTasks(workspaceId?: ScopeFilter) {
  const scope = useUi((s) => s.workspace);
  const ws = workspaceId ?? scope;
  return useQuery({ queryKey: qk.taskList(ws), queryFn: () => api.tasks.list({ workspaceId: ws }) });
}

/** A ticket's timeline, kept current by `task.event`. */
export function useTaskEvents(taskId: string) {
  return useQuery({ queryKey: qk.taskEvents(taskId), queryFn: () => api.tasks.events(taskId) });
}

export function useArchivedTasks(workspaceId?: ScopeFilter) {
  const scope = useUi((s) => s.workspace);
  const ws = workspaceId ?? scope;
  return useQuery({ queryKey: qk.archivedTaskList(ws), queryFn: () => api.tasks.list({ workspaceId: ws, archived: true }) });
}

/** Resolve the workspace name for display. */
export function useWorkspaceName(id: string | null | undefined): string {
  const { data } = useWorkspaces();
  if (!id) return "Global";
  return data?.find((w) => w.id === id)?.name ?? "Workspace";
}

/** Every pending follow-up, soonest first. */
export function useFollowups() {
  return useQuery({ queryKey: qk.followups, queryFn: () => api.followups.list() });
}

/** Routines, optionally for a single agent ("all" = every agent). */
export function useRoutines(agentId: string = "all") {
  return useQuery({
    queryKey: qk.routineList(agentId),
    queryFn: () => api.routines.list(agentId === "all" ? {} : { agentId }),
  });
}

/** Recent events of one automation (what started it), newest first. Kept live by realtime.ts. */
export function useRoutineEvents(routineId: string, { limit = 50, enabled = true } = {}) {
  return useQuery({
    queryKey: qk.automationEventList(routineId, limit),
    queryFn: () => api.routines.events(routineId, { limit }),
    enabled,
  });
}

/** Recent events across every automation, newest first. */
export function useAutomationEvents(limit = 20) {
  return useQuery({ queryKey: qk.automationEventList("all", limit), queryFn: () => api.automationEvents.list({ limit }) });
}

/** Composio trigger types (events) a toolkit offers; `null` toolkit = disabled. */
export function useComposioTriggerTypes(toolkit: string | null) {
  return useQuery({
    queryKey: qk.composioTriggerTypes(toolkit ?? ""),
    queryFn: () => api.composio.triggerTypes(toolkit!),
    enabled: !!toolkit,
    staleTime: 10 * 60_000,
  });
}

/** A single Composio trigger type by slug (for automations whose type isn't in the toolkit list anymore). */
export function useComposioTriggerType(slug: string | null, enabled = true) {
  return useQuery({
    queryKey: qk.composioTriggerType(slug ?? ""),
    queryFn: () => api.composio.triggerType(slug!),
    enabled: enabled && !!slug,
    staleTime: 10 * 60_000,
  });
}

/** Recent runs filtered by agent / status ("all" = no filter). */
export function useRuns(agentId: string = "all", status: string = "all", limit = 200) {
  return useQuery({
    queryKey: qk.runList(agentId, status),
    queryFn: () =>
      api.runs.list({ agentId: agentId === "all" ? undefined : agentId, status: status === "all" ? undefined : status, limit }),
  });
}

/** macOS VM support, Tart, image presets and host resources (GET /api/vms/status). */
export function useVmStatus(enabled = true) {
  return useQuery({ queryKey: qk.vmStatus, queryFn: api.vms.status, enabled, staleTime: 10_000 });
}

/** Every macOS VM; kept live (progress included) by `vm.updated` events in realtime.ts. */
export function useVms(enabled = true) {
  return useQuery({ queryKey: qk.vmList, queryFn: api.vms.list, enabled });
}

/**
 * VMs for assignment controls (agent form, chat composer, workspace dialog): `available` is false when VMs are turned
 * off in settings or this machine can't run them — callers then hide their VM controls entirely.
 */
export function useVmChoices() {
  const { data: boot } = useBootstrap();
  const enabled = boot?.settings.vm?.enabled ?? false;
  const status = useVmStatus(enabled);
  const available = enabled && status.data?.supported === true;
  const list = useVms(available);
  return { available, vms: list.data ?? [], isLoading: list.isLoading };
}

/** SSH servers agents and chats can use (kept current by `entity.changed` "ssh-servers"). */
export function useSshServers() {
  return useQuery({ queryKey: qk.sshServers, queryFn: api.ssh.list });
}

/** Runners: other computers that work for this one. Kept live by `runner.updated` events in realtime.ts. */
export function useRunners() {
  return useQuery({ queryKey: qk.runners, queryFn: api.runners.list });
}

export function useAgentTemplates() {
  return useQuery({ queryKey: qk.agentTemplates, queryFn: api.agents.templates, staleTime: 5 * 60_000 });
}
