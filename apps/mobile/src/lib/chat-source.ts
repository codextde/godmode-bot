import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { qk } from "./query";

/** The ticket a chat works on, on the board or in the archive; null while neither knows it. */
export function useChatTask(conversationId: string, enabled: boolean) {
  const board = useQuery({ queryKey: qk.taskList(null), queryFn: () => api.tasks.list({ workspaceId: null }), enabled });
  const onBoard = board.data?.find((task) => task.conversationId === conversationId);
  const archived = useQuery({ queryKey: qk.taskList(null, true), queryFn: () => api.tasks.list({ workspaceId: null, archived: true }), enabled: enabled && !!board.data && !onBoard });
  return onBoard ?? archived.data?.find((task) => task.conversationId === conversationId) ?? null;
}

export function useRoutine(id: string | null | undefined) {
  const routines = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list(), enabled: !!id });
  return routines.data?.find((routine) => routine.id === id) ?? null;
}

/** The automation that started a run; null for any other run. A run keeps its automation, whatever else it does. */
export function useRunRoutine(runId: string | null | undefined) {
  const routineId = useQuery({ queryKey: [...qk.run(runId ?? ""), "routine"], queryFn: () => api.runs.get(runId!).then((run) => run.routineId), enabled: !!runId, staleTime: Infinity, retry: false });
  return useRoutine(routineId.data);
}
