import { Image } from "expo-image";
import { router, useIsFocused } from "expo-router";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import type { AndroidDevice } from "@godmode/shared";
import { Glass } from "./glass";
import { Icon, type IconName } from "./icon";
import { LiveDot, T, tap } from "./ui";
import type { Frame } from "@/lib/live";
import { hostOf } from "@/lib/format";
import { t } from "@/lib/i18n";
import { isLive, screenHref, useAndroidFrame, useStreamFrame, useVmFrame, type LiveScreen } from "@/lib/screens";
import { radius, space, useColors } from "@/lib/theme";

const LABEL_MUTED = "rgba(255, 255, 255, 0.72)";
const KIND_ICON: Record<LiveScreen["kind"], IconName> = { browser: "globe", vm: "vm", share: "display", android: "phone" };
const VM_STATES = ["running", "stopped", "suspended", "starting", "stopping", "creating", "error"] as const;

export function frameUri(frame: Frame | undefined): string | undefined {
  return frame && frame.data ? `data:${frame.mime};base64,${frame.data}` : undefined;
}

/** A live picture of a browser, VM or shared screen with its name on a glass label. */
export function ScreenTile({ screen, style, compact }: { screen: LiveScreen; style?: StyleProp<ViewStyle>; compact?: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const focused = useIsFocused();
  const live = isLive(screen);
  const stream = useStreamFrame(screen, focused && live);
  const vmShot = useVmFrame(screen.kind === "vm" ? screen.vm : null, focused && live, compact ? 5000 : 3000);
  // A phone agents use shows its screen: live while one is on it, else one picture when the tab opens.
  const phone = screen.kind === "android" && (screen.device.busy || screen.device.assignments.length > 0) ? screen.device : null;
  const phoneShot = useAndroidFrame(phone, focused, live ? 3000 : false);
  const frame = screen.kind === "vm" ? vmShot.data : screen.kind === "android" ? phoneShot.data : stream;
  const uri = frameUri(frame);
  const subtitle =
    screen.kind === "browser"
      ? live
        ? hostOf(frame?.url) || t("screenTile.idle")
        : t("screenTile.notRunning")
      : screen.kind === "vm"
        ? vmState(screen.vm.state)
        : screen.kind === "android"
          ? phoneState(screen.device)
          : t("screenTile.sharedInChat");

  return (
    <Pressable
      onPress={() => {
        tap();
        router.push(screenHref(screen));
      }}
      style={({ pressed }) => [styles.tile, { backgroundColor: c.sunken, opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.985 : 1 }] }, style]}
    >
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" contentPosition="top" transition={0} cachePolicy="none" />
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

export function phoneState(device: AndroidDevice): string {
  if (device.state !== "connected") return device.state === "unauthorized" ? t("components:screenTile.phone.waitingForOk") : t("components:screenTile.phone.notConnected");
  return device.busy ? t("components:screenTile.phone.agentOnIt") : device.awake === false ? t("components:screenTile.phone.screenOff") : t("components:screenTile.phone.connected");
}

export function vmState(state: string): string {
  const known = VM_STATES.find((s) => s === state);
  return known ? t(`components:screenTile.vm.${known}`) : state;
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
