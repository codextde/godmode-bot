import { useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { differenceInCalendarDays, format } from "date-fns";
import { CreditCard, Gift, KeyRound, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LicenseState } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { dateLocale, t } from "@/i18n";
import { api } from "@/lib/api";
import { cloudContext, storageKey } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { useLicense } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { checkoutUrl } from "./activate";
import { noteCheckoutOpened } from "./deep-link";

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

function freeTrialText(iso: string): string {
  const days = differenceInCalendarDays(new Date(iso), new Date());
  return days <= 0 ? t("license:banner.freeTrial.today") : days === 1 ? t("license:banner.freeTrial.tomorrow") : t("license:banner.freeTrial.daysLeft", { count: days });
}

/** The free trial gets a banner only in its last days; before that the sidebar shows a quiet chip. */
const GRACE_BANNER_DAYS = 3;

function noticeFor(s: LicenseState, actions: { settings: () => void; manage: () => void; refresh: () => void; plans: () => void }): Notice | null {
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
    if (differenceInCalendarDays(new Date(s.graceEndsAt), new Date()) > GRACE_BANNER_DAYS) return null;
    return {
      kind: "grace",
      tone: "info",
      icon: <Gift />,
      text: (
        <>
          {freeTrialText(s.graceEndsAt)} <span className="text-muted-foreground">{t("license:banner.freeTrial.hint")}</span>
        </>
      ),
      action: { label: t("license:banner.seePlans"), run: actions.plans },
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
        plans: () => {
          navigate("/settings/license");
          noteCheckoutOpened();
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

/** Sidebar footer during the free trial: how many days are left, one click from the plans. */
export function FreeTrialChip() {
  const { t } = useTranslation("license");
  const { data } = useLicense(!cloudContext);
  if (cloudContext || !data?.enforced || data.status !== "grace" || !data.graceEndsAt) return null;
  const left = differenceInCalendarDays(new Date(data.graceEndsAt), new Date());
  return (
    <Link
      to="/settings/license"
      title={t("chip.until", { date: shortDate(data.graceEndsAt) })}
      className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:hidden"
    >
      <Gift className="size-4 shrink-0 text-brand-strong" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{t("chip.label")}</span>
      <span className="shrink-0 text-[11px] text-foreground/70 tabular-nums">{left <= 0 ? t("chip.today") : t("chip.daysLeft", { count: left })}</span>
    </Link>
  );
}
