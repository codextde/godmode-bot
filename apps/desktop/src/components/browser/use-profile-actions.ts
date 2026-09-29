import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { BrowserProfile, Workspace } from "@godmode/shared";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { toastApiError } from "@/components/vault/vault-utils";

/** Launch / stop / set default / rename / assign / delete for browser profiles, with toasts and cache refresh. */
export function useProfileActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.browserProfiles });

  const launch = useMutation({
    mutationFn: (p: BrowserProfile) => api.browser.launch(p.id),
    onSuccess: (_res, p) => {
      toast.success(`${p.name} is running`, { description: "Live view connects in a moment." });
      void invalidate();
    },
    onError: (e) => toastApiError(e, "Could not launch the browser", qc),
  });

  const stop = useMutation({
    mutationFn: (p: BrowserProfile) => api.browser.stop(p.id),
    onSuccess: (_res, p) => {
      toast.success(`${p.name} stopped`);
      void invalidate();
    },
    onError: (e) => toastApiError(e, "Could not stop the browser", qc),
  });

  const setDefault = useMutation({
    mutationFn: async ({ profile, workspace }: { profile: BrowserProfile; workspace: Workspace | null }) => {
      if (workspace) await api.workspaces.update(workspace.id, { browserProfileId: !profile.workspaceId && profile.isDefault ? null : profile.id });
      else await api.browser.updateProfile(profile.id, { isDefault: true });
    },
    onSuccess: (_res, { profile, workspace }) => {
      if (workspace)
        toast.success(`${profile.name} is now the default in ${workspace.name}`, {
          description: profile.workspaceId ? undefined : profile.isDefault ? `${workspace.name} follows the global default again.` : `Moved from Global into ${workspace.name}.`,
        });
      else toast.success(`${profile.name} is now the default profile`);
      void invalidate();
      void qc.invalidateQueries({ queryKey: qk.workspaces });
    },
    onError: (e) => toastApiError(e, "Could not change the default profile", qc),
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.browser.updateProfile(id, { name }),
    onSuccess: () => {
      toast.success("Profile renamed");
      void invalidate();
    },
    onError: (e) => toastApiError(e, "Could not rename the profile", qc),
  });

  const assign = useMutation({
    mutationFn: ({ profile, workspaceId, isDefault }: { profile: BrowserProfile; workspaceId: string | null; isDefault?: boolean; scopeName: string }) =>
      api.browser.updateProfile(profile.id, { workspaceId, isDefault }),
    onSuccess: (updated, { scopeName }) => {
      toast.success(updated.workspaceId ? `${updated.name} now belongs to ${scopeName}` : `${updated.name} is now global`, {
        description: updated.workspaceId && updated.isDefault ? `${scopeName}'s agents browse with it from their next run.` : undefined,
      });
      void invalidate();
      void qc.invalidateQueries({ queryKey: qk.workspaces });
    },
    onError: (e) => toastApiError(e, "Could not assign the profile", qc),
  });

  const remove = useMutation({
    mutationFn: (p: BrowserProfile) => api.browser.deleteProfile(p.id),
    onSuccess: (_res, p) => {
      toast.success(`${p.name} deleted`);
      void invalidate();
    },
    onError: (e) => toastApiError(e, "Could not delete the profile", qc),
  });

  return { launch, stop, setDefault, rename, assign, remove };
}

export type ProfileActions = ReturnType<typeof useProfileActions>;
