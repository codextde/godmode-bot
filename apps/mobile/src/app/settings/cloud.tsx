import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { Stack } from "expo-router";
import { useState } from "react";
import { Alert, Linking, RefreshControl, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { CloudBilling, CloudLinkState, CloudSettings, CloudStatus } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { BillingLinks } from "@/components/billing-links";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, SwitchRow } from "@/components/form";
import { actionFailed } from "@/components/linking-parts";
import { SettingsScroll } from "@/components/settings-scroll";
import { QueryState } from "@/components/settings-state";
import { InfoRow, ago } from "@/components/status-rows";
import { Button, EmptyState, T, tap, type Tone } from "@/components/ui";
import { hostOf } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { t as i18nT } from "@/lib/i18n";
import { approvalUrl, clock, isLinked, linkingApi, normalizeCloudUrl } from "@/lib/linking";
import { queryClient } from "@/lib/query";
import { isGatewayUrl, useSession } from "@/lib/session";
import { settingsApi, sq } from "@/lib/settings-api";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { fonts, space, useColors } from "@/lib/theme";

const STATE = {
  unlinked: { key: "cloud.state.unlinked", tone: "neutral" },
  linking: { key: "cloud.state.linking", tone: "warning" },
  connecting: { key: "cloud.state.connecting", tone: "warning" },
  online: { key: "cloud.state.online", tone: "success" },
  offline: { key: "cloud.state.offline", tone: "warning" },
  paused: { key: "cloud.state.paused", tone: "neutral" },
  blocked: { key: "cloud.state.blocked", tone: "danger" },
  revoked: { key: "cloud.state.revoked", tone: "danger" },
} as const satisfies Record<CloudLinkState, { key: string; tone: Tone }>;

/**
 * Settings → Cloud: how this computer is linked to Godmode Cloud. A full-access phone links, unlinks and changes what the
 * cloud may do, like the desktop app; a limited one only reads it.
 */
export default function Cloud() {
  const { t } = useTranslation("settings");
  const { fullAccess } = useFullAccess();
  // While a link waits for approval in the browser, ask again until it turns linked.
  const status = useQuery({ queryKey: sq.cloud, queryFn: settingsApi.cloud.status, refetchInterval: (q) => (q.state.data?.state === "linking" ? 2_000 : false) });
  const pull = usePullRefresh(status.refetch);

  return (
    <SettingsScroll
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Screen options={{ title: t("cloud.title") }} />
      <CloseButton />
      <QueryState query={status} icon="network" errorTitle={t("cloud.loadFailed")}>
        {(s) =>
          fullAccess ? (
            <Manage status={s} />
          ) : s.state === "unlinked" ? (
            <EmptyState icon="network" title={t("cloud.unlinkedTitle")} body={t("cloud.unlinkedBody")} />
          ) : (
            <Linked status={s} />
          )
        }
      </QueryState>
    </SettingsScroll>
  );
}

function StatusGroup({ status: s }: { status: CloudStatus }) {
  const { t } = useTranslation("settings");
  const state = STATE[s.state];
  return (
    <Group title={t("cloud.statusTitle")} footer={s.error ?? undefined}>
      <InfoRow icon="network" label={t("cloud.stateLabel")} value={t(state.key)} tone={state.tone} />
      {s.url ? <InfoRow icon="globe" label={t("cloud.server")} value={hostOf(s.url)} /> : null}
      {s.account ? <InfoRow icon="user" label={t("cloud.account")} value={s.account.email} /> : null}
      {s.plan ? <InfoRow icon="tag" label={t("cloud.plan")} value={s.plan.name} /> : null}
      {s.state === "online" && s.connectedSince ? (
        <InfoRow icon="clock" label={t("cloud.connected")} value={ago(s.connectedSince)} />
      ) : s.linkedAt ? (
        <InfoRow icon="clock" label={t("cloud.linked")} value={ago(s.linkedAt)} />
      ) : null}
    </Group>
  );
}

function Linked({ status: s }: { status: CloudStatus }) {
  const { t } = useTranslation(["settings", "common"]);
  const onOff = (on: boolean) => (on ? t("common:status.on") : t("common:status.off"));
  return (
    <>
      <StatusGroup status={s} />
      <Group title={t("cloud.access.title")}>
        <InfoRow icon="link" label={t("cloud.access.link")} value={onOff(s.settings.enabled)} />
        <InfoRow icon="globe" label={t("cloud.access.browser")} value={onOff(s.settings.browserAccess)} />
        <InfoRow icon="phone" label={t("cloud.access.phones")} value={onOff(s.settings.phoneAccess)} />
        <InfoRow icon="lock" label={t("cloud.access.secrets")} value={onOff(s.settings.allowSecrets)} tone={s.settings.allowSecrets ? "warning" : undefined} />
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Full access                                                          */
/* ------------------------------------------------------------------ */

/** This phone reaches the computer through the cloud gateway right now. */
function useViaCloud(): boolean {
  return useSession((s) => isGatewayUrl(s.connection?.activeUrl));
}

function cloudChanged(next: CloudStatus) {
  queryClient.setQueryData(sq.cloud, next);
  void queryClient.invalidateQueries({ queryKey: sq.cloudBilling });
}

function confirmUnlink(viaCloud: boolean, linking: boolean) {
  const run = () =>
    void linkingApi.cloud
      .unlink()
      .then((next) => {
        tap(Haptics.ImpactFeedbackStyle.Medium);
        cloudChanged(next);
      })
      .catch((err) => actionFailed(i18nT("linking:cloud.unlinkFailed"), err));
  if (linking) return run();
  Alert.alert(i18nT("linking:cloud.unlinkTitle"), [i18nT("linking:cloud.unlinkBody"), viaCloud ? i18nT("linking:cloud.cutsThisPhone") : null].filter(Boolean).join("\n\n"), [
    { text: i18nT("common:actions.cancel"), style: "cancel" },
    { text: i18nT("linking:cloud.unlink"), style: "destructive", onPress: run },
  ]);
}

/** Starts linking to `url` and opens the approval page in the browser. */
async function startLink(url: string): Promise<void> {
  try {
    const next = await linkingApi.cloud.link(url);
    cloudChanged(next);
    const page = approvalUrl(next);
    if (page) void Linking.openURL(page).catch(() => undefined);
  } catch (err) {
    actionFailed(i18nT("linking:cloud.linkFailed"), err);
  }
}

function Manage({ status: s }: { status: CloudStatus }) {
  if (s.state === "unlinked") return <LinkForm status={s} />;
  if (s.state === "linking" && s.pending) return <Pending status={s} />;
  return <ManageLinked status={s} />;
}

function LinkForm({ status: s }: { status: CloudStatus }) {
  const c = useColors();
  const { t } = useTranslation(["linking", "settings"]);
  const [value, setValue] = useState(s.url ?? s.defaultUrl ?? "");
  const [busy, setBusy] = useState(false);
  const url = normalizeCloudUrl(value);

  const link = async () => {
    if (!url) return;
    setBusy(true);
    await startLink(url);
    setBusy(false);
  };

  return (
    <>
      <EmptyState icon="network" title={t("settings:cloud.unlinkedTitle")} />
      <Group title={t("cloud.address")} footer={s.error ? t("cloud.lastFailed", { error: s.error }) : t("cloud.trust")}>
        <TextInput
          accessibilityLabel={t("cloud.address")}
          value={value}
          onChangeText={setValue}
          editable={!busy}
          placeholder="https://cloud.example.com"
          placeholderTextColor={c.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
          returnKeyType="go"
          onSubmitEditing={() => void link()}
          style={[styles.field, { color: c.text }]}
        />
      </Group>
      <Button title={busy ? t("settings:cloud.state.connecting") : t("cloud.connect")} icon="network" loading={busy} disabled={!url} onPress={() => void link()} />
    </>
  );
}

function Pending({ status: s }: { status: CloudStatus }) {
  const { t } = useTranslation(["linking", "settings"]);
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const viaCloud = useViaCloud();
  const pending = s.pending!;
  const page = approvalUrl(s);
  const remaining = Math.max(0, Math.round((new Date(pending.expiresAt).getTime() - now) / 1000));
  const expired = remaining === 0;

  const retry = async () => {
    if (!s.url) return;
    setBusy(true);
    await startLink(s.url);
    setBusy(false);
  };

  return (
    <>
      <Group title={t("settings:cloud.state.linking")} footer={expired ? t("cloud.expired") : t("cloud.approveHint", { time: clock(remaining) })}>
        <View style={styles.code}>
          <T variant="mono" selectable style={styles.codeText}>
            {pending.userCode}
          </T>
          <T variant="footnote" muted>
            {hostOf(s.url ?? "")}
          </T>
        </View>
      </Group>
      {expired ? (
        <Button title={t("cloud.newCode")} icon="refresh" loading={busy} onPress={() => void retry()} />
      ) : page ? (
        <Button title={t("cloud.openApproval")} icon="external" onPress={() => void Linking.openURL(page).catch(() => undefined)} />
      ) : null}
      <Button title={t("cloud.cancelLinking")} variant="secondary" onPress={() => confirmUnlink(viaCloud, true)} />
    </>
  );
}

function ManageLinked({ status: s }: { status: CloudStatus }) {
  const { t } = useTranslation(["linking", "settings"]);
  const viaCloud = useViaCloud();
  const billing = useQuery({ queryKey: sq.cloudBilling, queryFn: settingsApi.cloud.billing, enabled: isLinked(s), retry: false });
  const revoked = s.state === "revoked";
  const browserOn = s.settings.enabled && s.settings.browserAccess;

  const set = async (patch: Partial<CloudSettings>) => {
    const prev = queryClient.getQueryData<CloudStatus>(sq.cloud);
    if (prev) queryClient.setQueryData<CloudStatus>(sq.cloud, { ...prev, settings: { ...prev.settings, ...patch } });
    try {
      queryClient.setQueryData(sq.cloud, await linkingApi.cloud.update(patch));
    } catch (err) {
      if (prev) queryClient.setQueryData(sq.cloud, prev);
      actionFailed(t("cloud.accessFailed"), err);
    }
  };

  /** Turning off what carries this phone's own connection, or letting secrets through: asked first. */
  const toggle = (key: keyof CloudSettings) => (on: boolean) => {
    const cuts = !on && viaCloud && (key === "enabled" || key === "phoneAccess");
    if (key === "allowSecrets" && on) {
      Alert.alert(t("cloud.secretsTitle"), t("cloud.secretsBody"), [
        { text: i18nT("common:actions.cancel"), style: "cancel" },
        { text: i18nT("common:actions.enable"), style: "destructive", onPress: () => void set({ allowSecrets: true }) },
      ]);
      return;
    }
    if (cuts) {
      Alert.alert(t("cloud.cutTitle"), t("cloud.cutsThisPhone"), [
        { text: i18nT("common:actions.cancel"), style: "cancel" },
        { text: i18nT("common:actions.disable"), style: "destructive", onPress: () => void set({ [key]: false }) },
      ]);
      return;
    }
    void set({ [key]: on });
  };

  return (
    <>
      <StatusGroup status={s} />

      {revoked ? (
        <Group footer={t("cloud.revokedHint")}>
          <LinkRow icon="key" title={t("cloud.relink")} onPress={() => s.url && void startLink(s.url)} />
        </Group>
      ) : null}

      {s.browserUrl && isLinked(s) ? (
        <Group footer={browserOn ? undefined : t("cloud.inBrowserOff")}>
          {browserOn ? (
            <LinkRow icon="external" title={t("cloud.openInBrowser")} detail={hostOf(s.browserUrl)} onPress={() => void Linking.openURL(s.browserUrl!).catch(() => undefined)} />
          ) : (
            <InfoRow icon="external" label={t("cloud.openInBrowser")} value={i18nT("common:status.off")} />
          )}
        </Group>
      ) : null}

      {!revoked ? (
        <Group title={t("settings:cloud.access.title")}>
          <SwitchRow icon="link" title={t("settings:cloud.access.link")} value={s.settings.enabled} onChange={toggle("enabled")} />
          <SwitchRow icon="globe" title={t("settings:cloud.access.browser")} detail={t("cloud.browserDetail")} value={s.settings.browserAccess} onChange={toggle("browserAccess")} />
          <SwitchRow icon="phone" title={t("settings:cloud.access.phones")} value={s.settings.phoneAccess} onChange={toggle("phoneAccess")} />
          <SwitchRow icon="lock" title={t("settings:cloud.access.secrets")} detail={t("cloud.secretsDetail")} value={s.settings.allowSecrets} onChange={toggle("allowSecrets")} />
        </Group>
      ) : null}

      {billing.data ? <Subscription billing={billing.data} /> : null}
      {billing.data ? <BillingLinks billing={billing.data} /> : null}

      <Group>
        <LinkRow icon="logout" tone="danger" title={t("cloud.unlinkButton")} chevron={false} onPress={() => confirmUnlink(viaCloud, false)} />
      </Group>
    </>
  );
}

/** Cancel at the end of the period, or resume: both can be undone. */
function Subscription({ billing: b }: { billing: CloudBilling }) {
  const { t } = useTranslation("linking");
  const [busy, setBusy] = useState(false);
  const sub = b.subscription;
  const live = !!sub && (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due");
  if (!b.billingEnabled || !sub || !live) return null;
  const end = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : null;

  const change = async (action: "cancel" | "resume") => {
    setBusy(true);
    try {
      queryClient.setQueryData(sq.cloudBilling, action === "cancel" ? await linkingApi.cloud.cancel() : await linkingApi.cloud.resume());
      tap(Haptics.ImpactFeedbackStyle.Medium);
      void queryClient.invalidateQueries({ queryKey: sq.cloud });
    } catch (err) {
      actionFailed(action === "cancel" ? t("billing.cancelFailed") : t("billing.resumeFailed"), err);
    } finally {
      setBusy(false);
    }
  };

  const confirm = (action: "cancel" | "resume") =>
    Alert.alert(
      action === "cancel" ? t("billing.cancelTitle") : t("billing.resumeTitle"),
      action === "cancel" ? (end ? t("billing.cancelUntil", { date: end }) : t("billing.cancelPeriod")) : end ? t("billing.resumeOn", { date: end }) : undefined,
      [
        { text: action === "cancel" ? t("billing.keep") : i18nT("common:actions.cancel"), style: "cancel" },
        { text: action === "cancel" ? t("billing.cancel") : t("billing.resume"), style: action === "cancel" ? "destructive" : "default", onPress: () => void change(action) },
      ],
    );

  return (
    <Group title={t("billing.title")} footer={end ? (sub.cancelAtPeriodEnd ? t("billing.endsOn", { date: end }) : t("billing.renewsOn", { date: end })) : undefined}>
      {sub.cancelAtPeriodEnd ? (
        <LinkRow icon="refresh" title={busy ? i18nT("common:status.saving") : t("billing.resume")} chevron={false} onPress={() => !busy && confirm("resume")} />
      ) : (
        <LinkRow icon="close" tone="danger" title={busy ? i18nT("common:status.saving") : t("billing.cancelPlan")} chevron={false} onPress={() => !busy && confirm("cancel")} />
      )}
    </Group>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  field: {
    fontFamily: fonts.regular,
    fontSize: 15,
    paddingHorizontal: space.lg,
    paddingVertical: 15,
  },
  code: {
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.xl,
  },
  codeText: {
    fontSize: 28,
    lineHeight: 34,
    letterSpacing: 3,
  },
});
