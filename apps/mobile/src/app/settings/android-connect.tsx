import * as Haptics from "expo-haptics";
import { Stack } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FullAccessGate } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, Segmented } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { ActionRow, TestResult, TextRow } from "@/components/tool-form";
import { errorText } from "@/lib/api";
import { leave, machinesApi, refreshPhones, splitAddress } from "@/lib/machines";
import { space } from "@/lib/theme";

type Mode = "pair" | "connect";

/**
 * Wireless debugging, like the desktop's Wi-Fi dialog: the first time with the phone's six-digit pairing code (Android
 * 11 and newer), then the address it shows. The phone and the computer have to be on the same network.
 */
export default function AndroidConnect() {
  const { t } = useTranslation("machines");
  const [mode, setMode] = useState<Mode>("pair");
  const [pairing, setPairing] = useState("");
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = splitAddress(address);
  const pair = splitAddress(pairing);
  const pairReady = mode === "connect" || (/^\d{6}$/.test(code.trim()) && !!pair.port);
  const ready = !!target.host && !!target.port && pairReady;

  const submit = async () => {
    if (busy) return;
    if (!ready) return Alert.alert(t("wifi.checkTitle"), mode === "pair" && !pairReady ? t("wifi.pairMissing") : t("wifi.addressMissing"));
    setBusy(true);
    setError(null);
    try {
      const res = await machinesApi.android.connect({
        host: target.host || pair.host,
        port: target.port,
        ...(mode === "pair" ? { pairingCode: code.trim(), pairingPort: pair.port } : {}),
      });
      void refreshPhones();
      if (!res.ok) {
        setError(res.message);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      Alert.alert(t("wifi.connected"), res.message || undefined);
      leave("/settings/android");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: t("wifi.title"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate>
        <HeaderActions actions={[{ icon: "check", label: mode === "pair" ? t("wifi.pairAndConnect") : t("wifi.connect"), prominent: true, onPress: () => void submit() }]} />
        <View style={styles.segment}>
          <Segmented
            options={[
              { value: "pair", label: t("wifi.firstTime") },
              { value: "connect", label: t("wifi.pairedBefore") },
            ]}
            value={mode}
            onChange={(next) => {
              setMode(next);
              setError(null);
            }}
          />
        </View>

        {mode === "pair" ? (
          <Group title={t("wifi.pairTitle")} footer={t("wifi.pairHint")}>
            <TextRow label={t("wifi.address")} value={pairing} onChange={setPairing} placeholder="192.168.1.20:37099" keyboardType="numbers-and-punctuation" mono />
            <TextRow label={t("wifi.code")} value={code} onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))} placeholder="123456" keyboardType="number-pad" mono />
          </Group>
        ) : null}

        <Group title={t("wifi.connectTitle")} footer={t("wifi.addressHint")}>
          <TextRow label={t("wifi.address")} value={address} onChange={setAddress} placeholder="192.168.1.20:41235" keyboardType="numbers-and-punctuation" mono />
        </Group>

        <Group>
          <ActionRow icon="phone" title={busy ? t("wifi.connecting") : mode === "pair" ? t("wifi.pairAndConnect") : t("wifi.connect")} busy={busy} onPress={() => void submit()} />
          {error && !busy ? <TestResult ok={false} title={t("wifi.failed")} body={error} /> : null}
        </Group>
      </FullAccessGate>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  segment: {
    paddingHorizontal: space.xs,
  },
});
