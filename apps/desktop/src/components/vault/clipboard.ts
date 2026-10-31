import { toast } from "sonner";
import { t } from "@/i18n";

const CLEAR_AFTER_SECONDS = 30;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

export async function writeClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

/** Copy non-sensitive text (usernames, URLs). */
export async function copyText(text: string, label = t("common:actions.copied")) {
  try {
    await writeClipboard(text);
    toast.success(label);
  } catch {
    toast.error(t("vault:clipboard.accessFailed"));
  }
}

/**
 * Copy a secret and clear the clipboard after 30 s — but only if it still holds that secret
 * (when the clipboard can't be read back we clear anyway; a lingering secret is the bigger risk).
 */
export async function copySecret(secret: string, label = t("common:actions.copied")) {
  try {
    await writeClipboard(secret);
  } catch {
    toast.error(t("vault:clipboard.accessFailed"));
    return;
  }
  toast.success(label, { description: t("vault:clipboard.clearsIn", { seconds: CLEAR_AFTER_SECONDS }) });
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(async () => {
    clearTimer = null;
    try {
      const current = await navigator.clipboard.readText();
      if (current !== secret) return;
    } catch {
      /* unreadable — clear below */
    }
    try {
      await writeClipboard("");
    } catch {
      /* ignore */
    }
  }, CLEAR_AFTER_SECONDS * 1000);
}
