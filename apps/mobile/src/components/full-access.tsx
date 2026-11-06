import * as LocalAuthentication from "expo-local-authentication";
import { useQuery } from "@tanstack/react-query";
import { Alert, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { EmptyState } from "./ui";
import { api, ApiError } from "@/lib/api";
import { t } from "@/lib/i18n";
import { qk } from "@/lib/query";
import { space } from "@/lib/theme";

/**
 * Full access: the computer lets this phone do what the desktop app does (secrets, keys, security). Read from the
 * phone's own session; `undefined` while it loads, false on computers that don't know full access yet.
 */
export function useFullAccess(): { fullAccess: boolean | undefined } {
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  if (me.data) return { fullAccess: (me.data as { fullAccess?: unknown }).fullAccess === true };
  return { fullAccess: me.isError ? false : undefined };
}

/** The computer refused this because the phone has no full access (or runs an older Godmode). */
export function needsFullAccess(err: unknown): boolean {
  return err instanceof ApiError && err.code === "device_forbidden";
}

/** Where an action needs full access: what to do about it, in place of the screen's content. */
export function NeedsFullAccess({ style }: { style?: StyleProp<ViewStyle> }) {
  const { t: tr } = useTranslation("components");
  return <EmptyState icon="lock" title={tr("fullAccess.title")} style={style} />;
}

/** A whole screen that needs full access. */
export function NeedsFullAccessScreen() {
  return (
    <View style={styles.center}>
      <NeedsFullAccess />
    </View>
  );
}

/**
 * Face ID (or Touch ID, or the phone's passcode) before a secret shows, every time. A phone without any of them set up
 * asks with a plain confirmation instead. Resolves false when the human cancels.
 */
export async function confirmWithBiometrics(reason: string): Promise<boolean> {
  // Anything that goes wrong on the way refuses: a secret never shows because the check failed.
  const level = await LocalAuthentication.getEnrolledLevelAsync().catch(() => null);
  if (level === null) return false;
  if (level !== LocalAuthentication.SecurityLevel.NONE) {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: t("common:actions.cancel"), disableDeviceFallback: false }).catch(() => null);
    if (!result) return false;
    if (result.success) return true;
    if (result.error !== "not_enrolled" && result.error !== "passcode_not_set") return false;
  }
  return new Promise((resolve) => {
    Alert.alert(reason, t("components:fullAccess.noLock"), [
      { text: t("common:actions.cancel"), style: "cancel", onPress: () => resolve(false) },
      { text: t("common:actions.continue"), onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    padding: space.lg,
  },
});
