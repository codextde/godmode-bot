import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useCallback, useState, type ReactNode } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { POWER_MIN_BATTERY_OPTIONS, type DependencyStatus, type FixReport, type PermissionStatus, type PowerSettings, type PowerStatus, type ToolId, type ToolUpdateResult, type ToolUpdateStatus } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, SwitchRow, Tile } from "@/components/form";
import { ActionPill, SignInSteps, ToolRow, reportInstall } from "@/components/program-parts";
import { QueryState } from "@/components/settings-state";
import { CheckRow, ago } from "@/components/status-rows";
import { Card, T } from "@/components/ui";
import { patchAnySettings } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { t as translate } from "@/lib/i18n";
import { lastLines, pk, programsApi, useClaudeLogin } from "@/lib/programs";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { patchSettings, useSettings } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";

/** Checks the computer again (the doctor caches its answer). */
async function recheck() {
  try {
    queryClient.setQueryData(sq.doctor, await settingsApi.doctor.get(true));
  } catch {
    void queryClient.invalidateQueries({ queryKey: sq.doctor });
  }
}

/**
 * Settings → System health: the tools and permissions Godmode relies on, its upkeep, and lid-closed mode. A full-access
 * phone also installs, repairs, signs Claude in and updates, like the desktop app; the others only look.
 */
export default function Health() {
  const { t } = useTranslation(["settings", "programs"]);
  const admin = useFullAccess().fullAccess === true;
  const doctor = useQuery({ queryKey: sq.doctor, queryFn: () => settingsApi.doctor.get() });
  const permissions = useQuery({ queryKey: sq.permissions, queryFn: settingsApi.doctor.permissions });
  const maintenance = useQuery({ queryKey: sq.maintenance, queryFn: settingsApi.doctor.maintenance });
  const power = useQuery({ queryKey: sq.power, queryFn: settingsApi.power.get });
  const settings = useSettings();
  const [refreshing, setRefreshing] = useState(false);
  const signedIn = useCallback(() => void recheck(), []);
  const login = useClaudeLogin(admin, signedIn);

  const fixAll = useMutation({
    mutationFn: programsApi.doctor.fixAll,
    onSuccess: (report) => {
      reportFixes(report);
      void recheck();
      void permissions.refetch();
    },
    onError: (err) => Alert.alert(t("programs:health.fixAllFailed"), errorText(err)),
  });

  const refresh = async () => {
    setRefreshing(true);
    try {
      await recheck();
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
  const perms = permissions.data?.permissions ?? [];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <Stack.Screen options={{ title: t("health.title") }} />
      <CloseButton />
      <QueryState query={doctor} icon="heart" errorTitle={t("health.loadFailed")}>
        {(report) => {
          const broken = report.dependencies.filter((d) => !d.ok && d.required).length + perms.filter((p) => !p.ok && p.required).length;
          const fixable = report.dependencies.filter((d) => !d.ok && d.required && d.installable).length + perms.filter((p) => !p.ok && p.fix === "auto").length;
          const waitsForComputer = perms.some((p) => !p.ok && p.fix !== "auto");
          return (
            <>
              <Summary
                problems={broken}
                checkedAt={report.checkedAt}
                admin={admin}
                action={admin && fixable > 0 ? <ActionPill label={t("programs:health.fixAll")} busyLabel={t("programs:fixing")} busy={fixAll.isPending} onPress={() => fixAll.mutate()} /> : null}
              />

              <Group title={t("health.tools")}>
                {report.dependencies.map((d) =>
                  admin ? (
                    <DependencyRow key={d.id} dep={d} login={login} />
                  ) : (
                    <CheckRow key={d.id} title={d.name} detail={d.detail} ok={d.ok || (d.required ? false : null)} />
                  ),
                )}
                {admin && login.waiting ? (
                  <SignInSteps
                    key="sign-in"
                    title={t("programs:signIn.title")}
                    url={login.status?.url ?? null}
                    submitting={login.submit.isPending}
                    cancelling={login.cancel.isPending}
                    onSubmit={login.send}
                    onCancel={() => login.cancel.mutate()}
                  />
                ) : null}
              </Group>

              {permissions.data ? (
                <Group
                  title={t("health.permissions")}
                  footer={permissions.data.ok ? undefined : admin ? (waitsForComputer ? t("programs:health.permissionsFooter") : undefined) : t("health.fixOnComputer")}
                >
                  {permissions.data.permissions.map((p) =>
                    admin ? <PermissionRow key={p.id} permission={p} /> : <CheckRow key={p.id} title={p.name} detail={p.detail} ok={p.ok || (p.required ? false : null)} />,
                  )}
                </Group>
              ) : null}

              {admin ? <Updates /> : null}

              {m ? (
                <Group title={t("health.upkeep.title")} footer={upkeepLine}>
                  <SwitchRow icon="wrench" title={t("health.upkeep.autoFix")} value={m.autoFix} onChange={(autoFix) => void patchSettings({ maintenance: { autoFix } })} />
                  <SwitchRow icon="refresh" title={t("health.upkeep.autoUpdate")} value={m.autoUpdate} onChange={(autoUpdate) => void patchSettings({ maintenance: { autoUpdate } })} />
                  <SwitchRow icon="broom" title={t("health.upkeep.autoCleanup")} value={m.autoCleanup} onChange={(autoCleanup) => void patchSettings({ maintenance: { autoCleanup } })} />
                </Group>
              ) : null}

              {power.data?.supported ? <PowerGroup status={power.data} settings={admin ? settings.data?.power : undefined} /> : null}
            </>
          );
        }}
      </QueryState>
    </ScrollView>
  );
}

function reportFixes(report: FixReport) {
  if (!report.results.length) return Alert.alert(translate("programs:health.nothingToFix"));
  const fixed = report.results.filter((r) => r.outcome === "fixed");
  const rest = report.results.filter((r) => r.outcome !== "fixed");
  if (!rest.length) return Alert.alert(translate("programs:health.fixed", { names: fixed.map((r) => r.name).join(", ") }));
  Alert.alert(
    translate("programs:health.fixAllFailed"),
    rest.map((r) => `${r.name}: ${lastLines(r.output, 2) || r.outcome}`).join("\n\n"),
  );
}

function Summary({ problems, checkedAt, admin, action }: { problems: number; checkedAt: string; admin: boolean; action: ReactNode }) {
  const c = useColors();
  const { t } = useTranslation(["settings", "programs"]);
  return (
    <Card style={styles.summary}>
      <Tile icon={problems ? "warning" : "heart"} size={40} tint={problems ? c.warning : c.success} />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="headline">{problems ? t("health.problems", { count: problems }) : t("health.allGood")}</T>
        <T variant="footnote" muted>
          {problems ? (admin ? t("programs:health.fixBelow") : t("health.fixOnComputer")) : t("health.checked", { time: ago(checkedAt) })}
        </T>
      </View>
      {action}
    </Card>
  );
}

/** A tool the computer needs: installed from here when Godmode can, Claude's sign-in started from here. */
function DependencyRow({ dep, login }: { dep: DependencyStatus; login: ReturnType<typeof useClaudeLogin> }) {
  const { t } = useTranslation("programs");
  const install = useMutation({
    mutationFn: () => programsApi.doctor.install(dep.id),
    onSettled: (result, err) => {
      reportInstall(err ?? result, { done: t("installed", { name: dep.name }), failed: t("installFailed", { name: dep.name }) });
      void recheck();
    },
  });
  const ok = dep.ok || (dep.required ? false : null);
  if (dep.ok) return <ToolRow title={dep.name} detail={dep.detail} ok={ok} />;
  if (dep.id === "claude-auth") {
    return (
      <ToolRow
        title={dep.name}
        detail={dep.detail}
        ok={ok}
        action={
          login.waiting ? undefined : (
            <ActionPill label={login.status?.signedOut ? t("signIn.again") : t("signIn.start")} busy={login.start.isPending} onPress={() => login.start.mutate()} />
          )
        }
      />
    );
  }
  return (
    <ToolRow
      title={dep.name}
      detail={dep.detail}
      ok={ok}
      action={dep.installable ? <ActionPill label={t("install")} busyLabel={t("installing")} busy={install.isPending} onPress={() => install.mutate()} /> : undefined}
    />
  );
}

/** Godmode's own files and folders are repaired from here; what macOS asks for waits for the computer. */
function PermissionRow({ permission: p }: { permission: PermissionStatus }) {
  const { t } = useTranslation("programs");
  const fix = useMutation({
    mutationFn: () => programsApi.doctor.fixPermission(p.id),
    onSuccess: (result) => {
      if (result.outcome === "failed") Alert.alert(t("health.fixFailed", { name: p.name }), lastLines(result.output) || undefined);
      else if (result.outcome !== "fixed") Alert.alert(t("health.needsYou", { name: p.name }), lastLines(result.output) || undefined);
      void queryClient.invalidateQueries({ queryKey: sq.permissions });
      if (p.id === "tool-binaries") void recheck();
    },
    onError: (err) => Alert.alert(t("health.fixFailed", { name: p.name }), errorText(err)),
  });
  const ok = p.ok || (p.required ? false : null);
  return (
    <ToolRow
      title={p.name}
      detail={!p.ok && p.fixHint ? p.fixHint : p.detail}
      ok={ok}
      action={!p.ok && p.fix === "auto" ? <ActionPill label={t("fix")} busyLabel={t("fixing")} busy={fix.isPending} onPress={() => fix.mutate()} /> : undefined}
    />
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
      void recheck();
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
  summary: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    padding: space.lg,
  },
});
