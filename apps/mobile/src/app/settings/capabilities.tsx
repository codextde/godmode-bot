import { Stack } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, StepperRow, SwitchRow } from "@/components/form";
import { t } from "@/lib/i18n";
import { patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

const IDLE = [0, 5, 10, 15, 30, 60, 120, 240, 480, 1440] as const;

function minutes(n: number): string {
  if (n === 0) return t("common:words.never");
  return n < 60 ? `${n} min` : `${n / 60} h`;
}

export default function Capabilities() {
  const { t } = useTranslation("settings");
  const settings = useSettings();
  const s = settings.data;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("capabilities.title") }} />
      <CloseButton />
      {!s ? (
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      ) : (
        <>
          <Group title={t("capabilities.browser.title")} footer={t("capabilities.browser.footer")}>
            <SwitchRow icon="globe" title={t("capabilities.browser.enabled")} value={s.browser.enabled} onChange={(enabled) => void patchSettings({ browser: { enabled } })} />
            <SwitchRow
              icon="eye"
              title={t("capabilities.browser.headless")}
              detail={t("capabilities.browser.headlessDetail")}
              disabled={!s.browser.enabled}
              value={s.browser.headless}
              onChange={(headless) => void patchSettings({ browser: { headless } })}
            />
            <SwitchRow
              icon="shield"
              title={t("capabilities.browser.stealth")}
              detail={t("capabilities.browser.stealthDetail")}
              disabled={!s.browser.enabled}
              value={s.browser.stealth}
              onChange={(stealth) => void patchSettings({ browser: { stealth } })}
            />
            <SwitchRow icon="bell" title={t("capabilities.browser.mute")} disabled={!s.browser.enabled} value={s.browser.muteAudio} onChange={(muteAudio) => void patchSettings({ browser: { muteAudio } })} />
            <SwitchRow icon="screens" title={t("capabilities.liveView")} detail={t("capabilities.browser.liveViewDetail")} disabled={!s.browser.enabled} value={s.browser.liveView} onChange={(liveView) => void patchSettings({ browser: { liveView } })} />
            <StepperRow
              icon="clock"
              title={t("capabilities.browser.keepAlive")}
              value={s.browser.keepAliveMinutes}
              min={0}
              max={1440}
              steps={IDLE}
              format={minutes}
              onChange={(keepAliveMinutes) => void patchSettings({ browser: { keepAliveMinutes } })}
            />
          </Group>

          <Group title={t("capabilities.computer.title")} footer={t("capabilities.computer.footer")}>
            <SwitchRow icon="display" title={t("capabilities.computer.title")} value={s.computer.enabled} onChange={(enabled) => void patchSettings({ computer: { enabled } })} />
            <SwitchRow
              icon="expand"
              title={t("capabilities.computer.foreground")}
              detail={t("capabilities.computer.foregroundDetail")}
              disabled={!s.computer.enabled}
              value={s.computer.allowForeground}
              onChange={(allowForeground) => void patchSettings({ computer: { allowForeground } })}
            />
            <SwitchRow icon="cursor" title={t("capabilities.computer.cursor")} disabled={!s.computer.enabled} value={s.computer.agentCursor} onChange={(agentCursor) => void patchSettings({ computer: { agentCursor } })} />
            <SwitchRow icon="screens" title={t("capabilities.liveView")} disabled={!s.computer.enabled} value={s.computer.liveView} onChange={(liveView) => void patchSettings({ computer: { liveView } })} />
            <StepperRow
              icon="film"
              title={t("capabilities.computer.liveViewSpeed")}
              value={s.computer.liveViewFps}
              min={1}
              max={10}
              format={(n) => `${n} fps`}
              onChange={(liveViewFps) => void patchSettings({ computer: { liveViewFps } })}
            />
          </Group>

          <Group title={t("capabilities.vm.title")} footer={t("capabilities.vm.footer")}>
            <SwitchRow icon="vm" title={t("capabilities.vm.title")} value={s.vm.enabled} onChange={(enabled) => void patchSettings({ vm: { enabled } })} />
            <PickerRow
              icon="power"
              title={t("capabilities.vm.onQuit")}
              value={s.vm.onQuit}
              options={[
                { value: "suspend", label: t("capabilities.vm.suspend"), detail: t("capabilities.vm.suspendDetail") },
                { value: "stop", label: t("capabilities.vm.stop") },
                { value: "keep", label: t("capabilities.vm.keep") },
              ]}
              onChange={(onQuit) => void patchSettings({ vm: { onQuit } })}
            />
            <StepperRow
              icon="clock"
              title={t("capabilities.vm.idleStop")}
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
