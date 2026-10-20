import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Bootstrap, InterfaceMode, Settings } from "@godmode/shared";
import { api, errorMessage } from "./api";
import { useBootstrap } from "./hooks";
import { qk } from "./queryKeys";

export const MODE_LABEL: Record<InterfaceMode, string> = { easy: "Easy", pro: "Professional" };

export const MODE_BLURB: Record<InterfaceMode, string> = {
  easy: "Plain words and only what you need day to day. Everything else is one click away.",
  pro: "Every tool, setting and detail in view: models, runs, machines, logs.",
};

/** The dashboard's interface mode; Professional until the human picks Easy. */
export function useInterfaceMode(): InterfaceMode {
  const { data } = useBootstrap();
  return data?.settings.general.mode === "easy" ? "easy" : "pro";
}

/** Easy mode titles and descriptions for the top-level pages, by path (the sidebar uses the same names). */
export const EASY_PAGES: Record<string, { title?: string; description?: string }> = {
  "/my-tasks": { title: "My to-dos" },
  "/tasks": { title: "Task board" },
  "/automations": { description: "Let your agents start work by themselves: on a schedule, or when something happens in your apps." },
  "/files": { description: "What your agents keep: their files, notes and memory. Look through it, tidy it up, and put back what you deleted." },
  "/activity": { title: "History", description: "Everything your agents did." },
  "/calls": { title: "Phone calls" },
  "/plugins": { title: "Add-ons", description: "Extra skills for your agents. Add one, switch it off or remove it any time." },
  "/vault/logins": { title: "Passwords", description: "The logins your agents may use. Encrypted on this computer; agents never see the passwords." },
  "/vault/2fa": { title: "2FA codes" },
  "/vault/cards": { title: "Payment cards" },
  "/integrations": { title: "Connected apps", description: "Connect the apps you already use, like Gmail, Slack or Notion, so your agents can work in them." },
  "/messaging": { title: "Chat apps", description: "Talk to your agents from Slack, Telegram or Microsoft Teams." },
  "/computer": { title: "Computer control" },
  "/ssh": { title: "Servers" },
  "/runners": { title: "Other computers" },
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
      toast.error("Could not switch the mode", { description: errorMessage(err) });
    },
    onSuccess: (_next, mode) => {
      toast.success(`${MODE_LABEL[mode]} mode`, {
        id: "interface-mode",
        description: mode === "easy" ? "Switch back any time in Settings → General." : undefined,
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
