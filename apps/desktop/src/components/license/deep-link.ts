import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { licenseKeyFromDeepLink, type LicenseState } from "@godmode/shared";
import { t } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { isTauri } from "@/lib/core";
import { qk } from "@/lib/queryKeys";

/** Set when this window opened a checkout: the key that comes back from it is expected. */
let checkoutOpenedAt = 0;
const EXPECTED_MS = 2 * 3_600_000;

export function noteCheckoutOpened() {
  checkoutOpenedAt = Date.now();
}

/**
 * A `godmode://license?key=…` link (the "Open Godmode" button after checkout) activates that key. Any web page can open
 * such a link, so the human confirms it unless it is the answer to a checkout opened here and no working key is replaced.
 */
async function activate(qc: QueryClient, key: string) {
  const current = qc.getQueryData<LicenseState>(qk.license) ?? (await api.license.get().catch(() => null));
  const working = !!current?.keyHint && !current.blocked;
  if (working && key.endsWith(current!.keyHint!)) {
    toast.success(t("license:deepLink.alreadyActive"));
    return;
  }
  const expected = !!current && !working && Date.now() - checkoutOpenedAt < EXPECTED_MS;
  if (!expected) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const ok = await ask(
      working ? t("license:deepLink.replaceText", { old: current!.keyHint, next: key.slice(-5) }) : t("license:deepLink.confirmText", { next: key.slice(-5) }),
      {
        title: working ? t("license:deepLink.replaceTitle") : t("license:deepLink.confirmTitle"),
        okLabel: working ? t("license:deepLink.replace") : t("license:keyForm.activate"),
        cancelLabel: working ? t("license:deepLink.keep") : t("license:deepLink.cancel"),
      },
    ).catch(() => false);
    if (!ok) return;
  }
  const id = toast.loading(t("license:deepLink.activating"));
  try {
    const state = await api.license.set(key);
    qc.setQueryData(qk.license, state);
    if (state.blocked) toast.error(t("license:keyForm.cantUse"), { id, description: state.message ?? undefined });
    else toast.success(state.status === "trial" ? t("license:keyForm.trialActive") : t("license:keyForm.activated"), { id, description: state.status === "unverified" ? (state.message ?? undefined) : undefined });
  } catch (err) {
    toast.error(t("license:deepLink.failed"), { id, description: errorMessage(err) });
  }
}

const loadTauriCore = () => import("@tauri-apps/api/core");
const loadTauriEvent = () => import("@tauri-apps/api/event");

/** Takes the links the desktop shell received (waiting ones first, on a cold start) once the core can be asked. */
export function useLicenseDeepLinks(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || !isTauri) return;
    let stopped = false;
    let unlisten: (() => void) | null = null;
    let draining = Promise.resolve();
    const drain = () => {
      draining = draining.then(async () => {
        if (stopped) return;
        const { invoke } = await loadTauriCore();
        // An older shell without the command answers with an error: no links then.
        const links = await invoke<string[]>("take_deep_links").catch(() => [] as string[]);
        for (const link of links) {
          const key = licenseKeyFromDeepLink(link);
          if (key && !stopped) await activate(qc, key);
        }
      }).catch(() => {});
    };
    void loadTauriEvent().then(async ({ listen }) => {
      const off = await listen("deep-link", drain);
      if (stopped) off();
      else unlisten = off;
      drain();
    });
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [enabled, qc]);
}
