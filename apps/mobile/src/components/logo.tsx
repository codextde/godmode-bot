import { Image } from "expo-image";
import { View } from "react-native";
import { useIsDark } from "@/lib/theme";

const LOGO = require("../../assets/splash-icon.png");

/** The Godmode mark: a paper bolt on an anthracite tile. */
export function Logo({ size = 48 }: { size?: number }) {
  const dark = useIsDark();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        borderCurve: "continuous",
        overflow: "hidden",
        boxShadow: dark ? "0 0 0 1px rgba(255,250,240,0.12)" : "0 6px 18px -8px rgba(38,32,22,0.45)",
      }}
    >
      <Image source={LOGO} style={{ width: size * 1.067, height: size * 1.067, margin: -size * 0.0333 }} contentFit="cover" />
    </View>
  );
}
