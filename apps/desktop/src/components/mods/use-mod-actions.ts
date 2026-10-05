import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Mod, ModImportInput, ModInput, ModPatch } from "@godmode/shared";
import { toastApiError } from "@/components/vault/vault-utils";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

/** What a finished check means for the human, as a toast. */
export function toastCheck(mod: Mod, verb = "checked") {
  if (!mod.check) toast.warning(`${mod.title} wasn't checked`, { description: "Claude Code isn't installed on this computer." });
  else if (mod.check.ok) toast.success(`${mod.title} passed the check`);
  else {
    const first = mod.check.errors[0];
    toast.error(`${mod.title} needs fixing`, { description: first ? `${first.where}: ${first.message}` : `It was ${verb}, but the check failed.` });
  }
}

/**
 * Create, change, check and delete mods — with toasts, and the answer patched into the cached list right away
 * (realtime `entity.changed` keeps it current afterwards). Switching on and off, and every other plain field, shows
 * at once and goes back when the core refuses it.
 */
export function useModActions() {
  const qc = useQueryClient();
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());

  const put = (mod: Mod) => {
    qc.setQueryData<Mod[]>(qk.mods, (old) => (old ? (old.some((m) => m.id === mod.id) ? old.map((m) => (m.id === mod.id ? mod : m)) : [...old, mod]) : old));
  };

  // A list fetch already under way doesn't know the new mod yet and must not put the list back without it.
  const add = (mod: Mod) => {
    void qc.cancelQueries({ queryKey: qk.mods });
    put(mod);
  };

  const create = useMutation({
    mutationFn: (input: ModInput) => api.mods.create(input),
    onSuccess: (mod) => {
      add(mod);
      toast.success(`${mod.title} added`, { description: mod.enabled ? "It runs from the next message." : "It is switched off. Switch it on when you're ready." });
    },
    onError: (e) => toastApiError(e, "Couldn't add the mod", qc),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.mods }),
  });

  const importFolder = useMutation({
    mutationFn: (input: ModImportInput) => api.mods.import(input),
    onSuccess: (mod) => {
      add(mod);
      toast.success(`${mod.title} imported`, { description: mod.enabled ? "It runs from the next message." : "It is switched off. Read its code, then switch it on." });
    },
    onError: (e) => toastApiError(e, "Couldn't import the folder", qc),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.mods }),
  });

  const update = useMutation({
    mutationFn: ({ mod, patch }: { mod: Mod; patch: ModPatch }) => api.mods.update(mod.id, patch),
    onMutate: async ({ mod, patch }) => {
      await qc.cancelQueries({ queryKey: qk.mods });
      // Files and option values come back checked and filled in by the core; everything else shows at once.
      const { files: _files, values: _values, ...shown } = patch;
      qc.setQueryData<Mod[]>(qk.mods, (list) =>
        list?.map((m) => (m.id === mod.id ? { ...m, ...shown, needsReview: patch.enabled ? false : m.needsReview } : m)),
      );
      return { previous: mod };
    },
    onSuccess: (next, { patch }) => {
      put(next);
      if (patch.enabled === undefined) return;
      const id = `mod-switch-${next.id}`;
      if (!next.enabled) toast(`${next.title} is off`, { id, description: "Runs stop loading it from the next message." });
      else if (next.scope === "agents" && next.agentIds.length === 0) toast.success(`${next.title} is on`, { id, description: "No agent runs it yet — choose who it runs for." });
      else toast.success(`${next.title} is on`, { id, description: "It loads from the next message." });
    },
    onError: (e, { mod, patch }, ctx) => {
      if (ctx) put(ctx.previous);
      // 409: the core won't switch on a mod whose check fails, and says why.
      if (patch.enabled && e instanceof ApiRequestError && e.status === 409) toast.error(`Can't switch on ${mod.title}`, { description: errorMessage(e) });
      else toastApiError(e, patch.enabled === undefined ? `Couldn't save “${mod.title}”` : `Couldn't switch ${patch.enabled ? "on" : "off"} ${mod.title}`, qc);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.mods }),
  });

  // Switching on names the code that is on screen: the core refuses when an agent saved another version meanwhile.
  const toggle = (mod: Mod, enabled: boolean) => update.mutate({ mod, patch: enabled ? { enabled, digest: mod.digest } : { enabled } });

  const check = useMutation({
    mutationFn: ({ mod }: { mod: Mod; silent?: boolean }) => api.mods.check(mod.id),
    onMutate: ({ mod }) => setChecking((s) => new Set(s).add(mod.id)),
    onSuccess: (next, { silent }) => {
      put(next);
      if (!silent) toastCheck(next);
    },
    onError: (e, { mod }) => toastApiError(e, `Couldn't check “${mod.title}”`, qc),
    onSettled: (_next, _e, { mod }) => {
      setChecking((s) => {
        const next = new Set(s);
        next.delete(mod.id);
        return next;
      });
      void qc.invalidateQueries({ queryKey: qk.mods });
    },
  });

  const remove = useMutation({
    mutationFn: (mod: Mod) => api.mods.delete(mod.id),
    onSuccess: (_res, mod) => {
      qc.setQueryData<Mod[]>(qk.mods, (old) => old?.filter((m) => m.id !== mod.id));
      toast.success(`${mod.title} deleted`, { description: "Runs stop loading it from the next message." });
    },
    onError: (e, mod) => toastApiError(e, `Couldn't delete “${mod.title}”`, qc),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.mods }),
  });

  return { create, importFolder, update, toggle, check, checking, remove, put };
}

export type ModActions = ReturnType<typeof useModActions>;
