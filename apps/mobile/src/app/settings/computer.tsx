import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CloseButton } from "@/components/close-button";
import { Group, PickerRow, StepperRow, SwitchRow, Tile } from "@/components/form";
import { FormSkeleton, isOutdated } from "@/components/settings-state";
import { ErrorState, LiveDot, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { t as translate } from "@/lib/i18n";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { patchSettings, useSettings } from "@/lib/setup";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

const IDLE = [0, 5, 10, 15, 30, 60, 120, 240, 480, 1440] as const;
const SCREENSHOT_SIZES = [640, 800, 1024, 1280, 1568] as const;

function minutes(n: number): string {
  if (n === 0) return translate("common:words.never");
  return n < 60 ? `${n} min` : `${n / 60} h`;
}

/** Computer use and virtual machines: what agents see and control, and the helper that does it. */
export default function ComputerSettings() {
  const { t } = useTranslation(["settings", "common"]);
  const settings = useSettings();
  const status = useQuery({ queryKey: sq.computerStatus, queryFn: settingsApi.computer.status });
  const pull = usePullRefresh(() => Promise.all([settings.refetch(), status.refetch()]));
  const stopHelper = useMutation({
    mutationFn: settingsApi.computer.stopHelper,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: sq.computerStatus }),
    onError: (err) => Alert.alert(t("computer.helper.stopFailed"), errorText(err)),
  });
  const s = settings.data;
  const cua = status.data?.cua;
  const size = s?.computer.screenshotMaxSize ?? 1280;
  const sizes = SCREENSHOT_SIZES.some((n) => n === size) ? SCREENSHOT_SIZES : [...SCREENSHOT_SIZES, size].sort((a, b) => a - b);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("computer.title") }} />
      <CloseButton />
      {!s ? (
        settings.isError ? (
          <ErrorState title={t("computer.loadFailed")} error={errorText(settings.error)} onRetry={() => void settings.refetch()} />
        ) : (
          <FormSkeleton groups={2} rows={4} />
        )
      ) : (
        <>
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
            <PickerRow
              icon="photo"
              title={t("computer.screenshot")}
              detail={t("computer.screenshotDetail")}
              value={String(size)}
              options={sizes.map((n) => ({ value: String(n), label: `${n} px` }))}
              onChange={(next) => void patchSettings({ computer: { screenshotMaxSize: Number(next) } })}
            />
          </Group>

          {cua && !isOutdated(status.error) ? (
            <Group title={t("computer.helper.title")} footer={cua.running ? t("computer.helper.footer") : undefined}>
              <View style={styles.row}>
                <Tile icon="cursor" />
                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                  <T variant="callout" style={{ fontWeight: "500" }}>
                    {t("computer.helper.name")}
                  </T>
                  <T variant="footnote" muted numberOfLines={2}>
                    {cua.running ? t("computer.helper.running") : cua.installed ? t("computer.helper.idle") : t("computer.helper.notInstalled")}
                  </T>
                </View>
                {cua.running ? (
                  stopHelper.isPending ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <>
                      <LiveDot size={7} />
                      <StopPill label={t("common:actions.stop")} onPress={() => stopHelper.mutate()} />
                    </>
                  )
                ) : null}
              </View>
            </Group>
          ) : null}

          <Group title={t("capabilities.vm.title")} footer={s.vm.enabled ? t("capabilities.vm.footer") : t("computer.vmOnComputer")}>
            <SwitchRow icon="vm" title={t("capabilities.vm.title")} disabled={!s.vm.enabled} value={s.vm.enabled} onChange={(enabled) => void patchSettings({ vm: { enabled } })} />
            {s.vm.enabled ? (
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
            ) : null}
            {s.vm.enabled ? (
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
            ) : null}
          </Group>
        </>
      )}
    </ScrollView>
  );
}

function StopPill({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.pill, { backgroundColor: c.dangerSoft, opacity: pressed ? 0.8 : 1 }]}
    >
      <T variant="footnote" color={c.danger} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
});
