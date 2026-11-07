import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useState } from "react";
import { Alert, RefreshControl, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { POWER_MIN_BATTERY_OPTIONS, type PowerSettings, type PowerStatus, type ToolId, type ToolUpdateResult, type ToolUpdateStatus } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, SwitchRow } from "@/components/form";
import { ActionPill, ToolRow } from "@/components/program-parts";
import { SettingsScroll } from "@/components/settings-scroll";
import { ago } from "@/components/status-rows";
import { patchAnySettings } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { t as translate } from "@/lib/i18n";
import { lastLines, pk, programsApi, recheckDoctor } from "@/lib/programs";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { patchSettings, useSettings } from "@/lib/setup";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

/** Settings → System health → updates and upkeep: the tools' updates, what Godmode looks after itself, and lid-closed mode. */
export default function Upkeep() {
  const { t } = useTranslation("settings");
  const admin = useFullAccess().fullAccess === true;
  const maintenance = useQuery({ queryKey: sq.maintenance, queryFn: settingsApi.doctor.maintenance });
  const power = useQuery({ queryKey: sq.power, queryFn: settingsApi.power.get });
  const settings = useSettings();
  const pull = usePullRefresh(() => Promise.all([maintenance.refetch(), power.refetch(), settings.refetch(), queryClient.invalidateQueries({ queryKey: pk.updates })]));

  const m = settings.data?.maintenance;
  const upkeep = maintenance.data;
  const upkeepLine = !upkeep
    ? undefined
    : upkeep.running
      ? t("health.upkeep.running")
      : [upkeep.lastRunAt ? t("health.upkeep.lastLook", { time: ago(upkeep.lastRunAt) }) : t("health.upkeep.notYet"), upkeep.postponed].filter(Boolean).join(" ");

  return (
    <SettingsScroll contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("health.upkeep.link") }} />
      <CloseButton />
      {admin ? <Updates /> : null}
      {m ? (
        <Group title={t("health.upkeep.title")} footer={upkeepLine}>
          <SwitchRow icon="wrench" title={t("health.upkeep.autoFix")} value={m.autoFix} onChange={(autoFix) => void patchSettings({ maintenance: { autoFix } })} />
          <SwitchRow icon="refresh" title={t("health.upkeep.autoUpdate")} value={m.autoUpdate} onChange={(autoUpdate) => void patchSettings({ maintenance: { autoUpdate } })} />
          <SwitchRow icon="broom" title={t("health.upkeep.autoCleanup")} value={m.autoCleanup} onChange={(autoCleanup) => void patchSettings({ maintenance: { autoCleanup } })} />
        </Group>
      ) : null}
      {power.data?.supported ? <PowerGroup status={power.data} settings={admin ? settings.data?.power : undefined} /> : null}
    </SettingsScroll>
  );
}

const due = (tools: ToolUpdateStatus[]) => tools.filter((u) => u.installed && u.updatable && u.updateAvailable);

function reportUpdates(results: ToolUpdateResult[]) {
  if (!results.length) return Alert.alert(translate("programs:updates.allUpToDate"));
  const failed = results.filter((r) => !r.ok);
  const done = results.filter((r) => r.ok && !r.upToDate).map((r) => `${r.name}${r.version ? ` ${r.version}` : ""}`);
  if (failed.length) {
    return Alert.alert(
      translate("programs:updates.failed", { name: failed.map((r) => r.name).join(", ") }),
      failed.map((r) => lastLines(r.output, 3)).filter(Boolean).join("\n\n") || undefined,
    );
  }
  Alert.alert(done.length ? translate("programs:updates.done", { names: done.join(", ") }) : translate("programs:updates.allUpToDate"));
}

/** Installed tools with their versions, and an update where Godmode installs one. */
function Updates() {
  const { t } = useTranslation(["programs", "common"]);
  const updates = useQuery({ queryKey: pk.updates, queryFn: () => programsApi.doctor.updates(), staleTime: 5 * 60_000 });
  const check = useMutation({
    mutationFn: () => programsApi.doctor.updates(true),
    onSuccess: (report) => queryClient.setQueryData(pk.updates, report),
    onError: (err) => Alert.alert(t("updates.checkFailed"), errorText(err)),
  });
  const update = useMutation({
    mutationFn: (id?: ToolId) => programsApi.doctor.update(id),
    onSuccess: reportUpdates,
    onError: (err) => Alert.alert(t("updates.installFailed"), errorText(err)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: pk.updates });
      void recheckDoctor();
    },
  });

  const report = updates.data;
  const installed = report?.tools.filter((u) => u.installed) ?? [];
  const pending = due(installed);
  const updating = (tool: ToolUpdateStatus) => update.isPending && (update.variables === tool.id || (update.variables === undefined && pending.includes(tool)));

  return (
    <Group
      title={t("updates.title")}
      action={check.isPending ? t("common:status.loading") : t("updates.checkNow")}
      onAction={() => !check.isPending && check.mutate()}
      footer={report ? t("updates.checked", { time: ago(report.checkedAt) }) : undefined}
    >
      {!report ? (
        <ToolRow title={updates.isError ? t("updates.loadFailed") : t("common:status.loading")} detail={updates.isError ? errorText(updates.error) : undefined} />
      ) : !installed.length ? (
        <ToolRow title={t("updates.none")} />
      ) : (
        installed.map((tool) => {
          const available = tool.updateAvailable && tool.updatable;
          const upToDate = tool.track === "pinned" ? !!tool.current && tool.current === tool.latest : tool.track === "release" && !!tool.latest && !tool.updateAvailable;
          return (
            <ToolRow
              key={tool.id}
              title={tool.name}
              detail={[available && tool.latest ? `${tool.current ?? "?"} → ${tool.latest}` : tool.current, tool.detail].filter(Boolean).join(" · ")}
              ok={upToDate ? true : undefined}
              action={
                available ? (
                  <ActionPill label={t("update")} busyLabel={t("updating")} busy={updating(tool)} disabled={update.isPending && !updating(tool)} onPress={() => update.mutate(tool.id)} />
                ) : undefined
              }
            />
          );
        })
      )}
      {pending.length > 1 ? (
        <ToolRow
          key="all"
          title={t("updates.updateAll", { count: pending.length })}
          action={<ActionPill label={t("update")} busyLabel={t("updating")} busy={update.isPending && update.variables === undefined} disabled={update.isPending} onPress={() => update.mutate(undefined)} />}
        />
      ) : null}
    </Group>
  );
}

const POWER_STATE = {
  off: "health.power.state.off",
  on: "health.power.state.on",
  idle: "health.power.state.idle",
  low_battery: "health.power.state.lowBattery",
  error: "health.power.state.error",
} as const satisfies Record<PowerStatus["state"], string>;

/**
 * Lid-closed mode: switched from the phone only once macOS allowed Godmode to on the computer. `settings`: a full-access
 * phone also changes when the Mac may sleep again.
 */
function PowerGroup({ status, settings }: { status: PowerStatus; settings?: PowerSettings }) {
  const { t } = useTranslation(["settings", "programs"]);
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
      {settings ? (
        <SwitchRow
          icon="bolt"
          title={t("programs:health.lidOnly")}
          value={settings.onlyWhileWorking}
          disabled={!status.enabled}
          onChange={(onlyWhileWorking) => void patchAnySettings({ power: { onlyWhileWorking } })}
        />
      ) : null}
      {settings ? (
        <PickerRow
          icon="gauge"
          title={t("programs:health.lowBattery")}
          value={String(settings.minBattery)}
          options={POWER_MIN_BATTERY_OPTIONS.map((v) => ({ value: String(v), label: v ? t("programs:health.percent", { percent: v }) : t("programs:health.never") }))}
          onChange={(v) => void patchAnySettings({ power: { minBattery: Number(v) } })}
        />
      ) : null}
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
