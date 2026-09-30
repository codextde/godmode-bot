import * as Haptics from "expo-haptics";
import { useEffect, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ColorValue,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { Glass } from "./glass";
import { Icon, type IconName } from "./icon";
import { radius, space, type, useColors } from "@/lib/theme";

type Variant = keyof typeof type;

export const SMOKE = "rgba(28, 28, 28, 0.78)";

export function T({
  variant = "body",
  color,
  style,
  muted,
  ...props
}: TextProps & { variant?: Variant; color?: ColorValue; muted?: boolean }) {
  const c = useColors();
  return <Text {...props} style={[type[variant] as TextStyle, { color: color ?? (muted ? c.textMuted : c.text) }, style]} />;
}

export function tap(style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) {
  void Haptics.impactAsync(style).catch(() => undefined);
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const c = useColors();
  const base: ViewStyle = { backgroundColor: c.surface, borderRadius: radius.lg, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, borderColor: c.border };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [base, pressed && { opacity: 0.72, transform: [{ scale: 0.985 }] }, style]}>
      {children}
    </Pressable>
  );
}

export function SectionTitle({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const c = useColors();
  return (
    <View style={styles.sectionTitle}>
      <T variant="eyebrow" muted>
        {title}
      </T>
      {action && onAction ? (
        <Pressable hitSlop={10} onPress={onAction}>
          <T variant="footnote" color={c.textMuted} style={{ fontWeight: "600" }}>
            {action}
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}

export function LiveDot({ live = true, color, size = 8 }: { live?: boolean; color?: ColorValue; size?: number }) {
  const c = useColors();
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = live ? withRepeat(withTiming(1, { duration: 1400, easing: Easing.out(Easing.quad) }), -1, false) : 0;
  }, [live, pulse]);
  const ring = useAnimatedStyle(() => ({ opacity: 0.55 * (1 - pulse.value), transform: [{ scale: 1 + pulse.value * 1.6 }] }));
  const fill = color ?? (live ? c.brand : c.textFaint);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {live && <Animated.View style={[{ position: "absolute", width: size, height: size, borderRadius: size, backgroundColor: fill }, ring]} />}
      <View style={{ width: size, height: size, borderRadius: size, backgroundColor: fill }} />
    </View>
  );
}

export function Badge({ label, tone = "neutral", live }: { label: string; tone?: "neutral" | "brand" | "warning" | "danger"; live?: boolean }) {
  const c = useColors();
  const tones = {
    neutral: { bg: c.sunken, fg: c.textMuted },
    brand: { bg: c.brandSoft, fg: c.brandStrong },
    warning: { bg: c.warningSoft, fg: c.warning },
    danger: { bg: c.dangerSoft, fg: c.danger },
  }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: tones.bg }]}>
      {live && <LiveDot size={6} color={tones.fg} />}
      <T variant="caption" color={tones.fg} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </View>
  );
}

/** An agent's emoji on a quiet tile. */
export function Avatar({ emoji, size = 40, running }: { emoji: string; size?: number; running?: boolean }) {
  const c = useColors();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.32,
        borderCurve: "continuous",
        backgroundColor: c.sunken,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontSize: size * 0.5 }}>{emoji || "🤖"}</Text>
      {running && (
        <View style={[styles.avatarDot, { borderColor: c.background, right: -2, bottom: -2 }]}>
          <LiveDot size={8} />
        </View>
      )}
    </View>
  );
}

export function Button({
  title,
  icon,
  onPress,
  variant = "primary",
  loading,
  disabled,
  style,
  size = "md",
  dark,
}: {
  /** Over pictures or black screens: dark glass, white text. */
  dark?: boolean;
  title: string;
  icon?: IconName;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "glass" | "danger";
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  size?: "md" | "lg";
}) {
  const c = useColors();
  const fg = dark ? "#FFFFFF" : variant === "primary" ? c.onPrimary : variant === "danger" ? c.danger : c.text;
  const height = size === "lg" ? 54 : 46;
  const content = (
    <View style={[styles.buttonInner, { height }]}>
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size={17} color={fg} weight="semibold" /> : null}
      <T variant="headline" color={fg} style={{ fontSize: 16 }}>
        {title}
      </T>
    </View>
  );
  const press = () => {
    tap();
    onPress?.();
  };
  if (variant === "glass") {
    return (
      <Pressable onPress={press} disabled={disabled || loading} style={({ pressed }) => [{ opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }, style]}>
        <Glass interactive scheme={dark ? "dark" : undefined} fallback={dark ? SMOKE : undefined} style={{ borderRadius: radius.pill }}>
          {content}
        </Glass>
      </Pressable>
    );
  }
  const bg = variant === "primary" ? c.primary : variant === "danger" ? c.dangerSoft : c.sunken;
  return (
    <Pressable
      onPress={press}
      disabled={disabled || loading}
      style={({ pressed }) => [
        { backgroundColor: bg, borderRadius: radius.pill, opacity: disabled ? 0.4 : pressed ? 0.82 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] },
        style,
      ]}
    >
      {content}
    </Pressable>
  );
}

/** A round glass button with a symbol, for floating controls. */
export function GlassIconButton({
  icon,
  onPress,
  size = 44,
  color,
  tint,
  label,
  disabled,
  dark,
}: {
  icon: IconName;
  onPress: () => void;
  size?: number;
  color?: ColorValue;
  tint?: ColorValue;
  label: string;
  disabled?: boolean;
  /** Over pictures or black screens: dark glass, white symbol. */
  dark?: boolean;
} & Pick<PressableProps, "hitSlop">) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.75 : 1 })}
    >
      <Glass
        interactive
        tint={tint}
        scheme={dark ? "dark" : undefined}
        fallback={dark ? SMOKE : undefined}
        style={{ width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name={icon} size={size * 0.4} color={color ?? (dark ? "#FFFFFF" : c.text)} weight="semibold" />
      </Glass>
    </Pressable>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: c.sunken }]}>
        <Icon name={icon} size={24} color={c.textMuted} />
      </View>
      <T variant="headline" style={{ textAlign: "center" }}>
        {title}
      </T>
      {body ? (
        <T variant="subhead" muted style={{ textAlign: "center", maxWidth: 300 }}>
          {body}
        </T>
      ) : null}
      {action ? <View style={{ marginTop: space.sm }}>{action}</View> : null}
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: "row", alignItems: "center" }, style]}>{children}</View>;
}

export function Hairline({ inset = 0 }: { inset?: number }) {
  const c = useColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: inset }} />;
}

const styles = StyleSheet.create({
  sectionTitle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: space.sm,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    alignSelf: "flex-start",
  },
  avatarDot: {
    position: "absolute",
    borderWidth: 2,
    borderRadius: 8,
  },
  buttonInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 22,
  },
  empty: {
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 36,
    paddingHorizontal: space.xl,
  },
  emptyIcon: {
    width: 52,
    height: 52,
    borderRadius: 18,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
});
