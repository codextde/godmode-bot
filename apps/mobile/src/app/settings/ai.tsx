import { Stack } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { ULTRACODE_HINT, effortForModel, findModel, type Effort } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, PickerRow, SegmentRow, StepperRow, SwitchRow } from "@/components/form";
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

/** "50", "1,000", "1.000,50" or "12,5" in dollars; empty = no limit; anything else is ignored. */
function money(input: string): number | null | undefined {
  const raw = input.replace(/[\s$]/g, "");
  if (!raw) return null;
  if (!/^[0-9.,]+$/.test(raw)) return undefined;
  const last = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
  const decimals = last >= 0 && raw.length - last - 1 <= 2 ? raw.length - last - 1 : 0;
  const digits = raw.replace(/[.,]/g, "");
  const n = Number(digits) / 10 ** decimals;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
}

export default function ModelAndLimits() {
  const settings = useSettings();
  const catalog = useModelCatalog();
  const s = settings.data;

  if (!s) {
    return (
      <View style={styles.loading}>
        <Stack.Screen options={{ title: "Model & limits" }} />
        <ActivityIndicator />
      </View>
    );
  }

  const r = s.runner;
  const models = catalog.data?.models ?? [];
  const current = findModel(models, r.model);
  const fallback = findModel(models, r.fallbackModel);
  const options = [...(current ? [] : [{ value: r.model, label: r.model }]), ...models.map((m) => ({ value: m.id, label: m.label, detail: m.description }))];
  const efforts = current?.efforts.length ? current.efforts : null;
  const effort = efforts ? (effortForModel(efforts, r.effort) ?? r.effort) : r.effort;
  const budget = (key: "defaultMaxBudgetUsd" | "monthlyBudgetUsd") => (text: string) => {
    const value = money(text);
    if (value !== undefined) void patchSettings({ runner: { [key]: value } });
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: "Model & limits" }} />
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
          title="Continue after a restart"
          detail="Work Godmode was doing when it quit or restarted picks up by itself once it is back."
          value={r.resumeAfterRestart ?? true}
          onChange={(resumeAfterRestart) => void patchSettings({ runner: { resumeAfterRestart } })}
        />
      </Group>

      <Group title="Budgets" footer="Used up, unattended work waits until next month. Leave empty for no limit.">
        <FieldRow label="Per run" prefix="$" keyboardType="decimal-pad" placeholder="No limit" value={r.defaultMaxBudgetUsd ? String(r.defaultMaxBudgetUsd) : ""} onCommit={budget("defaultMaxBudgetUsd")} />
        <FieldRow label="Team per month" prefix="$" keyboardType="decimal-pad" placeholder="No limit" value={r.monthlyBudgetUsd ? String(r.monthlyBudgetUsd) : ""} onCommit={budget("monthlyBudgetUsd")} />
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
