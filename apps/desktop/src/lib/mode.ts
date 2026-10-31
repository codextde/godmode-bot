import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Bootstrap, InterfaceMode, Settings } from "@godmode/shared";
import { t } from "@/i18n";
import { api, errorMessage } from "./api";
import { useBootstrap } from "./hooks";
import { qk } from "./queryKeys";

export const MODE_LABEL: Record<InterfaceMode, string> = {
  get easy() {
    return t("system:mode.label.easy");
  },
  get pro() {
    return t("system:mode.label.pro");
  },
};

export const MODE_BLURB: Record<InterfaceMode, string> = {
  get easy() {
    return t("system:mode.blurb.easy");
  },
  get pro() {
    return t("system:mode.blurb.pro");
  },
};

/** The dashboard's interface mode; Professional until the human picks Easy. */
export function useInterfaceMode(): InterfaceMode {
  const { data } = useBootstrap();
  return data?.settings.general.mode === "easy" ? "easy" : "pro";
}

/** Easy mode titles and descriptions for the top-level pages, by path (the sidebar uses the same names). */
export const EASY_PAGES: Record<string, { title?: string; description?: string }> = {
  "/automations": {
    get description() {
      return t("system:easyPages.automations.description");
    },
  },
  "/files": {
    get description() {
      return t("system:easyPages.files.description");
    },
  },
  "/activity": {
    get title() {
      return t("system:easyPages.activity.title");
    },
    get description() {
      return t("system:easyPages.activity.description");
    },
  },
  "/calls": {
    get title() {
      return t("system:easyPages.calls.title");
    },
  },
  "/plugins": {
    get title() {
      return t("system:easyPages.plugins.title");
    },
    get description() {
      return t("system:easyPages.plugins.description");
    },
  },
  "/vault/cards": {
    get title() {
      return t("system:easyPages.cards.title");
    },
  },
  "/computer": {
    get title() {
      return t("system:easyPages.computer.title");
    },
  },
  "/ssh": {
    get title() {
      return t("system:easyPages.ssh.title");
    },
  },
};

export function useEasyMode(): boolean {
  return useInterfaceMode() === "easy";
}

/** Switches the mode at once on screen and saves it for every device that opens this Godmode. */
export function useSetInterfaceMode() {
  const qc = useQueryClient();
  const m = useMutation({
    scope: { id: "interface-mode" },
    mutationFn: (mode: InterfaceMode) => api.settings.update({ general: { mode } }),
    onMutate: async (mode) => {
      await qc.cancelQueries({ queryKey: qk.bootstrap });
      const boot = qc.getQueryData<Bootstrap>(qk.bootstrap);
      const settings = qc.getQueryData<Settings>(qk.settings);
      if (boot) qc.setQueryData<Bootstrap>(qk.bootstrap, { ...boot, settings: { ...boot.settings, general: { ...boot.settings.general, mode } } });
      if (settings) qc.setQueryData<Settings>(qk.settings, { ...settings, general: { ...settings.general, mode } });
      return { boot, settings };
    },
    onError: (err, _mode, ctx) => {
      if (ctx?.boot) qc.setQueryData(qk.bootstrap, ctx.boot);
      if (ctx?.settings) qc.setQueryData(qk.settings, ctx.settings);
      toast.error(t("system:mode.switchError"), { description: errorMessage(err) });
    },
    onSuccess: (_next, mode) => {
      toast.success(t(`system:mode.switched.${mode}`), {
        id: "interface-mode",
        description: mode === "easy" ? t("system:mode.switchBackHint") : undefined,
        duration: 2500,
      });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.settings });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
  });
  return { setMode: m.mutate, isPending: m.isPending };
}
