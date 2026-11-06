import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, type GestureResponderEvent, type ViewStyle } from "react-native";
import Animated, { FadeOut, ZoomIn } from "react-native-reanimated";
import type { AndroidInputEvent } from "@godmode/shared";
import { tap as haptic } from "./ui";
import { alpha, useColors } from "@/lib/theme";

const LONG_PRESS_MS = 550;
/** Finger travel (points) that turns a touch into a swipe. */
const SLOP = 8;

type Press = { x: number; y: number; pageX: number; pageY: number; at: number; held: boolean; timer: ReturnType<typeof setTimeout> | null };

/**
 * An Android phone's picture that takes touches like the phone itself, as the desktop's live view does with a mouse: tap,
 * hold for a long press, drag to swipe. Points go out in pixels of the picture (`frame`); the computer maps them to the
 * phone's screen. `scale` is points on screen per picture pixel.
 */
export function AndroidTouchSurface({
  frame,
  scale,
  onInput,
  style,
  children,
}: {
  frame: { width: number; height: number };
  scale: number;
  onInput: (event: AndroidInputEvent) => void;
  style: ViewStyle;
  children: ReactNode;
}) {
  const c = useColors();
  const press = useRef<Press | null>(null);
  const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null);
  useEffect(
    () => () => {
      if (press.current?.timer) clearTimeout(press.current.timer);
    },
    [],
  );

  const at = (x: number, y: number) => ({
    x: Math.round(Math.min(frame.width, Math.max(0, x / scale))),
    y: Math.round(Math.min(frame.height, Math.max(0, y / scale))),
  });
  const show = (x: number, y: number) => {
    const id = Date.now();
    setRipple({ x, y, id });
    setTimeout(() => setRipple((r) => (r?.id === id ? null : r)), 450);
  };
  const cancel = () => {
    if (press.current?.timer) clearTimeout(press.current.timer);
    press.current = null;
  };

  const grant = (e: GestureResponderEvent) => {
    const { locationX, locationY, pageX, pageY } = e.nativeEvent;
    const start: Press = { x: locationX, y: locationY, pageX, pageY, at: Date.now(), held: false, timer: null };
    start.timer = setTimeout(() => {
      if (press.current !== start) return;
      start.held = true;
      start.timer = null;
      haptic();
      show(start.x, start.y);
      onInput({ type: "long_press", ...at(start.x, start.y) });
    }, LONG_PRESS_MS);
    press.current = start;
  };

  const move = (e: GestureResponderEvent) => {
    const start = press.current;
    if (start?.timer && Math.hypot(e.nativeEvent.pageX - start.pageX, e.nativeEvent.pageY - start.pageY) > SLOP) {
      clearTimeout(start.timer);
      start.timer = null;
    }
  };

  const release = (e: GestureResponderEvent) => {
    const start = press.current;
    cancel();
    if (!start || start.held) return;
    // Page coordinates: the finger may end outside the picture, where location values stop meaning anything.
    const dx = e.nativeEvent.pageX - start.pageX;
    const dy = e.nativeEvent.pageY - start.pageY;
    const from = at(start.x, start.y);
    if (Math.hypot(dx, dy) > SLOP) {
      const to = at(start.x + dx, start.y + dy);
      show(start.x + dx, start.y + dy);
      onInput({ type: "swipe", ...from, toX: to.x, toY: to.y, durationMs: Math.min(2000, Math.max(80, Date.now() - start.at)) });
      return;
    }
    haptic();
    show(start.x, start.y);
    onInput({ type: "tap", ...from });
  };

  return (
    <View
      style={style}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={grant}
      onResponderMove={move}
      onResponderRelease={release}
      onResponderTerminate={cancel}
    >
      <View style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]}>{children}</View>
      {ripple ? <Animated.View key={ripple.id} entering={ZoomIn.duration(220)} exiting={FadeOut} style={[styles.ripple, { borderColor: c.brand, backgroundColor: alpha(c.brand, 0.25), left: ripple.x - 22, top: ripple.y - 22 }]} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  ripple: {
    position: "absolute",
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    pointerEvents: "none",
  },
});
