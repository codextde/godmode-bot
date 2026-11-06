import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { formatCallTime } from "./call-parts";
import { Icon } from "./icon";
import { Row, T, tap } from "./ui";
import { pictureBases } from "@/lib/api";
import { useSession } from "@/lib/session";
import { radius, space, useColors } from "@/lib/theme";

type Problem = "none" | "unavailable" | "failed";

/** Why the recording didn't load: asked once more, without playing it (an older Godmode refuses phones). */
async function problemOf(url: string, token: string): Promise<Problem> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      return body?.code === "device_forbidden" ? "unavailable" : "failed";
    }
    if (res.status === 404) return "none";
    return "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** The call's recording, played from the computer with this phone's key (it streams; nothing is saved). */
export function CallRecording({ callId, duration }: { callId: string; duration: number | null }) {
  const c = useColors();
  const { t } = useTranslation(["calls", "common"]);
  const connection = useSession((s) => s.connection);
  const base = connection ? pictureBases(connection)[0] : undefined;
  const url = base ? `${base}/api/calls/${callId}/audio` : null;
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [width, setWidth] = useState(0);
  const checking = useRef(false);

  const load = () => {
    if (!url || !connection) return;
    setProblem(null);
    player.replace({ uri: url, headers: { authorization: `Bearer ${connection.token}` } });
    setLoaded(true);
  };

  useEffect(() => {
    if (!status.error || !url || !connection || checking.current) return;
    checking.current = true;
    void problemOf(url, connection.token).then((p) => {
      checking.current = false;
      setProblem(p);
      setLoaded(false);
    });
  }, [status.error, url, connection]);

  const toggle = async () => {
    tap();
    if (status.playing) return player.pause();
    await setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
    if (!loaded) load();
    if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration - 0.2)) await player.seekTo(0);
    player.play();
  };

  const total = status.duration > 0 ? status.duration : (duration ?? 0);
  const progress = total > 0 ? Math.min(1, status.currentTime / total) : 0;
  const waiting = loaded && status.playing && (status.isBuffering || !status.isLoaded);
  const seek = (x: number) => {
    if (!loaded || !total || !width) return;
    tap();
    void player.seekTo(Math.max(0, Math.min(total, (x / width) * total)));
  };

  if (problem === "none" || problem === "unavailable") {
    return (
      <Row style={{ gap: space.sm, paddingHorizontal: 4 }}>
        <Icon name="waveform" size={13} color={c.textMuted} />
        <T variant="footnote" muted style={{ flex: 1 }}>
          {problem === "none" ? t("detail.noRecording") : t("detail.recordingUnavailable")}
        </T>
      </Row>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, boxShadow: c.shadowCard }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={status.playing ? t("detail.pause") : t("detail.play")}
        disabled={!url}
        onPress={() => void toggle()}
        style={({ pressed }) => [styles.play, { backgroundColor: c.primary, opacity: pressed ? 0.8 : 1 }]}
      >
        {waiting ? (
          <ActivityIndicator size="small" color={c.onPrimary} />
        ) : (
          <Icon name={status.playing ? "pause" : "play"} size={16} color={c.onPrimary} style={status.playing ? undefined : { marginLeft: 2 }} />
        )}
      </Pressable>
      <View style={{ flex: 1, gap: 6 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="subhead" style={{ fontWeight: "600", flex: 1 }}>
            {t("detail.recording")}
          </T>
          <T variant="caption" muted style={{ fontVariant: ["tabular-nums"] }}>
            {formatCallTime(status.currentTime)} / {total ? formatCallTime(total) : "–"}
          </T>
        </Row>
        <Pressable
          accessibilityRole="adjustable"
          accessibilityLabel={t("detail.seek")}
          accessibilityValue={{ min: 0, max: Math.round(total), now: Math.round(status.currentTime) }}
          onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
          onPress={(e) => seek(e.nativeEvent.locationX)}
          hitSlop={{ top: 12, bottom: 12 }}
          style={styles.track}
        >
          <View style={[styles.rail, { backgroundColor: c.sunken }]}>
            <View style={[styles.fill, { width: `${progress * 100}%`, backgroundColor: c.brand }]} />
          </View>
        </Pressable>
        {problem === "failed" ? (
          <Pressable accessibilityRole="button" onPress={load} hitSlop={6}>
            <T variant="caption" color={c.danger}>
              {t("detail.recordingFailed")} · {t("common:actions.tryAgain")}
            </T>
          </Pressable>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("detail.back15")}
        disabled={!loaded}
        hitSlop={8}
        onPress={() => {
          tap();
          void player.seekTo(Math.max(0, status.currentTime - 15));
        }}
        style={{ opacity: loaded ? 1 : 0.35 }}
      >
        <Icon name="gobackward" size={20} color={c.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  play: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  track: {
    height: 16,
    justifyContent: "center",
  },
  rail: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
  },
  fill: {
    height: 4,
    borderRadius: 2,
  },
});
