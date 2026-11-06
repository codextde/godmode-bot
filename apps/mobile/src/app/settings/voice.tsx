import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBytes, HEX_MODELS, type SttProvider, type TtsProvider, type VoiceSettings } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, PickerRow, SegmentRow, StepperRow, SwitchRow } from "@/components/form";
import { ActionPill, ToolRow } from "@/components/program-parts";
import { QueryState } from "@/components/settings-state";
import { patchAnySettings } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { languageName } from "@/lib/languages";
import { pk, programsApi } from "@/lib/programs";
import { queryClient } from "@/lib/query";
import { patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

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
    <Group title={t("hex.title")} footer={s?.error && !progress ? s.error : t("hex.footer")}>
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
