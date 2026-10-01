import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Task } from "@godmode/shared";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { upsertTask } from "@/lib/realtime";

interface ArchiveVars {
  tasks: Task[];
  archived: boolean;
  /** Undoing: the tasks as they were before, back to their own status. */
  undoOf?: Task[];
}

function topOfColumn(qc: QueryClient, task: Task): number {
  const positions = qc
    .getQueriesData<Task[]>({ queryKey: [...qk.tasks, "list"] })
    .flatMap(([, list]) => list ?? [])
    .filter((t) => t.id !== task.id && t.workspaceId === task.workspaceId && t.status === task.status)
    .map((t) => t.position);
  return (positions.length ? Math.min(...positions) : 1024) - 1024;
}

/** Take tasks off the board or bring them back. They move right away; the toast offers undo. */
export function useArchiveTasks() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async ({ tasks, archived, undoOf }: ArchiveVars): Promise<Task[]> => {
      if (undoOf) {
        const out: Task[] = [];
        for (const t of [...undoOf].reverse()) out.unshift(await api.tasks.update(t.id, { archived, status: t.status }));
        return out;
      }
      if (tasks.length === 1) return [await api.tasks.update(tasks[0]!.id, { archived })];
      return api.tasks.archive(
        tasks.map((t) => t.id),
        archived,
      );
    },
    onMutate: async ({ tasks, archived, undoOf }) => {
      await qc.cancelQueries({ queryKey: qk.tasks });
      const archivedAt = archived ? new Date().toISOString() : null;
      // Restored tasks land on top of their column, the first one highest.
      for (const t of [...(undoOf ?? tasks)].reverse()) upsertTask(qc, { ...t, archivedAt, position: archived ? t.position : topOfColumn(qc, t) });
    },
    onSuccess: (updated, { tasks, archived, undoOf }) => {
      for (const t of updated) upsertTask(qc, t);
      if (undoOf) return;
      const one = tasks.length === 1 ? tasks[0]! : null;
      toast.success(`${one ? `#${one.number}` : `${tasks.length} tasks`} ${archived ? "archived" : "back on the board"}`, {
        description: one?.title,
        action: { label: "Undo", onClick: () => mutation.mutate({ tasks: updated, archived: !archived, undoOf: tasks }) },
      });
    },
    onError: (e, { archived }) => toastApiError(e, archived ? "Could not archive" : "Could not restore", qc),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.tasks }),
  });
  return {
    setArchived: (tasks: Task | Task[], archived: boolean) => mutation.mutate({ tasks: Array.isArray(tasks) ? tasks : [tasks], archived }),
  };
}
