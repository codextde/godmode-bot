import { differenceInCalendarDays, format } from "date-fns";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import type { LicenseState } from "@godmode/shared";

const DAY_MS = 86_400_000;
/** The free trial gets a notice only in its last days, like the desktop's banner. */
const GRACE_DAYS = 3;

export type LicenseNoticeKind = "blocked" | "trial" | "past_due" | "grace" | "unverified";

/** What the licence needs the human to know about now; null when nothing does. */
export function licenseNotice(s: LicenseState, now = new Date()): LicenseNoticeKind | null {
  if (s.blocked) return "blocked";
  if (s.status === "trial" && s.trialEndsAt) {
    const left = new Date(s.trialEndsAt).getTime() - now.getTime();
    return left <= 0 || left > 3 * DAY_MS ? null : "trial";
  }
  if (s.status === "past_due") return "past_due";
  if (!s.enforced) return null;
  if (s.status === "grace" && s.graceEndsAt) return differenceInCalendarDays(new Date(s.graceEndsAt), now) > GRACE_DAYS ? null : "grace";
  if (s.status === "unverified" && s.unverifiedUntil) return "unverified";
  return null;
}

export type LicenseBlock = "trial" | "payment" | "canceled" | "ended" | "activate";

/** Why new work is refused, as the desktop's gate tells it apart. */
export function licenseBlock(s: LicenseState): LicenseBlock {
  const ended = s.status === "expired";
  if ((s.status === "missing" && !!s.graceEndsAt) || (ended && s.endReason === "trial_ended")) return "trial";
  if (ended && s.endReason === "payment_failed") return "payment";
  if (ended && s.endReason === "canceled") return "canceled";
  return ended ? "ended" : "activate";
}

const today = () => format(new Date(), "yyyy-MM-dd");
const storeKey = (kind: string) => `godmode.licenseNotice.${kind}`;

/** A notice waved away stays away for the day. `dismissed` is undefined until the phone answered. */
export function useDismissedToday(kind: string | null) {
  const [day, setDay] = useState<{ kind: string; on: string | null } | null>(null);
  useEffect(() => {
    if (!kind) return;
    let live = true;
    void SecureStore.getItemAsync(storeKey(kind))
      .catch(() => null)
      .then((on) => {
        if (live) setDay({ kind, on });
      });
    return () => {
      live = false;
    };
  }, [kind]);
  const dismiss = () => {
    if (!kind) return;
    const on = today();
    setDay({ kind, on });
    void SecureStore.setItemAsync(storeKey(kind), on).catch(() => undefined);
  };
  return { dismissed: day?.kind === kind ? day?.on === today() : undefined, dismiss };
}
