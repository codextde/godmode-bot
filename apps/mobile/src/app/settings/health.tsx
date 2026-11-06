import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useState } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { PowerStatus } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group, SwitchRow, Tile } from "@/components/form";
import { QueryState } from "@/components/settings-state";
import { CheckRow, ago } from "@/components/status-rows";
import { Card, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { patchSettings, useSettings } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";

/** Settings → System health: the tools and permissions Godmode relies on, its upkeep, and lid-closed mode. Repairs happen on the computer. */
export default function Health() {
  const { t } = useTranslation("settings");
  const doctor = useQuery({ queryKey: sq.doctor, queryFn: () => settingsApi.doctor.get() });
  const permissions = useQuery({ queryKey: sq.permissions, queryFn: settingsApi.doctor.permissions });
  const maintenance = useQuery({ queryKey: sq.maintenance, queryFn: settingsApi.doctor.maintenance });
  const power = useQuery({ queryKey: sq.power, queryFn: settingsApi.power.get });
  const settings = useSettings();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      queryClient.setQueryData(sq.doctor, await settingsApi.doctor.get(true));
    } catch {
      // The screen keeps what it had; the next pull tries again.
    } finally {
      await Promise.all([permissions.refetch(), maintenance.refetch(), power.refetch()]);
      setRefreshing(false);
    }
  };

  const m = settings.data?.maintenance;
  const upkeep = maintenance.data;
  const upkeepLine = !upkeep
    ? undefined
    : upkeep.running
      ? t("health.upkeep.running")
      : [upkeep.lastRunAt ? t("health.upkeep.lastLook", { time: ago(upkeep.lastRunAt) }) : t("health.upkeep.notYet"), upkeep.postponed].filter(Boolean).join(" ");

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <Stack.Screen options={{ title: t("health.title") }} />
      <CloseButton />
      <QueryState query={doctor} icon="heart" errorTitle={t("health.loadFailed")}>
        {(report) => {
          const broken = report.dependencies.filter((d) => !d.ok && d.required).length + (permissions.data?.permissions.filter((p) => !p.ok && p.required).length ?? 0);
          return (
            <>
              <Summary problems={broken} checkedAt={report.checkedAt} />

              <Group title={t("health.tools")}>
                {report.dependencies.map((d) => (
                  <CheckRow key={d.id} title={d.name} detail={d.detail} ok={d.ok || (d.required ? false : null)} />
                ))}
              </Group>

              {permissions.data ? (
                <Group title={t("health.permissions")} footer={permissions.data.ok ? undefined : t("health.fixOnComputer")}>
                  {permissions.data.permissions.map((p) => (
                    <CheckRow key={p.id} title={p.name} detail={p.detail} ok={p.ok || (p.required ? false : null)} />
                  ))}
                </Group>
              ) : null}

              {m ? (
                <Group title={t("health.upkeep.title")} footer={upkeepLine}>
                  <SwitchRow icon="wrench" title={t("health.upkeep.autoFix")} value={m.autoFix} onChange={(autoFix) => void patchSettings({ maintenance: { autoFix } })} />
                  <SwitchRow icon="refresh" title={t("health.upkeep.autoUpdate")} value={m.autoUpdate} onChange={(autoUpdate) => void patchSettings({ maintenance: { autoUpdate } })} />
                  <SwitchRow icon="broom" title={t("health.upkeep.autoCleanup")} value={m.autoCleanup} onChange={(autoCleanup) => void patchSettings({ maintenance: { autoCleanup } })} />
                </Group>
              ) : null}

              {power.data?.supported ? <PowerGroup status={power.data} /> : null}
            </>
          );
        }}
      </QueryState>
    </ScrollView>
  );
}

function Summary({ problems, checkedAt }: { problems: number; checkedAt: string }) {
  const c = useColors();
  const { t } = useTranslation("settings");
  return (
    <Card style={styles.summary}>
      <Tile icon={problems ? "warning" : "heart"} size={40} tint={problems ? c.warning : c.success} />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="headline">{problems ? t("health.problems", { count: problems }) : t("health.allGood")}</T>
        <T variant="footnote" muted>
          {problems ? t("health.fixOnComputer") : t("health.checked", { time: ago(checkedAt) })}
        </T>
      </View>
    </Card>
  );
}

const POWER_STATE = {
  off: "health.power.state.off",
  on: "health.power.state.on",
  idle: "health.power.state.idle",
  low_battery: "health.power.state.lowBattery",
  error: "health.power.state.error",
} as const satisfies Record<PowerStatus["state"], string>;

/** Lid-closed mode: switched from the phone only once macOS allowed Godmode to on the computer. */
function PowerGroup({ status }: { status: PowerStatus }) {
  const { t } = useTranslation("settings");
  const [pending, setPending] = useState(false);
  const battery = status.battery ? t(status.battery.charging ? "health.power.charging" : "health.power.battery", { percent: status.battery.percent }) : null;
  const state = status.state === "error" && status.error ? status.error : t(POWER_STATE[status.state]);

  const toggle = async (enabled: boolean) => {
    setPending(true);
    queryClient.setQueryData<PowerStatus>(sq.power, (s) => (s ? { ...s, enabled } : s));
    try {
      queryClient.setQueryData(sq.power, await settingsApi.power.setLid(enabled));
    } catch (err) {
      void queryClient.invalidateQueries({ queryKey: sq.power });
      Alert.alert(t("health.power.failed"), errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Group title={t("health.power.title")} footer={status.permission ? undefined : t("health.power.needsComputer")}>
      <SwitchRow
        icon="power"
        title={t("health.power.keepWorking")}
        detail={[state, battery].filter(Boolean).join(" · ")}
        value={status.enabled}
        disabled={pending || !status.permission}
        onChange={(on) => void toggle(on)}
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
  summary: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    padding: space.lg,
  },
});
