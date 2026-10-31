import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { modUpdateAvailable, type Mod, type ModImportInput, type ModInput, type ModInstallInput, type ModPatch } from "@godmode/shared";
import { toastApiError } from "@/components/vault/vault-utils";
import { t } from "@/i18n";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

/** A 409 from an install: the repository holds several plugins, here they are to pick from. */
export function installChoices(e: unknown): { name: string; description: string }[] | null {
  if (!(e instanceof ApiRequestError) || e.status !== 409 || e.code !== "pick_plugin") return null;
  const plugins = (e.details as { plugins?: unknown } | undefined)?.plugins;
  return Array.isArray(plugins) ? (plugins as { name: string; description: string }[]) : null;
}

function installedTitle(mod: Mod): string {
  return mod.source?.version ? t("mods:toasts.installedVersion", { title: mod.title, version: mod.source.version }) : t("mods:toasts.installed", { title: mod.title });
}

/** What a finished check means for the human, as a toast. */
export function toastCheck(mod: Mod) {
  if (!mod.check) toast.warning(t("mods:toasts.notChecked", { title: mod.title }), { description: t("mods:toasts.noClaudeCode") });
  else if (mod.check.ok) toast.success(t("mods:toasts.passed", { title: mod.title }));
  else {
    const first = mod.check.errors[0];
    toast.error(t("mods:toasts.needsFixing", { title: mod.title }), { description: first ? `${first.where}: ${first.message}` : t("mods:toasts.checkFailedDescription") });
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
      toast.success(t("mods:toasts.added", { title: mod.title }), { description: mod.enabled ? t("mods:toasts.runsFromNext") : t("mods:toasts.offWhenReady") });
    },
    onError: (e) => toastApiError(e, t("mods:toasts.addFailed"), qc),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.mods }),
  });

  const importFolder = useMutation({
    mutationFn: (input: ModImportInput) => api.mods.import(input),
    onSuccess: (mod) => {
      add(mod);
      toast.success(t("mods:toasts.imported", { title: mod.title }), { description: mod.enabled ? t("mods:toasts.runsFromNext") : t("mods:toasts.offReadCode") });
    },
    onError: (e) => toastApiError(e, t("mods:toasts.importFailed"), qc),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.mods }),
  });

  const install = useMutation({
    mutationFn: ({ label: _label, ...input }: ModInstallInput & { label?: string }) => api.mods.install(input),
    onMutate: (input) =>
      toast.loading(t("mods:toasts.installing", { name: input.label ?? input.source }), { id: `install-${input.catalogId ?? input.source}`, description: t("mods:toasts.installingDescription") }),
    onSuccess: (mod, input) => {
      add(mod);
      const id = `install-${input.catalogId ?? input.source}`;
      if (mod.check && !mod.check.ok) toast.error(t("mods:toasts.installedRefused", { title: mod.title }), { id, description: mod.check.errors[0]?.message });
      else if (mod.enabled) toast.success(installedTitle(mod), { id, description: t("mods:toasts.onForEveryAgent") });
      else toast.success(installedTitle(mod), { id, description: t("mods:toasts.offWhenReady") });
    },
    onError: (e, input) => {
      const id = `install-${input.catalogId ?? input.source}`;
      // The dialog lets the human pick one of several plugins: no toast for that.
      if (installChoices(e)) toast.dismiss(id);
      else toast.error(t("mods:toasts.installFailed", { name: input.label ?? input.source }), { id, description: errorMessage(e) });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.mods }),
  });

  const upgrade = useMutation({
    mutationFn: (mod: Mod) => api.mods.upgrade(mod.id),
    onMutate: (mod) => setUpgrading((s) => new Set(s).add(mod.id)),
    onSuccess: (next, mod) => {
      put(next);
      if (next.source?.commit === mod.source?.commit) toast(t("mods:toasts.upToDate", { title: next.title }), { description: next.source?.version ? t("mods:toasts.versionN", { version: next.source.version }) : undefined });
      else
        toast.success(next.source?.version ? t("mods:toasts.updatedTo", { title: next.title, version: next.source.version }) : t("mods:toasts.updated", { title: next.title }), {
          description: t("mods:toasts.newVersionNext"),
        });
    },
    onError: (e, mod) => toastApiError(e, t("mods:toasts.updateFailed", { title: mod.title }), qc),
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
      if (waiting.length)
        toast.success(waiting.length === 1 ? t("mods:toasts.updateReadyFor", { title: waiting[0]!.title }) : t("mods:toasts.updatesReady", { count: waiting.length }), {
          description: t("mods:toasts.updateFromCard"),
        });
      else if (failed.length) toast.warning(t("mods:toasts.updateCheckFailedFor", { title: failed[0]!.title }), { description: failed[0]!.source?.checkError ?? undefined });
      else toast.success(list.length === 1 ? t("mods:toasts.upToDate", { title: list[0]!.title }) : t("mods:toasts.allUpToDate"));
    },
    onError: (e) => toastApiError(e, t("mods:toasts.updateCheckFailed"), qc),
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
      if (!next.enabled) toast(t("mods:toasts.isOff", { title: next.title }), { id, description: t("mods:toasts.stopsLoading") });
      else if (next.scope === "agents" && next.agentIds.length === 0) toast.success(t("mods:toasts.isOn", { title: next.title }), { id, description: t("mods:toasts.noAgentYet") });
      else toast.success(t("mods:toasts.isOn", { title: next.title }), { id, description: t("mods:toasts.loadsFromNext") });
    },
    onError: (e, { mod, patch }, ctx) => {
      if (ctx) put(ctx.previous);
      // 409: the core won't switch on a mod whose check fails, and says why.
      if (patch.enabled && e instanceof ApiRequestError && e.status === 409) toast.error(t("mods:toasts.cantSwitchOn", { title: mod.title }), { description: errorMessage(e) });
      else
        toastApiError(
          e,
          patch.enabled === undefined
            ? t("mods:toasts.saveFailed", { title: mod.title })
            : patch.enabled
              ? t("mods:toasts.switchOnFailed", { title: mod.title })
              : t("mods:toasts.switchOffFailed", { title: mod.title }),
          qc,
        );
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
    onError: (e, { mod }) => toastApiError(e, t("mods:toasts.checkFailed", { title: mod.title }), qc),
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
      toast.success(mod.source ? t("mods:toasts.uninstalled", { title: mod.title }) : t("mods:toasts.deleted", { title: mod.title }), { description: t("mods:toasts.stopsLoading") });
    },
    onError: (e, mod) => toastApiError(e, mod.source ? t("mods:toasts.uninstallFailed", { title: mod.title }) : t("mods:toasts.deleteFailed", { title: mod.title }), qc),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.mods }),
  });

  return { create, importFolder, install, upgrade, upgrading, checkUpdates, update, toggle, check, checking, remove, put };
}

export type ModActions = ReturnType<typeof useModActions>;
