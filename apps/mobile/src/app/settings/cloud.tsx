import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { CloudLinkState, CloudStatus } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group } from "@/components/form";
import { QueryState } from "@/components/settings-state";
import { InfoRow, ago } from "@/components/status-rows";
import { EmptyState, type Tone } from "@/components/ui";
import { hostOf } from "@/lib/format";
import { settingsApi, sq } from "@/lib/settings-api";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

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

/** Settings → Cloud: how this computer is linked to Godmode Cloud, read-only. Linking and its switches stay on the computer. */
export default function Cloud() {
  const { t } = useTranslation("settings");
  const status = useQuery({ queryKey: sq.cloud, queryFn: settingsApi.cloud.status });
  const pull = usePullRefresh(status.refetch);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("cloud.title") }} />
      <CloseButton />
      <QueryState query={status} icon="network" errorTitle={t("cloud.loadFailed")}>
        {(s) => (s.state === "unlinked" ? <EmptyState icon="network" title={t("cloud.unlinkedTitle")} body={t("cloud.unlinkedBody")} /> : <Linked status={s} />)}
      </QueryState>
    </ScrollView>
  );
}

function Linked({ status: s }: { status: CloudStatus }) {
  const { t } = useTranslation(["settings", "common"]);
  const state = STATE[s.state];
  const onOff = (on: boolean) => (on ? t("common:status.on") : t("common:status.off"));
  return (
    <>
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

      <Group title={t("cloud.access.title")} footer={t("cloud.onComputer")}>
        <InfoRow icon="link" label={t("cloud.access.link")} value={onOff(s.settings.enabled)} />
        <InfoRow icon="globe" label={t("cloud.access.browser")} value={onOff(s.settings.browserAccess)} />
        <InfoRow icon="phone" label={t("cloud.access.phones")} value={onOff(s.settings.phoneAccess)} />
        <InfoRow icon="lock" label={t("cloud.access.secrets")} value={onOff(s.settings.allowSecrets)} tone={s.settings.allowSecrets ? "warning" : undefined} />
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
