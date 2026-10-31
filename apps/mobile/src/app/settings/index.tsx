import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import * as LocalAuthentication from "expo-local-authentication";
import { router, Stack } from "expo-router";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { EFFORT_LABELS, PALETTES, PALETTE_DEFS, findModel, type InterfaceMode, type Palette, type Theme } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { ChoiceRow, FieldRow, Group, LinkRow, PickerRow, SegmentRow, SwitchRow } from "@/components/form";
import { Icon, type IconName } from "@/components/icon";
import { Logo } from "@/components/logo";
import { Button, Card, LiveDot, Row, T } from "@/components/ui";
import { api } from "@/lib/api";
import { useAppearance } from "@/lib/appearance";
import { useModelCatalog } from "@/lib/composer";
import { hostOf } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { computersOf, preferredOf, primaryOf } from "@/lib/peers";
import { qk } from "@/lib/query";
import { preferComputer } from "@/lib/realtime";
import { isGatewayUrl, useSession } from "@/lib/session";
import { firstLine, patchSettings, useSettings } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

const PLATFORM: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const satisfies readonly { value: Theme; label: string }[];

const PALETTE_OPTIONS = PALETTES.map((value) => ({ value, label: PALETTE_DEFS[value].label, detail: PALETTE_DEFS[value].blurb }));

const MODE_OPTIONS = [
  { value: "easy", label: "Easy" },
  { value: "pro", label: "Professional" },
] as const satisfies readonly { value: InterfaceMode; label: string }[];

const MODE_BLURB: Record<InterfaceMode, string> = {
  easy: "Plain words and only what you need day to day. Everything else is one click away.",
  pro: "Every tool, setting and detail in view: models, runs, machines, logs.",
};

export default function Settings() {
  const c = useColors();
  const connection = useSession((s) => s.connection);
  const appLock = useSession((s) => s.appLock);
  const theme = useAppearance((s) => s.theme);
  const palette = useAppearance((s) => s.palette);
  const status = useLive((s) => s.status);
  const linked = useLive((s) => s.computer);
  const preferredAway = useLive((s) => s.preferredAway);
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
  const computers = computersOf(connection);
  const activeId = linked ?? connection.activeInstanceId;
  const preferredId = preferredOf(connection)?.instance.id;
  const primary = primaryOf(connection);
  const computerState = (id: string) => {
    if (id === activeId) return status === "online" ? "Connected" : status === "connecting" ? "Connecting…" : "Out of reach";
    return id === preferredId && preferredAway && status === "online" ? "Away" : null;
  };
  const pick = async (id: string | null) => {
    if (await preferComputer(id)) return;
    const name = computers.find((p) => p.instance.id === (id ?? primary?.instance.id))?.instance.name ?? "That computer";
    Alert.alert(`${name} doesn't answer right now`, "This phone switches to it as soon as it's back.");
  };

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

      {computers.length > 1 ? (
        <Group title="This phone uses" footer="When the one you pick is out of reach, this phone uses another computer of the group and switches back once it answers again.">
          <ChoiceRow
            icon="bolt"
            title="Automatic"
            detail={primary ? `The primary, ${primary.instance.name}` : "The computer that answers"}
            selected={!connection.preferredInstanceId}
            onPress={() => void pick(null)}
          />
          {computers.map((p) => (
            <ChoiceRow
              key={p.instance.id}
              icon="display"
              title={p.instance.name}
              detail={[p.role === "primary" ? "Primary" : "Secondary", computerState(p.instance.id)].filter(Boolean).join(" · ")}
              selected={connection.preferredInstanceId === p.instance.id}
              onPress={() => void pick(p.instance.id)}
            />
          ))}
        </Group>
      ) : null}

      <Group title="Preferences" footer="Changes apply to your computer right away. Running chats pick them up with their next message.">
        {s ? <FieldRow label="Your name" value={s.general.userName} placeholder="Add your name" maxLength={80} onCommit={(userName) => void patchSettings({ general: { userName } })} /> : null}
        {s ? (
          <SegmentRow
            title="Appearance"
            detail="System follows this phone's setting."
            options={THEME_OPTIONS}
            value={theme}
            onChange={(next) => {
              useAppearance.getState().setTheme(next);
              void patchSettings({ general: { theme: next } });
            }}
          />
        ) : null}
        {s ? (
          <PickerRow
            title="Palette"
            detail="Just for this phone, light and dark."
            options={PALETTE_OPTIONS}
            value={palette}
            onChange={(next: Palette) => useAppearance.getState().setPalette(next)}
          />
        ) : null}
        {s ? (
          <SegmentRow
            title="Interface"
            detail={`${MODE_BLURB[s.general.mode === "easy" ? "easy" : "pro"]} The same on your computer.`}
            options={MODE_OPTIONS}
            value={s.general.mode === "easy" ? "easy" : "pro"}
            onChange={(mode) => void patchSettings({ general: { mode } })}
          />
        ) : null}
        <LinkRow
          icon="sparkles"
          title="AI & Claude"
          value={s && model ? `${model} · ${EFFORT_LABELS[s.runner.effort]}` : undefined}
          onPress={() => router.push("/settings/ai")}
        />
        <LinkRow
          icon="text"
          title="Instructions"
          detail={s ? (s.runner.appendSystemPrompt.trim() ? firstLine(s.runner.appendSystemPrompt) : "Rules for every agent, workspace and project") : undefined}
          onPress={() => router.push("/settings/instructions")}
        />
        <LinkRow icon="globe" title="Browser" detail="Profiles, background, live view" onPress={() => router.push("/settings/capabilities")} />
        <LinkRow icon="display" title="Computer" detail="Computer use and virtual machines" onPress={() => router.push("/settings/capabilities")} />
        <LinkRow icon="brain" title="Memory" detail="Learning, dreaming, upkeep" onPress={() => router.push("/settings/memory")} />
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

      <Group title="Data & privacy" footer="Logins, 2FA codes, backups and the rest of Security stay on your computer.">
        {biometrics.data ? (
          <SwitchRow icon="faceid" title="Require Face ID" detail="Hides Godmode in the app switcher and asks after 30 seconds away." value={appLock} onChange={(on) => void toggleLock(on)} />
        ) : null}
        <Info icon="lock" label="Security" value="On your computer" />
      </Group>

      <Group title="App" footer="Remove this phone on your computer anytime in Settings → Phone.">
        <Info icon="network" label={isGatewayUrl(connection.activeUrl) ? "Godmode Cloud" : "Tailscale"} value={hostOf(connection.activeUrl)} />
        <Info icon="phone" label="This phone" value={me.data?.device.name ?? connection.deviceName} />
      </Group>

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
