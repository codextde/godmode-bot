import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Stack } from "expo-router";
import { Alert, RefreshControl, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBytes, type CloudBilling, type CloudSubscriptionStatus, type LicensePlan, type LicenseState, type LicenseStatus } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { useFullAccess } from "@/components/full-access";
import { Group } from "@/components/form";
import { SettingsScroll } from "@/components/settings-scroll";
import { QueryState } from "@/components/settings-state";
import { showToast } from "@/components/toast";
import { ActionRow } from "@/components/tool-form";
import { InfoRow } from "@/components/status-rows";
import { hours, UsageCard } from "@/components/usage-chart";
import type { Tone } from "@/components/ui";
import { errorText } from "@/lib/api";
import { dateLocale, intlLocale } from "@/lib/i18n";
import { licenseStateText } from "@/lib/license-text";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

const STATUS = {
  active: { key: "license.status.active", tone: "success" },
  trial: { key: "license.status.trial", tone: "success" },
  past_due: { key: "license.status.pastDue", tone: "warning" },
  grace: { key: "license.status.grace", tone: "success" },
  unverified: { key: "license.status.unverified", tone: "warning" },
  missing: { key: "license.status.missing", tone: "neutral" },
  invalid: { key: "license.status.invalid", tone: "danger" },
  expired: { key: "license.status.expired", tone: "danger" },
} as const satisfies Record<LicenseStatus, { key: string; tone: Tone }>;

const PLAN = {
  private: "license.plan.private",
  company: "license.plan.company",
  monthly: "license.plan.monthly",
  yearly: "license.plan.yearly",
  lifetime: "license.plan.lifetime",
} as const satisfies Record<LicensePlan, string>;

const SUBSCRIPTION = {
  trialing: "license.cloud.sub.trialing",
  active: "license.cloud.sub.active",
  past_due: "license.cloud.sub.pastDue",
  canceled: "license.cloud.sub.canceled",
  unpaid: "license.cloud.sub.unpaid",
  incomplete: "license.cloud.sub.incomplete",
  incomplete_expired: "license.cloud.sub.expired",
  paused: "license.cloud.sub.paused",
} as const satisfies Record<CloudSubscriptionStatus, string>;

const day = (iso: string) => format(new Date(iso), "PP", { locale: dateLocale() });
const count = (n: number) => n.toLocaleString(intlLocale());

/** Settings → License: plain status (and Check again with full access), no way to buy, pay or enter a key (store rules). All of that is on the computer. */
export default function License() {
  const { t } = useTranslation(["settings", "common"]);
  const license = useQuery({ queryKey: sq.license, queryFn: settingsApi.license.get });
  const usage = useQuery({ queryKey: sq.licenseUsage, queryFn: settingsApi.license.usage });
  const cloud = useQuery({ queryKey: sq.cloud, queryFn: settingsApi.cloud.status });
  const linked = !!cloud.data && cloud.data.state !== "unlinked";
  const billing = useQuery({ queryKey: sq.cloudBilling, queryFn: settingsApi.cloud.billing, enabled: linked, retry: false });
  const pull = usePullRefresh(() => Promise.all([license.refetch(), usage.refetch(), queryClient.invalidateQueries({ queryKey: ["usage"] }), cloud.refetch(), linked ? billing.refetch() : null]));

  return (
    <SettingsScroll contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("license.title") }} />
      <CloseButton />
      <QueryState query={license} icon="key" errorTitle={t("license.loadFailed")}>
        {(s) => (
          <>
            <LicenseGroup state={s} />

            {usage.data ? (
              <Group title={t("license.usage.title")} footer={usage.data.since ? t("license.usage.since", { date: day(usage.data.since) }) : undefined}>
                <InfoRow icon="check" label={t("license.usage.tasks")} value={count(usage.data.tasksDone)} />
                <InfoRow icon="clock" label={t("license.usage.automationRuns")} value={count(usage.data.automationRuns)} />
                <InfoRow icon="gauge" label={t("license.usage.worked")} value={hours(usage.data.minutesWorked * 60_000)} />
                <InfoRow icon="agents" label={t("license.usage.agents")} value={count(usage.data.agents)} />
                <InfoRow icon="workflow" label={t("license.usage.automations")} value={count(usage.data.automations)} />
                <InfoRow icon="key" label={t("license.usage.logins")} value={count(usage.data.logins)} />
              </Group>
            ) : null}

            <UsageCard />

            {billing.data ? <CloudPlanGroup billing={billing.data} /> : null}
          </>
        )}
      </QueryState>
    </SettingsScroll>
  );
}

function LicenseGroup({ state: s }: { state: LicenseState }) {
  const { t } = useTranslation("settings");
  // Asking the licence server again is the computer's call: a full-access phone does it like the desktop.
  const admin = useFullAccess().fullAccess === true;
  const check = useMutation({
    mutationFn: settingsApi.license.refresh,
    onSuccess: (next) => {
      queryClient.setQueryData(sq.license, next);
      showToast(t("license.checked"));
    },
    onError: (err) => Alert.alert(t("license.checkFailed"), errorText(err)),
  });
  const status = STATUS[s.status];
  const keepsWorking = s.graceEndsAt && (s.status === "invalid" || s.status === "expired") && new Date(s.graceEndsAt) > new Date() ? s.graceEndsAt : null;
  const footer = [s.enforced ? licenseStateText(s) : t("license.notEnforced"), t("license.onComputer")].filter(Boolean).join("\n\n");

  return (
    <Group title="Godmode Pro" footer={footer}>
      <InfoRow icon="key" label={t("license.statusLabel")} value={t(status.key)} tone={status.tone} />
      {s.plan ? <InfoRow icon="tag" label={t("license.planLabel")} value={t(PLAN[s.plan])} /> : null}
      {s.status === "unverified" && s.unverifiedUntil ? <InfoRow icon="calendar" label={t("license.acceptedUntil")} value={day(s.unverifiedUntil)} /> : null}
      {keepsWorking ? <InfoRow icon="calendar" label={t("license.keepsWorking")} value={day(keepsWorking)} /> : null}
      {admin ? <ActionRow icon="refresh" title={t("license.checkAgain")} busy={check.isPending} onPress={() => check.mutate()} /> : null}
    </Group>
  );
}

function CloudPlanGroup({ billing: b }: { billing: CloudBilling }) {
  const { t } = useTranslation("settings");
  const sub = b.subscription;
  const devices = b.usage.devices;
  const relay = b.usage.relayBytes;
  return (
    <Group title={t("license.cloud.title")}>
      <InfoRow icon="network" label={t("license.planLabel")} value={b.plan.name} tone={sub ? (sub.status === "active" || sub.status === "trialing" ? "success" : "warning") : undefined} />
      {sub ? <InfoRow icon="check" label={t("license.statusLabel")} value={t(SUBSCRIPTION[sub.status])} /> : null}
      <InfoRow icon="display" label={t("license.cloud.computers")} value={devices.limit == null ? count(devices.used) : t("license.cloud.of", { used: count(devices.used), limit: count(devices.limit) })} />
      <InfoRow
        icon="network"
        label={t("license.cloud.relay")}
        value={relay.limit == null ? formatBytes(relay.used) : t("license.cloud.of", { used: formatBytes(relay.used), limit: formatBytes(relay.limit) })}
      />
    </Group>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
