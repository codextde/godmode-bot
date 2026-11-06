import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ArchiveKind, ArchiveList } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useUi } from "@/stores/ui";

export interface ArchiveTarget {
  kind: ArchiveKind;
  id: string;
  name: string;
}

export function useArchiveList() {
  return useQuery({ queryKey: qk.archive, queryFn: api.archive.list });
}

export function archiveCount(list: ArchiveList | undefined): number {
  return list ? list.workspaces.length + list.projects.length + list.agents.length + list.routines.length : 0;
}

/** Archive or restore a workspace, project, agent or automation; archiving offers an undo. */
export function useArchive() {
  const { t } = useTranslation("archive");
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ target, archived }: { target: ArchiveTarget; archived: boolean }) => api.archive.set(target.kind, target.id, archived),
    onSuccess: (list, { target, archived }) => {
      qc.setQueryData(qk.archive, list);
      for (const key of [qk.workspaces, qk.agents, qk.routines, qk.conversationsAll, qk.tasks, qk.followups]) qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: qk.agent(target.id) });
      if (archived) {
        // The sidebar shouldn't stay on something that is gone from it.
        const ui = useUi.getState();
        if (target.kind === "workspace" && ui.workspace === target.id) ui.setWorkspace("all");
        if (target.kind === "project" && ui.project === target.id) ui.setWorkspace(ui.workspace);
        toast.success(t("toast.archived", { name: target.name }), {
          action: { label: t("toast.undo"), onClick: () => mutation.mutate({ target, archived: false }) },
        });
      } else {
        toast.success(t("toast.restored", { name: target.name }));
      }
    },
    onError: (err, { target, archived }) =>
      toast.error(t(archived ? "toast.archiveError" : "toast.restoreError", { name: target.name }), { description: errorMessage(err) }),
  });
  return {
    archive: (target: ArchiveTarget) => mutation.mutate({ target, archived: true }),
    restore: (target: ArchiveTarget) => mutation.mutate({ target, archived: false }),
    pending: mutation.isPending ? mutation.variables?.target.id : undefined,
  };
}
