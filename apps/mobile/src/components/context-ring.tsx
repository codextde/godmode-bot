import { router } from "expo-router";
import { Pressable, StyleSheet } from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { ContextGauge } from "@godmode/shared";
import { T, tap } from "./ui";
import { useColors, type Colors } from "@/lib/theme";

export function toneColor(c: Colors, tone: ContextGauge["tone"]): string {
  return tone === "full" ? c.danger : tone === "warn" ? c.warning : c.textMuted;
}

export function Ring({ share, color, track, size = 18, stroke = 2.4 }: { share: number; color: string; track: string; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const len = 2 * Math.PI * r;
  return (
    <Svg width={size} height={size} style={{ transform: [{ rotate: "-90deg" }] }}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${len} ${len}`}
        strokeDashoffset={len * (1 - Math.max(0.04, share))}
      />
    </Svg>
  );
}

/** How full the chat's memory is, in the composer's toolbar; opens the Chat memory sheet. */
export function ContextRing({ gauge, conversationId }: { gauge: ContextGauge; conversationId: string }) {
  const c = useColors();
  const pct = gauge.share === null ? null : Math.round(gauge.share * 100);
  const color = toneColor(c, gauge.tone);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={pct === null ? "Chat memory" : `Chat memory ${pct}% full`}
      accessibilityHint="Shows how full this chat is and lets you compress it"
      hitSlop={6}
      onPress={() => {
        tap();
        router.push({ pathname: "/chat-memory", params: { conversationId } });
      }}
      style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Ring share={gauge.share ?? 0} color={color} track={c.border} />
      {gauge.tone !== "calm" && pct !== null ? (
        <T variant="footnote" color={color} style={{ fontWeight: "600", fontVariant: ["tabular-nums"] }}>
          {pct}%
        </T>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: "row", alignItems: "center", gap: 5, height: 36, paddingHorizontal: 6 },
});
