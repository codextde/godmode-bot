import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { qrModules } from "@/lib/qr";

const MARGIN = 2;
const INK = "#1c1c1c";

/** A QR code, always dark on white so every camera reads it. */
export function QrCode({ value, size, label }: { value: string; size: number; label: string }) {
  const { path, count } = useMemo(() => {
    const modules = qrModules(value);
    let d = "";
    modules.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x + MARGIN} ${y + MARGIN}h1v1h-1z`)));
    return { path: d, count: modules.length + MARGIN * 2 };
  }, [value]);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg width={size} height={size} viewBox={`0 0 ${count} ${count}`}>
        <Rect x={0} y={0} width={count} height={count} fill="#ffffff" />
        <Path d={path} fill={INK} />
      </Svg>
    </View>
  );
}
