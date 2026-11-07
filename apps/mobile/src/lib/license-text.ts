import type { LicenseState, Task } from "@godmode/shared";
import { t } from "@/lib/i18n";

/** How the core and the cloud word a way to buy, for the desktop. The phone must not show it (store payment rules). */
const SELLS = /\b(subscribe|subscription has ended|pick a plan|choose a plan|choose a bigger plan|a bigger plan|payment method|finish the checkout|renew it)\b/i;

export const sellsSomething = (text: string) => SELLS.test(text);

/** A text from the computer about its licence, as a phone may show it. */
export const licenseText = (text: string) => (sellsSomething(text) ? t("system:api.license") : text);

/** The licence's own message, in the words of its state; null when the screen already says it all. */
export function licenseStateText(s: Pick<LicenseState, "status" | "message">): string | null {
  if (!s.message || !sellsSomething(s.message)) return s.message;
  if (s.status === "grace") return null;
  return s.status === "past_due" ? t("system:api.licenseCheck") : t("system:api.license");
}

/** Why a task is blocked. Only Godmode's own setup reasons are touched: an agent's words stay. */
export function blockedReasonText(task: Pick<Task, "blockedReason" | "blockedKind">): string | null {
  return task.blockedReason && task.blockedKind === "setup" ? licenseText(task.blockedReason) : task.blockedReason;
}

/** A sentence from Godmode Cloud, without its advice to buy a bigger plan. */
export const cloudText = (text: string) => (sellsSomething(text) ? t("system:api.cloudLimit") : text);
