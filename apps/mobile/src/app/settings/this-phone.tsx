import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import * as LocalAuthentication from "expo-local-authentication";
import { Stack } from "expo-router";
import { Alert, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { CloseButton } from "@/components/close-button";
import { ChoiceRow, Group, SwitchRow } from "@/components/form";
import { SettingsScroll } from "@/components/settings-scroll";
import { InfoRow } from "@/components/status-rows";
import { ThisPhoneAccess } from "@/components/this-phone-access";
import { Button, T } from "@/components/ui";
import { api } from "@/lib/api";
import { hostOf } from "@/lib/format";
import { useLive } from "@/lib/live";
import { computersOf, preferredOf, primaryOf } from "@/lib/peers";
import { qk } from "@/lib/query";
import { preferComputer } from "@/lib/realtime";
import { isGatewayUrl, useSession } from "@/lib/session";
import { space } from "@/lib/theme";

/** Settings → this phone: which computer it uses and how, its lock, and leaving. */
export default function ThisPhone() {
  const { t } = useTranslation(["settings", "common"]);
  const connection = useSession((s) => s.connection);
  const appLock = useSession((s) => s.appLock);
  const status = useLive((s) => s.status);
  const linked = useLive((s) => s.computer);
  const preferredAway = useLive((s) => s.preferredAway);
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const biometrics = useQuery({
    queryKey: ["biometrics"],
    queryFn: async () => (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync()),
  });

  if (!connection) return null;
  const instance = me.data?.instance ?? connection.instance;
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
    const android = process.env.EXPO_OS === "android";
    const promptMessage = on ? t(android ? "overview.lock.turnOnAndroid" : "overview.lock.turnOn") : t(android ? "overview.lock.turnOffAndroid" : "overview.lock.turnOff");
    const result = await LocalAuthentication.authenticateAsync({ promptMessage });
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
    <SettingsScroll contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("overview.app.thisPhone") }} />
      <CloseButton />

      {computers.length > 1 ? (
        <Group title={t("overview.computers.title")}>
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

      <Group>
        <InfoRow icon="phone" label={t("overview.app.name")} value={me.data?.device.name ?? connection.deviceName} />
        <InfoRow icon="network" label={isGatewayUrl(connection.activeUrl) ? "Godmode Cloud" : "Tailscale"} value={hostOf(connection.activeUrl)} />
        <ThisPhoneAccess />
        {biometrics.data ? (
          <SwitchRow icon="faceid" title={t(process.env.EXPO_OS === "android" ? "overview.privacy.screenLock" : "overview.privacy.faceId")} value={appLock} onChange={(on) => void toggleLock(on)} />
        ) : null}
      </Group>

      <Button title={t("overview.disconnect.button")} variant="danger" icon="logout" onPress={disconnect} />
      <T variant="caption" muted style={{ textAlign: "center" }}>
        {t("overview.app.version", { platform: process.env.EXPO_OS === "ios" ? "iOS" : "Android", version: Constants.expoConfig?.version ?? "" })}
      </T>
    </SettingsScroll>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
