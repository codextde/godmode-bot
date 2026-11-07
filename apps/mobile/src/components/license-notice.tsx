import { useMutation, useQuery } from "@tanstack/react-query";
import { differenceInCalendarDays, format } from "date-fns";
import { router } from "expo-router";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import type { LicenseState } from "@godmode/shared";
import { useFullAccess } from "./full-access";
import { HomeNotice } from "./home-notice";
import type { IconName } from "./icon";
import { ActionPill } from "./program-parts";
import { adminApi } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { dateLocale } from "@/lib/i18n";
import { licenseBlock, licenseNotice, useDismissedToday, type LicenseNoticeKind } from "@/lib/license-notice";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";

const ICONS: Record<LicenseNoticeKind, IconName> = { blocked: "key", trial: "sparkles", past_due: "creditCard", grace: "gift", unverified: "key" };

/**
 * What the licence needs attention for, on Home (the desktop's banner, and its gate when new runs are refused). The
 * phone only points at the licence: it never asks for a purchase or leads to one (no in-app purchases, App Review).
 */
export function LicenseNotice() {
  const { t } = useTranslation(["components", "common"]);
  const { fullAccess } = useFullAccess();
  const license = useQuery({ queryKey: sq.license, queryFn: settingsApi.license.get, staleTime: 5 * 60_000 });
  const s = license.data;
  const kind = s ? licenseNotice(s) : null;
  const { dismissed, dismiss } = useDismissedToday(kind === "blocked" ? null : kind);
  const refresh = useMutation({
    mutationFn: adminApi.license.refresh,
    onSuccess: (next) => queryClient.setQueryData(sq.license, next),
    onError: (err) => Alert.alert(t("licenseNotice.checkFailed"), errorText(err)),
  });
  if (!s || !kind || (kind !== "blocked" && dismissed !== false)) return null;

  const view = <ActionPill label={t("licenseNotice.viewLicence")} tone="neutral" onPress={() => router.push("/settings/license")} />;
  const addKey = <ActionPill label={t("licenseNotice.addKey")} onPress={() => router.push("/settings/license-key")} />;
  const check = <ActionPill label={t("licenseNotice.checkAgain")} tone="neutral" busy={refresh.isPending} onPress={() => refresh.mutate()} />;

  if (kind === "blocked") {
    const block = licenseBlock(s);
    return (
      <HomeNotice
        icon={ICONS.blocked}
        tone="danger"
        title={t(`licenseNotice.blocked.${block}`)}
        body={block === "payment" ? t("licenseNotice.blocked.paused") : fullAccess ? t("licenseNotice.blocked.addKey") : t("licenseNotice.blocked.onComputer")}
        actions={
          fullAccess ? (
            <>
              {addKey}
              {s.keyHint ? check : null}
            </>
          ) : (
            view
          )
        }
      />
    );
  }

  return (
    <HomeNotice
      icon={ICONS[kind]}
      tone={kind === "past_due" ? "warning" : "info"}
      title={noticeText(kind, s, t)}
      dismissLabel={t("licenseNotice.dismiss")}
      onDismiss={dismiss}
      actions={!fullAccess ? view : kind === "grace" ? addKey : kind === "unverified" ? check : view}
    />
  );
}

function noticeText(kind: Exclude<LicenseNoticeKind, "blocked">, s: LicenseState, t: ReturnType<typeof useTranslation<"components">>["t"]): string {
  const left = (iso: string) => differenceInCalendarDays(new Date(iso), new Date());
  switch (kind) {
    case "trial": {
      const days = left(s.trialEndsAt!);
      const group = s.cancelAtPeriodEnd ? "trialEnds" : "trialRenews";
      return days <= 0 ? t(`licenseNotice.${group}.today`) : days === 1 ? t(`licenseNotice.${group}.tomorrow`) : t(`licenseNotice.${group}.inDays`, { count: days });
    }
    case "past_due":
      return t("licenseNotice.pastDue");
    case "grace": {
      const days = left(s.graceEndsAt!);
      return days <= 0 ? t("licenseNotice.freeTrial.today") : days === 1 ? t("licenseNotice.freeTrial.tomorrow") : t("licenseNotice.freeTrial.daysLeft", { count: days });
    }
    case "unverified":
      return t("licenseNotice.unverified", { date: format(new Date(s.unverifiedUntil!), t("licenseNotice.dateFormat"), { locale: dateLocale() }) });
  }
}
