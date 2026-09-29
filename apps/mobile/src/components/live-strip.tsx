import { Image } from "expo-image";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { Glass } from "./glass";
import { Icon } from "./icon";
import { frameUri } from "./screen-tile";
import { LiveDot, T, tap } from "./ui";
import { activityText, hostOf } from "@/lib/format";
import { screenHref, useStreamFrame, useVmFrame, type LiveScreen } from "@/lib/screens";
import { radius, space, useColors } from "@/lib/theme";

/** While the agent works: what it's doing and a live thumbnail of where, above the composer. */
export function LiveStrip({ screen, activity }: { screen: LiveScreen; activity: string | null }) {
  const c = useColors();
  const stream = useStreamFrame(screen.kind === "vm" ? null : screen);
  const vm = useVmFrame(screen.kind === "vm" ? screen.vm : null, true, 4000);
  const frame = screen.kind === "vm" ? vm.data : stream;
  const uri = frameUri(frame);
  const where = screen.kind === "browser" ? hostOf(frame?.url) || screen.title : screen.title;

  return (
    <Animated.View entering={FadeInDown.springify().damping(18)} exiting={FadeOutDown.duration(150)} style={styles.wrap}>
      <Pressable
        onPress={() => {
          tap();
          router.push(screenHref(screen));
        }}
      >
        <Glass interactive style={styles.strip} fallback={c.surface}>
          <View style={[styles.thumb, { backgroundColor: c.sunken }]}>
            {uri ? (
              <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" contentPosition="top" transition={0} />
            ) : (
              <Icon name={screen.kind === "vm" ? "vm" : screen.kind === "share" ? "display" : "globe"} size={16} color={c.textFaint} />
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="footnote" numberOfLines={1} style={{ fontWeight: "600" }}>
              {activityText(activity)}
            </T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <LiveDot size={6} />
              <T variant="caption" muted numberOfLines={1}>
                {where}
              </T>
            </View>
          </View>
          <T variant="footnote" muted style={{ fontWeight: "600" }}>
            Watch
          </T>
          <Icon name="chevron" size={12} color={c.textFaint} />
        </Glass>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.md,
  },
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: 8,
    paddingRight: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
  },
  thumb: {
    width: 64,
    height: 40,
    borderRadius: 9,
    borderCurve: "continuous",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
});
