import * as LocalAuthentication from "expo-local-authentication";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { Logo } from "./logo";
import { Button, T } from "./ui";
import { useSession } from "@/lib/session";
import { space, useColors } from "@/lib/theme";

const RELOCK_AFTER_MS = 30_000;

/** With "Require Face ID" on: covers the app in the app switcher and asks again after 30 s away. */
export function AppLock() {
  const enabled = useSession((s) => s.appLock && !!s.connection);
  const [locked, setLocked] = useState(enabled);
  const [covered, setCovered] = useState(false);
  const leftAt = useRef<number | null>(null);
  const c = useColors();

  const unlock = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock Godmode", disableDeviceFallback: false });
    if (result.success) setLocked(false);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLocked(false);
      return;
    }
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
    if (locked) void unlock();
  }, [locked, unlock]);

  if (!enabled || (!locked && !covered)) return null;
  return (
    <Animated.View exiting={FadeOut.duration(180)} style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: c.background }]}>
      <Logo size={64} />
      {locked && (
        <View style={{ alignItems: "center", gap: space.lg }}>
          <T variant="headline">Godmode is locked</T>
          <Button title="Unlock" icon="faceid" onPress={() => void unlock()} />
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  cover: {
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
    zIndex: 100,
  },
});
