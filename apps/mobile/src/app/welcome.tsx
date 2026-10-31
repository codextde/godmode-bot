import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "@/components/icon";
import { Logo } from "@/components/logo";
import { Button, Card, T } from "@/components/ui";
import { useSession } from "@/lib/session";
import { space, useColors } from "@/lib/theme";

const POINTS = [
  { icon: "chats", key: "handOver" },
  { icon: "eye", key: "watch" },
  { icon: "lock", key: "inCharge" },
] as const satisfies readonly { icon: IconName; key: string }[];

export default function Welcome() {
  const c = useColors();
  const { t } = useTranslation("onboarding");
  const insets = useSafeAreaInsets();
  const removed = useSession((s) => s.endedBecause === "removed");

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 48, paddingHorizontal: space.xxl, paddingBottom: 180 }}>
        <Animated.View entering={FadeInDown.duration(500)}>
          <Logo size={64} />
          <T variant="eyebrow" muted style={{ marginTop: space.xxl }}>
            {t("welcome.eyebrow", { platform: process.env.EXPO_OS === "ios" ? "iPhone" : "Android" })}
          </T>
          <T variant="largeTitle" style={{ marginTop: space.sm, fontSize: 36, lineHeight: 40 }}>
            {t("welcome.title")}
          </T>
          <T variant="body" muted style={{ marginTop: space.md }}>
            {t("welcome.intro")}
          </T>
        </Animated.View>

        {removed && (
          <Card style={[styles.removed, { backgroundColor: c.warningSoft, borderColor: "transparent" }]}>
            <Icon name="warning" size={18} color={c.warning} />
            <T variant="subhead" style={{ flex: 1 }}>
              {t("welcome.removed")}
            </T>
          </Card>
        )}

        <View style={{ marginTop: 36, gap: 22 }}>
          {POINTS.map((p, i) => (
            <Animated.View key={p.key} entering={FadeInDown.delay(120 + i * 80).duration(450)} style={styles.point}>
              <View style={[styles.pointIcon, { backgroundColor: c.sunken }]}>
                <Icon name={p.icon} size={18} color={c.text} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="headline" style={{ fontSize: 16 }}>
                  {t(`welcome.points.${p.key}.title`)}
                </T>
                <T variant="subhead" muted>
                  {t(`welcome.points.${p.key}.body`)}
                </T>
              </View>
            </Animated.View>
          ))}
        </View>

      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + space.lg, backgroundColor: c.background }]}>
        <T variant="footnote" muted style={{ textAlign: "center" }}>
          {t("welcome.howTo")}
        </T>
        <Button title={t("welcome.scan")} icon="scan" size="lg" onPress={() => router.push("/scan")} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  removed: {
    marginTop: space.xl,
    padding: space.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  point: {
    flexDirection: "row",
    gap: space.lg,
    alignItems: "flex-start",
  },
  pointIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    gap: space.md,
  },
});
