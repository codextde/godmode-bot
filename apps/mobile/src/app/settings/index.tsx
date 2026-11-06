import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import * as LocalAuthentication from "expo-local-authentication";
import { router, Stack } from "expo-router";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { effortLabel, findModel } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { ChoiceRow, Group, LinkRow, SwitchRow } from "@/components/form";
import { Icon, type IconName } from "@/components/icon";
import { Logo } from "@/components/logo";
import { ToolsLinks } from "@/components/tools-links";
import { Button, Card, LiveDot, Row, T } from "@/components/ui";
import { api } from "@/lib/api";
import { currentLanguage } from "@/lib/i18n";
import { useModelCatalog } from "@/lib/composer";
import { hostOf } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { computersOf, preferredOf, primaryOf } from "@/lib/peers";
import { qk } from "@/lib/query";
import { preferComputer } from "@/lib/realtime";
import { isGatewayUrl, useSession } from "@/lib/session";
import { firstLine, useSettings } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

const PLATFORM: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** The optional features (Settings → Features); calls are `phone`, VMs `vm`. */
const FEATURES = ["activity", "artifacts", "integrations", "plugins", "messaging", "phone", "cards", "vm", "ssh", "sshKeys", "android"] as const;

export default function Settings() {
  const c = useColors();
  const { t } = useTranslation(["settings", "common"]);
  const connection = useSession((s) => s.connection);
  const appLock = useSession((s) => s.appLock);
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
    if (id === activeId) return status === "online" ? t("overview.status.connected") : status === "connecting" ? t("overview.status.connecting") : t("overview.status.outOfReach");
    return id === preferredId && preferredAway && status === "online" ? t("overview.status.away") : null;
  };
  const pick = async (id: string | null) => {
    if (await preferComputer(id)) return;
    const name = computers.find((p) => p.instance.id === (id ?? primary?.instance.id))?.instance.name ?? t("overview.pick.thatComputer");
    Alert.alert(t("overview.pick.title", { name }), t("overview.pick.body"));
  };

  const toggleLock = async (on: boolean) => {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: on ? t("overview.lock.turnOn") : t("overview.lock.turnOff") });
    if (result.success) await useSession.getState().setAppLock(on);
  };

  const disconnect = () =>
    Alert.alert(t("overview.disconnect.title", { name: instance.name }), t("overview.disconnect.body"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("overview.disconnect.confirm"),
        style: "destructive",
        onPress: async () => {
          await api.unpair().catch(() => undefined);
          await useSession.getState().disconnect();
        },
      },
    ]);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("common:words.settings") }} />
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
              {status === "online" ? t("overview.status.connected") : status === "connecting" ? t("overview.status.connecting") : t("overview.status.outOfReach")}
            </T>
          </Row>
        </View>
      </Card>

      {computers.length > 1 ? (
        <Group title={t("overview.computers.title")} footer={t("overview.computers.footer")}>
          <ChoiceRow
            icon="bolt"
            title={t("overview.computers.automatic")}
            detail={primary ? t("overview.computers.thePrimary", { name: primary.instance.name }) : t("overview.computers.whoAnswers")}
            selected={!connection.preferredInstanceId}
            onPress={() => void pick(null)}
          />
          {computers.map((p) => (
            <ChoiceRow
              key={p.instance.id}
              icon="display"
              title={p.instance.name}
              detail={[p.role === "primary" ? t("overview.computers.primary") : t("overview.computers.secondary"), computerState(p.instance.id)].filter(Boolean).join(" · ")}
              selected={connection.preferredInstanceId === p.instance.id}
              onPress={() => void pick(p.instance.id)}
            />
          ))}
        </Group>
      ) : null}

      <Group title={t("overview.preferences.title")} footer={t("overview.preferences.footer")}>
        <LinkRow icon="slider" title={t("overview.links.general")} onPress={() => router.push("/settings/general")} />
        <LinkRow
          icon="sparkles"
          title={t("overview.links.ai")}
          value={s && model ? `${model} · ${effortLabel(s.runner.effort, currentLanguage())}` : undefined}
          onPress={() => router.push("/settings/ai")}
        />
        <LinkRow icon="personCircle" title={t("overview.links.accounts")} onPress={() => router.push("/settings/accounts")} />
        <LinkRow
          icon="text"
          title={t("overview.links.instructions")}
          detail={s ? (s.runner.appendSystemPrompt.trim() ? firstLine(s.runner.appendSystemPrompt) : t("overview.links.instructionsDetail")) : undefined}
          onPress={() => router.push("/settings/instructions")}
        />
        <LinkRow icon="globe" title={t("overview.links.browser")} onPress={() => router.push("/settings/browser")} />
        <LinkRow icon="display" title={t("overview.links.computer")} onPress={() => router.push("/settings/computer")} />
        <LinkRow icon="waveform" title={t("overview.links.voice")} onPress={() => router.push("/settings/voice")} />
        <LinkRow icon="brain" title={t("overview.links.memory")} onPress={() => router.push("/settings/memory")} />
        <LinkRow
          icon="review"
          title={t("overview.links.review")}
          value={s ? (s.review.enabled ? t("common:status.on") : t("common:status.off")) : undefined}
          onPress={() => router.push("/settings/review")}
        />
      </Group>

      <Group title={t("overview.team.title")}>
        <LinkRow
          icon="layers"
          title={t("overview.team.workspaces")}
          value={workspaces.length ? `${workspaces.length}${projects ? ` · ${t("overview.team.projects", { count: projects })}` : ""}` : t("overview.team.noneYet")}
          onPress={() => router.push("/settings/workspaces")}
        />
        <LinkRow icon="agents" title={t("common:words.agents")} value={agents ? String(agents.length) : undefined} onPress={() => router.push("/settings/agents")} />
      </Group>

      <ToolsLinks />

      <Group title={t("overview.features.title")}>
        <LinkRow
          icon="puzzle"
          title={t("overview.links.features")}
          value={s ? t("overview.features.on", { count: FEATURES.filter((f) => s[f].enabled).length }) : undefined}
          onPress={() => router.push("/settings/features")}
        />
        {s?.phone.enabled ? (
          <LinkRow icon="call" title={t("overview.links.calls")} value={s.phone.callerName || undefined} onPress={() => router.push("/settings/calls")} />
        ) : null}
      </Group>

      <Group title={t("overview.privacy.title")}>
        {biometrics.data ? (
          <SwitchRow icon="faceid" title={t("overview.privacy.faceId")} detail={t("overview.privacy.faceIdDetail")} value={appLock} onChange={(on) => void toggleLock(on)} />
        ) : null}
        <Info icon="lock" label={t("overview.privacy.security")} value={t("overview.privacy.onComputer")} />
        <LinkRow icon="broom" title={t("overview.links.cleanup")} onPress={() => router.push("/settings/cleanup")} />
      </Group>

      <Group title={t("overview.app.title")}>
        <LinkRow icon="pulse" title={t("overview.links.health")} onPress={() => router.push("/settings/health")} />
        <LinkRow icon="key" title={t("overview.links.license")} onPress={() => router.push("/settings/license")} />
        <LinkRow icon="network" title={t("overview.links.cloud")} onPress={() => router.push("/settings/cloud")} />
        <LinkRow icon="cpu" title={t("overview.links.devices")} onPress={() => router.push("/settings/devices")} />
        <LinkRow icon="plug" title={t("overview.links.connected")} onPress={() => router.push("/settings/connected-apps")} />
        <LinkRow icon="list" title={t("overview.links.logs")} onPress={() => router.push("/settings/logs")} />
        <LinkRow icon="bolt" title={t("overview.links.about")} onPress={() => router.push("/settings/about")} />
      </Group>

      <Group footer={t("overview.app.footer")}>
        <Info icon="network" label={isGatewayUrl(connection.activeUrl) ? "Godmode Cloud" : "Tailscale"} value={hostOf(connection.activeUrl)} />
        <Info icon="phone" label={t("overview.app.thisPhone")} value={me.data?.device.name ?? connection.deviceName} />
      </Group>

      <Button title={t("overview.disconnect.button")} variant="danger" icon="logout" onPress={disconnect} />
      <T variant="caption" muted style={{ textAlign: "center" }}>
        {t("overview.app.version", { platform: process.env.EXPO_OS === "ios" ? "iOS" : "Android", version: Constants.expoConfig?.version ?? "" })}
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
