import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { AttentionItem, Routine } from "@godmode/shared";
import { api, ApiError } from "./api";
import { needsYou, type Need } from "./desktop-parity";
import { useAgents, useOpenHumanTasks } from "./hooks";
import { t } from "./i18n";
import { qk } from "./query";

/** The computer's attention list; an older Godmode that doesn't share it with phones adds nothing. */
export function useAttention() {
  return useQuery({
    queryKey: qk.attention,
    queryFn: async (): Promise<AttentionItem[]> => {
      try {
        return await api.attention();
      } catch (err) {
        if (err instanceof ApiError && err.code === "device_forbidden") return [];
        throw err;
      }
    },
  });
}

/**
 * Everything that waits for the human, from every workspace, in the desktop's order. `logins`: missing logins as rows
 * (the Inbox shows them as cards of their own).
 */
export function useNeeds({ logins = true }: { logins?: boolean } = {}) {
  const { byId: agents } = useAgents();
  const questions = useQuery({ queryKey: qk.questions, queryFn: api.questions.open });
  const humanTasks = useOpenHumanTasks();
  const missing = useQuery({ queryKey: qk.missingLogins, queryFn: api.missingLogins.open });
  const tasks = useQuery({ queryKey: qk.taskList(null), queryFn: () => api.tasks.list({}) });
  const attention = useAttention();
  const automationNeeded = (attention.data ?? []).some((a) => a.kind === "automation");
  const routines = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list(), enabled: automationNeeded });

  const items = useMemo<Need[]>(() => {
    const names = new Map((routines.data ?? []).map((r: Routine) => [r.id, r.name]));
    return needsYou({
      questions: questions.data ?? [],
      humanTasks: humanTasks.data ?? [],
      missing: logins ? (missing.data ?? []) : [],
      tasks: tasks.data ?? [],
      attention: attention.data,
      nameOf: (id) => (id ? (agents.get(id)?.name ?? t("tabs:home.needs.anAgent")) : t("tabs:home.needs.anAgent")),
      routineName: (id) => names.get(id),
      workspaceOf: (id) => (id ? (agents.get(id)?.workspaceId ?? null) : null),
    });
  }, [questions.data, humanTasks.data, missing.data, tasks.data, attention.data, routines.data, agents, logins]);

  const refetch = () => Promise.all([questions.refetch(), humanTasks.refetch(), missing.refetch(), tasks.refetch(), attention.refetch()]);
  return {
    items,
    missing,
    loading: questions.isLoading && humanTasks.isLoading && missing.isLoading,
    refetch,
  };
}
