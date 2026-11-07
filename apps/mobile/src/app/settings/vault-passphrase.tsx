import { router, Stack } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { FullAccessGate, isRefused } from "@/components/admin";
import { Group } from "@/components/form";
import { InputRow } from "@/components/secret-parts";
import { Button, T } from "@/components/ui";
import { adminApi } from "@/lib/admin";
import { ApiError, errorText } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { vk } from "@/lib/vault";
import { space, useColors } from "@/lib/theme";

/** A new Godmode password for the vault: its key is wrapped again, the secrets stay as they are. */
export default function VaultPassphrase() {
  const c = useColors();
  const { t } = useTranslation(["admin", "common", "components"]);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextError = next.length > 0 && next.length < 8 ? t("passwords.minLength", { count: 8 }) : next && next === current ? t("passwords.different") : null;
  const confirmError = confirm.length > 0 && confirm !== next ? t("passwords.mismatch") : null;
  const valid = current.length > 0 && next.length >= 8 && next === confirm && next !== current;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.security.changePassphrase(current, next);
      void queryClient.invalidateQueries({ queryKey: vk.status });
      Alert.alert(t("passwords.changed"), t("passwords.changedBody"));
      router.back();
    } catch (err) {
      if (isRefused(err)) setError(t("components:fullAccess.title"));
      else if (err instanceof ApiError && (err.status === 400 || err.status === 401 || err.status === 403)) setError(err.message || t("passwords.incorrect"));
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("passwords.changeTitle"), headerLargeTitleEnabled: false }} />
      <FullAccessGate>
        <Group
          footer={
            error ? (
              <T variant="footnote" color={c.danger}>
                {error}
              </T>
            ) : undefined
          }
        >
          <InputRow label={t("passwords.current")} value={current} onChangeText={(v) => {
              setCurrent(v);
              setError(null);
            }} secure autoFocus textContentType="password" />
        </Group>
        <Group footer={nextError ?? confirmError ?? t("passwords.noRecovery")}>
          <InputRow label={t("passwords.new")} value={next} onChangeText={setNext} secure textContentType="newPassword" />
          <InputRow label={t("passwords.confirm")} value={confirm} onChangeText={setConfirm} secure textContentType="newPassword" onSubmitEditing={() => void submit()} />
        </Group>
        <Button title={t("passwords.changeButton")} icon="key" loading={busy} disabled={!valid} onPress={() => void submit()} />
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
