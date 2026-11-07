import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Linking, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, SwitchRow } from "@/components/form";
import { SettingsScroll } from "@/components/settings-scroll";
import { QueryState } from "@/components/settings-state";
import { EmptyState } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { disablePush, enablePush, pushPermission, type PushPermission } from "@/lib/push";
import { qk } from "@/lib/query";
import { space } from "@/lib/theme";

/** Settings → Notifications: this phone gets what the computer notifies about, or nothing. */
export default function NotificationsSettings() {
  const { t } = useTranslation("settings");
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const [permission, setPermission] = useState<PushPermission | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);

  const check = useCallback(() => void pushPermission().then(setPermission, () => setPermission(null)), []);
  useEffect(() => {
    check();
    // Back from the phone's settings: the permission may have changed there.
    const sub = AppState.addEventListener("change", (state) => state === "active" && check());
    return () => sub.remove();
  }, [check]);

  const toggle = async (on: boolean) => {
    setPending(on);
    try {
      if (!on) await disablePush();
      else if ((await enablePush()) === "denied") setPermission("denied");
    } catch (err) {
      Alert.alert(t("notifications.failed"), errorText(err));
    } finally {
      setPending(null);
      check();
    }
  };

  return (
    <SettingsScroll contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("notifications.title") }} />
      <CloseButton />
      <QueryState query={me} icon="bell" errorTitle={t("notifications.loadFailed")}>
        {(session) =>
          typeof session.device.push !== "boolean" ? (
            <EmptyState icon="bell" title={t("phone.outdatedTitle")} />
          ) : (
            <>
              <Group>
                <SwitchRow icon="bell" title={t("notifications.switch")} value={pending ?? session.device.push} disabled={pending !== null} onChange={(on) => void toggle(on)} />
              </Group>
              {permission === "denied" ? (
                <Group footer={t("notifications.denied")}>
                  <LinkRow icon="settings" title={t("notifications.openSettings")} onPress={() => void Linking.openSettings()} />
                </Group>
              ) : null}
            </>
          )
        }
      </QueryState>
    </SettingsScroll>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
});
