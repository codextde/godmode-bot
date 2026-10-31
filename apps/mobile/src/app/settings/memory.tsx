import { Stack } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { findModel } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, StepperRow, SwitchRow } from "@/components/form";
import { useModelCatalog } from "@/lib/composer";
import { intlLocale } from "@/lib/i18n";
import { patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

const SCHEDULES = [
  { value: "0 3 * * *", labelKey: "memory.schedule.night3" },
  { value: "0 1 * * *", labelKey: "memory.schedule.night1" },
  { value: "0 3,15 * * *", labelKey: "memory.schedule.twiceDaily" },
  { value: "0 3 * * 0", labelKey: "memory.schedule.sundays" },
] as const;

export default function Memory() {
  const { t } = useTranslation(["settings", "common"]);
  const settings = useSettings();
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
  const presets = SCHEDULES.map((o) => ({ value: o.value as string, label: t(o.labelKey) }));
  const schedules = SCHEDULES.some((o) => o.value === cron) ? presets : [{ value: cron, label: t("memory.schedule.custom", { cron }) }, ...presets];

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("overview.links.memory") }} />
      <CloseButton />
      {!s || !m || !d ? (
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      ) : (
        <>
          <Group title={t("overview.links.memory")} footer={t("memory.memory.footer")}>
            <SwitchRow icon="brain" title={t("memory.memory.inject")} detail={t("memory.memory.injectDetail")} value={m.injectMemory} onChange={(injectMemory) => void patchSettings({ memory: { injectMemory } })} />
            <SwitchRow icon="sparkles" title={t("memory.memory.reflect")} detail={t("memory.memory.reflectDetail")} value={m.reflectAfterRun} onChange={(reflectAfterRun) => void patchSettings({ memory: { reflectAfterRun } })} />
            <SwitchRow icon="branch" title={t("memory.memory.autoCommit")} value={m.autoCommit} onChange={(autoCommit) => void patchSettings({ memory: { autoCommit } })} />
          </Group>

          <Group title={t("memory.dreaming.title")} footer={t("memory.dreaming.footer")}>
            <SwitchRow icon="moon" title={t("memory.dreaming.title")} value={d.enabled} onChange={(enabled) => void patchSettings({ memory: { dreaming: { enabled } } })} />
            <PickerRow icon="clock" title={t("memory.dreaming.when")} value={cron} options={schedules} onChange={(next) => void patchSettings({ memory: { dreaming: { cron: next } } })} />
            <SwitchRow
              icon="folder"
              title={t("memory.dreaming.tidy")}
              detail={t("memory.dreaming.tidyDetail")}
              value={d.tidyWorkspace}
              onChange={(tidyWorkspace) => void patchSettings({ memory: { dreaming: { tidyWorkspace } } })}
            />
            {/* An older Godmode on the computer doesn't offer work yet. */}
            {d.offers === undefined ? null : (
              <SwitchRow
                icon="sparkles"
                title={t("memory.dreaming.offers")}
                detail={t("memory.dreaming.offersDetail")}
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

          <Group title={t("memory.upkeep.title")} footer={t("memory.upkeep.footer")}>
            <SwitchRow icon="wrench" title={t("memory.upkeep.autoFix")} value={s.maintenance.autoFix} onChange={(autoFix) => void patchSettings({ maintenance: { autoFix } })} />
            <SwitchRow icon="refresh" title={t("memory.upkeep.autoUpdate")} value={s.maintenance.autoUpdate} onChange={(autoUpdate) => void patchSettings({ maintenance: { autoUpdate } })} />
            <SwitchRow icon="trash" title={t("memory.upkeep.autoCleanup")} value={s.maintenance.autoCleanup} onChange={(autoCleanup) => void patchSettings({ maintenance: { autoCleanup } })} />
          </Group>

          <Group title={t("memory.desktop.title")}>
            <SwitchRow icon="bell" title={t("memory.desktop.notifications")} value={s.general.desktopNotifications} onChange={(desktopNotifications) => void patchSettings({ general: { desktopNotifications } })} />
          </Group>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  loading: {
    paddingTop: 80,
    alignItems: "center",
  },
});
