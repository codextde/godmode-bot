import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import { Stack } from "expo-router";
import { Alert, Linking, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { LICENSE_SITE } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow } from "@/components/form";
import { Logo } from "@/components/logo";
import { SettingsScroll } from "@/components/settings-scroll";
import { InfoRow } from "@/components/status-rows";
import { T } from "@/components/ui";
import { api } from "@/lib/api";
import { qk } from "@/lib/query";
import { copyPlain } from "@/lib/secrets";
import { useSession } from "@/lib/session";
import { space } from "@/lib/theme";

const PLATFORM: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** Settings → About: which Godmode the computer and this phone run, and where to read more. */
export default function About() {
  const { t } = useTranslation(["settings", "manage"]);
  const connection = useSession((s) => s.connection);
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const boot = useQuery({ queryKey: qk.bootstrap, queryFn: api.bootstrap });
  const dataDir = boot.data?.dataDir ?? "";
  // The desktop's Settings → System → Installation: where Godmode keeps its data and writes its log.
  const sep = dataDir.includes("\\") ? "\\" : "/";
  const logPath = dataDir ? [dataDir.replace(/[\\/]+$/, ""), "logs", "godmode.jsonl"].join(sep) : "";
  const copy = (value: string) => void copyPlain(value).then(() => Alert.alert(t("manage:install.copied"), value));
  const instance = me.data?.instance ?? connection?.instance;
  const appVersion = Constants.expoConfig?.version ?? "";

  return (
    <SettingsScroll contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("about.title") }} />
      <CloseButton />

      <View style={styles.hero}>
        <Logo size={72} />
        <T variant="title">Godmode</T>
      </View>

      {instance ? (
        <Group title={t("about.computer")}>
          <InfoRow icon="display" label={t("about.name")} value={instance.name} />
          <InfoRow icon="bolt" label={t("about.version")} value={instance.version} mono />
          <InfoRow icon="cpu" label={t("about.platform")} value={PLATFORM[instance.platform] ?? instance.platform} />
        </Group>
      ) : null}

      {dataDir ? (
        <Group title={t("manage:install.title")}>
          <LinkRow icon="folder" title={t("manage:install.dataDir")} detail={dataDir} chevron={false} onPress={() => copy(dataDir)} />
          <LinkRow icon="list" title={t("manage:install.logFile")} detail={logPath} chevron={false} onPress={() => copy(logPath)} />
        </Group>
      ) : null}

      <Group title={t("about.phone")}>
        <InfoRow icon="phone" label={t("about.version")} value={appVersion} mono />
        <InfoRow icon="cpu" label={t("about.platform")} value={process.env.EXPO_OS === "ios" ? "iOS" : "Android"} />
      </Group>

      <Group footer={t("about.footer")}>
        <LinkRow icon="doc" title={t("about.terms")} onPress={() => void Linking.openURL(`${LICENSE_SITE}/legal/terms`).catch(() => undefined)} />
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
  hero: {
    alignItems: "center",
    gap: space.md,
    paddingTop: space.sm,
  },
});
