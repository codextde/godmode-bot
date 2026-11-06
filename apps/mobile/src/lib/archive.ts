import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert } from "react-native";
import type { ArchiveKind, ArchiveList } from "@godmode/shared";
import { api, errorText } from "./api";
import { t } from "./i18n";
import { qk, queryClient } from "./query";
import { useWorkspaceStore } from "./workspace";

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

/** Archive (after a confirm) or restore a workspace, project, agent or automation. */
export function useArchive(onArchived?: () => void) {
  const mutation = useMutation({
    mutationFn: ({ target, archived }: { target: ArchiveTarget; archived: boolean }) => api.archive.set(target.kind, target.id, archived),
    onSuccess: (list, { target, archived }) => {
      queryClient.setQueryData(qk.archive, list);
      for (const key of [qk.workspaces, qk.agents, qk.routines, qk.conversations, qk.tasks, qk.followups, qk.bootstrap]) void queryClient.invalidateQueries({ queryKey: key });
      if (!archived) return;
      // The phone shouldn't stay scoped to something that is gone from every list.
      const scope = useWorkspaceStore.getState();
      if (target.kind === "workspace" && scope.id === target.id) scope.select(null);
      if (target.kind === "project" && scope.projectId === target.id) scope.select(scope.id);
      onArchived?.();
    },
    onError: (err, { target, archived }) => Alert.alert(t(archived ? "archive:archiveError" : "archive:restoreError", { name: target.name }), errorText(err)),
  });
  return {
    archive: (target: ArchiveTarget) =>
      Alert.alert(t("archive:confirm.title", { name: target.name }), t("archive:confirm.body"), [
        { text: t("common:actions.cancel"), style: "cancel" },
        { text: t("archive:archive"), onPress: () => mutation.mutate({ target, archived: true }) },
      ]),
    restore: (target: ArchiveTarget) => mutation.mutate({ target, archived: false }),
    pending: mutation.isPending ? mutation.variables?.target.id : undefined,
  };
}
