import { Image } from "expo-image";
import { router, useIsFocused } from "expo-router";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Glass } from "./glass";
import { Icon, type IconName } from "./icon";
import { LiveDot, T, tap } from "./ui";
import type { Frame } from "@/lib/live";
import { hostOf } from "@/lib/format";
import { isLive, screenHref, useStreamFrame, useVmFrame, type LiveScreen } from "@/lib/screens";
import { radius, space, useColors } from "@/lib/theme";

const LABEL_MUTED = "rgba(255, 255, 255, 0.72)";
const KIND_ICON: Record<LiveScreen["kind"], IconName> = { browser: "globe", vm: "vm", share: "display" };

export function frameUri(frame: Frame | undefined): string | undefined {
  return frame && frame.data ? `data:${frame.mime};base64,${frame.data}` : undefined;
}

/** A live picture of a browser, VM or shared screen with its name on a glass label. */
export function ScreenTile({ screen, style, compact }: { screen: LiveScreen; style?: StyleProp<ViewStyle>; compact?: boolean }) {
  const c = useColors();
  const focused = useIsFocused();
  const live = isLive(screen);
  const stream = useStreamFrame(screen.kind === "vm" ? null : screen, focused && live);
  const vmShot = useVmFrame(screen.kind === "vm" ? screen.vm : null, focused && live, compact ? 5000 : 3000);
  const frame = screen.kind === "vm" ? vmShot.data : stream;
  const uri = frameUri(frame);
  const subtitle =
    screen.kind === "browser"
      ? live
        ? hostOf(frame?.url) || "Idle"
        : "Not running"
      : screen.kind === "vm"
        ? vmState(screen.vm.state)
        : "Shared in a chat";

  return (
    <Pressable
      onPress={() => {
        tap();
        router.push(screenHref(screen));
      }}
      style={({ pressed }) => [styles.tile, { backgroundColor: c.sunken, opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.985 : 1 }] }, style]}
    >
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" contentPosition="top" transition={0} />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.placeholder]}>
          <Icon name={KIND_ICON[screen.kind]} size={compact ? 22 : 28} color={c.textFaint} />
        </View>
      )}
      <View style={styles.labelWrap}>
        <Glass style={styles.label} scheme="dark" fallback="rgba(20, 20, 20, 0.72)">
          {live ? <LiveDot size={7} /> : <Icon name={KIND_ICON[screen.kind]} size={12} color={LABEL_MUTED} />}
          <View style={{ flexShrink: 1 }}>
            <T variant="caption" color="#FFFFFF" numberOfLines={1} style={{ fontWeight: "600" }}>
              {screen.title}
            </T>
            {!compact && (
              <T variant="caption" color={LABEL_MUTED} numberOfLines={1} style={{ fontSize: 11 }}>
                {subtitle}
              </T>
            )}
          </View>
        </Glass>
      </View>
    </Pressable>
  );
}

export function vmState(state: string): string {
  return (
    { running: "Running", stopped: "Stopped", suspended: "Paused", starting: "Starting…", stopping: "Stopping…", creating: "Setting up…", error: "Needs attention" }[
      state
    ] ?? state
  );
}

const styles = StyleSheet.create({
  tile: {
    aspectRatio: 16 / 10,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
  },
  labelWrap: {
    position: "absolute",
    left: space.sm,
    right: space.sm,
    bottom: space.sm,
    flexDirection: "row",
  },
  label: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    maxWidth: "100%",
  },
});
