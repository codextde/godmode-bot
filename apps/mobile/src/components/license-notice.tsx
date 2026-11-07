import { useQuery } from "@tanstack/react-query";
import { differenceInCalendarDays, format } from "date-fns";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import type { LicenseState } from "@godmode/shared";
import { HomeNotice } from "./home-notice";
import { ActionPill } from "./program-parts";
import { dateLocale } from "@/lib/i18n";
import { licenseNotice, useDismissedToday, type LicenseNoticeKind } from "@/lib/license-notice";
import { settingsApi, sq } from "@/lib/settings-api";

/**
 * What the licence needs attention for, on Home: one neutral line. The phone never asks for a purchase or a key, names a
 * price or a payment, or leads to one (store payment rules).
 */
export function LicenseNotice() {
  const { t } = useTranslation(["components", "common"]);
  const license = useQuery({ queryKey: sq.license, queryFn: settingsApi.license.get, staleTime: 5 * 60_000 });
  const s = license.data;
  const kind = s ? licenseNotice(s) : null;
  const { dismissed, dismiss } = useDismissedToday(kind === "blocked" ? null : kind);
  if (!s || !kind || (kind !== "blocked" && dismissed !== false)) return null;

  const view = <ActionPill label={t("licenseNotice.viewLicence")} tone="neutral" onPress={() => router.push("/settings/license")} />;
  if (kind === "blocked") return <HomeNotice icon="key" tone="danger" title={t("licenseNotice.needed")} actions={view} />;
  return (
    <HomeNotice
      icon="key"
      tone={kind === "past_due" ? "warning" : "info"}
      title={noticeText(kind, s, t)}
      dismissLabel={t("licenseNotice.dismiss")}
      onDismiss={dismiss}
      actions={view}
    />
  );
}

function noticeText(kind: Exclude<LicenseNoticeKind, "blocked">, s: LicenseState, t: ReturnType<typeof useTranslation<"components">>["t"]): string {
  const ending = (iso: string) => {
    const days = differenceInCalendarDays(new Date(iso), new Date());
    return days <= 0 ? t("licenseNotice.ending.today") : days === 1 ? t("licenseNotice.ending.tomorrow") : t("licenseNotice.ending.inDays", { count: days });
  };
  switch (kind) {
    case "trial":
      return ending(s.trialEndsAt!);
    case "past_due":
      return t("licenseNotice.pastDue");
    case "grace":
      return ending(s.graceEndsAt!);
    case "unverified":
      return t("licenseNotice.unverified", { date: format(new Date(s.unverifiedUntil!), t("licenseNotice.dateFormat"), { locale: dateLocale() }) });
  }
}
