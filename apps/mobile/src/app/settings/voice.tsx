import { useMutation, useQuery } from "@tanstack/react-query";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBytes, HEX_MODELS, type SttProvider, type TtsProvider, type VoiceSettings } from "@godmode/shared";
import { isRefused, useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, PickerRow, SegmentRow, StepperRow, SwitchRow } from "@/components/form";
import { ActionPill, ToolRow } from "@/components/program-parts";
import { QueryState } from "@/components/settings-state";
import { ActionRow, TextRow } from "@/components/tool-form";
import { patchAnySettings } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { languageName } from "@/lib/languages";
import { pk, programsApi } from "@/lib/programs";
import { queryClient } from "@/lib/query";
import { patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";
import { speak, type Speech } from "@/lib/voice-mode";
import { speakSample } from "@/lib/voice-test";

const LANGUAGES = ["en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "nl-NL", "pt-BR", "ja-JP"] as const;
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/**
 * Settings → Voice: voice mode and dictation in the apps, and who listens and speaks. Keys are added on the computer; a
 * full-access phone also sets up Hex and the OpenAI address, like the desktop app.
 */
export default function Voice() {
  const { t } = useTranslation(["settings", "common", "programs"]);
  const settings = useSettings();
  const admin = useFullAccess().fullAccess === true;

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
          const stt: SttProvider[] = admin || v.sttProvider === "hex" ? ["browser", "openai", "hex"] : ["browser", "openai"];
          const openai = v.sttProvider === "openai" || v.ttsProvider === "openai";
          const keyNeeded = v.sttProvider === "openai" || v.ttsProvider !== "browser";
          return (
            <>
              <Group title={t("voice.mode.title")}>
                <SwitchRow icon="waveform" title={t("voice.mode.enable")} value={v.enabled} onChange={(enabled) => save({ enabled })} />
                <SwitchRow icon="call" title={t("voice.mode.autoSpeak")} detail={t("voice.mode.autoSpeakDetail")} value={v.autoSpeak} onChange={(autoSpeak) => save({ autoSpeak })} />
                <PickerRow icon="globe" title={t("voice.mode.language")} value={v.language || "en-US"} options={languages} onChange={(language) => save({ language })} />
                <TagRow key={v.language} value={v.language} onCommit={(language) => save({ language })} />
                {v.ttsProvider === "browser" ? <TestPhoneVoiceRow voice={v} /> : <TestVoiceRow admin={admin} />}
              </Group>

              <Group title={t("voice.stt.title")}>
                <SwitchRow icon="mic" title={t("voice.stt.dictation")} value={v.dictation} onChange={(dictation) => save({ dictation })} />
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

              {admin && openai ? (
                <Group>
                  <FieldRow
                    label={t("programs:openaiBaseUrl")}
                    value={v.openaiBaseUrl}
                    placeholder="https://api.openai.com/v1"
                    keyboardType="url"
                    maxLength={500}
                    onCommit={(openaiBaseUrl) => void patchAnySettings({ voice: { openaiBaseUrl: openaiBaseUrl.trim() } })}
                  />
                </Group>
              ) : null}

              {admin && v.sttProvider === "hex" ? <HexGroup voice={v} /> : null}
            </>
          );
        }}
      </QueryState>
    </ScrollView>
  );
}

/** A language tag the list doesn't have (BCP-47, e.g. "de-AT"), saved when the field is left. */
function TagRow({ value, onCommit }: { value: string; onCommit: (tag: string) => void }) {
  const { t } = useTranslation("settings");
  const [text, setText] = useState(value);
  const commit = () => {
    const tag = text.trim();
    if (tag !== value) onCommit(tag);
  };
  return <TextRow label={t("voice.mode.tag")} value={text} onChange={setText} onBlur={commit} placeholder="en-US" maxLength={35} mono />;
}

/** The sample sentence in the phone's own voice, in the language and speed set here; again to stop. */
function TestPhoneVoiceRow({ voice }: { voice: VoiceSettings }) {
  const { t } = useTranslation(["settings", "common"]);
  const speech = useRef<Speech | null>(null);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => () => speech.current?.stop(), []);

  const test = () => {
    if (speech.current) return speech.current.stop();
    const said = speak(t("voice.sample"), voice, true);
    speech.current = said;
    setSpeaking(true);
    said.done
      .catch((err: unknown) => Alert.alert(t("voice.testFailed"), errorText(err)))
      .finally(() => {
        speech.current = null;
        setSpeaking(false);
      });
  };

  return <ActionRow icon={speaking ? "stop" : "play"} title={speaking ? t("common:actions.stop") : t("voice.mode.test")} onPress={test} />;
}

/** Plays a sample sentence in the voice set up for replies, spoken by the computer (`voice.speak`); again to stop. */
function TestVoiceRow({ admin }: { admin: boolean }) {
  const { t } = useTranslation(["settings", "common", "components"]);
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [loading, setLoading] = useState(false);
  // The player only ever holds the sample, so its state is the row's.
  const playing = status.playing;

  const test = async () => {
    if (!admin) return Alert.alert(t("components:fullAccess.title"));
    if (playing) return player.pause();
    setLoading(true);
    try {
      const file = await speakSample(t("voice.sample"));
      await setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
      player.replace({ uri: file.uri });
      player.play();
    } catch (err) {
      Alert.alert(isRefused(err) ? t("components:fullAccess.title") : t("voice.testFailed"), isRefused(err) ? undefined : errorText(err));
    } finally {
      setLoading(false);
    }
  };

  return <ActionRow icon={playing ? "stop" : "play"} title={playing ? t("common:actions.stop") : t("voice.mode.test")} busy={loading} onPress={() => void test()} />;
}

/** Hex, local dictation on the computer: its app, the speech model it downloads, where it lives. */
function HexGroup({ voice }: { voice: VoiceSettings }) {
  const { t } = useTranslation("programs");
  const status = useQuery({
    queryKey: [...pk.hex, voice.hexPath, voice.hexModel, voice.language],
    queryFn: programsApi.hex.status,
    refetchInterval: (q) => (q.state.data?.progress ? 1000 : false),
  });
  const prepare = useMutation({
    mutationFn: () => programsApi.hex.prepare(voice.language),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: pk.hex }),
    onError: (err) => Alert.alert(t("hex.startFailed"), errorText(err)),
  });
  const s = status.data;
  const progress = s?.progress;
  const percent = progress && (progress.phase === "downloading" || progress.phase === "installing") && progress.totalBytes ? Math.round((progress.downloadedBytes / progress.totalBytes) * 100) : 0;
  const phase = progress ? t(`hex.phase.${progress.phase}`, { percent }) : null;
  const usable = !!s && (!!s.path || s.canInstall);
  const size = formatBytes(s?.downloadBytes ?? (HEX_MODELS.find((m) => m.id === voice.hexModel)?.sizeMb ?? 0) * 1024 * 1024);
  const start = <ActionPill label={t("hex.downloadAction")} busy={prepare.isPending} onPress={() => prepare.mutate()} />;

  return (
    <Group title={t("hex.title")} footer={s?.error && !progress ? s.error : undefined}>
      {!s ? (
        <ToolRow title={t("hex.app")} detail={status.isError ? errorText(status.error) : undefined} />
      ) : s.path ? (
        <ToolRow title={t("hex.app")} detail={s.version ? t("hex.version", { version: s.version }) : t("hex.found")} ok />
      ) : s.canInstall ? (
        <ToolRow title={t("hex.app")} detail={progress?.phase === "installing" ? (phase ?? undefined) : t("notInstalled")} action={progress ? undefined : <ActionPill label={t("install")} busy={prepare.isPending} onPress={() => prepare.mutate()} />} />
      ) : (
        <ToolRow title={t("hex.app")} detail={voice.hexPath.trim() ? t("hex.notFound") : t("hex.missing")} ok={false} />
      )}
      <PickerRow
        title={t("hex.model")}
        value={voice.hexModel}
        options={HEX_MODELS.map((m) => ({ value: m.id, label: m.name, detail: formatBytes(m.sizeMb * 1024 * 1024) }))}
        onChange={(hexModel) => void patchAnySettings({ voice: { hexModel } })}
      />
      {usable ? (
        <ToolRow
          title={t("hex.download")}
          detail={progress && progress.phase !== "installing" ? (phase ?? undefined) : s.installed ? t("hex.ready") : t("hex.notDownloaded", { size })}
          ok={s.installed && !progress ? true : undefined}
          action={!s.installed && !progress ? start : undefined}
        />
      ) : null}
      <FieldRow
        label={t("hex.path")}
        value={voice.hexPath}
        placeholder={t("hex.pathPlaceholder")}
        maxLength={1000}
        onCommit={(hexPath) => void patchAnySettings({ voice: { hexPath: hexPath.trim() } })}
      />
    </Group>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
