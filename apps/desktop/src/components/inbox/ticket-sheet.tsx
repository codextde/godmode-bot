import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Archive } from "lucide-react";
import type { Agent, Task, TaskStatus, Workspace } from "@godmode/shared";
import { mergesOnApprove } from "@godmode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useApproveTask, useArchiveTasks } from "@/components/tasks/task-actions";
import { needsConfirm } from "@/components/tasks/task-meta";
import { TaskSheet } from "@/components/tasks/task-sheet";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { upsertTask } from "@/lib/realtime";

/** Approve, move or reassign a ticket from Needs you, without leaving the page. */
export function useTicketActions() {
  const { t } = useTranslation(["tasks", "common"]);
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.attention });
    void qc.invalidateQueries({ queryKey: qk.bootstrap });
  };
  const move = useMutation({
    mutationFn: ({ task, status }: { task: Task; status: TaskStatus }) => api.tasks.update(task.id, { status }),
    onSuccess: (updated) => upsertTask(qc, updated),
    onError: (e) => toastApiError(e, t("page.moveError"), qc),
    onSettled: refresh,
  });
  const merge = useApproveTask((task) => move.mutate({ task, status: "done" }), refresh);
  const approve = (task: Task) => {
    if (mergesOnApprove(task)) return merge.mutate(task);
    move.mutate({ task, status: "done" });
    toast.success(t("sheet.approvedToast", { number: task.number }), { action: { label: t("common:actions.undo"), onClick: () => move.mutate({ task, status: "in_review" }) } });
  };
  const reassign = useMutation({
    mutationFn: ({ task, agentId }: { task: Task; agentId: string | null }) => api.tasks.update(task.id, { agentId }),
    onSuccess: (updated) => upsertTask(qc, updated),
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      toastApiError(e, t("page.reassignError"), qc);
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (task: Task) => api.tasks.delete(task.id),
    onSuccess: (_r, task) => {
      qc.setQueriesData<Task[]>({ queryKey: qk.tasks }, (list) => list?.filter((x) => x.id !== task.id));
      toast.success(t("page.deleted", { number: task.number }));
    },
    onError: (e) => toastApiError(e, t("page.deleteError"), qc),
    onSettled: refresh,
  });
  const approving = merge.isPending ? merge.variables?.id : move.isPending && move.variables?.status === "done" ? move.variables.task.id : undefined;
  return { approve, approving, merge, move, reassign, remove };
}

/** The ticket's own sheet on top of Needs you. What needs a stop confirmation stays on Agent tasks, where that dialog lives. */
export function TicketSheet({ taskId, agents, workspaces, onClose }: { taskId: string | null; agents: Agent[]; workspaces: Map<string, Workspace>; onClose: () => void }) {
  const { t } = useTranslation(["tasks", "common"]);
  const navigate = useNavigate();
  const { setArchived } = useArchiveTasks();
  const actions = useTicketActions();
  const [deleting, setDeleting] = useState<Task | null>(null);
  const { data: tasks } = useQuery({ queryKey: qk.taskList("all"), queryFn: () => api.tasks.list({ workspaceId: "all" }), staleTime: 30_000, enabled: !!taskId });
  const task = taskId ? (tasks?.find((x) => x.id === taskId) ?? null) : null;
  const toTicketPage = (x: Task) => navigate(`/tasks?task=${x.id}`);

  return (
    <>
      <TaskSheet
        task={task}
        agents={agents}
        workspaces={workspaces}
        onClose={onClose}
        onMove={(x, status, merge) => {
          if (merge && status === "done" && mergesOnApprove(x)) actions.merge.mutate(x);
          else if (needsConfirm(x) && status !== "in_progress") toTicketPage(x);
          else actions.move.mutate({ task: x, status });
        }}
        onArchive={(x, archived) => (archived && needsConfirm(x) ? toTicketPage(x) : setArchived(x, archived))}
        onDelete={setDeleting}
        onReassign={(x, agentId) => {
          if (agentId === x.agentId) return;
          if (needsConfirm(x)) toTicketPage(x);
          else actions.reassign.mutate({ task: x, agentId });
        }}
      />
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("page.deleteTitle", { number: deleting?.number })}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.branch ? t("page.deleteTextBranch") : t("page.deleteText")}
              {deleting && !deleting.archivedAt && ` ${t("page.deleteArchiveHint")}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            {deleting && !deleting.archivedAt && !needsConfirm(deleting) && (
              <AlertDialogCancel
                onClick={() => {
                  setArchived(deleting, true);
                  setDeleting(null);
                }}
              >
                <Archive /> {t("page.archiveInstead")}
              </AlertDialogCancel>
            )}
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) {
                  actions.remove.mutate(deleting);
                  onClose();
                }
                setDeleting(null);
              }}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
