import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { FullAccessGate, isRefused } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group } from "@/components/form";
import { InputRow } from "@/components/secret-parts";
import { Button } from "@/components/ui";
import { adminApi } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { qk, queryClient } from "@/lib/query";
import { space } from "@/lib/theme";

const MIN = 10;

/** The password of the browser dashboard (`godmode serve`), separate from the Godmode password. */
export default function DashboardPassword() {
  const { t } = useTranslation(["admin", "common", "components"]);
  const { set } = useLocalSearchParams<{ set?: string }>();
  const change = set === "1";
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const pwError = pw.length > 0 && pw.length < MIN ? t("passwords.minLength", { count: MIN }) : null;
  const confirmError = confirm.length > 0 && confirm !== pw ? t("passwords.mismatch") : null;
  const valid = pw.length >= MIN && pw === confirm;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await adminApi.security.setDashboardPassword(pw);
      void queryClient.invalidateQueries({ queryKey: qk.settings });
      Alert.alert(change ? t("passwords.dashboardChanged") : t("passwords.dashboardSet"), t("passwords.dashboardSessions"));
      router.back();
    } catch (err) {
      Alert.alert(isRefused(err) ? t("components:fullAccess.title") : t("passwords.setFailed"), isRefused(err) ? undefined : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: change ? t("passwords.dashboardChangeTitle") : t("passwords.dashboardSetTitle"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate>
        <Group footer={pwError ?? confirmError ?? t("passwords.dashboardFooter")}>
          <InputRow label={t("passwords.new")} value={pw} onChangeText={setPw} secure autoFocus textContentType="newPassword" />
          <InputRow label={t("passwords.confirm")} value={confirm} onChangeText={setConfirm} secure textContentType="newPassword" onSubmitEditing={() => void submit()} />
        </Group>
        <Button title={change ? t("passwords.changeButton") : t("passwords.setButton")} icon="key" loading={busy} disabled={!valid} onPress={() => void submit()} />
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
});
