import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import * as LocalAuthentication from "expo-local-authentication";
import { router, Stack } from "expo-router";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { effortLabel, findModel, type AppLanguage, type InterfaceMode, type Theme } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { ChoiceRow, FieldRow, Group, LinkRow, SegmentRow, SwitchRow } from "@/components/form";
import { Icon, type IconName } from "@/components/icon";
import { Logo } from "@/components/logo";
import { Button, Card, LiveDot, Row, T } from "@/components/ui";
import { api } from "@/lib/api";
import { useAppearance } from "@/lib/appearance";
import { useLanguage, currentLanguage } from "@/lib/i18n";
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
  { value: "light", labelKey: "settings:overview.theme.light" },
  { value: "dark", labelKey: "settings:overview.theme.dark" },
  { value: "system", labelKey: "common:language.system" },
] as const satisfies readonly { value: Theme; labelKey: string }[];

const LANGUAGE_OPTIONS = [
  { value: "system", labelKey: "common:language.system" },
  { value: "en", labelKey: "common:language.en" },
  { value: "de", labelKey: "common:language.de" },
] as const satisfies readonly { value: AppLanguage; labelKey: string }[];

const MODE_OPTIONS = [
  { value: "easy", labelKey: "settings:overview.mode.easy" },
  { value: "pro", labelKey: "settings:overview.mode.pro" },
] as const satisfies readonly { value: InterfaceMode; labelKey: string }[];

const MODE_BLURB = {
  easy: "settings:overview.mode.easyBlurb",
  pro: "settings:overview.mode.proBlurb",
} as const satisfies Record<InterfaceMode, string>;

export default function Settings() {
  const c = useColors();
  const { t } = useTranslation(["settings", "common"]);
  const connection = useSession((s) => s.connection);
  const appLock = useSession((s) => s.appLock);
  const theme = useAppearance((s) => s.theme);
  const language = useLanguage((s) => s.language);
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
        {s ? <FieldRow label={t("overview.preferences.yourName")} value={s.general.userName} placeholder={t("overview.preferences.addName")} maxLength={80} onCommit={(userName) => void patchSettings({ general: { userName } })} /> : null}
        {s ? (
          <SegmentRow
            title={t("overview.theme.title")}
            detail={t("overview.theme.detail")}
            options={THEME_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            value={theme}
            onChange={(next) => {
              useAppearance.getState().setTheme(next);
              void patchSettings({ general: { theme: next } });
            }}
          />
        ) : null}
        {s ? (
          <SegmentRow
            title={t("overview.language.title")}
            detail={t("overview.language.detail")}
            options={LANGUAGE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            value={language}
            onChange={(next) => {
              useLanguage.getState().setLanguage(next);
              void patchSettings({ general: { language: next } });
            }}
          />
        ) : null}
        {s ? (
          <SegmentRow
            title={t("overview.mode.title")}
            detail={t("overview.mode.detail", { blurb: t(MODE_BLURB[s.general.mode === "easy" ? "easy" : "pro"]) })}
            options={MODE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            value={s.general.mode === "easy" ? "easy" : "pro"}
            onChange={(mode) => void patchSettings({ general: { mode } })}
          />
        ) : null}
        <LinkRow
          icon="sparkles"
          title={t("overview.links.ai")}
          value={s && model ? `${model} · ${effortLabel(s.runner.effort, currentLanguage())}` : undefined}
          onPress={() => router.push("/settings/ai")}
        />
        <LinkRow
          icon="text"
          title={t("overview.links.instructions")}
          detail={s ? (s.runner.appendSystemPrompt.trim() ? firstLine(s.runner.appendSystemPrompt) : t("overview.links.instructionsDetail")) : undefined}
          onPress={() => router.push("/settings/instructions")}
        />
        <LinkRow icon="globe" title={t("overview.links.browser")} detail={t("overview.links.browserDetail")} onPress={() => router.push("/settings/capabilities")} />
        <LinkRow icon="display" title={t("overview.links.computer")} detail={t("overview.links.computerDetail")} onPress={() => router.push("/settings/capabilities")} />
        <LinkRow icon="brain" title={t("overview.links.memory")} detail={t("overview.links.memoryDetail")} onPress={() => router.push("/settings/memory")} />
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

      <Group title={t("overview.privacy.title")} footer={t("overview.privacy.footer")}>
        {biometrics.data ? (
          <SwitchRow icon="faceid" title={t("overview.privacy.faceId")} detail={t("overview.privacy.faceIdDetail")} value={appLock} onChange={(on) => void toggleLock(on)} />
        ) : null}
        <Info icon="lock" label={t("overview.privacy.security")} value={t("overview.privacy.onComputer")} />
      </Group>

      <Group title={t("overview.app.title")} footer={t("overview.app.footer")}>
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
