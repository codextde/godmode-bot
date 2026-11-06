import { router } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import type { LicenseState } from "@godmode/shared";
import { isRefused, useFullAccess } from "./admin";
import { Group, LinkRow } from "./form";
import { adminApi } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { sq } from "@/lib/settings-api";

/** What the desktop does with the licence, for a phone with full access: a key added, checked again or removed. */
export function LicenseActions({ state: s }: { state: LicenseState }) {
  const { t } = useTranslation(["admin", "common", "components"]);
  const { fullAccess } = useFullAccess();
  const [busy, setBusy] = useState(false);
  if (!fullAccess) return null;

  const run = async (call: () => Promise<LicenseState>) => {
    setBusy(true);
    try {
      queryClient.setQueryData(sq.license, await call());
    } catch (err) {
      Alert.alert(isRefused(err) ? t("components:fullAccess.title") : t("license.failed"), isRefused(err) ? undefined : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    Alert.alert(t("license.removeTitle"), s.enforced ? t("license.removeEnforced") : t("license.removeFree"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("license.remove"), style: "destructive", onPress: () => void run(adminApi.license.remove) },
    ]);

  return (
    <Group>
      <LinkRow icon="key" title={s.keyHint ? t("license.change") : t("license.add")} onPress={() => router.push("/settings/license-key")} />
      {s.keyHint ? <LinkRow icon="refresh" title={t("license.refresh")} chevron={false} onPress={() => !busy && void run(adminApi.license.refresh)} /> : null}
      {s.keyHint ? <LinkRow icon="trash" title={t("license.remove")} tone="danger" chevron={false} onPress={remove} /> : null}
    </Group>
  );
}
