import { useMutation, useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { useCallback, useState, type ReactNode } from "react";
import { Alert, RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { DependencyStatus, FixReport, PermissionStatus } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, Tile } from "@/components/form";
import { ActionPill, SignInSteps, ToolRow, reportInstall } from "@/components/program-parts";
import { SettingsScroll } from "@/components/settings-scroll";
import { QueryState } from "@/components/settings-state";
import { CheckRow, ago } from "@/components/status-rows";
import { Card, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { t as translate } from "@/lib/i18n";
import { lastLines, programsApi, recheckDoctor, useClaudeLogin } from "@/lib/programs";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { space, useColors } from "@/lib/theme";

/**
 * Settings → System health: the tools and permissions Godmode relies on; updates and upkeep have their own screen. A
 * full-access phone also installs, repairs and signs Claude in, like the desktop app; the others only look.
 */
export default function Health() {
  const { t } = useTranslation(["settings", "programs"]);
  const admin = useFullAccess().fullAccess === true;
  const doctor = useQuery({ queryKey: sq.doctor, queryFn: () => settingsApi.doctor.get() });
  const permissions = useQuery({ queryKey: sq.permissions, queryFn: settingsApi.doctor.permissions });
  const [refreshing, setRefreshing] = useState(false);
  const signedIn = useCallback(() => void recheckDoctor(), []);
  const login = useClaudeLogin(admin, signedIn);

  const fixAll = useMutation({
    mutationFn: programsApi.doctor.fixAll,
    onSuccess: (report) => {
      reportFixes(report);
      void recheckDoctor();
      void permissions.refetch();
    },
    onError: (err) => Alert.alert(t("programs:health.fixAllFailed"), errorText(err)),
  });

  const refresh = async () => {
    setRefreshing(true);
    try {
      await recheckDoctor();
    } finally {
      await permissions.refetch();
      setRefreshing(false);
    }
  };

  const perms = permissions.data?.permissions ?? [];

  return (
    <SettingsScroll
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

              <Group>
                <LinkRow icon="refresh" title={t("health.upkeep.link")} onPress={() => router.push("/settings/upkeep")} />
              </Group>
            </>
          );
        }}
      </QueryState>
    </SettingsScroll>
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
      void recheckDoctor();
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
      if (p.id === "tool-binaries") void recheckDoctor();
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
