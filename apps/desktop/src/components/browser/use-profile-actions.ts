import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { BrowserProfile, Workspace } from "@godmode/shared";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { toastApiError } from "@/components/vault/vault-utils";
import { t } from "@/i18n";

/** Launch / stop / set default / rename / assign / delete for browser profiles, with toasts and cache refresh. */
export function useProfileActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.browserProfiles });

  const launch = useMutation({
    mutationFn: (p: BrowserProfile) => api.browser.launch(p.id),
    onSuccess: (_res, p) => {
      toast.success(t("browser:toast.running", { name: p.name }), { description: t("browser:toast.runningDescription") });
      void invalidate();
    },
    onError: (e) => toastApiError(e, t("browser:toast.launchFailed"), qc),
  });

  const stop = useMutation({
    mutationFn: (p: BrowserProfile) => api.browser.stop(p.id),
    onSuccess: (_res, p) => {
      toast.success(t("browser:toast.stopped", { name: p.name }));
      void invalidate();
    },
    onError: (e) => toastApiError(e, t("browser:toast.stopFailed"), qc),
  });

  const setDefault = useMutation({
    mutationFn: async ({ profile, workspace }: { profile: BrowserProfile; workspace: Workspace | null }) => {
      if (workspace) await api.workspaces.update(workspace.id, { browserProfileId: !profile.workspaceId && profile.isDefault ? null : profile.id });
      else await api.browser.updateProfile(profile.id, { isDefault: true });
    },
    onSuccess: (_res, { profile, workspace }) => {
      if (workspace)
        toast.success(t("browser:toast.defaultIn", { name: profile.name, workspace: workspace.name }), {
          description: profile.workspaceId
            ? undefined
            : profile.isDefault
              ? t("browser:toast.followsGlobal", { workspace: workspace.name })
              : t("browser:toast.movedInto", { workspace: workspace.name }),
        });
      else toast.success(t("browser:toast.defaultGlobal", { name: profile.name }));
      void invalidate();
      void qc.invalidateQueries({ queryKey: qk.workspaces });
    },
    onError: (e) => toastApiError(e, t("browser:toast.defaultFailed"), qc),
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.browser.updateProfile(id, { name }),
    onSuccess: () => {
      toast.success(t("browser:toast.renamed"));
      void invalidate();
    },
    onError: (e) => toastApiError(e, t("browser:toast.renameFailed"), qc),
  });

  const assign = useMutation({
    mutationFn: ({ profile, workspaceId, isDefault }: { profile: BrowserProfile; workspaceId: string | null; isDefault?: boolean; scopeName: string }) =>
      api.browser.updateProfile(profile.id, { workspaceId, isDefault }),
    onSuccess: (updated, { scopeName }) => {
      toast.success(updated.workspaceId ? t("browser:toast.belongsTo", { name: updated.name, scope: scopeName }) : t("browser:toast.nowGlobal", { name: updated.name }), {
        description: updated.workspaceId && updated.isDefault ? t("browser:toast.agentsBrowse", { scope: scopeName }) : undefined,
      });
      void invalidate();
      void qc.invalidateQueries({ queryKey: qk.workspaces });
    },
    onError: (e) => toastApiError(e, t("browser:toast.assignFailed"), qc),
  });

  const remove = useMutation({
    mutationFn: (p: BrowserProfile) => api.browser.deleteProfile(p.id),
    onSuccess: (_res, p) => {
      toast.success(t("browser:toast.deleted", { name: p.name }));
      void invalidate();
    },
    onError: (e) => toastApiError(e, t("browser:toast.deleteFailed"), qc),
  });

  return { launch, stop, setDefault, rename, assign, remove };
}

export type ProfileActions = ReturnType<typeof useProfileActions>;
