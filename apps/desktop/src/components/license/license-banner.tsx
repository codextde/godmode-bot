import { useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { differenceInCalendarDays, format } from "date-fns";
import { CreditCard, Gift, KeyRound, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LicenseState } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { dateLocale, t } from "@/i18n";
import { api } from "@/lib/api";
import { storageKey } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { useLicense } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { checkoutUrl } from "./activate";

const DAY_MS = 86_400_000;

type Kind = "trial" | "past_due" | "grace" | "unverified";

interface Notice {
  kind: Kind;
  tone: "info" | "warning";
  icon: ReactNode;
  text: ReactNode;
  action: Action | null;
  secondary?: Action;
}

interface Action {
  label: string;
  run: () => void;
}

const today = () => format(new Date(), "yyyy-MM-dd");
const dismissKey = (kind: Kind) => storageKey(`gm:license-banner:${kind}`);

function dismissedToday(kind: Kind): boolean {
  try {
    return localStorage.getItem(dismissKey(kind)) === today();
  } catch {
    return false;
  }
}

function trialText(iso: string, cancelAtPeriodEnd: boolean): string {
  const days = differenceInCalendarDays(new Date(iso), new Date());
  if (cancelAtPeriodEnd) {
    return days <= 0 ? t("license:banner.trialEnds.today") : days === 1 ? t("license:banner.trialEnds.tomorrow") : t("license:banner.trialEnds.inDays", { count: days });
  }
  return days <= 0 ? t("license:banner.trialRenews.today") : days === 1 ? t("license:banner.trialRenews.tomorrow") : t("license:banner.trialRenews.inDays", { count: days });
}

const shortDate = (iso: string) => format(new Date(iso), t("license:banner.dateFormat"), { locale: dateLocale() });

function noticeFor(s: LicenseState, actions: { settings: () => void; manage: () => void; refresh: () => void; trial: () => void }): Notice | null {
  if (s.blocked) return null;
  if (s.status === "trial" && s.trialEndsAt) {
    const left = new Date(s.trialEndsAt).getTime() - Date.now();
    if (left <= 0 || left > 3 * DAY_MS) return null;
    return {
      kind: "trial",
      tone: "info",
      icon: <Sparkles />,
      text: trialText(s.trialEndsAt, !!s.cancelAtPeriodEnd),
      action: s.manageUrl
        ? { label: s.cancelAtPeriodEnd ? t("license:banner.keepGodmode") : t("license:banner.managePlan"), run: actions.manage }
        : { label: t("license:banner.viewLicence"), run: actions.settings },
    };
  }
  if (s.status === "past_due") {
    return {
      kind: "past_due",
      tone: "warning",
      icon: <CreditCard />,
      text: t("license:banner.pastDue"),
      action: s.manageUrl ? { label: t("license:banner.updatePayment"), run: actions.manage } : { label: t("license:banner.viewLicence"), run: actions.settings },
    };
  }
  if (!s.enforced) return null;
  if (s.status === "grace" && s.graceEndsAt) {
    return {
      kind: "grace",
      tone: "info",
      icon: <Gift />,
      text: t("license:banner.grace", { date: shortDate(s.graceEndsAt) }),
      action: { label: t("license:banner.startTrial"), run: actions.trial },
      secondary: { label: t("license:banner.addKey"), run: actions.settings },
    };
  }
  if (s.status === "unverified" && s.unverifiedUntil) {
    return {
      kind: "unverified",
      tone: "info",
      icon: <KeyRound />,
      text: t("license:banner.unverified", { date: shortDate(s.unverifiedUntil) }),
      action: { label: t("license:checkAgain"), run: actions.refresh },
    };
  }
  return null;
}

/** One slim line above the page when the licence needs attention soon (not on the licence page); dismissed, it stays away for the day. */
export function LicenseBanner() {
  const { t } = useTranslation("license");
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const { data } = useLicense();
  const [, setDismissed] = useState(0);
  const refresh = useMutation({ mutationFn: api.license.refresh, onSuccess: (next) => qc.setQueryData(qk.license, next) });
  const notice = data
    ? noticeFor(data, {
        settings: () => navigate("/settings/license"),
        manage: () => data.manageUrl && void openExternal(data.manageUrl),
        refresh: () => refresh.mutate(),
        trial: () => {
          navigate("/settings/license");
          void openExternal(checkoutUrl("banner"));
        },
      })
    : null;
  const shown = notice && !dismissedToday(notice.kind) && !pathname.startsWith("/settings/license") ? notice : null;

  const dismiss = (kind: Kind) => {
    try {
      localStorage.setItem(dismissKey(kind), today());
    } catch {
      /* ignore */
    }
    setDismissed((n) => n + 1);
  };

  return (
    <AnimatePresence initial={false}>
      {shown && (
        <motion.div
          key={shown.kind}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="shrink-0 overflow-hidden"
        >
          <div className="px-3 pt-3">
            <div
              role="status"
              className={cn(
                "flex min-h-10 items-center gap-3 rounded-lg border py-1.5 pr-1.5 pl-3 text-[13px] shadow-card",
                shown.tone === "warning" ? "border-warning/30 bg-warning/[0.07]" : "bg-card",
              )}
            >
              <span className={cn("shrink-0 [&_svg]:size-4", shown.tone === "warning" ? "text-warning" : "text-brand-strong")}>{shown.icon}</span>
              <p className="min-w-0 flex-1 leading-snug">{shown.text}</p>
              {shown.secondary && (
                <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={shown.secondary.run}>
                  {shown.secondary.label}
                </Button>
              )}
              {shown.action && (
                <Button size="sm" variant="outline" className="h-7 shrink-0 bg-card" onClick={shown.action.run}>
                  {shown.action.label}
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground" aria-label={t("banner.dismiss")} onClick={() => dismiss(shown.kind)}>
                <X />
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
