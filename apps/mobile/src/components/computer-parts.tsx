import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router, useIsFocused } from "expo-router";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { computerView, type ComputerDisplay, type ComputerTarget } from "@godmode/shared";
import { Glass } from "./glass";
import { Icon, type IconName } from "./icon";
import { T, tap } from "./ui";
import { displayTarget, machinesApi, mk, sourceHref } from "@/lib/machines";
import { radius, space, useColors } from "@/lib/theme";

const LABEL_MUTED = "rgba(255, 255, 255, 0.72)";

/** What can be watched on this computer, asked again every few seconds while the screen is in front. */
export function useComputerSources(enabled: boolean) {
  const focused = useIsFocused();
  return useQuery({
    queryKey: mk.computerSources,
    queryFn: machinesApi.computer.sources,
    enabled,
    refetchInterval: focused ? 10_000 : false,
    retry: false,
  });
}

/** One of the computer's displays. */
export function DisplayTile({ display, style }: { display: ComputerDisplay; style?: StyleProp<ViewStyle> }) {
  const { t } = useTranslation("machines");
  const size = `${Math.round(display.width)} × ${Math.round(display.height)}`;
  return <ScreenTile target={displayTarget(display)} icon="display" title={display.name} detail={display.primary ? `${size} · ${t("computer.main")}` : size} style={style} />;
}

/** All displays in one picture, when there are several. */
export function DesktopTile({ count, style }: { count: number; style?: StyleProp<ViewStyle> }) {
  const { t } = useTranslation("machines");
  return <ScreenTile target={{ kind: "desktop" }} icon="layers" title={t("computer.entireDesktop")} detail={t("computer.displayCount", { count })} style={style} />;
}

/** A picture of what the target shows every few seconds, opened live with a tap. */
function ScreenTile({ target, icon, title, detail, style }: { target: ComputerTarget; icon: IconName; title: string; detail: string; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const focused = useIsFocused();
  const view = computerView(target);
  const shot = useQuery({
    queryKey: mk.thumbnail(view),
    queryFn: () => machinesApi.computer.thumbnail(view, 640),
    enabled: focused,
    refetchInterval: focused ? 8_000 : false,
    staleTime: 8_000,
    placeholderData: (prev) => prev,
    retry: false,
  });
  const uri = shot.data ? `data:${shot.data.mime};base64,${shot.data.data}` : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => {
        tap();
        router.push(sourceHref(target));
      }}
      style={({ pressed }) => [styles.tile, { backgroundColor: c.sunken, opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.985 : 1 }] }, style]}
    >
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" contentPosition="top" transition={150} cachePolicy="none" />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.placeholder]}>
          <Icon name={icon} size={26} color={c.textFaint} />
        </View>
      )}
      <View style={styles.labelWrap}>
        <Glass style={styles.label} scheme="dark" fallback="rgba(20, 20, 20, 0.72)">
          <Icon name={icon} size={12} color={LABEL_MUTED} />
          <View style={{ flexShrink: 1 }}>
            <T variant="caption" color="#FFFFFF" numberOfLines={1} style={{ fontWeight: "600" }}>
              {title}
            </T>
            <T variant="caption" color={LABEL_MUTED} numberOfLines={1} style={{ fontSize: 11 }}>
              {detail}
            </T>
          </View>
        </Glass>
      </View>
    </Pressable>
  );
}

/** An app's first letters, standing in for its icon. */
export function AppTile({ app }: { app: string }) {
  const c = useColors();
  return (
    <View style={[styles.appTile, { backgroundColor: c.sunken }]}>
      <T variant="caption" muted style={{ fontWeight: "700", fontSize: 11 }}>
        {appInitials(app)}
      </T>
    </View>
  );
}

export function appInitials(app: string): string {
  const words = app.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!).toUpperCase();
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
  appTile: {
    width: 36,
    height: 36,
    borderRadius: 11,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
