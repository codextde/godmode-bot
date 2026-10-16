import { Stack } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { findModel } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, StepperRow, SwitchRow } from "@/components/form";
import { useModelCatalog } from "@/lib/composer";
import { patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

const SCHEDULES = [
  { value: "0 3 * * *", label: "Every night at 3:00" },
  { value: "0 1 * * *", label: "Every night at 1:00" },
  { value: "0 3,15 * * *", label: "Twice a day" },
  { value: "0 3 * * 0", label: "Sundays at 3:00" },
];

export default function Memory() {
  const settings = useSettings();
  const s = settings.data;
  const m = s?.memory;
  const d = m?.dreaming;
  const cron = d?.cron.trim().replace(/\s+/g, " ") ?? "";
  // Dreams stay on Claude.
  const models = (useModelCatalog().data?.models ?? []).filter((m) => !m.provider);
  const dreamModel = findModel(models, d?.model)?.id ?? d?.model ?? "";
  const modelOptions = [
    { value: "agent", label: "Same as the agent" },
    ...(dreamModel && !models.some((m) => m.id === dreamModel) ? [{ value: dreamModel, label: dreamModel }] : []),
    ...models.map((m) => ({ value: m.id, label: m.label, detail: m.description })),
  ];
  const schedules = SCHEDULES.some((o) => o.value === cron) ? SCHEDULES : [{ value: cron, label: `Custom (${cron})` }, ...SCHEDULES];

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Memory" }} />
      <CloseButton />
      {!s || !m || !d ? (
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      ) : (
        <>
          <Group title="Memory" footer="Each agent keeps what it learns in its own repository on your computer.">
            <SwitchRow icon="brain" title="Start every chat knowing it" detail="Loads the agent's memory into each new chat." value={m.injectMemory} onChange={(injectMemory) => void patchSettings({ memory: { injectMemory } })} />
            <SwitchRow icon="sparkles" title="Learn after each run" detail="Agents note what they learned when a run ends." value={m.reflectAfterRun} onChange={(reflectAfterRun) => void patchSettings({ memory: { reflectAfterRun } })} />
            <SwitchRow icon="branch" title="Save changes with git" value={m.autoCommit} onChange={(autoCommit) => void patchSettings({ memory: { autoCommit } })} />
          </Group>

          <Group title="Dreaming" footer="While idle, agents review recent chats and tidy up their memory and workspace: merge duplicates, fix contradictions, date what has passed, sort files — and keep the memory short enough to load into every chat.">
            <SwitchRow icon="moon" title="Dreaming" value={d.enabled} onChange={(enabled) => void patchSettings({ memory: { dreaming: { enabled } } })} />
            <PickerRow icon="clock" title="When" value={cron} options={schedules} onChange={(next) => void patchSettings({ memory: { dreaming: { cron: next } } })} />
            <SwitchRow
              icon="folder"
              title="Tidy the workspace"
              detail="Sorts files into folders and clears out leftovers."
              value={d.tidyWorkspace}
              onChange={(tidyWorkspace) => void patchSettings({ memory: { dreaming: { tidyWorkspace } } })}
            />
            <PickerRow icon="sparkles" title="Model" value={dreamModel || "agent"} options={modelOptions} onChange={(v) => void patchSettings({ memory: { dreaming: { model: v === "agent" ? "" : v } } })} />
            {/* An older Godmode on the computer has no size limit to set. */}
            {d.maxMemoryChars === undefined ? null : (
              <StepperRow
                icon="brain"
                title="Memory size"
                value={d.maxMemoryChars}
                min={2000}
                max={40000}
                steps={[2000, 4000, 6000, 8000, 10000, 12000, 16000, 24000, 40000]}
                format={(n) => `${n.toLocaleString()} chars`}
                onChange={(maxMemoryChars) => void patchSettings({ memory: { dreaming: { maxMemoryChars } } })}
              />
            )}
            <StepperRow
              icon="chats"
              title="New exchanges needed"
              value={d.minNewExchanges}
              min={0}
              max={1000}
              steps={[0, 1, 2, 3, 5, 10, 20, 50, 100]}
              onChange={(minNewExchanges) => void patchSettings({ memory: { dreaming: { minNewExchanges } } })}
            />
            <StepperRow
              icon="refresh"
              title="Refresh dated memory"
              value={d.refreshDays}
              min={0}
              max={365}
              steps={[0, 1, 3, 7, 14, 30, 60, 90]}
              format={(n) => (n === 0 ? "Never" : n === 1 ? "Daily" : `${n} days`)}
              onChange={(refreshDays) => void patchSettings({ memory: { dreaming: { refreshDays } } })}
            />
          </Group>

          <Group title="Upkeep" footer="Godmode looks after itself: repairs, updates of its tools, and cleaning up old files.">
            <SwitchRow icon="wrench" title="Fix problems by itself" value={s.maintenance.autoFix} onChange={(autoFix) => void patchSettings({ maintenance: { autoFix } })} />
            <SwitchRow icon="refresh" title="Update tools" value={s.maintenance.autoUpdate} onChange={(autoUpdate) => void patchSettings({ maintenance: { autoUpdate } })} />
            <SwitchRow icon="trash" title="Clean up old files" value={s.maintenance.autoCleanup} onChange={(autoCleanup) => void patchSettings({ maintenance: { autoCleanup } })} />
          </Group>

          <Group title="On your computer">
            <SwitchRow icon="bell" title="Desktop notifications" value={s.general.desktopNotifications} onChange={(desktopNotifications) => void patchSettings({ general: { desktopNotifications } })} />
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
