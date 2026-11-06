import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { Alert, RefreshControl, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { MobileDevice, MobileStatus } from "@godmode/shared";
import { AdminQueryState, FullAccessGate, isRefused } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { FieldRow, Group, LinkRow, SwitchRow } from "@/components/form";
import { ago, InfoRow } from "@/components/status-rows";
import { adminApi, ak } from "@/lib/admin";
import { api, errorText } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

/** Settings → Phones: the phones paired with this computer, pairing another one, and how phones reach it. */
export default function Phones() {
  const { t } = useTranslation("admin");
  const status = useQuery({ queryKey: ak.phones, queryFn: () => adminApi.phones.status() });
  const pull = usePullRefresh(async () => {
    const next = await adminApi.phones.status(true);
    queryClient.setQueryData(ak.phones, next);
  });

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <Stack.Screen options={{ title: t("phones.title") }} />
      <CloseButton />
      <FullAccessGate>
        <AdminQueryState query={status} errorTitle={t("phones.loadFailed")}>
          {(s) => <PhonesList status={s} />}
        </AdminQueryState>
      </FullAccessGate>
    </ScrollView>
  );
}

function PhonesList({ status: s }: { status: MobileStatus }) {
  const { t } = useTranslation(["admin", "common", "components"]);
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const selfId = me.data?.device.id;
  const devices = [...s.devices].sort((a, b) => Number(b.id === selfId) - Number(a.id === selfId));

  const update = (input: { enabled?: boolean; port?: number }) =>
    adminApi.phones
      .update(input)
      .then((next) => queryClient.setQueryData(ak.phones, next))
      .catch((err) => (isRefused(err) ? Alert.alert(t("components:fullAccess.title")) : Alert.alert(t("phones.saveFailed"), errorText(err))));

  // Both cut the address this phone may be using right now.
  const confirmCut = (title: string, input: { enabled?: boolean; port?: number }) =>
    Alert.alert(title, t("phones.cutBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("common:actions.continue"), style: "destructive", onPress: () => void update(input) },
    ]);

  return (
    <>
      <Group>
        <LinkRow icon="scan" title={t("phones.pair")} tone="brand" onPress={() => router.push("/settings/phone-pair")} />
      </Group>

      <Group title={t("phones.paired")}>
        {devices.map((d) => (
          <PhoneRow key={d.id} device={d} self={d.id === selfId} />
        ))}
      </Group>

      <Group title={t("phones.access")} footer={s.enabled && s.error ? s.error : undefined}>
        <SwitchRow
          icon="phone"
          title={t("phones.enabled")}
          value={s.enabled}
          onChange={(enabled) => (enabled ? void update({ enabled }) : confirmCut(t("phones.disableTitle"), { enabled }))}
        />
        <FieldRow
          label={t("phones.port")}
          value={String(s.port)}
          keyboardType="number-pad"
          maxLength={5}
          onCommit={(next) => {
            const port = Number(next);
            if (!Number.isInteger(port) || port < 1024 || port > 65535) return Alert.alert(t("phones.portInvalid"));
            if (port !== s.port) confirmCut(t("phones.portTitle"), { port });
          }}
        />
      </Group>

      <Group title="Tailscale" footer={!s.tailscale.running ? (s.tailscale.detail ?? undefined) : undefined}>
        <InfoRow
          icon="network"
          label={t("phones.tailscale.state")}
          value={s.tailscale.running ? t("phones.tailscale.connected") : s.tailscale.installed ? t("phones.tailscale.notConnected") : t("phones.tailscale.notInstalled")}
          tone={s.tailscale.running ? "success" : "warning"}
        />
        {s.tailscale.dnsName ? <InfoRow icon="display" label={t("phones.tailscale.name")} value={s.tailscale.dnsName} mono /> : null}
        {s.tailscale.ip ? <InfoRow icon="globe" label={t("phones.tailscale.address")} value={s.tailscale.ip} mono /> : null}
        {s.tailscale.tailnet ? <InfoRow icon="user" label="Tailnet" value={s.tailscale.tailnet} /> : null}
      </Group>
    </>
  );
}

function PhoneRow({ device: d, self }: { device: MobileDevice; self: boolean }) {
  const { t } = useTranslation("admin");
  const seen = d.online ? t("phones.online") : d.lastSeenAt ? t("phones.seen", { time: ago(d.lastSeenAt) }) : t("phones.never");
  return (
    <LinkRow
      icon="phone"
      title={self ? t("phones.self", { name: d.name }) : d.name}
      detail={[d.model ?? (d.platform === "ios" ? "iPhone" : "Android"), seen].join(" · ")}
      value={d.fullAccess ? t("phones.fullAccess") : undefined}
      onPress={() => router.push({ pathname: "/settings/phone", params: { id: d.id } })}
    />
  );
}


const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
