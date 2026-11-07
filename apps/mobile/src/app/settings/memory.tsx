import { useMutation, useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { Alert, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { findModel, type Settings } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { ChoiceRow, Group, LinkRow, PickerRow, StepperRow, SwitchRow } from "@/components/form";
import { ActionPill, ToolRow, reportInstall } from "@/components/program-parts";
import { SettingsScroll } from "@/components/settings-scroll";
import { FormSkeleton } from "@/components/settings-state";
import { ErrorState } from "@/components/ui";
import { patchAnySettings } from "@/lib/admin";
import { ApiError, errorText, updateDesktopMessage } from "@/lib/api";
import { useModelCatalog } from "@/lib/composer";
import { intlLocale } from "@/lib/i18n";
import { programsApi } from "@/lib/programs";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

const SCHEDULES = [
  { value: "0 3 * * *", labelKey: "memory.schedule.night3" },
  { value: "0 1 * * *", labelKey: "memory.schedule.night1" },
  { value: "0 3,15 * * *", labelKey: "memory.schedule.twiceDaily" },
  { value: "0 3 * * 0", labelKey: "memory.schedule.sundays" },
] as const;

const CUSTOM = "custom";

export default function Memory() {
  const { t } = useTranslation(["settings", "common", "manage"]);
  const settings = useSettings();
  const admin = useFullAccess().fullAccess === true;
  const s = settings.data;
  const m = s?.memory;
  const d = m?.dreaming;
  const cron = d?.cron.trim().replace(/\s+/g, " ") ?? "";
  // Dreams stay on Claude.
  const models = (useModelCatalog().data?.models ?? []).filter((m) => !m.provider);
  const dreamModel = findModel(models, d?.model)?.id ?? d?.model ?? "";
  const modelOptions = [
    { value: "agent", label: t("memory.sameAsAgent") },
    ...(dreamModel && !models.some((m) => m.id === dreamModel) ? [{ value: dreamModel, label: dreamModel }] : []),
    ...models.map((m) => ({ value: m.id, label: m.label, detail: m.description })),
  ];
  const dreamAll = useMutation({
    mutationFn: settingsApi.memory.dreamAll,
    onSuccess: (r) =>
      Alert.alert(
        r.started.length ? t("memory.dreamAll.started", { count: r.started.length }) : t("memory.dreamAll.none"),
        r.started.length ? r.started.map((a) => a.name).join(", ") : t("memory.dreamAll.noneBody"),
      ),
    onError: (err) => Alert.alert(t("memory.dreamAll.failed"), err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err)),
  });
  const presets = SCHEDULES.map((o) => ({ value: o.value as string, label: t(o.labelKey) }));
  const schedules = [
    ...(SCHEDULES.some((o) => o.value === cron) ? presets : [{ value: cron, label: t("memory.schedule.custom", { cron }) }, ...presets]),
    { value: CUSTOM, label: t("manage:dreaming.customItem") },
  ];

  return (
    <SettingsScroll contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("overview.links.memory") }} />
      <CloseButton />
      {!s || !m || !d ? (
        settings.isError ? (
          <ErrorState title={t("computer.loadFailed")} error={errorText(settings.error)} onRetry={() => void settings.refetch()} />
        ) : (
          <FormSkeleton groups={3} rows={3} />
        )
      ) : (
        <>
          {admin ? <Backend backend={m.backend} /> : null}
          <Group title={t("overview.links.memory")}>
            <SwitchRow icon="brain" title={t("memory.memory.inject")} value={m.injectMemory} onChange={(injectMemory) => void patchSettings({ memory: { injectMemory } })} />
            <SwitchRow icon="sparkles" title={t("memory.memory.reflect")} value={m.reflectAfterRun} onChange={(reflectAfterRun) => void patchSettings({ memory: { reflectAfterRun } })} />
            <SwitchRow icon="branch" title={t("memory.memory.autoCommit")} value={m.autoCommit} onChange={(autoCommit) => void patchSettings({ memory: { autoCommit } })} />
          </Group>

          <Group title={t("memory.dreaming.title")}>
            <SwitchRow icon="moon" title={t("memory.dreaming.title")} value={d.enabled} onChange={(enabled) => void patchSettings({ memory: { dreaming: { enabled } } })} />
            <PickerRow
              icon="clock"
              title={t("memory.dreaming.when")}
              value={cron}
              options={schedules}
              onChange={(next) => (next === CUSTOM ? router.push("/dream-schedule") : void patchSettings({ memory: { dreaming: { cron: next } } }))}
            />
            <SwitchRow
              icon="folder"
              title={t("memory.dreaming.tidy")}
              value={d.tidyWorkspace}
              onChange={(tidyWorkspace) => void patchSettings({ memory: { dreaming: { tidyWorkspace } } })}
            />
            {/* An older Godmode on the computer doesn't offer work yet. */}
            {d.offers === undefined ? null : (
              <SwitchRow
                icon="sparkles"
                title={t("memory.dreaming.offers")}
                value={d.offers}
                onChange={(offers) => void patchSettings({ memory: { dreaming: { offers } } })}
              />
            )}
            <PickerRow icon="sparkles" title={t("ai.defaultModel.model")} value={dreamModel || "agent"} options={modelOptions} onChange={(v) => void patchSettings({ memory: { dreaming: { model: v === "agent" ? "" : v } } })} />
            {/* An older Godmode on the computer has no size limit to set. */}
            {d.maxMemoryChars === undefined ? null : (
              <StepperRow
                icon="brain"
                title={t("memory.dreaming.size")}
                value={d.maxMemoryChars}
                min={2000}
                max={40000}
                steps={[2000, 4000, 6000, 8000, 10000, 12000, 16000, 24000, 40000]}
                format={(n) => t("memory.dreaming.chars", { count: n, formatted: n.toLocaleString(intlLocale()) })}
                onChange={(maxMemoryChars) => void patchSettings({ memory: { dreaming: { maxMemoryChars } } })}
              />
            )}
            <StepperRow
              icon="chats"
              title={t("memory.dreaming.minExchanges")}
              value={d.minNewExchanges}
              min={0}
              max={1000}
              steps={[0, 1, 2, 3, 5, 10, 20, 50, 100]}
              onChange={(minNewExchanges) => void patchSettings({ memory: { dreaming: { minNewExchanges } } })}
            />
            <StepperRow
              icon="refresh"
              title={t("memory.dreaming.refresh")}
              value={d.refreshDays}
              min={0}
              max={365}
              steps={[0, 1, 3, 7, 14, 30, 60, 90]}
              format={(n) => (n === 0 ? t("common:words.never") : n === 1 ? t("memory.dreaming.daily") : t("memory.dreaming.days", { count: n }))}
              onChange={(refreshDays) => void patchSettings({ memory: { dreaming: { refreshDays } } })}
            />
          </Group>

          <Group>
            <LinkRow icon="moon" title={t("memory.dreamAll.title")} value={dreamAll.isPending ? t("memory.dreamAll.starting") : undefined} chevron={false} onPress={() => !dreamAll.isPending && dreamAll.mutate()} />
            <LinkRow icon="inbox" title={t("memory.import.link")} onPress={() => router.push("/memory-import")} />
          </Group>

          <Group title={t("memory.desktop.title")}>
            <SwitchRow icon="bell" title={t("memory.desktop.notifications")} value={s.general.desktopNotifications} onChange={(desktopNotifications) => void patchSettings({ general: { desktopNotifications } })} />
          </Group>
        </>
      )}
    </SettingsScroll>
  );
}

/** Where agents keep their memory (full-access phones, like the desktop app); claude-mem is installed from here too. */
function Backend({ backend }: { backend: Settings["memory"]["backend"] }) {
  const { t } = useTranslation("programs");
  const doctor = useQuery({ queryKey: sq.doctor, queryFn: () => settingsApi.doctor.get(), enabled: backend === "claude-mem" });
  const dep = doctor.data?.dependencies.find((d) => d.id === "claude-mem");
  const install = useMutation({
    mutationFn: () => programsApi.doctor.install("claude-mem"),
    onSettled: async (result, err) => {
      reportInstall(err ?? result, { done: t("installed", { name: "claude-mem" }), failed: t("installFailed", { name: "claude-mem" }) });
      queryClient.setQueryData(sq.doctor, await settingsApi.doctor.get(true).catch(() => doctor.data));
    },
  });
  const missing = backend === "claude-mem" && dep && !dep.ok;
  return (
    <Group title={t("memory.title")} footer={missing ? t("memory.claudeMemMissing") : undefined}>
      <ChoiceRow icon="doc" title={t("memory.files")} selected={backend === "files"} onPress={() => void patchAnySettings({ memory: { backend: "files" } })} />
      <ChoiceRow icon="brain" title={t("memory.claudeMem")} detail={t("memory.claudeMemDetail")} selected={backend === "claude-mem"} onPress={() => void patchAnySettings({ memory: { backend: "claude-mem" } })} />
      {missing ? (
        <ToolRow
          title={dep.name}
          detail={dep.detail}
          ok={false}
          action={dep.installable ? <ActionPill label={t("install")} busyLabel={t("installing")} busy={install.isPending} onPress={() => install.mutate()} /> : undefined}
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
