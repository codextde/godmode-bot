import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { alpha, useColors } from "@/lib/theme";

/** A tappable list row: tinted while pressed on iOS, with the system's ripple on Android. */
export function RowPressable({ style, ...props }: Omit<PressableProps, "style"> & { style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  if (process.env.EXPO_OS === "android") return <Pressable android_ripple={{ color: alpha(c.text, 0.1) }} style={style} {...props} />;
  return <Pressable style={({ pressed }) => [style, pressed && { backgroundColor: c.sunken }]} {...props} />;
}
