import { router, Stack } from "expo-router";
import { StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow } from "@/components/form";
import { SettingsScroll } from "@/components/settings-scroll";
import { archiveCount, useArchiveList } from "@/lib/archive";
import { useSettings } from "@/lib/setup";
import { space } from "@/lib/theme";

/** The optional features (Settings → Features); calls are `phone`, VMs `vm`. */
const FEATURES = ["activity", "artifacts", "integrations", "plugins", "messaging", "phone", "cards", "vm", "ssh", "sshKeys", "android"] as const;

/** Settings → Advanced: what people come for rarely, each with its own screen. */
export default function Advanced() {
  const { t } = useTranslation(["settings", "archive", "admin", "programs"]);
  const s = useSettings().data;
  const archived = archiveCount(useArchiveList().data);

  return (
    <SettingsScroll contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("overview.links.advanced") }} />
      <CloseButton />

      <Group>
        <LinkRow icon="pulse" title={t("overview.links.health")} onPress={() => router.push("/settings/health")} />
        <LinkRow icon="terminal" title={t("programs:title")} onPress={() => router.push("/settings/programs")} />
        <LinkRow icon="list" title={t("overview.links.logs")} onPress={() => router.push("/settings/logs")} />
      </Group>

      <Group>
        <LinkRow icon="archive" title={t("archive:title")} value={archived ? String(archived) : undefined} onPress={() => router.push("/settings/archive")} />
        <LinkRow icon="download" title={t("admin:backup.title")} onPress={() => router.push("/settings/backup")} />
        <LinkRow icon="broom" title={t("overview.links.cleanup")} onPress={() => router.push("/settings/cleanup")} />
      </Group>

      <Group>
        <LinkRow icon="cpu" title={t("overview.links.devices")} onPress={() => router.push("/settings/devices")} />
        <LinkRow icon="phone" title={t("admin:phones.title")} onPress={() => router.push("/settings/phones")} />
        <LinkRow icon="network" title={t("overview.links.cloud")} onPress={() => router.push("/settings/cloud")} />
        <LinkRow icon="plug" title={t("overview.links.connected")} onPress={() => router.push("/settings/connected-apps")} />
      </Group>

      <Group>
        <LinkRow
          icon="puzzle"
          title={t("overview.links.features")}
          value={s ? t("overview.features.on", { count: FEATURES.filter((f) => s[f].enabled).length }) : undefined}
          onPress={() => router.push("/settings/features")}
        />
        <LinkRow icon="key" title={t("overview.links.license")} onPress={() => router.push("/settings/license")} />
        <LinkRow icon="bolt" title={t("overview.links.about")} onPress={() => router.push("/settings/about")} />
      </Group>
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
