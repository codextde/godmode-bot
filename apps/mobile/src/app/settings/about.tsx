import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import { Stack } from "expo-router";
import { Linking, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { LICENSE_SITE } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow } from "@/components/form";
import { Logo } from "@/components/logo";
import { InfoRow } from "@/components/status-rows";
import { T } from "@/components/ui";
import { api } from "@/lib/api";
import { qk } from "@/lib/query";
import { useSession } from "@/lib/session";
import { space } from "@/lib/theme";

const PLATFORM: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** Settings → About: which Godmode the computer and this phone run, and where to read more. */
export default function About() {
  const { t } = useTranslation("settings");
  const connection = useSession((s) => s.connection);
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const instance = me.data?.instance ?? connection?.instance;
  const appVersion = Constants.expoConfig?.version ?? "";
  const open = (path: string) => void Linking.openURL(`${LICENSE_SITE}${path}`).catch(() => undefined);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
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

      <Group title={t("about.phone")}>
        <InfoRow icon="phone" label={t("about.version")} value={appVersion} mono />
        <InfoRow icon="cpu" label={t("about.platform")} value={process.env.EXPO_OS === "ios" ? "iOS" : "Android"} />
      </Group>

      <Group footer={t("about.footer")}>
        <LinkRow icon="globe" title={t("about.website")} value="usegodmode.com" onPress={() => open("")} />
        <LinkRow icon="doc" title={t("about.terms")} onPress={() => open("/legal/terms")} />
      </Group>
    </ScrollView>
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
