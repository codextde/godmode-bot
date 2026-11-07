import { router } from "expo-router";
import { useState } from "react";
import { Alert, Linking } from "react-native";
import { useTranslation } from "react-i18next";
import type { LicenseState } from "@godmode/shared";
import { isRefused, useFullAccess } from "./admin";
import { FieldRow, Group, LinkRow } from "./form";
import { InfoRow } from "./status-rows";
import { ActionRow } from "./tool-form";
import { adminApi } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { currentLanguage } from "@/lib/i18n";
import { queryClient } from "@/lib/query";
import { sq } from "@/lib/settings-api";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

/**
 * What the desktop does with the licence, for a phone with full access: a key added, checked again or removed, the
 * subscription managed, and the reminder address for the free trial.
 */
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

  const trial = !s.keyHint && s.status === "grace" && !!s.graceEndsAt && s.enforced;

  return (
    <>
      <Group>
        <LinkRow icon="key" title={s.keyHint ? t("license.change") : t("license.add")} onPress={() => router.push("/settings/license-key")} />
        {s.manageUrl ? <LinkRow icon="external" title={t("licenseExtra.manage")} chevron={false} onPress={() => void Linking.openURL(s.manageUrl!).catch(() => undefined)} /> : null}
        {s.keyHint ? <LinkRow icon="refresh" title={t("license.refresh")} chevron={false} onPress={() => !busy && void run(adminApi.license.refresh)} /> : null}
        {s.keyHint ? <LinkRow icon="trash" title={t("license.remove")} tone="danger" chevron={false} onPress={remove} /> : null}
      </Group>
      {trial ? <ReminderGroup email={s.reminderEmail} /> : null}
    </>
  );
}

/** The address for a heads-up before the free trial ends; nothing leaves the computer until it is typed in. */
function ReminderGroup({ email }: { email: string | null }) {
  const { t } = useTranslation("admin");
  const [busy, setBusy] = useState(false);
  const run = async (call: () => Promise<LicenseState>) => {
    setBusy(true);
    try {
      queryClient.setQueryData(sq.license, await call());
    } catch (err) {
      Alert.alert(t("licenseExtra.reminderFailed"), errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const save = (raw: string) => {
    const next = raw.trim();
    if (!next) return;
    if (!EMAIL.test(next)) return Alert.alert(t("licenseExtra.reminderInvalid"));
    void run(() => adminApi.license.setReminders({ email: next, locale: currentLanguage() }));
  };
  return (
    <Group title={t("licenseExtra.remindersTitle")} footer={email ? undefined : t("licenseExtra.reminderFooter")}>
      {email ? (
        <InfoRow icon="bell" label={t("licenseExtra.reminderOn", { email })} />
      ) : (
        <FieldRow label={t("licenseExtra.reminderEmail")} value="" placeholder={t("licenseExtra.reminderPlaceholder")} keyboardType="email-address" maxLength={254} onCommit={save} />
      )}
      {email ? <ActionRow icon="trash" title={t("licenseExtra.reminderRemove")} tone="danger" busy={busy} onPress={() => void run(adminApi.license.removeReminders)} /> : null}
    </Group>
  );
}
