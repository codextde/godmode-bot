import { Stack } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, StepperRow, SwitchRow } from "@/components/form";
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
  const schedules = SCHEDULES.some((o) => o.value === cron) ? SCHEDULES : [{ value: cron, label: `Custom (${cron})` }, ...SCHEDULES];

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Memory & upkeep" }} />
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

          <Group title="Dreaming" footer="While idle, agents review recent chats and tidy up their memory: merge duplicates, fix contradictions, date what has passed.">
            <SwitchRow icon="moon" title="Dreaming" value={d.enabled} onChange={(enabled) => void patchSettings({ memory: { dreaming: { enabled } } })} />
            <PickerRow icon="clock" title="When" value={cron} options={schedules} onChange={(next) => void patchSettings({ memory: { dreaming: { cron: next } } })} />
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
