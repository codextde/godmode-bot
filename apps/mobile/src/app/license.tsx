import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { isLicenseKey, normalizeLicenseKey } from "@godmode/shared";
import { FullAccessGate, isRefused } from "@/components/admin";
import { Icon } from "@/components/icon";
import { showToast } from "@/components/toast";
import { Button, EmptyState, ErrorState, LoadingState, T, tap } from "@/components/ui";
import { adminApi } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { settingsApi, sq } from "@/lib/settings-api";
import { space, useColors } from "@/lib/theme";

const close = () => (router.canGoBack() ? router.back() : router.replace("/"));

/**
 * A `godmode://license?key=…` link. Any web page can open one, so it always asks first; a working key is replaced only
 * when the human says so.
 */
export default function LicenseLink() {
  const { t } = useTranslation("admin");
  const insets = useSafeAreaInsets();
  const { key } = useLocalSearchParams<{ key?: string }>();
  const next = normalizeLicenseKey(typeof key === "string" ? key : "");
  return (
    <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
      {isLicenseKey(next) ? (
        <FullAccessGate>
          <Confirm licenseKey={next} />
        </FullAccessGate>
      ) : (
        <EmptyState icon="key" title={t("licenseLink.invalid")} />
      )}
    </View>
  );
}

function Confirm({ licenseKey }: { licenseKey: string }) {
  const c = useColors();
  const { t } = useTranslation(["admin", "components", "common", "settings"]);
  const license = useQuery({ queryKey: sq.license, queryFn: settingsApi.license.get });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = license.data;
  if (!current) {
    if (license.isError) return <ErrorState title={t("settings:license.loadFailed")} error={errorText(license.error)} onRetry={() => void license.refetch()} />;
    return <LoadingState />;
  }
  const working = !!current.keyHint && !current.blocked;
  const tail = licenseKey.slice(-5);

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      const state = await adminApi.license.set(licenseKey);
      queryClient.setQueryData(sq.license, state);
      if (state.blocked) {
        setError(state.message ?? t("licenseLink.cantUse"));
        return;
      }
      tap();
      if (state.status === "unverified") Alert.alert(t("licenseLink.activated"), state.message ?? undefined);
      else showToast(state.status === "trial" ? t("licenseLink.trialActive") : t("licenseLink.activated"));
      close();
    } catch (err) {
      setError(isRefused(err) ? t("components:fullAccess.title") : `${t("licenseLink.failed")}: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (working && licenseKey.endsWith(current.keyHint!)) {
    return (
      <View style={styles.body}>
        <Icon name="checkCircle" size={30} color={c.success} />
        <T variant="headline" style={styles.center}>
          {t("licenseLink.alreadyActive")}
        </T>
        <Button title={t("common:actions.done")} style={styles.action} onPress={close} />
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <Icon name="key" size={30} color={c.brandStrong} />
      <T variant="headline" style={styles.center}>
        {working ? t("licenseLink.replaceTitle") : t("licenseLink.confirmTitle")}
      </T>
      <T variant="subhead" muted style={styles.center}>
        {working ? t("licenseLink.replaceText", { old: current.keyHint, next: tail }) : t("licenseLink.confirmText", { next: tail })}
      </T>
      {error ? (
        <T variant="footnote" color={c.danger} style={styles.center}>
          {error}
        </T>
      ) : null}
      <Button title={working ? t("licenseLink.replace") : t("licenseLink.activate")} icon="key" loading={busy} style={styles.action} onPress={() => void activate()} />
      <Button title={working ? t("licenseLink.keep") : t("common:actions.cancel")} variant="secondary" disabled={busy} style={styles.action} onPress={close} />
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
  },
  body: {
    alignItems: "center",
    gap: space.md,
  },
  center: {
    textAlign: "center",
  },
  action: {
    alignSelf: "stretch",
  },
});
