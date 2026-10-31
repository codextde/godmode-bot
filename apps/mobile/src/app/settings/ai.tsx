import { Stack } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { DEFAULT_AUTO_COMPACT_PERCENT, ULTRACODE_HINT, ULTRACODE_HINT_DE, effortForModel, findModel, type Effort } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, SegmentRow, StepperRow, SwitchRow } from "@/components/form";
import { useModelCatalog } from "@/lib/composer";
import { t, currentLanguage } from "@/lib/i18n";
import { EFFORT_SHORT, patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

const TIMEOUTS = [0, 5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440] as const;

function minutes(n: number): string {
  if (n === 0) return t("common:status.none");
  if (n < 60) return `${n} min`;
  const h = n / 60;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}

export default function ModelAndLimits() {
  const { t } = useTranslation(["settings", "common"]);
  const settings = useSettings();
  const catalog = useModelCatalog();
  const s = settings.data;

  if (!s) {
    return (
      <View style={styles.loading}>
        <Stack.Screen options={{ title: t("overview.links.ai") }} />
        <ActivityIndicator />
      </View>
    );
  }

  const r = s.runner;
  // Defaults and the fallback are Claude only: GLM is picked per agent or chat.
  const models = (catalog.data?.models ?? []).filter((m) => !m.provider);
  const current = findModel(models, r.model);
  const fallback = findModel(models, r.fallbackModel);
  const options = [...(current ? [] : [{ value: r.model, label: r.model }]), ...models.map((m) => ({ value: m.id, label: m.label, detail: m.description }))];
  const efforts = current?.efforts.length ? current.efforts : null;
  const effort = efforts ? (effortForModel(efforts, r.effort) ?? r.effort) : r.effort;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: t("overview.links.ai") }} />
      <CloseButton />

      <Group title={t("ai.defaultModel.title")} footer={t("ai.defaultModel.footer")}>
        <PickerRow icon="sparkles" title={t("ai.defaultModel.model")} value={current?.id ?? r.model} options={options} onChange={(model) => void patchSettings({ runner: { model } })} />
        {efforts ? (
          <SegmentRow
            title={t("ai.defaultModel.effort")}
            detail={t("ai.defaultModel.effortDetail")}
            value={effort}
            options={efforts.map((e) => ({ value: e, label: EFFORT_SHORT[e] }))}
            onChange={(next: Effort) => void patchSettings({ runner: { effort: next } })}
          />
        ) : null}
        {current?.ultracode ? <SwitchRow icon="workflow" title="Ultracode" detail={currentLanguage() === "de" ? ULTRACODE_HINT_DE : ULTRACODE_HINT} value={r.ultracode} onChange={(ultracode) => void patchSettings({ runner: { ultracode } })} /> : null}
        <PickerRow
          icon="refresh"
          title={t("ai.defaultModel.fallback")}
          detail={t("ai.defaultModel.fallbackDetail")}
          value={fallback?.id ?? (r.fallbackModel || "none")}
          options={[
            { value: "none", label: t("common:status.none") },
            ...(r.fallbackModel && !fallback ? [{ value: r.fallbackModel, label: r.fallbackModel }] : []),
            ...models.filter((m) => m.id !== current?.id).map((m) => ({ value: m.id, label: m.label })),
          ]}
          onChange={(v) => void patchSettings({ runner: { fallbackModel: v === "none" ? "" : v } })}
        />
      </Group>

      <Group title={t("ai.work.title")} footer={t("ai.work.footer")}>
        <StepperRow icon="cpu" title={t("ai.work.parallel")} value={r.maxConcurrentRuns} min={1} max={32} onChange={(maxConcurrentRuns) => void patchSettings({ runner: { maxConcurrentRuns } })} />
        <StepperRow
          icon="clock"
          title={t("ai.work.timeout")}
          value={r.runTimeoutMinutes}
          min={TIMEOUTS[0]}
          max={TIMEOUTS[TIMEOUTS.length - 1]}
          steps={TIMEOUTS}
          format={minutes}
          onChange={(runTimeoutMinutes) => void patchSettings({ runner: { runTimeoutMinutes } })}
        />
        <SwitchRow
          icon="play"
          title={t("ai.work.continueLimit")}
          detail={t("ai.work.continueLimitDetail")}
          value={r.autoContinueOnLimit}
          onChange={(autoContinueOnLimit) => void patchSettings({ runner: { autoContinueOnLimit } })}
        />
        <SwitchRow
          icon="refresh"
          title={t("ai.work.resume")}
          detail={t("ai.work.resumeDetail")}
          value={r.resumeAfterRestart ?? true}
          onChange={(resumeAfterRestart) => void patchSettings({ runner: { resumeAfterRestart } })}
        />
      </Group>

      <Group title={t("ai.compact.title")} footer={t("ai.compact.footer")}>
        <PickerRow
          icon="layers"
          title={t("ai.compact.auto")}
          value={r.autoCompactPercent === undefined ? String(DEFAULT_AUTO_COMPACT_PERCENT) : r.autoCompactPercent === null ? "claude" : String(r.autoCompactPercent)}
          options={[
            ...[40, 50, 60, 70, 80].map((p) => ({ value: String(p), label: p === DEFAULT_AUTO_COMPACT_PERCENT ? t("ai.compact.atDefault", { percent: p }) : t("ai.compact.at", { percent: p }) })),
            { value: "claude", label: t("ai.compact.nearlyFull") },
            { value: "0", label: t("ai.compact.never") },
          ]}
          onChange={(v) => void patchSettings({ runner: { autoCompactPercent: v === "claude" ? null : Number(v) } })}
        />
      </Group>

      <Group title={t("ai.watchdog.title")} footer={t("ai.watchdog.footer")}>
        <SwitchRow icon="shield" title={t("ai.watchdog.title")} value={r.watchdog} onChange={(watchdog) => void patchSettings({ runner: { watchdog } })} />
        <StepperRow
          icon="pulse"
          title={t("ai.watchdog.stalled")}
          value={r.stallMinutes}
          min={3}
          max={240}
          steps={[3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240]}
          format={minutes}
          onChange={(stallMinutes) => void patchSettings({ runner: { stallMinutes } })}
        />
        <StepperRow
          icon="refresh"
          title={t("ai.watchdog.repeated")}
          value={r.loopRepeats}
          min={3}
          max={50}
          format={(n) => `${n}×`}
          onChange={(loopRepeats) => void patchSettings({ runner: { loopRepeats } })}
        />
      </Group>
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
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
