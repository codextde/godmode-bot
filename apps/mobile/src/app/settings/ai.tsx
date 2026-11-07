import { router, Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { DEFAULT_AUTO_COMPACT_PERCENT, ULTRACODE_HINT, ULTRACODE_HINT_DE, effortForModel, findModel, type Effort } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, LinkRow, PickerRow, SegmentRow, StepperRow, SwitchRow } from "@/components/form";
import { SettingsScroll } from "@/components/settings-scroll";
import { useModelCatalog } from "@/lib/composer";
import { t, currentLanguage } from "@/lib/i18n";
import { EFFORT_SHORT, patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

/** "Custom model id…": any Claude CLI model id or alias, like the desktop's model picker. */
const CUSTOM = "__custom__";

const TIMEOUTS = [0, 5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440] as const;

function minutes(n: number): string {
  if (n === 0) return t("common:status.none");
  if (n < 60) return `${n} min`;
  const h = n / 60;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}

export default function ModelAndLimits() {
  const { t } = useTranslation(["settings", "common", "manage"]);
  const settings = useSettings();
  const catalog = useModelCatalog();
  const s = settings.data;
  const [customModel, setCustomModel] = useState(false);
  const [customFallback, setCustomFallback] = useState(false);

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
  const options = [
    ...(current ? [] : [{ value: r.model, label: r.model }]),
    ...models.map((m) => ({ value: m.id, label: m.label, detail: m.description })),
    { value: CUSTOM, label: t("manage:model.customItem") },
  ];
  // An id the catalog doesn't know is a custom one: its field shows, like on the desktop.
  const modelField = customModel || (!!catalog.data && !current);
  const fallbackField = customFallback || (!!catalog.data && !!r.fallbackModel && !fallback);
  const efforts = current?.efforts.length ? current.efforts : null;
  const effort = efforts ? (effortForModel(efforts, r.effort) ?? r.effort) : r.effort;

  return (
    <SettingsScroll
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: t("overview.links.ai") }} />
      <CloseButton />

      <Group title={t("ai.defaultModel.title")}>
        <PickerRow
          icon="sparkles"
          title={t("ai.defaultModel.model")}
          value={modelField ? CUSTOM : (current?.id ?? r.model)}
          options={options}
          onChange={(model) => {
            setCustomModel(model === CUSTOM);
            if (model !== CUSTOM) void patchSettings({ runner: { model } });
          }}
        />
        {modelField ? (
          <FieldRow label={t("manage:model.custom")} value={current ? "" : r.model} placeholder={t("manage:model.placeholder")} maxLength={200} onCommit={(model) => model.trim() && void patchSettings({ runner: { model: model.trim() } })} />
        ) : null}
        {efforts ? (
          <SegmentRow
            title={t("ai.defaultModel.effort")}
            value={effort}
            options={efforts.map((e) => ({ value: e, label: EFFORT_SHORT[e] }))}
            onChange={(next: Effort) => void patchSettings({ runner: { effort: next } })}
          />
        ) : null}
        {current?.ultracode ? <SwitchRow icon="workflow" title="Ultracode" detail={currentLanguage() === "de" ? ULTRACODE_HINT_DE : ULTRACODE_HINT} value={r.ultracode} onChange={(ultracode) => void patchSettings({ runner: { ultracode } })} /> : null}
        <PickerRow
          icon="refresh"
          title={t("ai.defaultModel.fallback")}
          value={fallbackField ? CUSTOM : (fallback?.id ?? (r.fallbackModel || "none"))}
          options={[
            { value: "none", label: t("common:status.none") },
            ...models.filter((m) => m.id !== current?.id).map((m) => ({ value: m.id, label: m.label })),
            { value: CUSTOM, label: t("manage:model.customItem") },
          ]}
          onChange={(v) => {
            setCustomFallback(v === CUSTOM);
            if (v !== CUSTOM) void patchSettings({ runner: { fallbackModel: v === "none" ? "" : v } });
          }}
        />
        {fallbackField ? (
          <FieldRow
            label={t("manage:model.custom")}
            value={fallback ? "" : r.fallbackModel}
            placeholder={t("manage:model.placeholder")}
            maxLength={200}
            onCommit={(fallbackModel) => fallbackModel.trim() && void patchSettings({ runner: { fallbackModel: fallbackModel.trim() } })}
          />
        ) : null}
      </Group>

      <Group>
        <LinkRow icon="personCircle" title={t("overview.links.accounts")} onPress={() => router.push("/settings/accounts")} />
        <LinkRow icon="text" title={t("overview.links.instructions")} onPress={() => router.push("/settings/instructions")} />
        <LinkRow icon="brain" title={t("overview.links.memory")} onPress={() => router.push("/settings/memory")} />
        <LinkRow icon="waveform" title={t("overview.links.voice")} onPress={() => router.push("/settings/voice")} />
        <LinkRow
          icon="review"
          title={t("overview.links.review")}
          value={s.review.enabled ? t("common:status.on") : t("common:status.off")}
          onPress={() => router.push("/settings/review")}
        />
      </Group>

      <Group title={t("ai.work.title")}>
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
          value={r.autoContinueOnLimit}
          onChange={(autoContinueOnLimit) => void patchSettings({ runner: { autoContinueOnLimit } })}
        />
        <SwitchRow
          icon="refresh"
          title={t("ai.work.resume")}
          value={r.resumeAfterRestart ?? true}
          onChange={(resumeAfterRestart) => void patchSettings({ runner: { resumeAfterRestart } })}
        />
      </Group>

      <Group title={t("ai.compact.title")}>
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

      <Group title={t("ai.watchdog.title")}>
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
    </SettingsScroll>
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
