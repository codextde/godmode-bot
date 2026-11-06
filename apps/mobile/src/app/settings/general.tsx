import { Stack } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { PALETTES, type AppLanguage, type InterfaceMode, type Palette, type Theme, type TimeFormat } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, PickerRow, SegmentRow, SwitchRow } from "@/components/form";
import { QueryState } from "@/components/settings-state";
import { useAppearance } from "@/lib/appearance";
import { useChatPrefs, type Animations, type ToolCallView } from "@/lib/chat-prefs";
import { deviceHour12, useLanguage, useTimeFormat } from "@/lib/i18n";
import { patchSettings, useSettings } from "@/lib/setup";
import { useSuggestions } from "@/lib/suggestions";
import { space } from "@/lib/theme";

const THEME_OPTIONS = [
  { value: "light", labelKey: "overview.theme.light" },
  { value: "dark", labelKey: "overview.theme.dark" },
  { value: "system", labelKey: "common:language.system" },
] as const satisfies readonly { value: Theme; labelKey: string }[];

const LANGUAGE_OPTIONS = [
  { value: "system", labelKey: "common:language.system" },
  { value: "en", labelKey: "common:language.en" },
  { value: "de", labelKey: "common:language.de" },
] as const satisfies readonly { value: AppLanguage; labelKey: string }[];

const TIME_FORMAT_OPTIONS = [
  { value: "system", labelKey: "overview.timeFormat.system" },
  { value: "24h", labelKey: "overview.timeFormat.h24" },
  { value: "12h", labelKey: "overview.timeFormat.h12" },
] as const satisfies readonly { value: TimeFormat; labelKey: string }[];

const MODE_OPTIONS = [
  { value: "easy", labelKey: "overview.mode.easy" },
  { value: "pro", labelKey: "overview.mode.pro" },
] as const satisfies readonly { value: InterfaceMode; labelKey: string }[];

const MODE_BLURB = {
  easy: "overview.mode.easyBlurb",
  pro: "overview.mode.proBlurb",
} as const satisfies Record<InterfaceMode, string>;

/** Settings → General: who you are, how the apps look and read, and how chats look on this phone. */
export default function General() {
  const { t } = useTranslation(["settings", "common"]);
  const settings = useSettings();
  const theme = useAppearance((s) => s.theme);
  const palette = useAppearance((s) => s.palette);
  const language = useLanguage((s) => s.language);
  const timeFormat = useTimeFormat((s) => s.timeFormat);
  const hideSuggestions = useSuggestions((s) => s.hidden);
  const toolCalls = useChatPrefs((s) => s.toolCalls);
  const animations = useChatPrefs((s) => s.animations);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("general.title") }} />
      <CloseButton />
      <QueryState query={settings} icon="slider" errorTitle={t("general.loadFailed")}>
        {(s) => {
          const mode = s.general.mode === "easy" ? "easy" : "pro";
          return (
            <>
              <Group footer={t("overview.preferences.footer")}>
                <FieldRow label={t("overview.preferences.yourName")} value={s.general.userName} placeholder={t("overview.preferences.addName")} maxLength={80} onCommit={(userName) => void patchSettings({ general: { userName } })} />
                <SegmentRow
                  title={t("overview.mode.title")}
                  detail={t("overview.mode.detail", { blurb: t(MODE_BLURB[mode]) })}
                  options={MODE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                  value={mode}
                  onChange={(next) => void patchSettings({ general: { mode: next } })}
                />
              </Group>

              <Group title={t("general.appearance")}>
                <SegmentRow
                  title={t("general.colors")}
                  detail={t("overview.theme.detail")}
                  options={THEME_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                  value={theme}
                  onChange={(next) => {
                    useAppearance.getState().setTheme(next);
                    void patchSettings({ general: { theme: next } });
                  }}
                />
                <PickerRow
                  title={t("overview.palette.title")}
                  detail={t("overview.palette.detail")}
                  options={PALETTES.map((value) => ({ value, label: t(`overview.palette.names.${value}.label`), detail: t(`overview.palette.names.${value}.blurb`) }))}
                  value={palette}
                  onChange={(next: Palette) => useAppearance.getState().setPalette(next)}
                />
                <SegmentRow<Animations>
                  title={t("general.animations.title")}
                  detail={t(`general.animations.${animations}`)}
                  options={[
                    { value: "full", label: t("general.animations.fullLabel") },
                    { value: "light", label: t("general.animations.lightLabel") },
                  ]}
                  value={animations}
                  onChange={(next) => useChatPrefs.getState().setAnimations(next)}
                />
              </Group>

              <Group title={t("general.language")}>
                <SegmentRow
                  title={t("overview.language.title")}
                  detail={t("overview.language.detail")}
                  options={LANGUAGE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                  value={language}
                  onChange={(next) => {
                    useLanguage.getState().setLanguage(next);
                    void patchSettings({ general: { language: next } });
                  }}
                />
                <SegmentRow
                  title={t("overview.timeFormat.title")}
                  detail={t("overview.timeFormat.detail", { example: t(deviceHour12() ? "overview.timeFormat.h12" : "overview.timeFormat.h24") })}
                  options={TIME_FORMAT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                  value={timeFormat}
                  onChange={(next) => {
                    useTimeFormat.getState().setTimeFormat(next);
                    void patchSettings({ general: { timeFormat: next } });
                  }}
                />
              </Group>

              <Group title={t("general.chat.title")} footer={t("general.chat.footer")}>
                <SegmentRow<ToolCallView>
                  title={t("general.chat.toolCalls")}
                  detail={t(`general.chat.${toolCalls}`)}
                  options={[
                    { value: "cards", label: t("general.chat.cardsLabel") },
                    { value: "compact", label: t("general.chat.compactLabel") },
                  ]}
                  value={toolCalls}
                  onChange={(next) => useChatPrefs.getState().setToolCalls(next)}
                />
                <SwitchRow
                  icon="sparkles"
                  title={t("overview.suggestions.title")}
                  detail={t("overview.suggestions.detail")}
                  value={!hideSuggestions}
                  onChange={(on) => useSuggestions.getState().setHidden(!on)}
                />
              </Group>

              {/* An older Godmode on the computer has no AI summaries yet. */}
              {s.general.aiChatTitles === undefined ? null : (
                <Group title={t("general.summaries.title")} footer={t("general.summaries.footer")}>
                  <SwitchRow
                    icon="chats"
                    title={t("general.summaries.chatTitles")}
                    detail={t("general.summaries.chatTitlesDetail")}
                    value={s.general.aiChatTitles}
                    onChange={(aiChatTitles) => void patchSettings({ general: { aiChatTitles } })}
                  />
                  <SwitchRow
                    icon="bell"
                    title={t("general.summaries.notifications")}
                    detail={t("general.summaries.notificationsDetail")}
                    value={s.general.aiNotificationSummaries}
                    onChange={(aiNotificationSummaries) => void patchSettings({ general: { aiNotificationSummaries } })}
                  />
                </Group>
              )}
            </>
          );
        }}
      </QueryState>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
