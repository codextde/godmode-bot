import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from "expo-audio";
import { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "./icon";
import { LiveDot, T, tap } from "./ui";
import { ApiError, api, errorText, updateDesktopMessage } from "@/lib/api";
import { useSettings } from "@/lib/setup";
import { radius, useColors } from "@/lib/theme";

/** A recording stops by itself after this long (25 MB of 16 kHz WAV is about 13 minutes). */
const MAX_SECONDS = 10 * 60;
const BARS = 22;

/**
 * 16 kHz mono WAV on iOS: what Hex on the computer reads, and OpenAI too. Android records AAC (it has no WAV encoder),
 * which only OpenAI reads.
 */
const OPTIONS: RecordingOptions = {
  extension: ".wav",
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 256_000,
  isMeteringEnabled: true,
  ios: { outputFormat: IOSOutputFormat.LINEARPCM, audioQuality: AudioQuality.HIGH, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
  android: { extension: ".m4a", outputFormat: "mpeg4", audioEncoder: "aac", sampleRate: 16_000 },
  web: { mimeType: "audio/webm", bitsPerSecond: 128_000 },
};

type Phase = "idle" | "starting" | "recording" | "transcribing";

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function removeFile(uri: string | null) {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {
    // Recordings live in the cache; the system clears what is left.
  }
}

/**
 * Dictation in the composer: the mic records on the phone, the computer writes it down (with its own key or Hex) and
 * the text lands in the field. While it records it takes the whole toolbar (`onActive`).
 */
export function VoiceButton({ onText, onActive, disabled }: { onText: (text: string) => void; onActive: (active: boolean) => void; disabled?: boolean }) {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const settings = useSettings();
  const recorder = useAudioRecorder(OPTIONS);
  const [phase, setPhase] = useState<Phase>("idle");
  const [meter, setMeter] = useState<{ ms: number; levels: number[] }>({ ms: 0, levels: [] });
  const phaseRef = useRef(phase);

  useEffect(() => {
    phaseRef.current = phase;
    onActive(phase !== "idle" && phase !== "starting");
  }, [phase, onActive]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => {
      const status = recorder.getStatus();
      // -50 dB and below reads as silence; 0 dB fills the bar.
      const level = Math.max(0, Math.min(1, ((status.metering ?? -160) + 50) / 50));
      setMeter((prev) => ({ ms: status.durationMillis, levels: [...prev.levels.slice(-(BARS - 1)), level] }));
    }, 100);
    return () => clearInterval(timer);
  }, [phase, recorder]);

  // Leaving the chat mid-sentence drops the recording.
  useEffect(
    () => () => {
      if (phaseRef.current === "recording") void recorder.stop().catch(() => undefined);
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    },
    [recorder],
  );

  if (settings.data?.voice?.enabled === false || settings.data?.voice?.dictation === false) return null;

  const start = async () => {
    tap();
    setPhase("starting");
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setPhase("idle");
        Alert.alert(
          t("voice.micDeniedTitle"),
          t("voice.micDenied"),
          permission.canAskAgain
            ? undefined
            : [
                { text: t("common:actions.cancel"), style: "cancel" },
                { text: t("common:words.settings"), onPress: () => void Linking.openSettings() },
              ],
        );
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      setMeter({ ms: 0, levels: [] });
      recorder.record({ forDuration: MAX_SECONDS });
      setPhase("recording");
    } catch (err) {
      setPhase("idle");
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      Alert.alert(t("voice.recordFailed"), errorText(err));
    }
  };

  const discard = async () => {
    tap();
    await recorder.stop().catch(() => undefined);
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    removeFile(recorder.uri);
    setPhase("idle");
  };

  const finish = async () => {
    tap();
    setPhase("transcribing");
    await recorder.stop().catch(() => undefined);
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    const uri = recorder.uri;
    try {
      if (!uri) throw new Error(t("voice.recordFailed"));
      const wav = uri.endsWith(".wav");
      const { text } = await api.voice.transcribe({ uri, name: wav ? "speech.wav" : "speech.m4a", mime: wav ? "audio/wav" : "audio/mp4" });
      if (text.trim()) onText(text.trim());
      else Alert.alert(t("voice.failed"), t("voice.nothingHeard"));
    } catch (err) {
      if (err instanceof ApiError && err.code === "voice_not_set_up") Alert.alert(t("voice.notSetUpTitle"), t("voice.notSetUp"));
      else if (err instanceof ApiError && err.code === "device_forbidden") Alert.alert(t("voice.failed"), updateDesktopMessage());
      else Alert.alert(t("voice.failed"), errorText(err));
    } finally {
      removeFile(uri);
      setPhase("idle");
    }
  };

  if (phase === "idle" || phase === "starting") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("voice.dictate")}
        disabled={disabled || phase === "starting"}
        onPress={() => void start()}
        hitSlop={4}
        style={({ pressed }) => [styles.tool, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
      >
        {phase === "starting" ? <ActivityIndicator size="small" color={c.textMuted} /> : <Icon name="mic" size={17} color={c.textMuted} />}
      </Pressable>
    );
  }

  if (phase === "transcribing") {
    return (
      <View style={styles.wide} accessibilityRole="progressbar" accessibilityLabel={t("voice.transcribing")}>
        <ActivityIndicator size="small" color={c.textMuted} />
        <T variant="subhead" muted>
          {t("voice.transcribing")}
        </T>
      </View>
    );
  }

  return (
    <View style={styles.wide}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("voice.discard")}
        onPress={() => void discard()}
        hitSlop={4}
        style={({ pressed }) => [styles.tool, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
      >
        <Icon name="close" size={14} weight="semibold" color={c.textMuted} />
      </Pressable>
      <View style={styles.meter} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <LiveDot color={c.danger} size={7} />
        <View style={styles.bars}>
          {Array.from({ length: BARS }, (_, i) => {
            const level = meter.levels[i - (BARS - meter.levels.length)] ?? 0;
            return <View key={i} style={[styles.bar, { height: 3 + level * 19, backgroundColor: level > 0 ? c.text : c.border }]} />;
          })}
        </View>
        <T variant="subhead" style={{ fontVariant: ["tabular-nums"], fontWeight: "600" }}>
          {clock(meter.ms)}
        </T>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("voice.stop")}
        onPress={() => void finish()}
        style={({ pressed }) => [styles.done, { backgroundColor: c.primary, opacity: pressed ? 0.75 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] }]}
      >
        <Icon name="check" size={15} weight="bold" color={c.onPrimary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  tool: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  wide: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 36,
    paddingLeft: 4,
  },
  meter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  bars: {
    flex: 1,
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  bar: {
    width: 3,
    borderRadius: 2,
  },
  done: {
    width: 36,
    height: 36,
    marginLeft: 2,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
