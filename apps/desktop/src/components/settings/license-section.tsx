import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { differenceInCalendarDays, format, formatDistanceToNow } from "date-fns";
import { ExternalLink, KeyRound, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { LicensePlan, LicenseState, LicenseStatus } from "@godmode/shared";
import { ActivatePanel, LicenseKeyForm } from "@/components/license/activate";
import { ReminderEmailForm, ReminderEmailSet } from "@/components/license/reminder-email";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { dateLocale, t as translate } from "@/i18n";
import { cloudContext } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { useLicense } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { ToneBadge } from "./cloud-section";
import { Callout, InfoRow, SectionHeading, SettingsGroup } from "./settings-kit";

const STATUS = {
  active: { labelKey: "license.status.active", tone: "live" },
  trial: { labelKey: "license.status.trial", tone: "live" },
  past_due: { labelKey: "license.status.pastDue", tone: "warning" },
  grace: { labelKey: "license.status.grace", tone: "live" },
  unverified: { labelKey: "license.status.unverified", tone: "warning" },
  missing: { labelKey: "license.status.missing", tone: "neutral" },
  invalid: { labelKey: "license.status.invalid", tone: "danger" },
  expired: { labelKey: "license.status.expired", tone: "danger" },
} as const satisfies Record<LicenseStatus, { labelKey: string; tone: "live" | "neutral" | "warning" | "danger" }>;

const PLAN = {
  monthly: "license.plan.monthly",
  yearly: "license.plan.yearly",
  lifetime: "license.plan.lifetime",
} as const satisfies Record<LicensePlan, string>;

const day = (iso: string) => format(new Date(iso), translate("settings:license.dateFormat"), { locale: dateLocale() });

function daysLeft(iso: string): string {
  const days = differenceInCalendarDays(new Date(iso), new Date());
  return days <= 0 ? translate("settings:license.endsToday") : translate("settings:license.daysLeft", { count: days });
}

export function LicenseSection() {
  const { t } = useTranslation(["settings", "common"]);
  const license = useLicense();
  return (
    <div className="space-y-5">
      <SectionHeading title={t("license.title")} description={t("license.description")} />
      {license.data ? (
        <LicenseCard state={license.data} />
      ) : license.isError ? (
        <Callout tone="danger" title={t("license.loadError")}>
          {errorMessage(license.error)}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => license.refetch()}>
              <RefreshCw /> {t("common:actions.tryAgain")}
            </Button>
          </div>
        </Callout>
      ) : (
        <div className="space-y-4 rounded-xl border bg-card p-5 shadow-card">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-4 w-56" />
        </div>
      )}
    </div>
  );
}

function LicenseCard({ state: s }: { state: LicenseState }) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const status = STATUS[s.status];
  const local = !cloudContext;

  const refresh = useMutation({
    mutationFn: api.license.refresh,
    onSuccess: (next) => {
      qc.setQueryData(qk.license, next);
      toast.success(t("license.checked"), { id: "license-checked", duration: 1500 });
    },
    onError: (err) => toast.error(t("license.checkError"), { description: errorMessage(err) }),
  });
  const remove = useMutation({
    mutationFn: api.license.remove,
    onSuccess: (next) => {
      qc.setQueryData(qk.license, next);
      toast.success(t("license.removed"));
    },
    onError: (err) => toast.error(t("license.removeError"), { description: errorMessage(err) }),
  });

  if (!s.keyHint) {
    const freeWeek = s.status === "grace" && s.graceEndsAt ? s.graceEndsAt : null;
    return (
      <>
        {s.message && !freeWeek && <Callout tone={s.blocked ? "warning" : "info"}>{s.message}</Callout>}
        <SettingsGroup
          title={freeWeek ? t("license.activate.trialTitle") : t("license.activate.title")}
          icon={<Sparkles />}
          description={freeWeek ? t("license.activate.trialDescription") : t("license.activate.description")}
          actions={<ToneBadge tone={status.tone}>{t(status.labelKey)}</ToneBadge>}
        >
          {freeWeek && (
            <InfoRow label={t("license.freeUntil")}>
              {day(freeWeek)}
              <span className="text-muted-foreground"> · {daysLeft(freeWeek)}</span>
            </InfoRow>
          )}
          <div className="py-5">{local ? <ActivatePanel source="settings" /> : <Callout>{t("license.activate.remote")}</Callout>}</div>
          {freeWeek && s.enforced && local && (
            <div className="py-4">{s.reminderEmail ? <ReminderEmailSet email={s.reminderEmail} /> : <ReminderEmailForm />}</div>
          )}
        </SettingsGroup>
        {!s.enforced && <NotEnforced />}
      </>
    );
  }

  const renewal =
    s.status === "trial" && s.trialEndsAt
      ? { label: s.cancelAtPeriodEnd ? t("license.trialEndsStops") : t("billing.plan.trialEnds"), value: day(s.trialEndsAt) }
      : s.renewsAt
        ? { label: s.cancelAtPeriodEnd ? t("license.cancelsOn") : t("billing.plan.renewsOn"), value: day(s.renewsAt) }
        : s.plan === "lifetime"
          ? { label: t("license.renews"), value: t("license.never") }
          : null;

  return (
    <>
      {s.message && <Callout tone={s.blocked ? "danger" : s.status === "past_due" || s.status === "unverified" ? "warning" : "info"}>{s.message}</Callout>}
      <SettingsGroup
        title={s.plan === "lifetime" ? `Godmode Pro · ${t("license.plan.lifetime")}` : "Godmode Pro"}
        icon={<KeyRound />}
        description={s.checkedAt ? t("license.checkedAgo", { time: formatDistanceToNow(new Date(s.checkedAt), { addSuffix: true, locale: dateLocale() }) }) : t("license.notChecked")}
        actions={<ToneBadge tone={status.tone}>{t(status.labelKey)}</ToneBadge>}
      >
        <InfoRow label={t("cloud.status.plan")}>{s.plan ? t(PLAN[s.plan]) : "—"}</InfoRow>
        {renewal && <InfoRow label={renewal.label}>{renewal.value}</InfoRow>}
        {s.status === "unverified" && s.unverifiedUntil && <InfoRow label={t("license.acceptedUntil")}>{day(s.unverifiedUntil)}</InfoRow>}
        {s.graceEndsAt && (s.status === "invalid" || s.status === "expired") && new Date(s.graceEndsAt) > new Date() && (
          <InfoRow label={t("license.keepsWorking")}>{day(s.graceEndsAt)}</InfoRow>
        )}
        <InfoRow label={t("license.key")} mono>
          <span className="text-muted-foreground">GM-•••••-•••••-•••••-</span>
          {s.keyHint}
        </InfoRow>
        <div className="flex flex-wrap items-center gap-2 py-4">
          {local && (
            <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
              <KeyRound /> {t("license.changeKey")}
            </Button>
          )}
          {s.manageUrl && (
            <Button variant="outline" size="sm" onClick={() => void openExternal(s.manageUrl!)}>
              <ExternalLink /> {t("license.manage")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? <Spinner className="size-3.5" /> : <RefreshCw />} {t("common:actions.refresh")}
          </Button>
          {local && (
            <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => setRemoving(true)} disabled={remove.isPending}>
              {t("license.removeKeyEllipsis")}
            </Button>
          )}
        </div>
      </SettingsGroup>
      {!s.enforced && <NotEnforced />}

      <Dialog open={changing} onOpenChange={setChanging}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("license.changeTitle")}</DialogTitle>
            <DialogDescription>{t("license.changeDescription", { hint: s.keyHint })}</DialogDescription>
          </DialogHeader>
          <LicenseKeyForm autoFocus submitLabel={t("license.useKey")} onActivated={() => setChanging(false)} />
        </DialogContent>
      </Dialog>

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("license.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{s.enforced ? t("license.removeEnforced") : t("license.removeFree")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("license.keep")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              {t("license.removeKey")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function NotEnforced() {
  const { t } = useTranslation("settings");
  return <Callout tone="muted">{t("license.notEnforced")}</Callout>;
}
