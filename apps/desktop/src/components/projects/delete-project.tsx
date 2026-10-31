import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { Project } from "@godmode/shared";
import { ConfirmDialog } from "@/components/integrations/confirm-dialog";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useUi } from "@/stores/ui";

export function DeleteProjectDialog({
  project,
  workspaceName,
  open,
  onOpenChange,
  onDeleted,
}: {
  project: Project;
  workspaceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation("projects");
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.projects.delete(project.id),
    onSuccess: () => {
      const { workspace, project: scoped, setWorkspace } = useUi.getState();
      if (workspace === project.workspaceId && scoped === project.id) setWorkspace(project.workspaceId);
      void qc.invalidateQueries({ queryKey: qk.workspaces });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      toast.success(t("dialog.deleted", { name: project.name }), { description: t("dialog.deletedDescription", { workspace: workspaceName }) });
      onDeleted?.();
    },
    onError: (e) => toastApiError(e, t("dialog.deleteFailed"), qc),
  });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("dialog.deleteTitle", { name: project.name })}
      description={t("dialog.deleteDescription", { workspace: workspaceName })}
      confirmLabel={t("dialog.deleteConfirm")}
      onConfirm={() => remove.mutate()}
    />
  );
}
