import { Stack } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { DEFAULT_AUTO_COMPACT_PERCENT, ULTRACODE_HINT, effortForModel, findModel, type Effort } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, SegmentRow, StepperRow, SwitchRow } from "@/components/form";
import { useModelCatalog } from "@/lib/composer";
import { EFFORT_SHORT, patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

const TIMEOUTS = [0, 5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440] as const;

function minutes(n: number): string {
  if (n === 0) return "None";
  if (n < 60) return `${n} min`;
  const h = n / 60;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}

export default function ModelAndLimits() {
  const settings = useSettings();
  const catalog = useModelCatalog();
  const s = settings.data;

  if (!s) {
    return (
      <View style={styles.loading}>
        <Stack.Screen options={{ title: "AI & Claude" }} />
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
      <Stack.Screen options={{ title: "AI & Claude" }} />
      <CloseButton />

      <Group title="Default model" footer="Agents without a model of their own use this one. Change it per agent, or per chat from the composer.">
        <PickerRow icon="sparkles" title="Model" value={current?.id ?? r.model} options={options} onChange={(model) => void patchSettings({ runner: { model } })} />
        {efforts ? (
          <SegmentRow
            title="Effort"
            detail="How long Claude thinks before it acts."
            value={effort}
            options={efforts.map((e) => ({ value: e, label: EFFORT_SHORT[e] }))}
            onChange={(next: Effort) => void patchSettings({ runner: { effort: next } })}
          />
        ) : null}
        {current?.ultracode ? <SwitchRow icon="workflow" title="Ultracode" detail={ULTRACODE_HINT} value={r.ultracode} onChange={(ultracode) => void patchSettings({ runner: { ultracode } })} /> : null}
        <PickerRow
          icon="refresh"
          title="Fallback"
          detail="Used when the default model is overloaded."
          value={fallback?.id ?? (r.fallbackModel || "none")}
          options={[
            { value: "none", label: "None" },
            ...(r.fallbackModel && !fallback ? [{ value: r.fallbackModel, label: r.fallbackModel }] : []),
            ...models.filter((m) => m.id !== current?.id).map((m) => ({ value: m.id, label: m.label })),
          ]}
          onChange={(v) => void patchSettings({ runner: { fallbackModel: v === "none" ? "" : v } })}
        />
      </Group>

      <Group title="Work" footer="Runs over the limit wait in line. A run that takes longer than the timeout is stopped.">
        <StepperRow icon="cpu" title="Parallel runs" value={r.maxConcurrentRuns} min={1} max={32} onChange={(maxConcurrentRuns) => void patchSettings({ runner: { maxConcurrentRuns } })} />
        <StepperRow
          icon="clock"
          title="Timeout per run"
          value={r.runTimeoutMinutes}
          min={TIMEOUTS[0]}
          max={TIMEOUTS[TIMEOUTS.length - 1]}
          steps={TIMEOUTS}
          format={minutes}
          onChange={(runTimeoutMinutes) => void patchSettings({ runner: { runTimeoutMinutes } })}
        />
        <SwitchRow
          icon="play"
          title="Continue after usage limits"
          detail="A run that hit Claude's limit picks up by itself once it resets."
          value={r.autoContinueOnLimit}
          onChange={(autoContinueOnLimit) => void patchSettings({ runner: { autoContinueOnLimit } })}
        />
        <SwitchRow
          icon="refresh"
          title="Continue cut-off work"
          detail="Work cut off by a restart, a lost internet connection or the end of a turn picks up by itself once Godmode and the connection are back."
          value={r.resumeAfterRestart ?? true}
          onChange={(resumeAfterRestart) => void patchSettings({ runner: { resumeAfterRestart } })}
        />
      </Group>

      <Group title="Long chats" footer="A chat that fills this much of the model's memory is summarized by itself and goes on from the summary. Earlier keeps every step faster and cheaper, later keeps more detail. Compress any chat by hand with the ring next to the model.">
        <PickerRow
          icon="layers"
          title="Compress by itself"
          value={r.autoCompactPercent === undefined ? String(DEFAULT_AUTO_COMPACT_PERCENT) : r.autoCompactPercent === null ? "claude" : String(r.autoCompactPercent)}
          options={[
            ...[40, 50, 60, 70, 80].map((p) => ({ value: String(p), label: `At ${p}%${p === DEFAULT_AUTO_COMPACT_PERCENT ? " (default)" : ""}` })),
            { value: "claude", label: "When nearly full" },
            { value: "0", label: "Never by itself" },
          ]}
          onChange={(v) => void patchSettings({ runner: { autoCompactPercent: v === "claude" ? null : Number(v) } })}
        />
      </Group>

      <Group title="Watchdog" footer="Stops runs that stall or go in circles, so they don't burn time and tokens.">
        <SwitchRow icon="shield" title="Watchdog" value={r.watchdog} onChange={(watchdog) => void patchSettings({ runner: { watchdog } })} />
        <StepperRow
          icon="pulse"
          title="Stalled after"
          value={r.stallMinutes}
          min={3}
          max={240}
          steps={[3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240]}
          format={minutes}
          onChange={(stallMinutes) => void patchSettings({ runner: { stallMinutes } })}
        />
        <StepperRow
          icon="refresh"
          title="Same step repeated"
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
