import { useMutation, useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { Alert, RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { androidSummary, type AndroidDevice, type AndroidStatus, type Settings } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { PhoneTile } from "@/components/android-parts";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, LinkRow, SwitchRow } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { ActionPill, reportInstall, ToolRow } from "@/components/program-parts";
import { ListRow } from "@/components/readonly-list";
import { phoneState } from "@/components/screen-tile";
import { SettingsScroll } from "@/components/settings-scroll";
import { FormSkeleton } from "@/components/settings-state";
import { InfoRow } from "@/components/status-rows";
import { TestResult } from "@/components/tool-form";
import { Button, EmptyState, ErrorState, T } from "@/components/ui";
import { adminApi, patchAnySettings, withVaultGrant } from "@/lib/admin";
import { api, errorText } from "@/lib/api";
import { machinesApi, mk, refreshPhones } from "@/lib/machines";
import { programsApi } from "@/lib/programs";
import { qk, queryClient } from "@/lib/query";
import { useSettings } from "@/lib/setup";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

/** Android phones connected to the computer over adb, like the desktop's Android settings: phones, Wi-Fi, fills, adb. */
export default function AndroidPhones() {
  const { t } = useTranslation("machines");
  const status = useQuery({ queryKey: mk.androidStatus, queryFn: programsApi.androidStatus });
  const settings = useSettings();
  const pull = usePullRefresh(() => Promise.all([status.refetch(), settings.refetch(), queryClient.invalidateQueries({ queryKey: qk.androidDevices })]));
  return (
    <SettingsScroll
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Screen options={{ title: t("android.title") }} />
      <CloseButton />
      <FullAccessGate skeleton={<FormSkeleton groups={3} rows={2} />}>
        <AdminQueryState query={status} errorTitle={t("android.checkFailed")} skeleton={<FormSkeleton groups={3} rows={2} />}>
          {(s) => (
            <>
              {settings.data?.android.enabled === false ? (
                <Group>
                  <LinkRow icon="power" title={t("android.turnedOff")} onPress={() => router.push("/settings/features")} />
                </Group>
              ) : null}
              <Phones status={s} />
              {settings.data ? <AndroidSettingsGroups settings={settings.data} status={s} /> : null}
            </>
          )}
        </AdminQueryState>
      </FullAccessGate>
    </SettingsScroll>
  );
}

function Phones({ status: s }: { status: AndroidStatus }) {
  const { t } = useTranslation(["machines", "programs"]);
  const list = useQuery({ queryKey: qk.androidDevices, queryFn: api.android.devices });
  const rescan = useMutation({
    mutationFn: machinesApi.android.rescan,
    onSettled: () => void refreshPhones(),
    onError: (err) => Alert.alert(t("android.rescanFailed"), errorText(err)),
  });
  const install = useMutation({
    mutationFn: programsApi.installAndroidTools,
    onSettled: (result, err) => {
      reportInstall(err ?? result, { done: t("android.adbReady"), failed: t("android.adbFailed") });
      void refreshPhones();
    },
  });
  const devices = list.data ?? [];
  const here = devices.filter((d) => d.state !== "disconnected");
  const away = devices.filter((d) => d.state === "disconnected");
  const ready = s.adb.installed;
  const connect = () => router.push("/settings/android-connect");

  const row = (d: AndroidDevice) => (
    <ListRow
      key={d.id}
      grouped
      lead={<PhoneTile device={d} />}
      title={d.name}
      lines={[androidSummary(d), d.state === "connected" && d.battery ? `${phoneState(d)} · ${d.battery.level}%` : phoneState(d)]}
      onPress={() => router.push({ pathname: "/settings/android-phone", params: { id: d.id } })}
    />
  );

  return (
    <>
      {ready ? (
        <HeaderActions
          actions={[
            { icon: "refresh", label: t("android.rescan"), onPress: () => rescan.mutate() },
            { icon: "plus", label: t("android.connectWifi"), onPress: connect },
          ]}
        />
      ) : null}

      {!ready ? (
        <Group footer={s.canInstall ? t("android.adbCanInstall") : t("android.adbManual")}>
          <ToolRow
            title={t("android.adbTitle")}
            detail={t("programs:notInstalled")}
            action={s.canInstall ? <ActionPill label={t("android.installAdb")} busyLabel={t("android.installing")} busy={install.isPending} onPress={() => install.mutate()} /> : undefined}
          />
        </Group>
      ) : null}

      {s.pending.length ? (
        <Group title={t("android.waiting")}>
          {s.pending.map((p) => (
            <ListRow key={p.adbSerial} grouped icon="phone" title={p.state === "unauthorized" ? t("android.waitingOk") : t("android.waitingConnect")} lines={[p.adbSerial, p.hint]} />
          ))}
        </Group>
      ) : null}

      {s.error ? (
        <Group>
          <TestResult ok={false} title="adb" body={s.error} />
        </Group>
      ) : null}

      {list.isLoading ? (
        <FormSkeleton groups={1} rows={2} />
      ) : list.isError ? (
        <ErrorState title={t("android.loadFailed")} error={errorText(list.error)} onRetry={() => void list.refetch()} />
      ) : devices.length === 0 ? (
        ready ? (
          <EmptyState
            style={styles.state}
            icon="phone"
            title={t("android.emptyTitle")}
            body={t("android.emptyBody")}
            action={<Button title={t("android.connectWifi")} icon="plus" variant="outline" onPress={connect} />}
          />
        ) : null
      ) : (
        <>
          {here.length ? <Group title={t("android.connectedCount", { connected: here.filter((d) => d.state === "connected").length, total: devices.length })}>{here.map(row)}</Group> : null}
          {away.length ? <Group title={t("android.notConnected")}>{away.map(row)}</Group> : null}
        </>
      )}
    </>
  );
}

function AndroidSettingsGroups({ settings: s, status }: { settings: Settings; status: AndroidStatus }) {
  const { t } = useTranslation(["machines", "common", "programs"]);
  const a = s.android;
  const setVaultFill = (on: boolean) => {
    if (!on) return void patchAnySettings({ android: { vaultFill: false } });
    void withVaultGrant(t("android.fillFailed"), async (grant) => queryClient.setQueryData(qk.settings, await adminApi.security.settings({ android: { vaultFill: true } }, grant)));
  };
  const saveAdbPath = (adbPath: string) =>
    void patchAnySettings({ android: { adbPath: adbPath.trim() } }).then((ok) => {
      if (ok) void refreshPhones();
    });
  const adb = status.adb;

  return (
    <>
      <Group title={t("android.fillTitle")} footer={t("android.fillFooter")}>
        <SwitchRow icon="key" title={t("android.fill")} value={a.vaultFill} onChange={setVaultFill} />
      </Group>

      <Group title="adb" footer={t("android.adbPathFooter")}>
        <InfoRow
          label={t("android.adbState")}
          value={adb.installed ? [adb.version ? `adb ${adb.version}` : t("android.installed"), adb.managed ? t("android.ownCopy") : t("android.found")].join(" · ") : t("programs:notInstalled")}
          tone={adb.installed ? "success" : "warning"}
        />
        {adb.path ? (
          <View style={styles.path}>
            <T variant="mono" muted selectable numberOfLines={2}>
              {adb.path}
            </T>
          </View>
        ) : null}
        <FieldRow label={t("android.adbPath")} value={a.adbPath} placeholder={t("android.automatic")} stacked maxLength={4096} onCommit={saveAdbPath} />
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
  state: {
    paddingTop: 40,
  },
  path: {
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
});
