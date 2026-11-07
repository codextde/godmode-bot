import type { ReactElement, ReactNode } from "react";
import { useKeyboardHandler } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { readableLayout } from "./readable";

/** Root screens that move their own content above the keyboard (or keep the keyboard over the tab bar). */
const OWN_KEYBOARD = new Set(["(tabs)", "chat/[id]", "artifact/[id]"]);

/**
 * Android draws the keyboard over the screen instead of making the screen shorter. The screen ends above the keyboard
 * here, in one step when the keyboard starts to move, so a scroll view keeps the field being typed in on screen.
 */
function KeyboardRoom({ children }: { children: ReactNode }) {
  const room = useSharedValue(0);
  useKeyboardHandler(
    {
      onStart: (e) => {
        "worklet";
        room.value = Math.max(0, e.height);
      },
    },
    [],
  );
  const style = useAnimatedStyle(() => ({ paddingBottom: room.value }));
  return <Animated.View style={[{ flex: 1 }, style]}>{children}</Animated.View>;
}

/** The root stack's `screenLayout`: the readable column, and on Android room for the keyboard on pushed screens. */
export function rootScreenLayout(props: { route: { name: string }; options: { presentation?: string }; children: ReactElement }) {
  const page = readableLayout(props);
  const presentation = props.options.presentation;
  if (process.env.EXPO_OS !== "android" || OWN_KEYBOARD.has(props.route.name)) return page;
  if (presentation !== undefined && presentation !== "card" && presentation !== "modal") return page;
  return <KeyboardRoom>{page}</KeyboardRoom>;
}
