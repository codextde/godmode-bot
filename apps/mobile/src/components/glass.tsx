import { GlassContainer, GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { StyleSheet, View, type ColorValue, type StyleProp, type ViewStyle } from "react-native";
import { useColors } from "@/lib/theme";

export const liquidGlass = process.env.EXPO_OS === "ios" && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

/**
 * Liquid Glass on iOS 26; a solid, softly bordered surface everywhere else (Android, older iOS, Reduce Transparency).
 */
export function Glass({
  children,
  style,
  interactive,
  tint,
  clear,
  fallback,
  scheme,
}: {
  /** Force the glass's appearance, e.g. dark over pictures. */
  scheme?: "light" | "dark";
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  interactive?: boolean;
  tint?: ColorValue;
  clear?: boolean;
  /** Surface color without Liquid Glass (default: the theme's floating surface). */
  fallback?: ColorValue;
}) {
  const c = useColors();
  if (liquidGlass) {
    return (
      <GlassView
        style={style}
        isInteractive={interactive}
        tintColor={tint as string | undefined}
        glassEffectStyle={clear ? "clear" : "regular"}
        colorScheme={scheme ?? "auto"}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View style={[{ backgroundColor: tint ?? fallback ?? c.glassFallback, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth }, style]}>
      {children}
    </View>
  );
}

/** Groups glass shapes so they blend into each other as they come close (iOS 26). */
export function GlassGroup({ children, style, spacing = 10 }: { children: ReactNode; style?: StyleProp<ViewStyle>; spacing?: number }) {
  if (liquidGlass) {
    return (
      <GlassContainer spacing={spacing} style={style}>
        {children}
      </GlassContainer>
    );
  }
  return <View style={style}>{children}</View>;
}
