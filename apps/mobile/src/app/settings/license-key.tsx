import { router, Stack } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { FullAccessGate, isRefused } from "@/components/admin";
import { Group } from "@/components/form";
import { InputRow } from "@/components/secret-parts";
import { Button, T } from "@/components/ui";
import { adminApi } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { sq } from "@/lib/settings-api";
import { space, useColors } from "@/lib/theme";

/** A licence key for this computer, typed or pasted on the phone. */
export default function LicenseKey() {
  const c = useColors();
  const { t } = useTranslation(["admin", "components"]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const next = key.trim();
    if (!next || busy) return;
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(sq.license, await adminApi.license.set(next));
      void queryClient.invalidateQueries({ queryKey: sq.license });
      router.back();
    } catch (err) {
      setError(isRefused(err) ? t("components:fullAccess.title") : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("license.keyTitle"), headerLargeTitleEnabled: false }} />
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
          <InputRow label={t("license.key")} value={key} onChangeText={setKey} mono autoFocus placeholder="GM-…" onSubmitEditing={() => void save()} />
        </Group>
        <Button title={t("license.save")} icon="key" loading={busy} disabled={!key.trim()} onPress={() => void save()} />
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
