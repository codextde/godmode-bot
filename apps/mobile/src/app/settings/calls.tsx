import { Stack } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useFullAccess } from "@/components/admin";
import { CALL_LANGUAGES } from "@/components/call-parts";
import { CallStatusGroup, NumberGroup, useVoiceRows } from "@/components/call-setup";
import { CallsAdmin } from "@/components/calls-admin";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, PickerRow, StepperRow, SwitchRow, TextEditor } from "@/components/form";
import { SettingsScroll } from "@/components/settings-scroll";
import { QueryState } from "@/components/settings-state";
import { TimeRow } from "@/components/time-row";
import { SectionTitle } from "@/components/ui";
import { languageName } from "@/lib/languages";
import { patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

const LONGEST = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60] as const;

/**
 * Settings → Calls: how Godmode's voice introduces itself and its limits. A full-access phone also sets up what the
 * desktop does: the number, the voice and model, calls to you, the PIN and answering.
 */
export default function CallsPersona() {
  const { t } = useTranslation(["settings", "common"]);
  const settings = useSettings();
  const admin = !!useFullAccess().fullAccess;
  const voiceRows = useVoiceRows(settings.data?.phone, admin && !!settings.data);

  return (
    <SettingsScroll contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("calls.title") }} />
      <CloseButton />
      <QueryState query={settings} icon="call" errorTitle={t("calls.loadFailed")}>
        {(s) => {
          const p = s.phone;
          const languages = [...(CALL_LANGUAGES.includes(p.language as never) ? [] : [p.language]), ...CALL_LANGUAGES].map((code) => ({ value: code, label: languageName(code) }));
          const quiet = !!(p.quietFrom && p.quietTo);
          return (
            <>
              {admin ? <CallStatusGroup /> : null}
              {admin ? <NumberGroup phone={p} /> : null}

              <Group title={t("calls.voice.title")} footer={admin ? undefined : t("calls.voice.footer")}>
                {voiceRows}
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

              <Group title={t("calls.quiet.title")} footer={quiet ? t("calls.quiet.on") : undefined}>
                <SwitchRow
                  icon="moon"
                  title={t("calls.quiet.title")}
                  value={quiet}
                  onChange={(on) => void patchSettings({ phone: on ? { quietFrom: p.quietFrom || "22:00", quietTo: p.quietTo || "07:00" } : { quietFrom: "", quietTo: "" } })}
                />
                {quiet ? <TimeRow title={t("calls.quiet.from")} label={t("calls.quiet.fromLabel")} value={p.quietFrom} onChange={(quietFrom) => void patchSettings({ phone: { quietFrom } })} /> : null}
                {quiet ? <TimeRow title={t("calls.quiet.to")} label={t("calls.quiet.toLabel")} value={p.quietTo} onChange={(quietTo) => void patchSettings({ phone: { quietTo } })} /> : null}
              </Group>

              <View>
                <SectionTitle title={t("calls.greeting.title")} />
                <TextEditor
                  label={t("calls.greeting.title")}
                  value={p.inboundGreeting}
                  placeholder={t("calls.greeting.placeholder")}
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
    </SettingsScroll>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
