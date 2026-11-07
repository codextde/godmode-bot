import {
  AudioQuality,
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from "expo-audio";
import { File } from "expo-file-system";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Alert, Linking, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "./icon";
import { LiveDot, T, tap } from "./ui";
import { ApiError, api, errorText, updateDesktopMessage } from "@/lib/api";
import { askToListen, FILE_MAX_MS, listen, recognizeFile, refreshDictation, speechLocale, useDictation, type DictationEngine, type Heard, type Listening } from "@/lib/dictation";
import { useSettings } from "@/lib/setup";
import { radius, useColors } from "@/lib/theme";

/** A dictation stops by itself after this long (25 MB of 16 kHz WAV is about 13 minutes). */
const MAX_SECONDS = 10 * 60;
const BARS = 22;
/** How long "Nothing was heard" stays in the toolbar. */
const EMPTY_MS = 2_500;

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

type Phase = "idle" | "starting" | "recording" | "transcribing" | "empty";

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
 * Dictation in the composer. When the computer writes recordings down (Hex or an OpenAI key) the phone records and
 * uploads; otherwise the phone's own speech recognition listens. The text lands in the field. While it listens it
 * takes the whole toolbar (`onActive`); without either way to dictate there is no mic (the keyboard's stays).
 */
export function VoiceButton({ onText, onActive, disabled }: { onText: (text: string) => void; onActive: (active: boolean) => void; disabled?: boolean }) {
  const c = useColors();
  const { t } = useTranslation(["chat", "common"]);
  const settings = useSettings();
  const voice = settings.data?.voice;
  const engine = useDictation(voice?.sttProvider);
  const recorder = useAudioRecorder(OPTIONS);
  const [phase, setPhase] = useState<Phase>("idle");
  const [meter, setMeter] = useState<{ ms: number; levels: number[] }>({ ms: 0, levels: [] });
  const phaseRef = useRef(phase);
  /** The engine of the dictation that runs now. */
  const using = useRef<DictationEngine>("computer");
  const listening = useRef<Listening | null>(null);
  /** Counts the phone's dictations: the end of one that was dropped is not the end of the next. */
  const session = useRef(0);
  const heardLevel = useRef(0);
  const startedAt = useRef(0);
  const emptyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const go = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const nothingHeard = () => {
    go("empty");
    AccessibilityInfo.announceForAccessibility(t("voice.nothingHeard"));
    clearTimeout(emptyTimer.current);
    emptyTimer.current = setTimeout(() => {
      if (phaseRef.current === "empty") go("idle");
    }, EMPTY_MS);
  };

  const denied = (title: string, message: string, canAskAgain: boolean) =>
    Alert.alert(
      title,
      message,
      canAskAgain
        ? undefined
        : [
            { text: t("common:actions.cancel"), style: "cancel" },
            { text: t("common:words.settings"), onPress: () => void Linking.openSettings() },
          ],
    );

  const heardOnPhone = (id: number, heard: Heard) => {
    if (session.current !== id) return;
    listening.current = null;
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    if (phaseRef.current === "idle") return;
    if (heard.text) {
      onText(heard.text);
      go("idle");
      return;
    }
    const code = heard.error?.code;
    if (!code || code === "no-speech" || code === "speech-timeout" || code === "aborted") return nothingHeard();
    go("idle");
    if (code === "not-allowed") denied(t("voice.speechDeniedTitle"), t("voice.speechDenied"), false);
    else Alert.alert(t("voice.failed"), code === "service-not-allowed" || code === "language-not-supported" ? t("voice.phoneUnavailable") : t("voice.tryAgain"));
  };

  const startOnPhone = async () => {
    const permission = await askToListen();
    if (phaseRef.current !== "starting") return;
    if (!permission.granted) {
      go("idle");
      denied(t("voice.speechDeniedTitle"), t("voice.speechDenied"), permission.canAskAgain);
      return;
    }
    const lang = await speechLocale(voice?.language ?? "");
    if (phaseRef.current !== "starting") return;
    heardLevel.current = 0;
    startedAt.current = Date.now();
    setMeter({ ms: 0, levels: [] });
    const id = ++session.current;
    const handle = listen(lang, { onLevel: (level) => (heardLevel.current = level), onEnd: (heard) => heardOnPhone(id, heard) });
    // It may have ended at once (no recognizer for the language, no access).
    if (session.current !== id || phaseRef.current !== "starting") return;
    listening.current = handle;
    go("recording");
  };

  const startRecording = async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (phaseRef.current !== "starting") return;
    if (!permission.granted) {
      go("idle");
      denied(t("voice.micDeniedTitle"), t("voice.micDenied"), permission.canAskAgain);
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    setMeter({ ms: 0, levels: [] });
    recorder.record();
    go("recording");
  };

  const start = async () => {
    if (!engine) return;
    tap();
    clearTimeout(emptyTimer.current);
    using.current = engine;
    go("starting");
    try {
      if (engine === "phone") await startOnPhone();
      else await startRecording();
    } catch (err) {
      // Left the chat while it started: nothing to say.
      const here = phaseRef.current === "starting";
      go("idle");
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      if (here) Alert.alert(t("voice.recordFailed"), errorText(err));
    }
  };

  const discard = async () => {
    tap();
    const uri = recorder.uri;
    go("idle");
    if (using.current === "phone") {
      session.current++;
      listening.current?.abort();
      listening.current = null;
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      return;
    }
    await recorder.stop().catch(() => undefined);
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    removeFile(uri);
  };

  /** The computer writes the recording down; when it can't, the phone tries before anything is lost. */
  const transcribe = async (uri: string, ms: number) => {
    const wav = uri.endsWith(".wav");
    let text: string;
    try {
      text = (await api.voice.transcribe({ uri, name: wav ? "speech.wav" : "speech.m4a", mime: wav ? "audio/wav" : "audio/mp4" })).text.trim();
    } catch (err) {
      refreshDictation();
      text = ms <= FILE_MAX_MS ? await recognizeFile(uri, voice?.language ?? "").catch(() => "") : "";
      if (!text) {
        go("idle");
        if (err instanceof ApiError && err.code === "voice_not_set_up") Alert.alert(t("voice.notSetUpTitle"), t("voice.notSetUp"));
        else if (err instanceof ApiError && err.code === "device_forbidden") Alert.alert(t("voice.failed"), updateDesktopMessage());
        else Alert.alert(t("voice.failed"), errorText(err));
        return;
      }
    }
    if (!text) return nothingHeard();
    onText(text);
    go("idle");
  };

  const finish = async () => {
    if (phaseRef.current !== "recording") return;
    tap();
    go("transcribing");
    if (using.current === "phone") {
      listening.current?.stop();
      return;
    }
    const ms = recorder.getStatus().durationMillis;
    await recorder.stop().catch(() => undefined);
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    const uri = recorder.uri;
    if (!uri) {
      go("idle");
      Alert.alert(t("voice.failed"), t("voice.recordFailed"));
      return;
    }
    try {
      await transcribe(uri, ms);
    } finally {
      removeFile(uri);
    }
  };

  const overtime = useEffectEvent(() => void finish());

  useEffect(() => {
    onActive(phase !== "idle" && phase !== "starting");
  }, [phase, onActive]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => {
      let ms: number;
      let level: number;
      if (using.current === "computer") {
        const status = recorder.getStatus();
        ms = status.durationMillis;
        // -50 dB and below reads as silence; 0 dB fills the bar.
        level = Math.max(0, Math.min(1, ((status.metering ?? -160) + 50) / 50));
      } else {
        ms = Date.now() - startedAt.current;
        level = heardLevel.current;
      }
      setMeter((prev) => ({ ms, levels: [...prev.levels.slice(-(BARS - 1)), level] }));
      if (ms >= MAX_SECONDS * 1000) overtime();
    }, 100);
    return () => clearInterval(timer);
  }, [phase, recorder]);

  // Leaving the chat mid-sentence drops the recording.
  useEffect(
    () => () => {
      clearTimeout(emptyTimer.current);
      session.current++;
      listening.current?.abort();
      listening.current = null;
      if (phaseRef.current === "recording" && using.current === "computer") void recorder.stop().catch(() => undefined);
      phaseRef.current = "idle";
      void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    },
    [recorder],
  );

  if (voice?.enabled === false || voice?.dictation === false) return null;
  if (!engine && phase === "idle") return null;

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

  if (phase === "empty") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("voice.nothingHeard")} ${t("voice.dictate")}`}
        disabled={disabled}
        onPress={() => void start()}
        style={({ pressed }) => [styles.wide, { opacity: pressed ? 0.6 : 1 }]}
      >
        <View style={styles.tool}>
          <Icon name="mic" size={17} color={c.textMuted} />
        </View>
        <T variant="subhead" muted>
          {t("voice.nothingHeard")}
        </T>
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
