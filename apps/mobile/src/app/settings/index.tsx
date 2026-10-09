import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import * as LocalAuthentication from "expo-local-authentication";
import { router, Stack } from "expo-router";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { EFFORT_LABELS, findModel } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, LinkRow, SwitchRow } from "@/components/form";
import { Icon, type IconName } from "@/components/icon";
import { Logo } from "@/components/logo";
import { Button, Card, LiveDot, Row, T } from "@/components/ui";
import { api } from "@/lib/api";
import { useModelCatalog } from "@/lib/composer";
import { hostOf } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { isGatewayUrl, useSession } from "@/lib/session";
import { firstLine, patchSettings, useSettings } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

const PLATFORM: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

export default function Settings() {
  const c = useColors();
  const connection = useSession((s) => s.connection);
  const appLock = useSession((s) => s.appLock);
  const status = useLive((s) => s.status);
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const settings = useSettings();
  const catalog = useModelCatalog();
  const { workspaces } = useWorkspace();
  const { data: agents } = useAgents();
  const biometrics = useQuery({
    queryKey: ["biometrics"],
    queryFn: async () => (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync()),
  });

  if (!connection) return null;
  const instance = me.data?.instance ?? connection.instance;
  const s = settings.data;
  const model = s ? (findModel(catalog.data?.models ?? [], s.runner.model)?.label ?? s.runner.model) : undefined;
  const projects = workspaces.reduce((n, w) => n + w.projects.length, 0);

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
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Settings" }} />
      <CloseButton />

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

      <Group title="How your agents work" footer="Changes apply to your computer right away. Running chats pick them up with their next message.">
        <LinkRow
          icon="text"
          title="Instructions"
          detail={s ? (s.runner.appendSystemPrompt.trim() ? firstLine(s.runner.appendSystemPrompt) : "Rules for every agent, workspace and project") : undefined}
          onPress={() => router.push("/settings/instructions")}
        />
        <LinkRow
          icon="sparkles"
          title="Model & limits"
          value={s && model ? `${model} · ${EFFORT_LABELS[s.runner.effort]}` : undefined}
          onPress={() => router.push("/settings/ai")}
        />
        <LinkRow icon="globe" title="Browser & computer" detail="What agents may see and control" onPress={() => router.push("/settings/capabilities")} />
        <LinkRow icon="brain" title="Memory & upkeep" detail="Learning, dreaming, self-repair" onPress={() => router.push("/settings/memory")} />
      </Group>

      <Group title="Your team">
        <LinkRow
          icon="layers"
          title="Workspaces"
          value={workspaces.length ? `${workspaces.length}${projects ? ` · ${projects} ${projects === 1 ? "project" : "projects"}` : ""}` : "None yet"}
          onPress={() => router.push("/settings/workspaces")}
        />
        <LinkRow icon="agents" title="Agents" value={agents ? String(agents.length) : undefined} onPress={() => router.push("/settings/agents")} />
      </Group>

      {s ? (
        <Group title="You" footer="Agents greet you and write to you by this name.">
          <FieldRow label="Your name" value={s.general.userName} placeholder="Add your name" maxLength={80} onCommit={(userName) => void patchSettings({ general: { userName } })} />
        </Group>
      ) : null}

      <Group title="Connection" footer="Logins, 2FA codes, backups and security stay on your computer. Remove this phone there anytime in Settings → Phone.">
        <Info icon="network" label={isGatewayUrl(connection.activeUrl) ? "Godmode Cloud" : "Tailscale"} value={hostOf(connection.activeUrl)} />
        <Info icon="phone" label="This phone" value={me.data?.device.name ?? connection.deviceName} />
      </Group>

      {biometrics.data ? (
        <Group title="Privacy">
          <SwitchRow icon="faceid" title="Require Face ID" detail="Hides Godmode in the app switcher and asks after 30 seconds away." value={appLock} onChange={(on) => void toggleLock(on)} />
        </Group>
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
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  computer: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    padding: space.lg,
  },
});
