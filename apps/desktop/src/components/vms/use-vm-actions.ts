import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Vm, VmAssignmentKind, VmPatch } from "@godmode/shared";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, type VmOpenTarget } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

/** Where runs go once an assignment is removed (a chat's VM wins over its agent's, which wins over the workspace's). */
const UNASSIGNED: Record<VmAssignmentKind, string> = {
  conversation: "The chat uses its agent's VM again, if it has one.",
  agent: "The agent uses its workspace's VM again, if there is one — otherwise it works on this Mac.",
  workspace: "Its agents work on this Mac again, unless they have a VM of their own.",
};

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
    onError: (e, vm) => toastApiError(e, `Couldn't start “${vm.name}”`, qc),
  });

  const stop = useMutation({
    mutationFn: (vm: Vm) => api.vms.stop(vm.id),
    onSuccess: put,
    onError: (e, vm) => toastApiError(e, `Couldn't stop “${vm.name}”`, qc),
  });

  const suspend = useMutation({
    mutationFn: (vm: Vm) => api.vms.suspend(vm.id),
    onSuccess: (next) => {
      put(next);
      toast.success(`${next.name} is suspended`, { description: "Its memory is saved to disk — Resume continues right where it left off." });
    },
    onError: (e, vm) => toastApiError(e, `Couldn't suspend “${vm.name}”`, qc),
  });

  const restart = useMutation({
    mutationFn: (vm: Vm) => api.vms.restart(vm.id),
    onSuccess: put,
    onError: (e, vm) => toastApiError(e, `Couldn't restart “${vm.name}”`, qc),
  });

  const open = useMutation({
    mutationFn: ({ vm, what }: { vm: Vm; what: VmOpenTarget }) => api.vms.open(vm.id, what),
    onMutate: ({ vm, what }) => {
      if (what !== "folder" && vm.state !== "running") {
        toast(`Starting ${vm.name} first…`, {
          description: what === "screen" ? "Its screen opens as soon as macOS is up." : "Terminal opens as soon as macOS is up.",
        });
      }
    },
    onError: (e, { vm, what }) =>
      toastApiError(e, what === "screen" ? `Couldn't show the screen of “${vm.name}”` : what === "terminal" ? "Couldn't open Terminal" : "Couldn't open the shared folder", qc),
  });

  const update = useMutation({
    mutationFn: ({ vm, patch }: { vm: Vm; patch: VmPatch }) => api.vms.update(vm.id, patch),
    onSuccess: (next, { vm, patch }) => {
      put(next);
      const later = vm.state === "running" && (patch.cpu !== undefined || patch.memoryMb !== undefined || patch.display !== undefined);
      toast.success("Changes saved", { description: later ? "CPU, memory and display apply the next time the VM starts." : undefined });
    },
    onError: (e) => toastApiError(e, "Couldn't save the changes", qc),
  });

  const reset = useMutation({
    mutationFn: ({ vm, start }: { vm: Vm; start?: boolean }) => api.vms.reset(vm.id, { start }),
    onSuccess: (next) => {
      put(next);
      toast.success(`${next.name} is fresh again`, { description: "A clean macOS from its image. The shared folder and assignments were kept." });
    },
    onError: (e, { vm }) => toastApiError(e, `Couldn't reset “${vm.name}”`, qc),
  });

  const duplicate = useMutation({
    mutationFn: ({ vm, name }: { vm: Vm; name?: string }) => api.vms.duplicate(vm.id, name),
    onSuccess: (copy) => {
      put(copy);
      toast.success(`${copy.name} created`, { description: "Same disk contents, its own shared folder. Assign it to an agent or workspace." });
    },
    onError: (e, { vm }) => toastApiError(e, `Couldn't duplicate “${vm.name}”`, qc),
  });

  const remove = useMutation({
    mutationFn: ({ vm, keepFiles }: { vm: Vm; keepFiles: boolean }) => api.vms.delete(vm.id, { keepFiles }),
    onSuccess: (_res, { vm, keepFiles }) => {
      qc.setQueryData<Vm[]>(qk.vmList, (old) => old?.filter((v) => v.id !== vm.id));
      void qc.invalidateQueries({ queryKey: qk.vmStatus });
      toast.success(`${vm.name} deleted`, { description: keepFiles ? `Its shared folder is still at ${vm.sharedDir}` : undefined });
    },
    onError: (e, { vm }) => toastApiError(e, `Couldn't delete “${vm.name}”`, qc),
  });

  const assign = useMutation({
    mutationFn: ({ vm, kind, id, assigned }: { vm: Vm; kind: VmAssignmentKind; id: string; name: string; assigned: boolean }) =>
      api.vms.assign(vm.id, { kind, id, assigned }),
    onSuccess: (next, { kind, name, assigned }) => {
      put(next);
      if (assigned) toast.success(`${name} now works in ${next.name}`, { description: next.state === "running" ? undefined : "The VM starts when a run needs it." });
      else toast.success(`${name} no longer uses ${next.name}`, { description: UNASSIGNED[kind] });
    },
    onError: (e) => toastApiError(e, "Couldn't change the assignment", qc),
  });

  return { start, stop, suspend, restart, open, update, reset, duplicate, remove, assign };
}

export type VmActions = ReturnType<typeof useVmActions>;
