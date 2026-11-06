import { Stack } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { SttProvider, TtsProvider } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, PickerRow, SegmentRow, StepperRow, SwitchRow } from "@/components/form";
import { QueryState } from "@/components/settings-state";
import { languageName } from "@/lib/languages";
import { patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

const LANGUAGES = ["en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "nl-NL", "pt-BR", "ja-JP"] as const;
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Settings → Voice: voice mode and dictation in the apps, and who listens and speaks. Keys and Hex are set up on the computer. */
export default function Voice() {
  const { t } = useTranslation(["settings", "common"]);
  const settings = useSettings();

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("voice.title") }} />
      <CloseButton />
      <QueryState query={settings} icon="waveform" errorTitle={t("voice.loadFailed")}>
        {(s) => {
          const v = s.voice;
          const save = (voice: NonNullable<Parameters<typeof patchSettings>[0]["voice"]>) => void patchSettings({ voice });
          const languages = [...(v.language && !LANGUAGES.includes(v.language as never) ? [v.language] : []), ...LANGUAGES].map((tag) => ({ value: tag, label: languageName(tag), detail: tag }));
          // Hex is a program and a download: only the computer switches to it.
          const stt: SttProvider[] = v.sttProvider === "hex" ? ["browser", "openai", "hex"] : ["browser", "openai"];
          const keyNeeded = v.sttProvider === "openai" || v.ttsProvider !== "browser";
          return (
            <>
              <Group title={t("voice.mode.title")}>
                <SwitchRow icon="waveform" title={t("voice.mode.enable")} detail={t("voice.mode.enableDetail")} value={v.enabled} onChange={(enabled) => save({ enabled })} />
                <SwitchRow icon="call" title={t("voice.mode.autoSpeak")} detail={t("voice.mode.autoSpeakDetail")} value={v.autoSpeak} onChange={(autoSpeak) => save({ autoSpeak })} />
                <PickerRow icon="globe" title={t("voice.mode.language")} value={v.language || "en-US"} options={languages} onChange={(language) => save({ language })} />
              </Group>

              <Group title={t("voice.stt.title")} footer={t(`voice.stt.${v.sttProvider}`)}>
                <SwitchRow icon="mic" title={t("voice.stt.dictation")} detail={t("voice.stt.dictationDetail")} value={v.dictation} onChange={(dictation) => save({ dictation })} />
                <SegmentRow<SttProvider>
                  title={t("voice.provider")}
                  options={stt.map((p) => ({ value: p, label: p === "browser" ? t("voice.browser") : p === "openai" ? "OpenAI" : "Hex" }))}
                  value={v.sttProvider}
                  onChange={(sttProvider) => save({ sttProvider })}
                />
                {v.sttProvider === "openai" ? (
                  <FieldRow label={t("voice.openai.sttModel")} value={v.sttModel} placeholder="gpt-4o-transcribe" maxLength={200} onCommit={(sttModel) => save({ sttModel: sttModel.trim() })} />
                ) : null}
              </Group>

              <Group title={t("voice.tts.title")} footer={keyNeeded ? t("voice.keys") : undefined}>
                <SegmentRow<TtsProvider>
                  title={t("voice.provider")}
                  options={[
                    { value: "browser", label: t("voice.browser") },
                    { value: "openai", label: "OpenAI" },
                    { value: "elevenlabs", label: "ElevenLabs" },
                  ]}
                  value={v.ttsProvider}
                  onChange={(ttsProvider) => save({ ttsProvider })}
                />
                {v.ttsProvider === "browser" ? (
                  <StepperRow icon="gauge" title={t("voice.tts.rate")} value={v.rate} min={RATES[0]} max={RATES[RATES.length - 1]} steps={RATES} format={(n) => `${n}×`} onChange={(rate) => save({ rate })} />
                ) : null}
                {v.ttsProvider === "openai" ? (
                  <FieldRow label={t("voice.openai.ttsModel")} value={v.ttsModel} placeholder="gpt-4o-mini-tts" maxLength={200} onCommit={(ttsModel) => save({ ttsModel: ttsModel.trim() })} />
                ) : null}
                {v.ttsProvider === "openai" ? (
                  <FieldRow label={t("voice.tts.voice")} value={v.ttsVoice} placeholder="alloy" maxLength={200} onCommit={(ttsVoice) => save({ ttsVoice: ttsVoice.trim() })} />
                ) : null}
                {v.ttsProvider === "elevenlabs" ? (
                  <FieldRow
                    label={t("voice.tts.elevenlabsVoice")}
                    value={v.elevenlabsVoiceId}
                    placeholder="21m00Tcm4TlvDq8ikWAM"
                    maxLength={200}
                    onCommit={(elevenlabsVoiceId) => save({ elevenlabsVoiceId: elevenlabsVoiceId.trim() })}
                  />
                ) : null}
              </Group>
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
