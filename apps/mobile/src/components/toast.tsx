import { useEffect } from "react";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";
import { create } from "zustand";
import { Glass } from "./glass";
import { Icon } from "./icon";
import { T } from "./ui";
import { space, useColors } from "@/lib/theme";

const SHOWN_MS = 1800;
const LEAVING_MS = 220;

const useToast = create<{ text: string | null; visible: boolean; id: number }>(() => ({ text: null, visible: false, id: 0 }));

/** A one-line confirmation that goes by itself, for an action whose result happens somewhere else. */
export function showToast(text: string) {
  useToast.setState((s) => ({ text, visible: true, id: s.id + 1 }));
  AccessibilityInfo.announceForAccessibility(text);
}

/** Above everything, sheets included. Mounted only while it shows: the overlay sits over the whole app. */
export function Toast() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { text, visible, id } = useToast();
  useEffect(() => {
    if (!id) return;
    const hide = setTimeout(() => useToast.setState({ visible: false }), SHOWN_MS);
    const clear = setTimeout(() => useToast.setState({ text: null }), SHOWN_MS + LEAVING_MS);
    return () => {
      clearTimeout(hide);
      clearTimeout(clear);
    };
  }, [id]);
  if (!text) return null;
  const toast = (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: "center", paddingTop: insets.top + space.sm }]}>
      {visible ? (
        <Animated.View entering={FadeInUp.duration(180)} exiting={FadeOutUp.duration(LEAVING_MS)}>
          <Glass style={styles.pill} fallback={c.surface}>
            <Icon name="check" size={14} color={c.brandStrong} weight="bold" />
            <T variant="subhead" style={{ fontWeight: "500" }}>
              {text}
            </T>
          </Glass>
        </Animated.View>
      ) : null}
    </View>
  );
  return process.env.EXPO_OS === "ios" ? <FullWindowOverlay>{toast}</FullWindowOverlay> : toast;
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    borderRadius: 999,
    borderCurve: "continuous",
  },
});
