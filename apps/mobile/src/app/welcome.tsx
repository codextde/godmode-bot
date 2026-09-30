import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "@/components/icon";
import { Logo } from "@/components/logo";
import { Button, Card, T } from "@/components/ui";
import { useSession } from "@/lib/session";
import { space, useColors } from "@/lib/theme";

const POINTS: { icon: IconName; title: string; body: string }[] = [
  { icon: "chats", title: "Hand over work from anywhere", body: "Start a task, follow the answer as it's written, stop it with one tap." },
  { icon: "eye", title: "Look over their shoulder", body: "Watch the browser, shared screen or VM an agent works in, live." },
  { icon: "lock", title: "Private by design", body: "Your phone talks to your computer over your own Tailscale network. Logins stay on the computer." },
];

export default function Welcome() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const removed = useSession((s) => s.endedBecause === "removed");

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 48, paddingHorizontal: space.xxl, paddingBottom: 180 }}>
        <Animated.View entering={FadeInDown.duration(500)}>
          <Logo size={64} />
          <T variant="eyebrow" muted style={{ marginTop: space.xxl }}>
            Godmode for {process.env.EXPO_OS === "ios" ? "iPhone" : "Android"}
          </T>
          <T variant="largeTitle" style={{ marginTop: space.sm, fontSize: 36, lineHeight: 40 }}>
            Your AI coworkers, in your pocket.
          </T>
          <T variant="body" muted style={{ marginTop: space.md }}>
            This app controls the Godmode running on your computer. Pair it once with the code on your computer's screen.
          </T>
        </Animated.View>

        {removed && (
          <Card style={[styles.removed, { backgroundColor: c.warningSoft, borderColor: "transparent" }]}>
            <Icon name="warning" size={18} color={c.warning} />
            <T variant="subhead" style={{ flex: 1 }}>
              This phone was removed on your computer. Scan a new code to connect again.
            </T>
          </Card>
        )}

        <View style={{ marginTop: 36, gap: 22 }}>
          {POINTS.map((p, i) => (
            <Animated.View key={p.title} entering={FadeInDown.delay(120 + i * 80).duration(450)} style={styles.point}>
              <View style={[styles.pointIcon, { backgroundColor: c.sunken }]}>
                <Icon name={p.icon} size={18} color={c.text} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="headline" style={{ fontSize: 16 }}>
                  {p.title}
                </T>
                <T variant="subhead" muted>
                  {p.body}
                </T>
              </View>
            </Animated.View>
          ))}
        </View>

      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + space.lg, backgroundColor: c.background }]}>
        <T variant="footnote" muted style={{ textAlign: "center" }}>
          On your computer: Settings → Phone → Connect a phone.{"\n"}Tailscale on, here and there, same account.
        </T>
        <Button title="Scan QR code" icon="scan" size="lg" onPress={() => router.push("/scan")} />
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
