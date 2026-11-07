import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { Alert, RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { BrowserSignIns, DeviceGroup, DeviceGroupPatch, GroupDevice, RemoteRunner, RunnerState } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, PickerRow, SwitchRow, type Option } from "@/components/form";
import { actionFailed } from "@/components/linking-parts";
import { QueryState } from "@/components/settings-state";
import { InfoRow, ago } from "@/components/status-rows";
import { useMenuSheet } from "@/components/header-actions";
import { SettingsScroll } from "@/components/settings-scroll";
import { Button, EmptyState, tap, type Tone } from "@/components/ui";
import { whenText } from "@/lib/format";
import { t as i18nT } from "@/lib/i18n";
import { lk, linkingApi } from "@/lib/linking";
import { queryClient } from "@/lib/query";
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

const STAND_IN_MINUTES = [1, 2, 3, 5, 10, 15];
const FAILOVER_MINUTES = [1, 3, 5, 10, 15, 30];
const HERE = "here";

/**
 * Settings → Devices: the computers of this one's device group. A full-access phone sets the group up like the desktop
 * app (invite, join, leave, remove, stand-in and failover); a limited one only reads it.
 */
export default function Devices() {
  const { t } = useTranslation("settings");
  const { fullAccess } = useFullAccess();
  const group = useQuery({ queryKey: sq.devices, queryFn: settingsApi.devices });
  const runners = useQuery({ queryKey: lk.runners, queryFn: linkingApi.runners.list, enabled: !!fullAccess, retry: false });
  const pull = usePullRefresh(() => Promise.all([group.refetch(), fullAccess ? runners.refetch() : null]));

  return (
    <SettingsScroll contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("devices.title") }} />
      <CloseButton />
      <QueryState query={group} icon="display" errorTitle={t("devices.loadFailed")}>
        {(g) =>
          fullAccess ? (
            <Manage group={g} runners={runners.data ?? []} />
          ) : g.role ? (
            <InGroup group={g} />
          ) : (
            <EmptyState icon="display" title={t("devices.aloneTitle")} body={t("devices.aloneBody")} />
          )
        }
      </QueryState>
    </SettingsScroll>
  );
}

function InGroup({ group: g }: { group: DeviceGroup }) {
  const { t } = useTranslation(["settings", "common"]);
  const after = (on: boolean, minutes: number) => (on ? t("devices.after", { minutes }) : t("common:status.off"));
  return (
    <>
      <StatusGroup group={g} />

      <Group title={t("devices.computers")}>
        {g.devices.map((d) => (
          <DeviceRow key={d.id ?? "primary"} device={d} />
        ))}
      </Group>

      <Group title={t("devices.away.title")}>
        <InfoRow icon="handoff" label={t("devices.away.failover")} value={after(g.failover, g.failoverMinutes)} />
        <InfoRow icon="server" label={t("devices.away.standIn")} value={after(g.standInEnabled, g.standInMinutes)} />
      </Group>
    </>
  );
}

function StatusGroup({ group: g }: { group: DeviceGroup }) {
  const { t } = useTranslation("settings");
  const secondary = g.role === "secondary";
  return (
    <Group footer={secondary && !g.primaryOnline ? (g.primaryError ?? undefined) : undefined}>
      <InfoRow icon="display" label={t("devices.thisComputer")} value={t(secondary ? "devices.role.secondary" : "devices.role.primary")} />
      {secondary && g.primaryName ? <InfoRow icon="server" label={t("devices.primary")} value={g.primaryName} tone={g.primaryOnline ? "success" : "warning"} /> : null}
      {g.standIn.state === "active" && g.standIn.since ? <InfoRow icon="handoff" label={t("devices.standsIn")} value={ago(g.standIn.since)} tone="warning" /> : null}
      {g.standIn.state === "waiting" && g.standIn.takesOverAt ? <InfoRow icon="clock" label={t("devices.takesOver")} value={whenText(g.standIn.takesOverAt)} /> : null}
      {g.pendingChanges ? <InfoRow icon="refresh" label={t("devices.pending")} value={String(g.pendingChanges)} /> : null}
    </Group>
  );
}

function deviceDetail(d: GroupDevice): string {
  return [
    i18nT(d.role === "primary" ? "settings:devices.role.primary" : "settings:devices.role.secondary"),
    d.standingIn ? i18nT("settings:devices.role.standIn") : null,
    d.version ? `Godmode ${d.version}` : null,
    d.platform ? (PLATFORM[d.platform] ?? d.platform) : null,
    d.latencyMs != null && d.state === "online" ? `${d.latencyMs} ms` : null,
    d.activeRuns ? i18nT("settings:devices.runs", { count: d.activeRuns }) : null,
    i18nT("settings:devices.chats", { count: d.conversations }),
  ]
    .filter(Boolean)
    .join(" · ");
}

function DeviceRow({ device: d }: { device: GroupDevice }) {
  const { t } = useTranslation("settings");
  const state = STATE[d.state];
  return (
    <InfoRow
      icon={d.role === "primary" ? "server" : "display"}
      label={d.self ? t("devices.self", { name: d.name }) : d.name}
      detail={deviceDetail(d)}
      value={d.state === "online" || !d.lastSeenAt ? t(state.key) : t("devices.seen", { time: ago(d.lastSeenAt) })}
      tone={state.tone}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Full access                                                          */
/* ------------------------------------------------------------------ */

/** One PATCH /api/devices: shows at once, goes back when the computer refuses it. */
async function patchGroup(input: DeviceGroupPatch) {
  const prev = queryClient.getQueryData<DeviceGroup>(sq.devices);
  if (prev) queryClient.setQueryData<DeviceGroup>(sq.devices, { ...prev, ...input });
  try {
    queryClient.setQueryData(sq.devices, await linkingApi.devices.update(input));
  } catch (err) {
    if (prev) queryClient.setQueryData(sq.devices, prev);
    actionFailed(i18nT("common:errors.couldNotSave"), err);
  }
}

/** Everything the setup of this computer changed: the rest of the app asks again. */
function setupChanged(next: DeviceGroup) {
  queryClient.setQueryData(sq.devices, next);
  void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "devices" });
}

function Manage({ group: g, runners }: { group: DeviceGroup; runners: RemoteRunner[] }) {
  const { t } = useTranslation(["linking", "settings"]);
  const twins = new Set(g.devices.map((d) => d.runnerTwin).filter(Boolean));
  const older = runners.filter((r) => r.kind === "runner" && !twins.has(r.id));

  if (!g.role) {
    return (
      <>
        <EmptyState
          icon="display"
          title={t("settings:devices.aloneTitle")}
          action={
            <View style={{ gap: space.sm, alignSelf: "stretch" }}>
              <Button title={t("devices.add")} icon="plus" onPress={() => router.push("/settings/devices-invite")} />
              <Button title={t("devices.join")} icon="link" variant="secondary" onPress={() => router.push("/settings/devices-join")} />
            </View>
          }
        />
        <OlderRunners runners={older} />
      </>
    );
  }

  return (
    <>
      <StatusGroup group={g} />
      <Handoff group={g} />
      <Group title={t("settings:devices.computers")} action={t("devices.addShort")} onAction={() => router.push("/settings/devices-invite")}>
        {g.devices.map((d) => (
          <ManagedDevice key={d.id ?? "primary"} device={d} group={g} runner={d.runnerTwin ? runners.find((r) => r.id === d.runnerTwin) : undefined} />
        ))}
      </Group>
      <StandIn group={g} />
      <Chats group={g} />
      <SignIns group={g} />
      <OlderRunners runners={older} />
      <Leave group={g} />
    </>
  );
}

function ManagedDevice({ device: d, group: g, runner }: { device: GroupDevice; group: DeviceGroup; runner?: RemoteRunner }) {
  const { t } = useTranslation(["linking", "settings", "common"]);
  const { t: ts } = useTranslation("settings");
  const removable = g.role === "primary" && !d.self && d.role === "secondary" && !!d.id;
  const state = STATE[d.state];
  const value = d.state === "online" || !d.lastSeenAt ? ts(state.key) : ts("devices.seen", { time: ago(d.lastSeenAt) });
  const label = d.self ? ts("devices.self", { name: d.name }) : d.name;
  const detail = [deviceDetail(d), d.fullDiskAccess === false ? t("devices.noFullDisk") : null].filter(Boolean).join(" · ");

  const remove = () =>
    Alert.alert(
      t("devices.removeTitle", { name: d.name }),
      [d.activeRuns > 0 ? t("devices.removeBodyWorking", { count: d.activeRuns }) : t("devices.removeBody"), t("devices.phoneWarning")].join("\n\n"),
      [
        { text: t("common:actions.cancel"), style: "cancel" },
        {
          text: t("common:actions.remove"),
          style: "destructive",
          onPress: () =>
            void linkingApi.devices
              .remove(d.id!)
              .then((next) => {
                tap(Haptics.ImpactFeedbackStyle.Medium);
                queryClient.setQueryData(sq.devices, next);
                void queryClient.invalidateQueries({ queryKey: lk.runners });
              })
              .catch((err) => actionFailed(t("devices.removeFailed", { name: d.name }), err)),
        },
      ],
    );

  const retire = () => {
    const there = d.self ? t("devices.thisComputer") : d.name;
    const n = runner?.conversations ?? 0;
    Alert.alert(t("devices.twinTitle", { there }), [t("devices.twinBody", { there }), n > 0 ? t("devices.twinMoves", { count: n }) : null].filter(Boolean).join(" "), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("devices.twinAction"),
        onPress: () =>
          void linkingApi.devices
            .retireRunner(d.runnerTwin!)
            .then((result) => {
              tap(Haptics.ImpactFeedbackStyle.Medium);
              Alert.alert(t("devices.twinDone", { there }), result.uninstalled ? undefined : t("devices.twinStillStarts", { there, command: "godmode runner uninstall" }));
              void queryClient.invalidateQueries({ queryKey: sq.devices });
              void queryClient.invalidateQueries({ queryKey: lk.runners });
            })
            .catch((err) => actionFailed(t("devices.twinFailed", { there }), err)),
      },
    ]);
  };

  return (
    <View>
      {removable ? (
        <LinkRow icon="display" title={label} detail={detail} value={value} chevron={false} onPress={remove} />
      ) : (
        <InfoRow icon={d.role === "primary" ? "server" : "display"} label={label} detail={detail} value={value} tone={state.tone} />
      )}
      {d.runnerTwin ? <LinkRow icon="terminal" title={t("devices.twin")} detail={t("devices.twinAction")} onPress={retire} /> : null}
    </View>
  );
}

/** Where this computer's running work can go: the primary from a secondary, the online secondaries from the primary. */
function handoffTargets(g: DeviceGroup): GroupDevice[] {
  if (g.role === "secondary") return g.primaryOnline ? g.devices.filter((d) => d.role === "primary") : [];
  return g.devices.filter((d) => !d.self && d.role === "secondary" && d.state === "online");
}

function Handoff({ group: g }: { group: DeviceGroup }) {
  const { t } = useTranslation(["linking", "common"]);
  const [busy, setBusy] = useState(false);
  const menu = useMenuSheet();
  const self = g.devices.find((d) => d.self);
  const working = self?.activeRuns ?? 0;
  const targets = handoffTargets(g);

  const run = async (to: GroupDevice) => {
    setBusy(true);
    try {
      const result = await linkingApi.devices.handoff(g.role === "secondary" ? { from: g.selfId, to: null } : { from: null, to: to.id });
      tap(Haptics.ImpactFeedbackStyle.Medium);
      const moved = result.moved.length;
      const failed = result.failed.length;
      const details = result.failed.map((f) => `${f.title}: ${f.error}`).join("\n");
      if (!moved && !failed) Alert.alert(t("handoff.nothing"));
      else if (!failed) Alert.alert(t("handoff.moved", { count: moved, name: to.name }));
      else Alert.alert(t("handoff.partly", { moved, total: moved + failed, name: to.name }), details);
      void queryClient.invalidateQueries({ queryKey: sq.devices });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      actionFailed(t("handoff.failed", { name: to.name }), err);
    } finally {
      setBusy(false);
    }
  };

  const pick = () => {
    if (targets.length === 1) {
      const to = targets[0]!;
      Alert.alert(t("handoff.confirm", { name: to.name }), t("handoff.body"), [
        { text: t("common:actions.cancel"), style: "cancel" },
        { text: t("handoff.go"), onPress: () => void run(to) },
      ]);
      return;
    }
    if (process.env.EXPO_OS === "android") return menu.show(targets.map((to) => ({ icon: "laptop", title: to.name, onPress: () => void run(to) })), t("handoff.pick"), t("handoff.body"));
    Alert.alert(t("handoff.pick"), t("handoff.body"), [...targets.map((to) => ({ text: to.name, onPress: () => void run(to) })), { text: t("common:actions.cancel"), style: "cancel" as const }]);
  };

  const footer = working === 0 ? t("handoff.idle") : t("handoff.working", { count: working });
  return (
    <>
      <Group title={t("handoff.title")} footer={footer}>
        {targets.length ? (
          <LinkRow
            icon="handoff"
            title={busy ? t("handoff.handingOff") : targets.length === 1 ? t("handoff.to", { name: targets[0]!.name }) : t("handoff.pick")}
            onPress={() => !busy && pick()}
          />
        ) : (
          <InfoRow icon="handoff" label={t("handoff.label")} value={g.role === "secondary" ? t("handoff.primaryAway") : t("handoff.noneOnline")} />
        )}
      </Group>
      {menu.sheet}
    </>
  );
}

const minutesOptions = (list: number[], current: number, label: (n: number) => string): Option<string>[] =>
  (list.includes(current) ? list : [...list, current].sort((a, b) => a - b)).map((n) => ({ value: String(n), label: label(n) }));

function StandIn({ group: g }: { group: DeviceGroup }) {
  const { t } = useTranslation(["linking", "settings", "common"]);
  const primary = g.role === "primary";
  const after = (n: number) => t("settings:devices.after", { minutes: n });
  return (
    <Group title={t("standIn.title")} footer={primary ? undefined : t("onPrimary", { name: g.primaryName ?? t("settings:devices.primary") })}>
      <SwitchRow icon="server" title={t("standIn.label")} value={g.standInEnabled} disabled={!primary} onChange={(standInEnabled) => void patchGroup({ standInEnabled })} />
      {g.standInEnabled ? (
        primary ? (
          <PickerRow
            icon="clock"
            title={t("standIn.after")}
            value={String(g.standInMinutes)}
            options={minutesOptions(STAND_IN_MINUTES, g.standInMinutes, after)}
            onChange={(v) => void patchGroup({ standInMinutes: Number(v) })}
          />
        ) : (
          <InfoRow icon="clock" label={t("standIn.after")} value={after(g.standInMinutes)} />
        )
      ) : null}
    </Group>
  );
}

function Chats({ group: g }: { group: DeviceGroup }) {
  const { t } = useTranslation(["linking", "settings"]);
  const value = g.defaultRunOn ?? HERE;
  const primaryDevice = g.devices.find((d) => d.role === "primary");
  const options: Option<string>[] = [{ value: HERE, label: t("devices.thisComputer") }];
  if (g.role === "secondary" && primaryDevice) options.push({ value: "primary", label: g.primaryName ?? primaryDevice.name, detail: t("settings:devices.role.primary") });
  for (const d of g.devices) {
    if (d.self || d.role !== "secondary" || !d.id) continue;
    if (d.state === "online" || d.id === value) options.push({ value: d.id, label: d.name });
  }
  if (!options.some((o) => o.value === value)) options.push({ value, label: t("chats.gone") });
  const after = (n: number) => t("settings:devices.after", { minutes: n });

  return (
    <Group title={t("chats.title")}>
      <PickerRow icon="chats" title={t("chats.runOn")} value={value} options={options} onChange={(v) => void patchGroup({ defaultRunOn: v === HERE ? null : v })} />
      <SwitchRow icon="handoff" title={t("chats.failover")} value={g.failover} onChange={(failover) => void patchGroup({ failover })} />
      {g.failover ? (
        <PickerRow
          icon="clock"
          title={t("chats.failoverAfter")}
          value={String(g.failoverMinutes)}
          options={minutesOptions(FAILOVER_MINUTES, g.failoverMinutes, after)}
          onChange={(v) => void patchGroup({ failoverMinutes: Number(v) })}
        />
      ) : null}
    </Group>
  );
}

function SignIns({ group: g }: { group: DeviceGroup }) {
  const { t } = useTranslation(["linking", "settings"]);
  const primary = g.role === "primary";
  const options: Option<BrowserSignIns>[] = [
    { value: "own", label: t("signIns.own"), detail: t("signIns.ownLine") },
    { value: "seed", label: t("signIns.seed"), detail: t("signIns.seedLine") },
  ];
  return (
    <Group title={t("signIns.title")} footer={primary ? undefined : t("onPrimary", { name: g.primaryName ?? t("settings:devices.primary") })}>
      {primary ? (
        <PickerRow icon="key" title={t("signIns.label")} value={g.browserSignIns} options={options} onChange={(browserSignIns) => void patchGroup({ browserSignIns })} />
      ) : (
        <InfoRow icon="key" label={t("signIns.label")} value={options.find((o) => o.value === g.browserSignIns)?.label} />
      )}
    </Group>
  );
}

/** Classic runners still paired here (from before device groups). */
function OlderRunners({ runners }: { runners: RemoteRunner[] }) {
  const { t } = useTranslation(["linking", "settings", "common"]);
  const { t: ts } = useTranslation("settings");
  if (!runners.length) return null;

  const remove = (r: RemoteRunner) =>
    Alert.alert(
      t("older.removeTitle", { name: r.name }),
      [t("older.forget"), r.conversations > 0 ? t("older.chats", { count: r.conversations }) : null, r.activeRuns > 0 ? t("older.working", { count: r.activeRuns }) : null]
        .filter(Boolean)
        .join(" "),
      [
        { text: t("common:actions.cancel"), style: "cancel" },
        ...(r.state === "online"
          ? []
          : [
              {
                text: t("older.reconnect"),
                onPress: () =>
                  void linkingApi.runners
                    .connect(r.id)
                    .then((next) => queryClient.setQueryData<RemoteRunner[]>(lk.runners, (old) => old?.map((x) => (x.id === next.id ? next : x))))
                    .catch((err) => actionFailed(t("older.reconnectFailed", { name: r.name }), err)),
              },
            ]),
        {
          text: t("common:actions.remove"),
          style: "destructive",
          onPress: () =>
            void linkingApi.runners
              .remove(r.id)
              .then(() => {
                tap(Haptics.ImpactFeedbackStyle.Medium);
                queryClient.setQueryData<RemoteRunner[]>(lk.runners, (old) => old?.filter((x) => x.id !== r.id));
                void queryClient.invalidateQueries({ queryKey: ["conversations"] });
              })
              .catch((err) => actionFailed(t("devices.removeFailed", { name: r.name }), err)),
        },
      ],
    );

  return (
    <Group title={t("older.title")} footer={t("older.footer")}>
      {runners.map((r) => (
        <LinkRow
          key={r.id}
          icon="terminal"
          title={r.name}
          detail={[ts(STATE[r.state].key), ts("devices.chats", { count: r.conversations }), r.activeRuns ? ts("devices.runs", { count: r.activeRuns }) : null].filter(Boolean).join(" · ")}
          chevron={false}
          onPress={() => remove(r)}
        />
      ))}
    </Group>
  );
}

function Leave({ group: g }: { group: DeviceGroup }) {
  const { t } = useTranslation(["linking", "common"]);
  const primary = g.role === "primary";
  const others = g.devices.length - 1;
  const confirm = () =>
    Alert.alert(
      primary ? t("leave.dissolveTitle") : t("leave.leaveTitle", { name: g.primaryName ?? "" }),
      [primary ? t("leave.dissolveBody", { count: others }) : t("leave.leaveBody", { name: g.primaryName ?? "" }), t("devices.phoneWarning")].join("\n\n"),
      [
        { text: t("common:actions.cancel"), style: "cancel" },
        {
          text: primary ? t("leave.dissolve") : t("leave.leave"),
          style: "destructive",
          onPress: () =>
            void linkingApi.devices
              .leave()
              .then((next) => {
                tap(Haptics.ImpactFeedbackStyle.Medium);
                setupChanged(next);
              })
              .catch((err) => actionFailed(primary ? t("leave.dissolveFailed") : t("leave.leaveFailed"), err)),
        },
      ],
    );
  return (
    <Group>
      <LinkRow icon="logout" tone="danger" title={primary ? t("leave.dissolveButton") : t("leave.leaveButton")} chevron={false} onPress={confirm} />
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
