import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { MobileDevice, MobileStatus } from "@godmode/shared";
import { AdminQueryState, FullAccessGate, isRefused } from "@/components/admin";
import { FieldRow, Group } from "@/components/form";
import { ago, InfoRow } from "@/components/status-rows";
import { Button, EmptyState } from "@/components/ui";
import { adminApi, ak } from "@/lib/admin";
import { api, errorText } from "@/lib/api";
import { whenText } from "@/lib/format";
import { qk, queryClient } from "@/lib/query";
import { useSession } from "@/lib/session";
import { space } from "@/lib/theme";

/** One paired phone: renamed or removed here. Full access is given on the computer; a phone only gives up its own. */
export default function Phone() {
  const { t } = useTranslation("admin");
  const { id } = useLocalSearchParams<{ id: string }>();
  const status = useQuery({ queryKey: ak.phones, queryFn: () => adminApi.phones.status() });
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("phones.phone"), headerLargeTitleEnabled: false }} />
      <FullAccessGate>
        <AdminQueryState query={status} errorTitle={t("phones.loadFailed")}>
          {(s) => {
            const device = s.devices.find((d) => d.id === id);
            return device ? <Details device={device} /> : <EmptyState icon="phone" title={t("phones.gone")} />;
          }}
        </AdminQueryState>
      </FullAccessGate>
    </ScrollView>
  );
}

function Details({ device: d }: { device: MobileDevice }) {
  const { t } = useTranslation(["admin", "common", "components"]);
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const self = me.data?.device.id === d.id;

  const failed = (title: string, err: unknown) => Alert.alert(isRefused(err) ? t("components:fullAccess.title") : title, isRefused(err) ? undefined : errorText(err));

  const setDevice = (next: MobileDevice | null) =>
    queryClient.setQueryData<MobileStatus>(ak.phones, (s) => (s ? { ...s, devices: next ? s.devices.map((x) => (x.id === d.id ? next : x)) : s.devices.filter((x) => x.id !== d.id) } : s));

  const rename = (name: string) => {
    if (!name) return;
    adminApi.phones
      .rename(d.id, name)
      .then((next) => {
        setDevice(next);
        if (self) void queryClient.invalidateQueries({ queryKey: qk.me });
      })
      .catch((err) => failed(t("phones.renameFailed"), err));
  };

  const dropFullAccess = () =>
    Alert.alert(t("phones.dropTitle"), t("phones.dropBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("phones.dropConfirm"),
        style: "destructive",
        onPress: () =>
          api
            .setFullAccess(false)
            .then((session) => {
              queryClient.setQueryData(qk.me, session);
              setDevice(session.device);
              router.back();
            })
            .catch((err) => failed(t("phones.saveFailed"), err)),
      },
    ]);

  const takeBack = () =>
    Alert.alert(t("phonesExtra.takeBackTitle", { name: d.name }), t("phonesExtra.takeBackBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("phonesExtra.takeBack"),
        style: "destructive",
        onPress: () =>
          void adminApi.phones
            .dropFullAccess(d.id)
            .then(setDevice)
            .catch((err) => failed(t("phones.saveFailed"), err)),
      },
    ]);

  const remove = () =>
    Alert.alert(t("phones.removeTitle", { name: d.name }), self ? t("phones.removeSelfBody") : t("phones.removeBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("common:actions.remove"),
        style: "destructive",
        onPress: async () => {
          if (self) {
            await api.unpair().catch(() => undefined);
            await useSession.getState().disconnect();
            return;
          }
          adminApi.phones
            .remove(d.id)
            .then(() => {
              setDevice(null);
              router.back();
            })
            .catch((err) => failed(t("phones.removeFailed"), err));
        },
      },
    ]);

  const seen = d.online ? t("phones.online") : d.lastSeenAt ? ago(d.lastSeenAt) : t("phones.never");
  return (
    <>
      <Group>
        <FieldRow label={t("phones.name")} value={d.name} maxLength={80} onCommit={rename} />
      </Group>

      <Group footer={!d.fullAccess ? t("phones.fullAccessOnComputer") : undefined}>
        <InfoRow icon="phone" label={t("phones.model")} value={d.model ?? (d.platform === "ios" ? "iPhone" : "Android")} />
        {d.appVersion ? <InfoRow icon="package" label={t("phones.app")} value={d.appVersion} /> : null}
        <InfoRow icon="pulse" label={t("phones.status")} value={seen} tone={d.online ? "success" : undefined} />
        <InfoRow icon="clock" label={t("phones.pairedAt")} value={whenText(d.createdAt)} />
        {d.lastAddress ? <InfoRow icon="network" label={t("phones.address")} value={d.lastAddress} mono /> : null}
        <InfoRow icon="lock" label={t("phones.fullAccess")} value={d.fullAccess ? t("common:status.on") : t("common:status.off")} tone={d.fullAccess ? "warning" : undefined} />
        <InfoRow icon="bell" label={t("phones.push")} value={d.push ? t("common:status.on") : t("common:status.off")} />
      </Group>

      {self && d.fullAccess ? <Button title={t("phones.dropConfirm")} icon="lock" variant="outline" onPress={dropFullAccess} /> : null}
      {me.data && !self && d.fullAccess ? <Button title={t("phonesExtra.takeBack")} icon="lock" variant="outline" onPress={takeBack} /> : null}
      <Button title={self ? t("phones.removeSelf") : t("phones.remove")} icon="trash" variant="danger" onPress={remove} />
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
