import { router } from "expo-router";
import { Pressable, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import Svg, { Circle, Path } from "react-native-svg";
import type { ContextGauge } from "@godmode/shared";
import { T, tap } from "./ui";
import { useColors, type Colors } from "@/lib/theme";

export function toneColor(c: Colors, tone: ContextGauge["tone"]): string {
  return tone === "full" ? c.danger : tone === "warn" ? c.warning : c.textMuted;
}

/** A filled wedge, so it reads as a meter rather than a spinner. */
export function Pie({ share, color, track, size = 16 }: { share: number; color: string; track: string; size?: number }) {
  const mid = size / 2;
  const r = mid - 2.25;
  const part = Math.min(1, Math.max(0.04, share));
  const angle = part * 2 * Math.PI;
  const x = mid + r * Math.sin(angle);
  const y = mid - r * Math.cos(angle);
  return (
    <Svg width={size} height={size}>
      <Circle cx={mid} cy={mid} r={mid - 0.75} stroke={track} strokeWidth={1.5} fill="none" />
      {part >= 1 ? (
        <Circle cx={mid} cy={mid} r={r} fill={color} />
      ) : (
        <Path d={`M ${mid} ${mid} L ${mid} ${mid - r} A ${r} ${r} 0 ${part > 0.5 ? 1 : 0} 1 ${x} ${y} Z`} fill={color} />
      )}
    </Svg>
  );
}

/** How full the chat's memory is, in the composer's toolbar; opens the Chat memory sheet. */
export function ContextRing({ gauge, conversationId }: { gauge: ContextGauge; conversationId: string }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const pct = gauge.share === null ? null : Math.round(gauge.share * 100);
  const color = toneColor(c, gauge.tone);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={pct === null ? t("contextRing.label") : t("contextRing.labelFull", { pct })}
      accessibilityHint={t("contextRing.hint")}
      hitSlop={6}
      onPress={() => {
        tap();
        router.push({ pathname: "/chat-memory", params: { conversationId } });
      }}
      style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Pie share={gauge.share ?? 0} color={color} track={gauge.tone === "calm" ? c.textFaint : color} />
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
