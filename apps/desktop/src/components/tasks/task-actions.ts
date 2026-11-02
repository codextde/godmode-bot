import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { Task } from "@godmode/shared";
import { toastApiError } from "@/components/vault/vault-utils";
import { ApiRequestError, api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { upsertTask } from "@/lib/realtime";
import { APPROVE_KEY } from "./task-meta";

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
  const { t } = useTranslation(["tasks", "common"]);
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
      const title = one
        ? archived
          ? t("archive.oneArchived", { number: one.number })
          : t("archive.oneRestored", { number: one.number })
        : archived
          ? t("archive.manyArchived", { count: tasks.length })
          : t("archive.manyRestored", { count: tasks.length });
      toast.success(title, {
        description: one?.title,
        action: { label: t("common:actions.undo"), onClick: () => mutation.mutate({ tasks: updated, archived: !archived, undoOf: tasks }) },
      });
    },
    onError: (e, { archived }) => toastApiError(e, archived ? t("archive.archiveError") : t("archive.restoreError"), qc),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.tasks }),
  });
  return {
    setArchived: (tasks: Task | Task[], archived: boolean) => mutation.mutate({ tasks: Array.isArray(tasks) ? tasks : [tasks], archived }),
  };
}

/** Approving a ticket with an open pull request merges it: it moves to Done once that worked. */
export function useApproveTask(markDone: (task: Task) => void, onSettled?: () => void) {
  const { t } = useTranslation("tasks");
  const qc = useQueryClient();
  return useMutation({
    mutationKey: APPROVE_KEY,
    mutationFn: (task: Task) => api.tasks.approve(task.id),
    onSuccess: (updated, task) => {
      upsertTask(qc, updated);
      const pr = task.pullRequest?.number;
      if (updated.pullRequest?.state === "merged") {
        toast.success(t("page.mergedInto", { number: updated.number, branch: updated.baseBranch }), {
          description: updated.status === "done" ? t("page.prMergedDone", { number: pr }) : t("page.prMerged", { number: pr }),
        });
      } else toast.info(t("page.queuedToMerge", { number: pr }), { description: t("page.queuedToMergeDescription") });
    },
    onError: (e, task) => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      if (!(e instanceof ApiRequestError && e.code === "merge_failed")) return toastApiError(e, t("page.approveError"), qc);
      toast.error(t("page.mergeError", { number: task.pullRequest?.number }), {
        description: e.message,
        duration: 12_000,
        action: { label: t("page.markDoneAnyway"), onClick: () => markDone(task) },
      });
    },
    onSettled,
  });
}
