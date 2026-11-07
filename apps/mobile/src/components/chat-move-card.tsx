import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeInDown, FadeOutDown, useAnimatedStyle, withTiming } from "react-native-reanimated";
import type { ChatMove } from "@godmode/shared";
import { Icon } from "./icon";
import { T } from "./ui";
import { hideChatMove, useChatMoves, type MoveOnItsWay } from "@/lib/chat-moves";
import { radius, space, useColors } from "@/lib/theme";

const MB = 1024 * 1024;

function size(n: number): string {
  if (n < MB) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min`;
}

/** Copy speed from the first bytes of the copy on, once there is enough to tell. */
function useRate(move: ChatMove | null, now: number): number | null {
  const [first, setFirst] = useState<{ at: number; bytes: number } | null>(null);
  if (move?.stage !== "copying") {
    if (first) setFirst(null);
    return null;
  }
  if (!first) {
    if (move.bytes > 0) setFirst({ at: now, bytes: move.bytes });
    return null;
  }
  const seconds = (now - first.at) / 1000;
  return seconds >= 1.5 ? (move.bytes - first.bytes) / seconds : null;
}

/** Above the composer while this chat moves to another computer: stage, copied so far, time left. Like the desktop's corner card. */
export function ChatMoveCard({ conversationId }: { conversationId: string }) {
  const moving = useChatMoves((s) => s.moves[conversationId]);
  if (!moving || moving.hidden) return null;
  return <Card conversationId={conversationId} moving={moving} />;
}

function Card({ conversationId, moving }: { conversationId: string; moving: MoveOnItsWay }) {
  const c = useColors();
  const { t } = useTranslation("chat");
  const { move, dest, agentName, finishing, startedAt } = moving;
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const rate = useRate(move, now);

  const percent = move?.stage === "copying" && move.total ? Math.min(100, (move.bytes / move.total) * 100) : finishing || move?.stage === "saving" || move?.stage === "continuing" ? 100 : null;
  const left = move?.stage === "copying" && move.total && rate ? (move.total - move.bytes) / rate : null;

  const detail = finishing
    ? t("move.almost")
    : !move
      ? t("move.starting")
      : move.stage === "checking"
        ? t("move.checking", { from: move.from })
        : move.stage === "copying"
          ? move.total
            ? t("move.copyingOf", { done: size(move.bytes), total: size(move.total) })
            : t("move.copying", { done: size(move.bytes) })
          : move.stage === "sending"
            ? t("move.sending", { to: move.to })
            : move.stage === "saving"
              ? t("move.saving", { dest })
              : t("move.continuing", { name: agentName });

  const bar = useAnimatedStyle(() => ({ width: withTiming(`${Math.max(4, percent ?? 33)}%`, { duration: 300 }) }));

  return (
    <Animated.View entering={FadeInDown.duration(180)} exiting={FadeOutDown.duration(140)} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]} accessibilityRole="progressbar" accessibilityLiveRegion="polite">
      <View style={styles.head}>
        <Icon name="laptop" size={15} color={c.brandStrong} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="footnote" numberOfLines={1} style={{ fontWeight: "600" }}>
            {t("move.movingTo", { dest })}
          </T>
          <T variant="caption" muted numberOfLines={1} style={styles.numbers}>
            {detail}
          </T>
        </View>
        <T variant="caption" muted style={styles.numbers}>
          {left !== null ? t("move.left", { time: clock(left), rate: size(rate!) }) : clock((now - startedAt) / 1000)}
        </T>
        <Pressable accessibilityRole="button" accessibilityLabel={t("move.hide")} hitSlop={10} onPress={() => hideChatMove(conversationId)}>
          <Icon name="close" size={12} weight="semibold" color={c.textFaint} />
        </Pressable>
      </View>
      <View style={[styles.track, { backgroundColor: c.sunken }]}>
        <Animated.View style={[styles.fill, { backgroundColor: c.brand }, bar]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 10, marginHorizontal: space.lg, marginBottom: space.sm, padding: space.md, borderRadius: radius.lg, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  numbers: { fontVariant: ["tabular-nums"] },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
});
