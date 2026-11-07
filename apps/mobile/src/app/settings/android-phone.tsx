import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { androidSummary, type AndroidDevice } from "@godmode/shared";
import { AdminQueryState, FullAccessGate } from "@/components/admin";
import { PhoneButtons, PhoneCommand, PhoneScreen, PhoneUsedBy } from "@/components/android-parts";
import { CloseButton } from "@/components/close-button";
import { Group } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { InfoRow } from "@/components/status-rows";
import { ActionRow, TextRow } from "@/components/tool-form";
import { EmptyState } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { leave, machinesApi, putPhone, refreshPhones } from "@/lib/machines";
import { qk } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

/** One Android phone, like the desktop's phone page: its screen, name and purpose, who uses it, a shell command, about. */
export default function AndroidPhone() {
  const { t } = useTranslation("machines");
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useQuery({ queryKey: qk.androidDevices, queryFn: api.android.devices });
  const pull = usePullRefresh(list.refetch);
  const device = list.data?.find((d) => d.id === id);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Screen options={{ title: device?.name ?? "", headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate>
        <AdminQueryState query={list} errorTitle={t("android.loadFailed")}>
          {(devices) => {
            const found = devices.find((d) => d.id === id);
            return found ? <Body key={found.id} device={found} /> : <EmptyState style={styles.state} icon="phone" title={t("phone.gone")} body={t("phone.goneBody")} />;
          }}
        </AdminQueryState>
      </FullAccessGate>
    </ScrollView>
  );
}

function Body({ device }: { device: AndroidDevice }) {
  const { t } = useTranslation(["machines", "common"]);
  const [name, setName] = useState(device.name);
  const [description, setDescription] = useState(device.description);
  const [busy, setBusy] = useState<"save" | "disconnect" | "forget" | null>(null);
  const connected = device.state === "connected";
  const dirty = name.trim() !== device.name || description.trim() !== device.description;

  const save = async () => {
    if (!name.trim()) return Alert.alert(t("phone.nameMissing"));
    setBusy("save");
    try {
      const next = await machinesApi.android.update(device.id, { name: name.trim(), description: description.trim() });
      putPhone(next);
      setName(next.name);
      setDescription(next.description);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (err) {
      Alert.alert(t("phone.saveFailed"), errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    try {
      putPhone(await machinesApi.android.disconnect(device.id));
    } catch (err) {
      Alert.alert(t("phone.disconnectFailed"), errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const forget = () => {
    const users = device.assignments.length;
    const body = [
      t("phone.forgetBody"),
      users === 1 ? t("phone.forgetOneUser", { name: device.assignments[0]?.name || t("vm.untitledChat") }) : null,
      users > 1 ? t("phone.forgetManyUsers", { count: users }) : null,
      t("phone.forgetRest"),
    ]
      .filter(Boolean)
      .join(" ");
    Alert.alert(t("phone.forgetTitle", { name: device.name }), body, [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: t("phone.forget"),
        style: "destructive",
        onPress: async () => {
          setBusy("forget");
          try {
            await machinesApi.android.forget(device.id);
            await refreshPhones();
            leave("/settings/android");
          } catch (err) {
            setBusy(null);
            Alert.alert(t("phone.forgetFailed"), errorText(err));
          }
        },
      },
    ]);
  };

  const connection = device.connection ? t(`phone.connection.${device.connection}`) : t("phone.notConnected");

  return (
    <>
      {dirty ? <HeaderActions actions={[{ icon: "check", label: t("common:actions.save"), prominent: true, onPress: () => void save() }]} /> : null}

      <PhoneScreen device={device} />

      {connected ? <PhoneButtons device={device} /> : null}

      <Group>
        <TextRow label={t("phone.name")} value={name} onChange={setName} maxLength={100} />
        <TextRow label={t("phone.whatFor")} value={description} onChange={setDescription} placeholder={t("phone.whatForPlaceholder")} multiline minHeight={72} maxLength={4000} />
      </Group>

      <PhoneUsedBy device={device} />

      {connected ? <PhoneCommand device={device} /> : null}

      <Group title={t("phone.about")}>
        <InfoRow label={t("phone.model")} value={androidSummary(device)} />
        <InfoRow label={t("phone.connectionLabel")} value={connection} tone={connected ? "success" : undefined} />
        {connected && device.battery ? (
          <InfoRow label={t("phone.battery")} value={device.battery.charging ? t("phone.charging", { level: device.battery.level }) : `${device.battery.level}%`} />
        ) : null}
        <InfoRow label={t("phone.screen")} value={device.width && device.height ? `${device.width} × ${device.height}` : t("phone.unknown")} />
        <InfoRow label={t("phone.serial")} value={device.serial.replace(/^avd:/, "")} mono />
      </Group>

      <Group>
        {connected && device.connection === "wifi" ? (
          <ActionRow icon="wifi" title={t("phone.disconnect")} busy={busy === "disconnect"} onPress={() => void disconnect()} />
        ) : null}
        {device.state === "disconnected" ? (
          <ActionRow icon="trash" title={t("phone.forget")} tone="danger" busy={busy === "forget"} onPress={forget} />
        ) : (
          <InfoRow label={t("phone.forget")} detail={t("phone.forgetUnplugFirst")} />
        )}
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  state: {
    paddingTop: 60,
  },
});
