import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Agent, HumanTask } from "@godmode/shared";
import { api } from "./api";
import { qk } from "./query";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** One page of chats for every list that shows them (Home, Chats, live runs, screens), so they share one request. */
export const CHAT_LIST_LIMIT = 200;

export function chatListQuery(workspaceId: string | null) {
  return { queryKey: qk.conversationList("", workspaceId), queryFn: () => api.conversations.list({ limit: CHAT_LIST_LIMIT, workspaceId }) };
}

export function useAgents() {
  const query = useQuery({ queryKey: qk.agents, queryFn: api.agents.list });
  const byId = useMemo(() => new Map<string, Agent>((query.data ?? []).map((a) => [a.id, a])), [query.data]);
  return { ...query, byId };
}

// A ticket that stands for a question shows as the question wherever this list is used.
const urgentFirst = (list: HumanTask[]) => list.filter((t) => !t.questionId).sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high") || (a.createdAt < b.createdAt ? 1 : -1));

/** Tasks agents handed to the human and decisions they left open that still wait (open or doing), most urgent first. */
export function useOpenHumanTasks() {
  return useQuery({ queryKey: qk.humanTaskList("active"), queryFn: () => api.humanTasks.list({ status: "active" }), select: urgentFirst });
}
