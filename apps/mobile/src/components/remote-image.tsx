import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, Text, View, type ImageStyle, type StyleProp } from "react-native";
import { Icon } from "./icon";
import { pictureBases } from "@/lib/api";
import { useSession } from "@/lib/session";
import { radius, space, type, useColors } from "@/lib/theme";

/**
 * A picture the computer serves (a task's attachment, a screenshot a tool took): loaded with this phone's key, from each
 * address in turn, and kept on disk so it loads once.
 */
export function RemoteImage({ path, alt, style }: { path: string; alt: string; style?: StyleProp<ImageStyle> }) {
  const c = useColors();
  const connection = useSession((s) => s.connection);
  const [ratio, setRatio] = useState(4 / 3);
  const [attempt, setAttempt] = useState(0);
  if (!connection) return null;
  const bases = pictureBases(connection);
  if (attempt >= bases.length) {
    return (
      <View style={[styles.missing, { backgroundColor: c.sunken }]}>
        <Icon name="photo" size={15} color={c.textFaint} />
        <Text style={[type.footnote, { color: c.textMuted, flexShrink: 1 }]} numberOfLines={1}>
          {alt || "Picture"} couldn't load
        </Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: bases[attempt] + path, headers: { authorization: `Bearer ${connection.token}` }, cacheKey: path }}
      onLoad={(e) => e.source.width && e.source.height && setRatio(Math.max(0.5, e.source.width / e.source.height))}
      onError={() => setAttempt((a) => a + 1)}
      accessibilityLabel={alt}
      contentFit="contain"
      cachePolicy="disk"
      transition={150}
      style={[styles.picture, { aspectRatio: ratio, backgroundColor: c.sunken }, style]}
    />
  );
}

const styles = StyleSheet.create({
  picture: {
    width: "100%",
    maxHeight: 420,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  missing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: space.md,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
});
