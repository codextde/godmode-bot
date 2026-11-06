import { Stack } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CALL_LANGUAGES } from "@/components/call-parts";
import { CallsAdmin } from "@/components/calls-admin";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, PickerRow, StepperRow, SwitchRow, TextEditor } from "@/components/form";
import { QueryState } from "@/components/settings-state";
import { SectionTitle } from "@/components/ui";
import { languageName } from "@/lib/languages";
import { patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

const LONGEST = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60] as const;
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);

/** Settings → Calls: how Godmode's voice introduces itself and its limits. Numbers, your phone, the PIN and answering stay on the computer. */
export default function CallsPersona() {
  const { t } = useTranslation(["settings", "common"]);
  const settings = useSettings();

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("calls.title") }} />
      <CloseButton />
      <QueryState query={settings} icon="call" errorTitle={t("calls.loadFailed")}>
        {(s) => {
          const p = s.phone;
          const languages = [...(CALL_LANGUAGES.includes(p.language as never) ? [] : [p.language]), ...CALL_LANGUAGES].map((code) => ({ value: code, label: languageName(code) }));
          const hours = (value: string) => (HOURS.includes(value) ? HOURS : [value, ...HOURS]).map((h) => ({ value: h, label: h }));
          const quiet = !!(p.quietFrom && p.quietTo);
          return (
            <>
              <Group title={t("calls.voice.title")} footer={t("calls.voice.footer")}>
                <FieldRow label={t("calls.voice.name")} value={p.callerName} placeholder="Alex" maxLength={60} onCommit={(callerName) => void patchSettings({ phone: { callerName: callerName.trim() } })} />
                <PickerRow icon="globe" title={t("calls.voice.language")} value={p.language} options={languages} onChange={(language) => void patchSettings({ phone: { language } })} />
                <StepperRow
                  icon="clock"
                  title={t("calls.voice.longest")}
                  value={p.maxMinutes}
                  min={LONGEST[0]}
                  max={LONGEST[LONGEST.length - 1]}
                  steps={LONGEST}
                  format={(n) => t("calls.minutes", { count: n })}
                  onChange={(maxMinutes) => void patchSettings({ phone: { maxMinutes } })}
                />
              </Group>

              <Group title={t("calls.quiet.title")} footer={quiet ? t("calls.quiet.on", { from: p.quietFrom, to: p.quietTo }) : t("calls.quiet.off")}>
                <SwitchRow
                  icon="moon"
                  title={t("calls.quiet.title")}
                  value={quiet}
                  onChange={(on) => void patchSettings({ phone: on ? { quietFrom: p.quietFrom || "22:00", quietTo: p.quietTo || "07:00" } : { quietFrom: "", quietTo: "" } })}
                />
                {quiet ? <PickerRow title={t("calls.quiet.from")} value={p.quietFrom} options={hours(p.quietFrom)} onChange={(quietFrom) => void patchSettings({ phone: { quietFrom } })} /> : null}
                {quiet ? <PickerRow title={t("calls.quiet.to")} value={p.quietTo} options={hours(p.quietTo)} onChange={(quietTo) => void patchSettings({ phone: { quietTo } })} /> : null}
              </Group>

              <View>
                <SectionTitle title={t("calls.greeting.title")} />
                <TextEditor
                  label={t("calls.greeting.title")}
                  value={p.inboundGreeting}
                  placeholder={t("calls.greeting.placeholder")}
                  hint={t("calls.greeting.hint")}
                  maxLength={500}
                  minHeight={88}
                  onSave={(inboundGreeting) => patchSettings({ phone: { inboundGreeting: inboundGreeting.trim() } }, { quiet: true })}
                />
              </View>

              <CallsAdmin phone={p} />
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
