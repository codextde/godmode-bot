import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { modUpdateAvailable, type Mod, type ModImportInput, type ModInput, type ModInstallInput, type ModPatch } from "@godmode/shared";
import { toastApiError } from "@/components/vault/vault-utils";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

/** A 409 from an install: the repository holds several plugins, here they are to pick from. */
export function installChoices(e: unknown): { name: string; description: string }[] | null {
  if (!(e instanceof ApiRequestError) || e.status !== 409 || e.code !== "pick_plugin") return null;
  const plugins = (e.details as { plugins?: unknown } | undefined)?.plugins;
  return Array.isArray(plugins) ? (plugins as { name: string; description: string }[]) : null;
}

function version(mod: Mod): string {
  return mod.source?.version ? ` ${mod.source.version}` : "";
}

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
 * Create, install, update, change, check and delete plugins — with toasts, and the answer patched into the cached list right away
 * (realtime `entity.changed` keeps it current afterwards). Switching on and off, and every other plain field, shows
 * at once and goes back when the core refuses it.
 */
export function useModActions() {
  const qc = useQueryClient();
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [upgrading, setUpgrading] = useState<ReadonlySet<string>>(new Set());

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
    onError: (e) => toastApiError(e, "Couldn't add the plugin", qc),
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

  const install = useMutation({
    mutationFn: ({ label: _label, ...input }: ModInstallInput & { label?: string }) => api.mods.install(input),
    onMutate: (input) =>
      toast.loading(`Installing ${input.label ?? input.source}`, { id: `install-${input.catalogId ?? input.source}`, description: "Downloading it and checking it with Claude Code. Large plugins take a minute." }),
    onSuccess: (mod, input) => {
      add(mod);
      const id = `install-${input.catalogId ?? input.source}`;
      if (mod.check && !mod.check.ok) toast.error(`${mod.title} installed, but Claude Code refuses it`, { id, description: mod.check.errors[0]?.message });
      else if (mod.enabled) toast.success(`${mod.title}${version(mod)} installed`, { id, description: "It is on for every agent from the next message." });
      else toast.success(`${mod.title}${version(mod)} installed`, { id, description: "It is switched off. Switch it on when you're ready." });
    },
    onError: (e, input) => {
      const id = `install-${input.catalogId ?? input.source}`;
      // The dialog lets the human pick one of several plugins: no toast for that.
      if (installChoices(e)) toast.dismiss(id);
      else toast.error(`Couldn't install ${input.label ?? input.source}`, { id, description: errorMessage(e) });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.mods }),
  });

  const upgrade = useMutation({
    mutationFn: (mod: Mod) => api.mods.upgrade(mod.id),
    onMutate: (mod) => setUpgrading((s) => new Set(s).add(mod.id)),
    onSuccess: (next, mod) => {
      put(next);
      if (next.source?.commit === mod.source?.commit) toast(`${next.title} is up to date`, { description: next.source?.version ? `Version ${next.source.version}` : undefined });
      else toast.success(`${next.title} updated${next.source?.version ? ` to ${next.source.version}` : ""}`, { description: "Runs load the new version from the next message." });
    },
    onError: (e, mod) => toastApiError(e, `Couldn't update ${mod.title}`, qc),
    onSettled: (_next, _e, mod) => {
      setUpgrading((s) => {
        const next = new Set(s);
        next.delete(mod.id);
        return next;
      });
      void qc.invalidateQueries({ queryKey: qk.mods });
    },
  });

  const checkUpdates = useMutation({
    mutationFn: (mods?: Mod[]) => api.mods.checkUpdates(mods?.map((m) => m.id)),
    onSuccess: (list) => {
      for (const mod of list) put(mod);
      const failed = list.filter((m) => m.source?.checkError);
      const waiting = list.filter(modUpdateAvailable);
      if (waiting.length) toast.success(waiting.length === 1 ? `An update for ${waiting[0]!.title} is ready` : `${waiting.length} updates are ready`, { description: "Update from the plugin's card or page." });
      else if (failed.length) toast.warning(`Couldn't look for updates of ${failed[0]!.title}`, { description: failed[0]!.source?.checkError ?? undefined });
      else toast.success(list.length === 1 ? `${list[0]!.title} is up to date` : "All plugins are up to date");
    },
    onError: (e) => toastApiError(e, "Couldn't look for updates", qc),
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
      toast.success(`${mod.title} ${mod.source ? "uninstalled" : "deleted"}`, { description: "Runs stop loading it from the next message." });
    },
    onError: (e, mod) => toastApiError(e, `Couldn't ${mod.source ? "uninstall" : "delete"} “${mod.title}”`, qc),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.mods }),
  });

  return { create, importFolder, install, upgrade, upgrading, checkUpdates, update, toggle, check, checking, remove, put };
}

export type ModActions = ReturnType<typeof useModActions>;
