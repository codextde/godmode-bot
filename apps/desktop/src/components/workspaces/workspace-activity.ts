import { useMemo } from "react";
import type { AttentionItem } from "@godmode/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { chatProject, useAllAgents, useAttention, useConversations, useScopeProject } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { useLive } from "@/stores/live";
import { useUi } from "@/stores/ui";

export interface WorkspaceActivity {
  /** Runs working or queued right now. */
  running: number;
  /** Questions, reviews, missing logins… waiting for the human. */
  needsYou: number;
  /** Tickets not done, cancelled or archived. */
  openTasks: number;
  agents: number;
  /** Last message in one of its chats. */
  lastActive: string | null;
}

const EMPTY: WorkspaceActivity = { running: 0, needsYou: 0, openTasks: 0, agents: 0, lastActive: null };

/** Key of a project's activity in `useWorkspaceActivity`. */
export const projectKey = (id: string) => `p:${id}`;

/** What happens in each workspace, keyed by workspace id ("global" for the shared scope), and in each project (`projectKey`). */
export function useWorkspaceActivity(): { of: (scope: string | null) => WorkspaceActivity; total: WorkspaceActivity } {
  const { data: agents } = useAllAgents();
  const { data: conversations } = useConversations();
  const { data: attention } = useAttention();
  const { data: tasks } = useQuery({ queryKey: qk.taskList("all"), queryFn: () => api.tasks.list({ workspaceId: "all" }), staleTime: 30_000 });
  const runs = useLive((s) => s.runs);

  const map = useMemo(() => {
    const out = new Map<string, WorkspaceActivity>();
    const at = (ws: string | null | undefined) => {
      const key = ws ?? "global";
      let entry = out.get(key);
      if (!entry) out.set(key, (entry = { ...EMPTY }));
      return entry;
    };
    // Projects are counted on their own as well: never in the totals (see `total`).
    const projectAt = (id: string | null | undefined) => {
      if (!id) return null;
      let entry = out.get(projectKey(id));
      if (!entry) out.set(projectKey(id), (entry = { ...EMPTY }));
      return entry;
    };
    const agentWs = new Map((agents ?? []).map((a) => [a.id, a.workspaceId ?? null]));
    const agentProject = new Map((agents ?? []).map((a) => [a.id, a.projectId ?? null]));
    const chatWs = new Map<string, string | null>();
    const chatProject = new Map<string, string | null>();
    for (const a of agents ?? []) {
      at(a.workspaceId).agents++;
      const p = projectAt(a.projectId);
      if (p) p.agents++;
    }
    for (const c of conversations ?? []) {
      const ws = c.workspaceId ?? agentWs.get(c.agentId) ?? null;
      chatWs.set(c.id, ws);
      chatProject.set(c.id, c.projectId ?? agentProject.get(c.agentId) ?? null);
      const last = c.lastMessageAt ?? c.createdAt;
      for (const entry of [at(ws), projectAt(chatProject.get(c.id))]) if (entry && (!entry.lastActive || last > entry.lastActive)) entry.lastActive = last;
    }
    for (const r of Object.values(runs)) {
      if (r.status !== "running" && r.status !== "queued") continue;
      at(chatWs.has(r.conversationId) ? chatWs.get(r.conversationId) : agentWs.get(r.agentId)).running++;
      const p = projectAt(chatProject.has(r.conversationId) ? chatProject.get(r.conversationId) : agentProject.get(r.agentId));
      if (p) p.running++;
    }
    for (const item of attention ?? []) {
      at(workspaceOfItem(item, chatWs, agentWs)).needsYou++;
      const p = projectAt(item.task ? item.task.projectId : item.conversationId && chatProject.has(item.conversationId) ? chatProject.get(item.conversationId) : item.agentId ? agentProject.get(item.agentId) : null);
      if (p) p.needsYou++;
    }
    for (const t of tasks ?? []) {
      if (t.archivedAt || t.status === "done" || t.status === "cancelled") continue;
      at(t.workspaceId).openTasks++;
      const p = projectAt(t.projectId);
      if (p) p.openTasks++;
    }
    return out;
  }, [agents, conversations, attention, tasks, runs]);

  const total = useMemo(() => {
    const sum = { ...EMPTY };
    for (const [key, a] of map) {
      if (key.startsWith("p:")) continue;
      sum.running += a.running;
      sum.needsYou += a.needsYou;
      sum.openTasks += a.openTasks;
      sum.agents += a.agents;
      if (a.lastActive && (!sum.lastActive || a.lastActive > sum.lastActive)) sum.lastActive = a.lastActive;
    }
    return sum;
  }, [map]);

  return useMemo(() => ({ of: (scope: string | null) => map.get(scope ?? "global") ?? EMPTY, total }), [map, total]);
}

function workspaceOfItem(item: AttentionItem, chatWs: Map<string, string | null>, agentWs: Map<string, string | null>): string | null {
  if (item.task) return item.task.workspaceId ?? null;
  if (item.conversationId && chatWs.has(item.conversationId)) return chatWs.get(item.conversationId) ?? null;
  return item.agentId ? (agentWs.get(item.agentId) ?? null) : null;
}

/** What waits for the human in the workspace picked in the sidebar, how many wait elsewhere, and where each one belongs. */
export function useScopedAttention() {
  const scope = useUi((s) => s.workspace);
  const project = useScopeProject();
  const { data: agents } = useAllAgents();
  const { data: conversations } = useConversations();
  const { data: attention = [] } = useAttention();
  return useMemo(() => {
    const agentWs = new Map((agents ?? []).map((a) => [a.id, a.workspaceId ?? null]));
    const chatWs = new Map((conversations ?? []).map((c) => [c.id, c.workspaceId ?? agentWs.get(c.agentId) ?? null]));
    const workspaceOf = (item: AttentionItem) => workspaceOfItem(item, chatWs, agentWs);
    const projectOf = (item: AttentionItem): string | null => {
      if (item.task) return item.task.projectId ?? null;
      const chat = item.conversationId ? conversations?.find((c) => c.id === item.conversationId) : undefined;
      if (chat) return chatProject(chat, agents);
      return item.agentId ? (agents?.find((a) => a.id === item.agentId)?.projectId ?? null) : null;
    };
    const target = scope === "global" ? null : scope;
    const items = scope === "all" ? attention : attention.filter((i) => workspaceOf(i) === target && (!project || projectOf(i) === project.id));
    return { items, elsewhere: attention.length - items.length, workspaceOf };
  }, [scope, project, agents, conversations, attention]);
}
