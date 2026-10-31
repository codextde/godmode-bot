import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Vm, VmAssignmentKind, VmPatch } from "@godmode/shared";
import { toastApiError } from "@/components/vault/vault-utils";
import { t } from "@/i18n";
import { api, type VmOpenTarget } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

/** Where runs go once an assignment is removed (a chat's VM wins over its agent's, which wins over the workspace's). */
const UNASSIGNED = {
  conversation: "vms:toast.unassigned.conversation",
  agent: "vms:toast.unassigned.agent",
  workspace: "vms:toast.unassigned.workspace",
} as const satisfies Record<VmAssignmentKind, string>;

/**
 * Lifecycle, open, edit, reset, duplicate, delete and assignment for macOS VMs — with toasts, and the answer patched
 * into the cached list right away (realtime `vm.updated` events keep it current afterwards).
 */
export function useVmActions() {
  const qc = useQueryClient();

  const put = (vm: Vm) => {
    qc.setQueryData<Vm[]>(qk.vmList, (old) => (old ? (old.some((v) => v.id === vm.id) ? old.map((v) => (v.id === vm.id ? vm : v)) : [...old, vm]) : old));
    void qc.invalidateQueries({ queryKey: qk.vmStatus });
  };

  const start = useMutation({
    mutationFn: (vm: Vm) => api.vms.start(vm.id),
    onSuccess: put,
    onError: (e, vm) => toastApiError(e, t("vms:toast.startFailed", { name: vm.name }), qc),
  });

  const stop = useMutation({
    mutationFn: (vm: Vm) => api.vms.stop(vm.id),
    onSuccess: put,
    onError: (e, vm) => toastApiError(e, t("vms:toast.stopFailed", { name: vm.name }), qc),
  });

  const suspend = useMutation({
    mutationFn: (vm: Vm) => api.vms.suspend(vm.id),
    onSuccess: (next) => {
      put(next);
      toast.success(t("vms:toast.suspended", { name: next.name }), { description: t("vms:toast.suspendedDescription") });
    },
    onError: (e, vm) => toastApiError(e, t("vms:toast.suspendFailed", { name: vm.name }), qc),
  });

  const restart = useMutation({
    mutationFn: (vm: Vm) => api.vms.restart(vm.id),
    onSuccess: put,
    onError: (e, vm) => toastApiError(e, t("vms:toast.restartFailed", { name: vm.name }), qc),
  });

  const open = useMutation({
    mutationFn: ({ vm, what }: { vm: Vm; what: VmOpenTarget }) => api.vms.open(vm.id, what),
    onMutate: ({ vm, what }) => {
      if (what !== "folder" && vm.state !== "running") {
        toast(t("vms:toast.startingFirst", { name: vm.name }), {
          description: what === "screen" ? t("vms:toast.startingFirstScreen") : t("vms:toast.startingFirstTerminal"),
        });
      }
    },
    onError: (e, { vm, what }) =>
      toastApiError(
        e,
        what === "screen" ? t("vms:toast.screenFailed", { name: vm.name }) : what === "terminal" ? t("vms:toast.terminalFailed") : t("vms:toast.folderFailed"),
        qc,
      ),
  });

  const update = useMutation({
    mutationFn: ({ vm, patch }: { vm: Vm; patch: VmPatch }) => api.vms.update(vm.id, patch),
    onSuccess: (next, { vm, patch }) => {
      put(next);
      const later = vm.state === "running" && (patch.cpu !== undefined || patch.memoryMb !== undefined || patch.display !== undefined);
      toast.success(t("vms:toast.saved"), { description: later ? t("vms:toast.savedLater") : undefined });
    },
    onError: (e) => toastApiError(e, t("vms:toast.saveFailed"), qc),
  });

  const reset = useMutation({
    mutationFn: ({ vm, start }: { vm: Vm; start?: boolean }) => api.vms.reset(vm.id, { start }),
    onSuccess: (next) => {
      put(next);
      toast.success(t("vms:toast.reset", { name: next.name }), { description: t("vms:toast.resetDescription") });
    },
    onError: (e, { vm }) => toastApiError(e, t("vms:toast.resetFailed", { name: vm.name }), qc),
  });

  const duplicate = useMutation({
    mutationFn: ({ vm, name }: { vm: Vm; name?: string }) => api.vms.duplicate(vm.id, name),
    onSuccess: (copy) => {
      put(copy);
      toast.success(t("vms:toast.duplicated", { name: copy.name }), { description: t("vms:toast.duplicatedDescription") });
    },
    onError: (e, { vm }) => toastApiError(e, t("vms:toast.duplicateFailed", { name: vm.name }), qc),
  });

  const remove = useMutation({
    mutationFn: ({ vm, keepFiles }: { vm: Vm; keepFiles: boolean }) => api.vms.delete(vm.id, { keepFiles }),
    onSuccess: (_res, { vm, keepFiles }) => {
      qc.setQueryData<Vm[]>(qk.vmList, (old) => old?.filter((v) => v.id !== vm.id));
      void qc.invalidateQueries({ queryKey: qk.vmStatus });
      toast.success(t("vms:toast.deleted", { name: vm.name }), { description: keepFiles ? t("vms:toast.deletedKeep", { path: vm.sharedDir }) : undefined });
    },
    onError: (e, { vm }) => toastApiError(e, t("vms:toast.deleteFailed", { name: vm.name }), qc),
  });

  const assign = useMutation({
    mutationFn: ({ vm, kind, id, assigned }: { vm: Vm; kind: VmAssignmentKind; id: string; name: string; assigned: boolean }) =>
      api.vms.assign(vm.id, { kind, id, assigned }),
    onSuccess: (next, { kind, name, assigned }) => {
      put(next);
      if (assigned) toast.success(t("vms:toast.assigned", { name, vm: next.name }), { description: next.state === "running" ? undefined : t("vms:toast.assignedDescription") });
      else toast.success(t("vms:toast.unassignedTitle", { name, vm: next.name }), { description: t(UNASSIGNED[kind]) });
    },
    onError: (e) => toastApiError(e, t("vms:toast.assignFailed"), qc),
  });

  return { start, stop, suspend, restart, open, update, reset, duplicate, remove, assign };
}

export type VmActions = ReturnType<typeof useVmActions>;
