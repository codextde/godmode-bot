import * as LocalAuthentication from "expo-local-authentication";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeOut } from "react-native-reanimated";
import { FullWindowOverlay } from "react-native-screens";
import { Logo } from "./logo";
import { Button, T } from "./ui";
import { useSession } from "@/lib/session";
import { space, useColors } from "@/lib/theme";

const RELOCK_AFTER_MS = 30_000;

/** With "Require Face ID" on: covers the app in the app switcher and asks again after 30 s away. */
export function AppLock() {
  const enabled = useSession((s) => s.appLock && !!s.connection);
  const [locked, setLocked] = useState(enabled);
  const [wasEnabled, setWasEnabled] = useState(enabled);
  const [covered, setCovered] = useState(false);
  const leftAt = useRef<number | null>(null);
  const c = useColors();
  const { t } = useTranslation("components");

  if (enabled !== wasEnabled) {
    setWasEnabled(enabled);
    if (!enabled) setLocked(false);
  }

  const prompt = t("appLock.prompt");
  const unlock = useCallback(() => {
    void LocalAuthentication.authenticateAsync({ promptMessage: prompt, disableDeviceFallback: false }).then((result) => {
      if (result.success) setLocked(false);
    });
  }, [prompt]);

  useEffect(() => {
    if (!enabled) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setCovered(false);
        if (leftAt.current && Date.now() - leftAt.current > RELOCK_AFTER_MS) setLocked(true);
        leftAt.current = null;
      } else {
        setCovered(true);
        leftAt.current ??= Date.now();
      }
    });
    return () => sub.remove();
  }, [enabled]);

  useEffect(() => {
    if (locked) unlock();
  }, [locked, unlock]);

  if (!enabled || (!locked && !covered)) return null;
  const ios = process.env.EXPO_OS === "ios";
  const cover = (
    <Animated.View exiting={ios ? undefined : FadeOut.duration(180)} style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: c.background }]}>
      <Logo size={64} />
      {locked && (
        <View style={{ alignItems: "center", gap: space.lg }}>
          <T variant="headline">{t("appLock.locked")}</T>
          <Button title={t("appLock.unlock")} icon="faceid" onPress={unlock} />
        </View>
      )}
    </Animated.View>
  );
  // iOS presents sheets and modals natively, above the app's own views: the cover goes on top of the window, only while it's needed.
  return ios ? <FullWindowOverlay unstable_accessibilityContainerViewIsModal>{cover}</FullWindowOverlay> : cover;
}

const styles = StyleSheet.create({
  cover: {
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
    zIndex: 100,
  },
});
