import type { ReactNode } from "react";
import { ScrollView, type ScrollViewProps, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";

/** Below this a pinch counts as back to normal size. */
const NORMAL = 1.02;

/** expo-image props for a picture in a ZoomView: Android decodes to the view's size unless told, which looks soft when zoomed. */
export const zoomImage = { allowDownscaling: process.env.EXPO_OS !== "android" };

/**
 * Something to pinch: iOS zooms the scroll view itself. `maximumZoomScale` does nothing on Android, so it gets pinch,
 * dragging while zoomed and double tap here. `held` turns true when a scroller around it must keep still (two fingers or
 * a zoomed picture), or it takes the pinch for itself: on the UI thread, the JS one comes too late for that.
 */
export function ZoomView({ max, held, children, ...scroll }: ScrollViewProps & { max: number; held?: SharedValue<boolean>; children: ReactNode }) {
  if (process.env.EXPO_OS !== "android" || max <= 1) {
    return (
      <ScrollView maximumZoomScale={max} minimumZoomScale={1} {...scroll}>
        {children}
      </ScrollView>
    );
  }
  return (
    <AndroidZoom max={max} held={held} style={scroll.style} contentStyle={scroll.contentContainerStyle}>
      {children}
    </AndroidZoom>
  );
}

function AndroidZoom({
  max,
  held,
  style,
  contentStyle,
  children,
}: {
  max: number;
  held?: SharedValue<boolean>;
  style: ScrollViewProps["style"];
  contentStyle: ScrollViewProps["contentContainerStyle"];
  children: ReactNode;
}) {
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const start = useSharedValue({ scale: 1, x: 0, y: 0 });
  const box = useSharedValue({ width: 0, height: 0 });

  const inside = (at: number, length: number, zoom: number) => {
    "worklet";
    const limit = (length * (zoom - 1)) / 2;
    return Math.min(limit, Math.max(-limit, at));
  };
  const hold = (on: boolean) => {
    "worklet";
    if (held) held.set(on);
  };
  const reset = () => {
    "worklet";
    scale.set(withTiming(1));
    x.set(withTiming(0));
    y.set(withTiming(0));
    hold(false);
  };

  const pinch = Gesture.Pinch()
    .onTouchesDown((e) => {
      if (e.numberOfTouches >= 2) hold(true);
    })
    .onStart(() => {
      start.set({ scale: scale.get(), x: x.get(), y: y.get() });
    })
    .onUpdate((e) => {
      const next = Math.min(max, Math.max(1, start.get().scale * e.scale));
      scale.set(next);
      x.set(inside(x.get(), box.get().width, next));
      y.set(inside(y.get(), box.get().height, next));
    })
    .onFinalize(() => {
      if (scale.get() < NORMAL) reset();
    });
  // Takes over only while zoomed: at normal size a swipe stays with what is around it, like the pager of pictures.
  const pan = Gesture.Pan()
    .manualActivation(true)
    .onTouchesMove((_, state) => {
      if (scale.get() >= NORMAL) state.activate();
      else state.fail();
    })
    .onStart(() => {
      start.set({ scale: scale.get(), x: x.get(), y: y.get() });
    })
    .onUpdate((e) => {
      x.set(inside(start.get().x + e.translationX, box.get().width, scale.get()));
      y.set(inside(start.get().y + e.translationY, box.get().height, scale.get()));
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.get() >= NORMAL) return reset();
      scale.set(withTiming(Math.min(max, 2.5)));
      hold(true);
    });
  const content = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }] }));

  return (
    <View
      style={[{ flex: 1, overflow: "hidden" }, style]}
      onLayout={(e) => {
        box.set({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
      }}
    >
      <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
        <Animated.View collapsable={false} style={[{ flex: 1 }, contentStyle, content]}>
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
