import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { toE164 } from "@godmode/shared";
import { FullAccessGate } from "@/components/admin";
import { Group } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { TextRow } from "@/components/tool-form";
import { errorText } from "@/lib/api";
import { callsAdmin, ck } from "@/lib/calls-admin";
import { queryClient } from "@/lib/query";
import { space } from "@/lib/theme";

/** Settings → Calls → a Twilio number brought into ElevenLabs. The token goes to ElevenLabs once; Godmode keeps nothing of it. */
export default function CallNumber() {
  const { t } = useTranslation("admin");
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("callSetup.importTwilio"), headerLargeTitleEnabled: false }} />
      <FullAccessGate>
        <NumberForm />
      </FullAccessGate>
    </ScrollView>
  );
}

function NumberForm() {
  const { t } = useTranslation(["admin", "common"]);
  const [number, setNumber] = useState("");
  const [label, setLabel] = useState("");
  const [sid, setSid] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    const e164 = toE164(number);
    if (!e164) return Alert.alert(t("calls.invalidNumber"));
    if (!sid.trim() || !token.trim()) return Alert.alert(t("callSetup.needsTwilio"));
    setSaving(true);
    try {
      queryClient.setQueryData(ck.setup, await callsAdmin.importNumber({ number: e164, label: label.trim() || undefined, sid: sid.trim(), token: token.trim() }));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      router.back();
    } catch (err) {
      Alert.alert(t("callSetup.importFailed"), errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <HeaderActions actions={[{ icon: "check", label: t("callSetup.import"), prominent: true, onPress: () => void save() }]} />
      <Group>
        <TextRow label={t("callSetup.number")} value={number} onChange={setNumber} placeholder="+1 415 555 0123" keyboardType="phone-pad" mono />
        <TextRow label={t("callSetup.label")} value={label} onChange={setLabel} placeholder={t("callSetup.labelPlaceholder")} maxLength={100} />
      </Group>
      <Group title="Twilio">
        <TextRow label="Account SID" value={sid} onChange={setSid} placeholder="AC…" mono />
        <TextRow label="Auth Token" value={token} onChange={setToken} secure />
      </Group>
      {saving ? <ActivityIndicator /> : null}
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
