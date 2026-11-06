import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { RefreshControl, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { DeviceGroup, GroupDevice, RunnerState } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group } from "@/components/form";
import { QueryState } from "@/components/settings-state";
import { InfoRow, ago } from "@/components/status-rows";
import { EmptyState, type Tone } from "@/components/ui";
import { whenText } from "@/lib/format";
import { settingsApi, sq } from "@/lib/settings-api";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

const STATE = {
  online: { key: "devices.state.online", tone: "success" },
  connecting: { key: "devices.state.connecting", tone: "warning" },
  offline: { key: "devices.state.offline", tone: "neutral" },
  update_required: { key: "devices.state.updateRequired", tone: "warning" },
} as const satisfies Record<RunnerState, { key: string; tone: Tone }>;

const PLATFORM: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** Settings → Devices: the computers of this one's device group, read-only. Who belongs to it is decided on the computers. */
export default function Devices() {
  const { t } = useTranslation("settings");
  const group = useQuery({ queryKey: sq.devices, queryFn: settingsApi.devices });
  const pull = usePullRefresh(group.refetch);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("devices.title") }} />
      <CloseButton />
      <QueryState query={group} icon="display" errorTitle={t("devices.loadFailed")}>
        {(g) => (g.role ? <InGroup group={g} /> : <EmptyState icon="display" title={t("devices.aloneTitle")} body={t("devices.aloneBody")} />)}
      </QueryState>
    </ScrollView>
  );
}

function InGroup({ group: g }: { group: DeviceGroup }) {
  const { t } = useTranslation(["settings", "common"]);
  const secondary = g.role === "secondary";
  const after = (on: boolean, minutes: number) => (on ? t("devices.after", { minutes }) : t("common:status.off"));
  return (
    <>
      <Group footer={secondary && !g.primaryOnline ? (g.primaryError ?? undefined) : undefined}>
        <InfoRow icon="display" label={t("devices.thisComputer")} value={t(secondary ? "devices.role.secondary" : "devices.role.primary")} />
        {secondary && g.primaryName ? (
          <InfoRow icon="server" label={t("devices.primary")} value={g.primaryName} tone={g.primaryOnline ? "success" : "warning"} />
        ) : null}
        {g.standIn.state === "active" && g.standIn.since ? <InfoRow icon="handoff" label={t("devices.standsIn")} value={ago(g.standIn.since)} tone="warning" /> : null}
        {g.standIn.state === "waiting" && g.standIn.takesOverAt ? <InfoRow icon="clock" label={t("devices.takesOver")} value={whenText(g.standIn.takesOverAt)} /> : null}
        {g.pendingChanges ? <InfoRow icon="refresh" label={t("devices.pending")} value={String(g.pendingChanges)} /> : null}
      </Group>

      <Group title={t("devices.computers")}>
        {g.devices.map((d) => (
          <DeviceRow key={d.id ?? "primary"} device={d} />
        ))}
      </Group>

      <Group title={t("devices.away.title")} footer={t("devices.onComputer")}>
        <InfoRow icon="handoff" label={t("devices.away.failover")} value={after(g.failover, g.failoverMinutes)} />
        <InfoRow icon="server" label={t("devices.away.standIn")} value={after(g.standInEnabled, g.standInMinutes)} />
      </Group>
    </>
  );
}

function DeviceRow({ device: d }: { device: GroupDevice }) {
  const { t } = useTranslation("settings");
  const state = STATE[d.state];
  const detail = [
    t(d.role === "primary" ? "devices.role.primary" : "devices.role.secondary"),
    d.standingIn ? t("devices.role.standIn") : null,
    d.version ? `Godmode ${d.version}` : null,
    d.platform ? (PLATFORM[d.platform] ?? d.platform) : null,
    d.latencyMs != null && d.state === "online" ? `${d.latencyMs} ms` : null,
    d.activeRuns ? t("devices.runs", { count: d.activeRuns }) : null,
    t("devices.chats", { count: d.conversations }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <InfoRow
      icon={d.role === "primary" ? "server" : "display"}
      label={d.self ? t("devices.self", { name: d.name }) : d.name}
      detail={detail}
      value={d.state === "online" || !d.lastSeenAt ? t(state.key) : t("devices.seen", { time: ago(d.lastSeenAt) })}
      tone={state.tone}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
