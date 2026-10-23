import { useState } from "react";
import { type LayoutRectangle, Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, withSpring } from "react-native-reanimated";
import { LiveDot, T, tap } from "./ui";
import { alpha, radius, useColors } from "@/lib/theme";

export interface SegmentedTab<V extends string> {
  value: V;
  label: string;
  /** A count pill after the label. */
  count?: number;
  /** brand: something works (pulsing dot), warning: someone waits for you. */
  tone?: "brand" | "warning" | "neutral";
  /** A small dot instead of a count: new replies (brand) or waiting for you (warning). */
  dot?: "brand" | "warning" | null;
  accessibilityHint?: string;
}

const SPRING = { stiffness: 460, damping: 36, mass: 1 };

/** The desktop's segmented tab bar: one row of equal tabs with a sliding pill under the picked one. */
export function SegmentedTabs<V extends string>({ tabs, value, onChange, label }: { tabs: readonly SegmentedTab<V>[]; value: V; onChange: (next: V) => void; label: string }) {
  const c = useColors();
  const [frames, setFrames] = useState<Partial<Record<V, LayoutRectangle>>>({});
  const frame = frames[value];
  const pill = useAnimatedStyle(() =>
    frame ? { opacity: 1, transform: [{ translateX: withSpring(frame.x, SPRING) }], width: withSpring(frame.width, SPRING) } : { opacity: 0 },
  );

  return (
    <View accessibilityRole="tablist" accessibilityLabel={label} style={[styles.list, { backgroundColor: alpha(c.sunken, 0.7), borderColor: c.border }]}>
      <Animated.View pointerEvents="none" style={[styles.pill, { backgroundColor: c.surface, borderColor: c.border }, pill]} />
      {tabs.map((t) => {
        const active = t.value === value;
        const pillTone = t.tone === "warning" ? c.warning : t.tone === "brand" ? c.brandStrong : active ? c.text : c.textMuted;
        return (
          <Pressable
            key={t.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityHint={t.accessibilityHint}
            hitSlop={{ top: 6, bottom: 6 }}
            onLayout={(e) => {
              const next = e.nativeEvent.layout;
              setFrames((prev) => (prev[t.value]?.x === next.x && prev[t.value]?.width === next.width ? prev : { ...prev, [t.value]: next }));
            }}
            onPress={() => {
              if (active) return;
              tap();
              onChange(t.value);
            }}
            style={styles.tab}
          >
            <T variant="footnote" numberOfLines={1} color={active ? c.text : c.textMuted} style={{ fontWeight: "600", flexShrink: 1 }}>
              {t.label}
            </T>
            {t.count ? (
              <View style={[styles.count, { backgroundColor: alpha(pillTone, t.tone && t.tone !== "neutral" ? 0.14 : 0.08) }]}>
                {t.tone === "brand" && <LiveDot size={4} color={pillTone} />}
                <T variant="caption" color={pillTone} style={styles.countText}>
                  {t.count}
                </T>
              </View>
            ) : t.dot && !active ? (
              <View style={[styles.dot, { backgroundColor: t.dot === "warning" ? c.warning : c.brandStrong }]} />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    flexDirection: "row",
    padding: 2,
    gap: 1,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  pill: {
    position: "absolute",
    top: 2,
    bottom: 2,
    left: 0,
    borderRadius: 10,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  tab: {
    flex: 1,
    minWidth: 0,
    height: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 6,
  },
  count: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: radius.pill,
    justifyContent: "center",
  },
  countText: {
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    fontSize: 11,
    lineHeight: 13,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
