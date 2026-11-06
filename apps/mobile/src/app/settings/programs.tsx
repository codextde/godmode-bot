import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, PickerRow, SwitchRow, TextEditor } from "@/components/form";
import { ActionPill, ToolRow, reportInstall } from "@/components/program-parts";
import { FormSkeleton } from "@/components/settings-state";
import { patchAnySettings } from "@/lib/admin";
import { useAgents } from "@/lib/hooks";
import { pk, programsApi, type InstallResult } from "@/lib/programs";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { useSettings } from "@/lib/setup";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

const DEFAULT_AGENT = "default";

/**
 * Settings → Programs (full-access phones): where Claude Code lives and how it is started, the tools Godmode installs,
 * and where fixes from the log go. Like the desktop app's AI, System and Logs sections.
 */
export default function Programs() {
  const { t } = useTranslation("programs");
  const settings = useSettings();
  const pull = usePullRefresh(() =>
    Promise.all([
      settings.refetch(),
      queryClient.invalidateQueries({ queryKey: sq.computerStatus }),
      queryClient.invalidateQueries({ queryKey: pk.vmStatus }),
      queryClient.invalidateQueries({ queryKey: pk.androidStatus }),
    ]),
  );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Screen options={{ title: t("title") }} />
      <CloseButton />
      <FullAccessGate skeleton={<FormSkeleton groups={3} rows={3} />}>
        <AdminQueryState query={settings} errorTitle={t("loadFailed")} skeleton={<FormSkeleton groups={3} rows={3} />}>
          {(s) => <Sections settings={s} />}
        </AdminQueryState>
      </FullAccessGate>
    </ScrollView>
  );
}

function Sections({ settings: s }: { settings: Settings }) {
  const { t } = useTranslation(["programs", "common"]);
  const { data: agents } = useAgents();
  const r = s.runner;
  const repair = s.selfRepair;
  const fallback = agents?.find((a) => a.isDefault);
  const agentOptions = [
    { value: DEFAULT_AGENT, label: fallback?.name ?? t("repair.defaultAgent"), detail: fallback ? t("repair.defaultAgent") : undefined },
    ...(agents ?? []).filter((a) => !a.isDefault && (a.enabled || a.id === repair.agentId)).map((a) => ({ value: a.id, label: a.name, detail: a.role || undefined })),
  ];

  const setBypass = (on: boolean) => {
    if (!on) return void patchAnySettings({ runner: { bypassPermissions: false } });
    Alert.alert(t("advanced.bypassTitle"), t("advanced.bypassBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("advanced.bypassConfirm"), style: "destructive", onPress: () => void patchAnySettings({ runner: { bypassPermissions: true } }) },
    ]);
  };

  return (
    <>
      <Group title={t("cli.title")} footer={t("cli.footer")}>
        <FieldRow label={t("cli.path")} value={r.claudePath} placeholder={t("cli.auto")} maxLength={1000} onCommit={(claudePath) => void patchAnySettings({ runner: { claudePath } })} />
        <FieldRow
          label={t("cli.configDir")}
          value={r.claudeConfigDir}
          placeholder="~/.claude"
          maxLength={1000}
          onCommit={(claudeConfigDir) => void patchAnySettings({ runner: { claudeConfigDir } })}
        />
      </Group>

      <View style={{ gap: space.sm }}>
        <Group title={t("advanced.title")} footer={t("advanced.footer")}>
          <SwitchRow icon="warning" title={t("advanced.bypass")} detail={t("advanced.bypassDetail")} value={r.bypassPermissions} onChange={setBypass} />
        </Group>
        <TextEditor
          label={t("advanced.extraArgs")}
          hint={t("advanced.extraArgsHint")}
          value={r.extraArgs.join("\n")}
          placeholder={"--verbose\n--add-dir\n/Users/me/projects"}
          minHeight={88}
          onSave={(text) =>
            patchAnySettings(
              {
                runner: {
                  extraArgs: text
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean),
                },
              },
              { quiet: true },
            )
          }
        />
      </View>

      <Tools />

      <Group title={t("repair.title")} footer={t("repair.footer")}>
        <FieldRow
          stacked
          label={t("repair.repo")}
          value={repair.repoUrl}
          placeholder="https://github.com/codextde/godmode-bot"
          keyboardType="url"
          maxLength={500}
          onCommit={(repoUrl) => void patchAnySettings({ selfRepair: { repoUrl } })}
        />
        <FieldRow label={t("repair.branch")} value={repair.baseBranch} placeholder="main" maxLength={200} onCommit={(baseBranch) => baseBranch && void patchAnySettings({ selfRepair: { baseBranch } })} />
        <PickerRow
          title={t("repair.agent")}
          value={repair.agentId ?? DEFAULT_AGENT}
          options={agentOptions}
          onChange={(v) => void patchAnySettings({ selfRepair: { agentId: v === DEFAULT_AGENT ? null : v } })}
        />
        <SwitchRow title={t("repair.merge")} value={repair.autoMerge} onChange={(autoMerge) => void patchAnySettings({ selfRepair: { autoMerge } })} />
      </Group>

      <Group>
        <SwitchRow
          icon="list"
          title={t("diagnostics.verbose")}
          detail={t("diagnostics.verboseDetail")}
          value={s.diagnostics.verbose}
          onChange={(verbose) => void patchAnySettings({ diagnostics: { verbose } })}
        />
      </Group>
    </>
  );
}

/** The helpers Godmode downloads for computer use, virtual machines and Android phones. */
function Tools() {
  const { t } = useTranslation("programs");
  const computer = useQuery({ queryKey: sq.computerStatus, queryFn: settingsApi.computer.status });
  const vms = useQuery({ queryKey: pk.vmStatus, queryFn: programsApi.vmStatus });
  const android = useQuery({ queryKey: pk.androidStatus, queryFn: programsApi.androidStatus });
  const cua = computer.data?.cua;
  const tart = vms.data;
  const adb = android.data;

  return (
    <Group title={t("tools.title")}>
      {cua ? (
        <InstallRow name={t("tools.cua")} installed={cua.installed} detail={cua.installed ? cua.detail : t("notInstalled")} install={programsApi.installCua} refresh={sq.computerStatus} />
      ) : null}
      {tart ? (
        tart.supported ? (
          <InstallRow
            name={t("tools.tart")}
            installed={tart.tart.installed}
            detail={tart.tart.installed ? (tart.tart.version ?? tart.tart.path ?? undefined) : t("notInstalled")}
            install={programsApi.installVmTools}
            refresh={pk.vmStatus}
          />
        ) : (
          <ToolRow title={t("tools.tart")} detail={tart.reason ?? t("tools.notSupported")} ok={null} />
        )
      ) : null}
      {adb ? (
        <InstallRow
          name={t("tools.adb")}
          installed={adb.adb.installed}
          detail={adb.adb.installed ? (adb.adb.version ?? adb.adb.path ?? undefined) : adb.canInstall ? t("notInstalled") : t("tools.notSupported")}
          install={adb.canInstall ? programsApi.installAndroidTools : undefined}
          refresh={pk.androidStatus}
        />
      ) : null}
      {!cua && !tart && !adb ? <ToolRow title={t("tools.title")} detail={computer.isLoading || vms.isLoading || android.isLoading ? undefined : t("tools.notSupported")} /> : null}
    </Group>
  );
}

function InstallRow({
  name,
  installed,
  detail,
  install,
  refresh,
}: {
  name: string;
  installed: boolean;
  detail?: string;
  install?: () => Promise<InstallResult>;
  refresh: readonly string[];
}) {
  const { t } = useTranslation("programs");
  const run = useMutation({
    mutationFn: () => (install ? install() : Promise.resolve({ ok: false, output: "" })),
    onSettled: (result, err) => {
      reportInstall(err ?? result, { done: t("installed", { name }), failed: t("installFailed", { name }) });
      void queryClient.invalidateQueries({ queryKey: refresh });
    },
  });
  return (
    <ToolRow
      title={name}
      detail={detail}
      ok={installed ? true : install ? undefined : null}
      action={!installed && install ? <ActionPill label={t("install")} busyLabel={t("installing")} busy={run.isPending} onPress={() => run.mutate()} /> : undefined}
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
