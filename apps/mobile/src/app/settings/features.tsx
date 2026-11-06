import { router, Stack } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import type { Settings } from "@godmode/shared";
import { useFullAccess } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, SwitchRow } from "@/components/form";
import type { IconName } from "@/components/icon";
import { QueryState } from "@/components/settings-state";
import type { SettingsPatch } from "@/lib/api";
import { patchSettings, useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

type Feature = "activity" | "artifacts" | "integrations" | "plugins" | "messaging" | "phone" | "cards" | "vm" | "ssh" | "sshKeys" | "android";

/** In the desktop's order. `phone`: may also go back on from the phone; the others widen what agents reach and go on at the computer. */
const FEATURES: { id: Feature; icon: IconName; phone: boolean }[] = [
  { id: "activity", icon: "pulse", phone: true },
  { id: "artifacts", icon: "artifact", phone: true },
  { id: "integrations", icon: "plug", phone: false },
  { id: "plugins", icon: "puzzle", phone: false },
  { id: "messaging", icon: "chats", phone: false },
  { id: "phone", icon: "call", phone: false },
  { id: "cards", icon: "creditCard", phone: false },
  { id: "vm", icon: "vm", phone: false },
  { id: "ssh", icon: "server", phone: false },
  { id: "sshKeys", icon: "key", phone: false },
  { id: "android", icon: "phone", phone: false },
];

const enabledOf = (s: Settings, id: Feature): boolean | undefined => (s as unknown as Partial<Record<Feature, { enabled?: boolean }>>)[id]?.enabled;

/** Settings → Features: every optional feature off from here; only the harmless ones back on, unless this phone has full access. */
export default function Features() {
  const { t } = useTranslation(["settings", "common"]);
  const settings = useSettings();
  const { fullAccess } = useFullAccess();

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("features.title") }} />
      <CloseButton />
      <QueryState query={settings} icon="puzzle" errorTitle={t("features.loadFailed")}>
        {(s) => (
          <Group footer={fullAccess ? undefined : t("features.footer")}>
            {FEATURES.flatMap(({ id, icon, phone }) => {
              const on = enabledOf(s, id);
              // An older Godmode on the computer doesn't have this feature yet.
              if (on === undefined) return [];
              const row = (
                <SwitchRow
                  key={id}
                  icon={icon}
                  title={t(`features.${id}.title`)}
                  detail={t(`features.${id}.detail`)}
                  value={on}
                  disabled={!on && !phone && !fullAccess}
                  onChange={(enabled) => void patchSettings({ [id]: { enabled } } as SettingsPatch)}
                />
              );
              return id === "phone" && on
                ? [row, <LinkRow key="persona" icon="personCircle" title={t("features.phone.persona")} onPress={() => router.push("/settings/calls")} />]
                : [row];
            })}
          </Group>
        )}
      </QueryState>
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
