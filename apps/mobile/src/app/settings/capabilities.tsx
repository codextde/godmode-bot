import { Stack } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, StepperRow, SwitchRow } from "@/components/form";
import { patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

const IDLE = [0, 5, 10, 15, 30, 60, 120, 240, 480, 1440] as const;

function minutes(n: number): string {
  if (n === 0) return "Never";
  return n < 60 ? `${n} min` : `${n / 60} h`;
}

export default function Capabilities() {
  const settings = useSettings();
  const s = settings.data;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Browser & computer" }} />
      <CloseButton />
      {!s ? (
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      ) : (
        <>
          <Group title="Browser" footer="Agents browse in their own profiles, with your saved logins filled in by Godmode.">
            <SwitchRow icon="globe" title="Browser for agents" value={s.browser.enabled} onChange={(enabled) => void patchSettings({ browser: { enabled } })} />
            <SwitchRow
              icon="eye"
              title="Run in the background"
              detail="No browser window opens on your computer."
              disabled={!s.browser.enabled}
              value={s.browser.headless}
              onChange={(headless) => void patchSettings({ browser: { headless } })}
            />
            <SwitchRow
              icon="shield"
              title="Look like a person"
              detail="Hides automation signals so sites don't block agents."
              disabled={!s.browser.enabled}
              value={s.browser.stealth}
              onChange={(stealth) => void patchSettings({ browser: { stealth } })}
            />
            <SwitchRow icon="bell" title="Mute sound" disabled={!s.browser.enabled} value={s.browser.muteAudio} onChange={(muteAudio) => void patchSettings({ browser: { muteAudio } })} />
            <SwitchRow icon="screens" title="Live view" detail="Watch the browser while an agent works." disabled={!s.browser.enabled} value={s.browser.liveView} onChange={(liveView) => void patchSettings({ browser: { liveView } })} />
            <StepperRow
              icon="clock"
              title="Close idle browser after"
              value={s.browser.keepAliveMinutes}
              min={0}
              max={1440}
              steps={IDLE}
              format={minutes}
              onChange={(keepAliveMinutes) => void patchSettings({ browser: { keepAliveMinutes } })}
            />
          </Group>

          <Group title="Computer use" footer="Agents only see and control a screen, window or tab you share with them in a chat.">
            <SwitchRow icon="display" title="Computer use" value={s.computer.enabled} onChange={(enabled) => void patchSettings({ computer: { enabled } })} />
            <SwitchRow
              icon="expand"
              title="Bring windows to the front"
              detail="Briefly, when a background action doesn't land."
              disabled={!s.computer.enabled}
              value={s.computer.allowForeground}
              onChange={(allowForeground) => void patchSettings({ computer: { allowForeground } })}
            />
            <SwitchRow icon="cursor" title="Show the agent's cursor" disabled={!s.computer.enabled} value={s.computer.agentCursor} onChange={(agentCursor) => void patchSettings({ computer: { agentCursor } })} />
            <SwitchRow icon="screens" title="Live view" disabled={!s.computer.enabled} value={s.computer.liveView} onChange={(liveView) => void patchSettings({ computer: { liveView } })} />
            <StepperRow
              icon="film"
              title="Live view speed"
              value={s.computer.liveViewFps}
              min={1}
              max={10}
              format={(n) => `${n} fps`}
              onChange={(liveViewFps) => void patchSettings({ computer: { liveViewFps } })}
            />
          </Group>

          <Group title="Virtual machines" footer="Agents with a VM work inside it instead of on this computer.">
            <SwitchRow icon="vm" title="Virtual machines" value={s.vm.enabled} onChange={(enabled) => void patchSettings({ vm: { enabled } })} />
            <PickerRow
              icon="power"
              title="When Godmode quits"
              value={s.vm.onQuit}
              options={[
                { value: "suspend", label: "Suspend", detail: "Resume where they left off." },
                { value: "stop", label: "Shut down" },
                { value: "keep", label: "Keep running" },
              ]}
              onChange={(onQuit) => void patchSettings({ vm: { onQuit } })}
            />
            <StepperRow
              icon="clock"
              title="Stop idle VMs after"
              value={s.vm.idleStopMinutes}
              min={0}
              max={1440}
              steps={IDLE}
              format={minutes}
              onChange={(idleStopMinutes) => void patchSettings({ vm: { idleStopMinutes } })}
            />
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
