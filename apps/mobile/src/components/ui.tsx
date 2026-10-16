import * as Haptics from "expo-haptics";
import { useIsFocused } from "expo-router";
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
import Animated, { cancelAnimation, Easing, FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { Glass } from "./glass";
import { Icon, type IconName } from "./icon";
import { alpha, radius, space, type, useColors, withFont, type Colors } from "@/lib/theme";

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
  const flat = StyleSheet.flatten([type[variant] as TextStyle, { color: color ?? (muted ? c.textMuted : c.text) }, style]);
  return <Text {...props} style={withFont(flat)} />;
}

export function tap(style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) {
  void Haptics.impactAsync(style).catch(() => undefined);
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const c = useColors();
  const base: ViewStyle = {
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    boxShadow: c.shadowCard,
  };
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
          <T variant="footnote" color={c.textMuted} style={{ fontWeight: "500" }}>
            {action}
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Pulses like the desktop's live dot (a ring that fades out every 2s), only while its screen is in front. */
export function LiveDot({ live = true, color, size = 8 }: { live?: boolean; color?: ColorValue; size?: number }) {
  const c = useColors();
  const focused = useIsFocused();
  const pulse = useSharedValue(0);
  const moving = live && focused;
  useEffect(() => {
    if (!moving) return;
    pulse.value = withRepeat(withTiming(1, { duration: 2000, easing: Easing.out(Easing.quad) }), -1, false);
    return () => {
      cancelAnimation(pulse);
      pulse.value = 0;
    };
  }, [moving, pulse]);
  const ring = useAnimatedStyle(() => ({ opacity: 0.55 * Math.max(0, 1 - pulse.value * 1.25), transform: [{ scale: 1 + pulse.value * 1.8 }] }));
  const fill = color ?? (live ? c.brand : c.textFaint);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {live && <Animated.View style={[{ position: "absolute", width: size, height: size, borderRadius: size, backgroundColor: fill }, ring]} />}
      <View style={{ width: size, height: size, borderRadius: size, backgroundColor: fill }} />
    </View>
  );
}

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "amber" | "emerald" | "rose" | "sky" | "violet" | "dream";

/** A tone's text, fill, border and dot, like the desktop's tinted pills (fill 6–12%, border 20–30%). */
export function toneColors(c: Colors, tone: Tone): { fg: string; bg: string; border: string; dot: string } {
  switch (tone) {
    case "brand":
      return { fg: c.brandStrong, bg: c.brandSoft, border: alpha(c.brand, 0.25), dot: c.brand };
    case "success":
      return { fg: c.success, bg: c.successSoft, border: alpha(c.success, 0.2), dot: c.success };
    case "warning":
      return { fg: c.warning, bg: c.warningSoft, border: alpha(c.warning, 0.3), dot: c.warning };
    case "danger":
      return { fg: c.danger, bg: c.dangerSoft, border: alpha(c.danger, 0.2), dot: c.danger };
    case "amber":
      return { fg: c.amber, bg: alpha(c.amberMark, 0.1), border: alpha(c.amberMark, 0.3), dot: c.amberMark };
    case "emerald":
      return { fg: c.emerald, bg: alpha(c.emeraldMark, 0.1), border: alpha(c.emeraldMark, 0.25), dot: c.emeraldMark };
    case "rose":
      return { fg: c.rose, bg: alpha(c.roseMark, 0.1), border: alpha(c.roseMark, 0.25), dot: c.roseMark };
    case "sky":
      return { fg: c.sky, bg: alpha(c.skyMark, 0.1), border: alpha(c.skyMark, 0.25), dot: c.skyMark };
    case "violet":
      return { fg: c.violet, bg: alpha(c.violet, 0.1), border: alpha(c.violet, 0.25), dot: c.violet };
    case "dream":
      return { fg: c.dream, bg: c.dreamSoft, border: alpha(c.dream, 0.25), dot: c.dream };
    default:
      return { fg: c.textMuted, bg: c.sunken, border: c.border, dot: alpha(c.textMuted, 0.6) };
  }
}

/** The desktop's pill: 5px corners, a 1px tinted border, 11px medium text and a 6px dot (`icon` stands in for the dot). */
export function Badge({ label, tone = "neutral", live, icon, dot = true }: { label: string; tone?: Tone; live?: boolean; icon?: ReactNode; dot?: boolean }) {
  const c = useColors();
  const t = toneColors(c, tone);
  return (
    <View style={[styles.badge, { backgroundColor: t.bg, borderColor: t.border }]}>
      {icon ?? (dot ? live ? <LiveDot size={6} color={t.dot} /> : <View style={[styles.badgeDot, { backgroundColor: t.dot }]} /> : null)}
      <T variant="caption" color={t.fg} numberOfLines={1} style={styles.badgeText}>
        {label}
      </T>
    </View>
  );
}

/** Nobody is on it: the desktop's dashed square where an agent's face would be. */
export function UnassignedAvatar({ size = 40 }: { size?: number }) {
  const c = useColors();
  return (
    <View
      accessibilityLabel="Unassigned"
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(5, size * 0.25),
        borderCurve: "continuous",
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: alpha(c.textMuted, 0.4),
      }}
    />
  );
}

/** Kept for screens that still pass an emoji: a ticket without an agent shows the unassigned square, never an emoji. */
export function Avatar({ size = 40 }: { emoji?: string; size?: number; running?: boolean }) {
  return <UnassignedAvatar size={size} />;
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
  variant?: "primary" | "secondary" | "outline" | "glass" | "danger";
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  size?: "md" | "lg";
}) {
  const c = useColors();
  const fg = dark ? "#FFFFFF" : variant === "primary" ? c.onPrimary : variant === "danger" ? c.danger : c.text;
  const height = size === "lg" ? 48 : 44;
  const corner = size === "lg" ? 10 : radius.md;
  const content = (
    <View style={[styles.buttonInner, { height }]}>
      {loading ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size={16} color={fg} weight="medium" /> : null}
      <T variant="callout" color={fg} style={{ fontWeight: "500", letterSpacing: -0.1 }}>
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
      <Pressable onPress={press} disabled={disabled || loading} style={({ pressed }) => [{ opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }, style]}>
        <Glass interactive scheme={dark ? "dark" : undefined} fallback={dark ? SMOKE : undefined} style={{ borderRadius: corner, borderCurve: "continuous" }}>
          {content}
        </Glass>
      </Pressable>
    );
  }
  const bg = variant === "primary" ? c.primary : variant === "danger" ? c.dangerSoft : variant === "outline" ? c.surface : c.sunken;
  const outline: ViewStyle | null =
    variant === "outline" ? { borderWidth: 1, borderColor: c.input, boxShadow: c.shadowCard } : variant === "danger" ? { borderWidth: 1, borderColor: alpha(c.danger, 0.2) } : null;
  return (
    <Pressable
      onPress={press}
      disabled={disabled || loading}
      style={({ pressed }) => [
        { backgroundColor: bg, borderRadius: corner, borderCurve: "continuous", opacity: disabled ? 0.5 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] },
        outline,
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

/**
 * Nothing to show yet, like the desktop: a dashed box on a half-transparent card with a bordered icon tile, or `art`
 * (a character) in its place.
 */
export function EmptyState({
  icon,
  art,
  title,
  body,
  action,
  style,
}: {
  icon?: IconName;
  art?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  return (
    <Animated.View entering={FadeIn.duration(220)} style={[styles.empty, { borderColor: c.borderStrong, backgroundColor: alpha(c.surface, 0.5) }, style]}>
      {art ? (
        <View style={{ marginBottom: space.lg }}>{art}</View>
      ) : icon ? (
        <View style={[styles.emptyIcon, { backgroundColor: c.surface, borderColor: c.border, boxShadow: c.shadowCard }]}>
          <Icon name={icon} size={20} color={c.text} />
        </View>
      ) : null}
      <T variant="callout" style={{ textAlign: "center", fontSize: 16, fontWeight: "500", letterSpacing: -0.16 }}>
        {title}
      </T>
      {body ? (
        <T variant="subhead" muted style={{ textAlign: "center", maxWidth: 320, marginTop: 6 }}>
          {body}
        </T>
      ) : null}
      {action ? <View style={{ marginTop: space.xl }}>{action}</View> : null}
    </Animated.View>
  );
}

/** A placeholder block that breathes while its content loads. */
export function Skeleton({ width, height = 12, radius: r = radius.sm, style }: { width?: ViewStyle["width"]; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const focused = useIsFocused();
  const v = useSharedValue(0.55);
  useEffect(() => {
    if (!focused) return;
    v.value = withRepeat(withTiming(1, { duration: 850, easing: Easing.inOut(Easing.quad) }), -1, true);
    return () => cancelAnimation(v);
  }, [v, focused]);
  const pulse = useAnimatedStyle(() => ({ opacity: v.value }));
  return <Animated.View style={[{ width, height, borderRadius: r, borderCurve: "continuous", backgroundColor: c.sunken }, pulse, style]} />;
}

/** List rows while a list loads: the shape of what comes, so the screen is never blank. */
export function SkeletonRows({ count = 6, avatar = 44, inset = space.lg }: { count?: number; avatar?: number; inset?: number }) {
  return (
    <View accessibilityLabel="Loading" accessibilityRole="progressbar">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.skeletonRow, { paddingHorizontal: inset }]}>
          {avatar > 0 && <Skeleton width={avatar} height={avatar} radius={avatar * 0.32} />}
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width={`${62 - ((i * 17) % 26)}%`} height={14} />
            <Skeleton width={`${88 - ((i * 23) % 30)}%`} height={11} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** A whole screen waiting for its data. */
export function LoadingState({ label = "Loading…", style }: { label?: string; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return (
    <View style={[styles.loading, style]} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={c.textMuted} />
      <T variant="footnote" muted>
        {label}
      </T>
    </View>
  );
}

/** Loading failed: say why and offer to try again instead of an empty screen. */
export function ErrorState({ title, error, onRetry }: { title: string; error: string; onRetry?: () => void }) {
  return (
    <EmptyState
      icon="wifi"
      title={title}
      body={error}
      action={onRetry ? <Button title="Try again" icon="refresh" variant="outline" onPress={onRetry} /> : undefined}
    />
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
    gap: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.badge,
    borderCurve: "continuous",
    borderWidth: 1,
    alignSelf: "flex-start",
    flexShrink: 1,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "500",
  },
  buttonInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 18,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    marginHorizontal: space.lg,
    marginVertical: space.sm,
    paddingVertical: 48,
    paddingHorizontal: space.xl,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: 1,
    borderStyle: "dashed",
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
  },
  loading: {
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    paddingVertical: 48,
  },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.lg,
  },
});
