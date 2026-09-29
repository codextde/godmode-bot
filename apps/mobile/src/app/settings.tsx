import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import * as LocalAuthentication from "expo-local-authentication";
import { Alert, ScrollView, StyleSheet, Switch, View } from "react-native";
import { Icon, type IconName } from "@/components/icon";
import { Logo } from "@/components/logo";
import { Button, Card, Hairline, LiveDot, Row, SectionTitle, T } from "@/components/ui";
import { api } from "@/lib/api";
import { hostOf } from "@/lib/format";
import { useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { useSession } from "@/lib/session";
import { space, useColors } from "@/lib/theme";

const PLATFORM: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

export default function Settings() {
  const c = useColors();
  const connection = useSession((s) => s.connection);
  const appLock = useSession((s) => s.appLock);
  const status = useLive((s) => s.status);
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const biometrics = useQuery({
    queryKey: ["biometrics"],
    queryFn: async () => (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync()),
  });

  if (!connection) return null;
  const instance = me.data?.instance ?? connection.instance;

  const toggleLock = async (on: boolean) => {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: on ? "Turn on Face ID for Godmode" : "Turn off Face ID for Godmode" });
    if (result.success) await useSession.getState().setAppLock(on);
  };

  const disconnect = () =>
    Alert.alert(`Disconnect from ${instance.name}?`, "This phone forgets its key. Scan a new code to connect again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          await api.unpair().catch(() => undefined);
          await useSession.getState().disconnect();
        },
      },
    ]);

  return (
    <ScrollView contentContainerStyle={styles.content} style={{ backgroundColor: c.background }}>
      <T variant="title">Settings</T>

      <Card style={styles.computer}>
        <Logo size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="headline" numberOfLines={1}>
            {instance.name}
          </T>
          <T variant="footnote" muted>
            Godmode {instance.version} · {PLATFORM[instance.platform] ?? instance.platform}
          </T>
          <Row style={{ gap: 6, marginTop: 4 }}>
            <LiveDot live={status === "online"} size={6} color={status === "offline" ? c.warning : undefined} />
            <T variant="caption" muted>
              {status === "online" ? "Connected" : status === "connecting" ? "Connecting…" : "Out of reach"}
            </T>
          </Row>
        </View>
      </Card>

      <View>
        <SectionTitle title="Connection" />
        <Card>
          <Info icon="network" label="Tailscale" value={hostOf(connection.activeUrl)} />
          <Hairline inset={48} />
          <Info icon="phone" label="This phone" value={me.data?.device.name ?? connection.deviceName} />
          <Hairline inset={48} />
          <Info icon="lock" label="Access" value="Chats, agents, screens" />
        </Card>
        <T variant="caption" muted style={styles.note}>
          Logins, 2FA codes, backups and settings stay on your computer. Remove this phone there anytime in Settings → Phone.
        </T>
      </View>

      {biometrics.data ? (
        <View>
          <SectionTitle title="Privacy" />
          <Card>
            <Row style={{ gap: space.md, padding: space.lg }}>
              <Icon name="faceid" size={20} color={c.text} />
              <View style={{ flex: 1 }}>
                <T variant="subhead" style={{ fontWeight: "600" }}>
                  Require Face ID
                </T>
                <T variant="footnote" muted>
                  Hides Godmode in the app switcher and asks after 30 seconds away.
                </T>
              </View>
              <Switch value={appLock} onValueChange={(on) => void toggleLock(on)} trackColor={{ true: c.brand, false: c.sunken }} />
            </Row>
          </Card>
        </View>
      ) : null}

      <Button title="Disconnect this phone" variant="danger" icon="logout" onPress={disconnect} />
      <T variant="caption" muted style={{ textAlign: "center" }}>
        Godmode for {process.env.EXPO_OS === "ios" ? "iOS" : "Android"} {Constants.expoConfig?.version}
      </T>
    </ScrollView>
  );
}

function Info({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const c = useColors();
  return (
    <Row style={{ gap: space.md, paddingHorizontal: space.lg, paddingVertical: 14 }}>
      <Icon name={icon} size={18} color={c.textMuted} />
      <T variant="subhead" style={{ flex: 1 }}>
        {label}
      </T>
      <T variant="subhead" muted numberOfLines={1} style={{ flexShrink: 1, maxWidth: "55%" }}>
        {value}
      </T>
    </Row>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.xl,
    paddingTop: 28,
    gap: space.xl,
    paddingBottom: 60,
  },
  computer: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    padding: space.lg,
  },
  note: {
    marginTop: space.sm,
    paddingHorizontal: 4,
  },
});
