import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { effortLabel, findModel } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow } from "@/components/form";
import { Logo } from "@/components/logo";
import { SettingsSearchResults } from "@/components/settings-search";
import { T } from "@/components/ui";
import { api } from "@/lib/api";
import { currentLanguage } from "@/lib/i18n";
import { useModelCatalog } from "@/lib/composer";
import { useAgents } from "@/lib/hooks";
import { usePluginsWaiting } from "@/lib/integrations";
import { useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { useSession } from "@/lib/session";
import { useSettings } from "@/lib/setup";
import { space, useColors } from "@/lib/theme";
import { useWorkspace } from "@/lib/workspace";

/** Settings: what people come for. The rest sits behind AI, Integrations and Advanced, and the search finds all of it. */
export default function Settings() {
  const c = useColors();
  const { t } = useTranslation(["settings", "common", "vault", "files", "integrations", "admin", "manage"]);
  const connection = useSession((s) => s.connection);
  const status = useLive((s) => s.status);
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const settings = useSettings();
  const catalog = useModelCatalog();
  const { workspaces } = useWorkspace();
  const { data: agents } = useAgents();
  const pluginsWaiting = usePluginsWaiting();
  const [search, setSearch] = useState("");
  const searchBar = <Stack.SearchBar placeholder={t("manage:search.placeholder")} autoCapitalize="none" onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />;

  if (!connection) return null;
  // Same root and leading children as below, so the search bar keeps its focus while results replace the list.
  if (search.trim()) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}>
        <Stack.Screen options={{ title: t("common:words.settings") }} />
        {searchBar}
        <CloseButton />
        <SettingsSearchResults query={search} />
      </ScrollView>
    );
  }
  const instance = me.data?.instance ?? connection.instance;
  const s = settings.data;
  const model = s ? (findModel(catalog.data?.models ?? [], s.runner.model)?.label ?? s.runner.model) : undefined;
  const projects = workspaces.reduce((n, w) => n + w.projects.length, 0);
  const state = status === "online" ? t("overview.status.connected") : status === "connecting" ? t("overview.status.connecting") : t("overview.status.outOfReach");

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("common:words.settings") }} />
      {searchBar}
      <CloseButton />

      <Group>
        <LinkRow
          lead={<Logo size={44} />}
          title={instance.name}
          detail={status === "offline" ? <T variant="footnote" color={c.warning}>{state}</T> : state}
          onPress={() => router.push("/settings/this-phone")}
        />
      </Group>

      <Group>
        <LinkRow icon="slider" title={t("overview.links.general")} onPress={() => router.push("/settings/general")} />
        <LinkRow
          icon="bell"
          title={t("overview.links.notifications")}
          value={typeof me.data?.device.push === "boolean" ? (me.data.device.push ? t("common:status.on") : t("common:status.off")) : undefined}
          onPress={() => router.push("/settings/notifications")}
        />
        <LinkRow icon="key" title={t("vault:index.title")} onPress={() => router.push("/settings/vault")} />
      </Group>

      <Group>
        <LinkRow
          icon="sparkles"
          title={t("overview.links.ai")}
          value={s && model ? `${model} · ${effortLabel(s.runner.effort, currentLanguage())}` : undefined}
          onPress={() => router.push("/settings/ai")}
        />
        <LinkRow icon="agents" title={t("common:words.agents")} value={agents ? String(agents.length) : undefined} onPress={() => router.push("/settings/agents")} />
        <LinkRow
          icon="layers"
          title={t("overview.team.workspaces")}
          value={workspaces.length ? `${workspaces.length}${projects ? ` · ${t("overview.team.projects", { count: projects })}` : ""}` : t("overview.team.noneYet")}
          onPress={() => router.push("/settings/workspaces")}
        />
        <LinkRow icon="files" title={t("files:index.title")} onPress={() => router.push("/settings/files")} />
      </Group>

      <Group>
        <LinkRow icon="display" title={t("overview.links.computer")} onPress={() => router.push("/settings/computer")} />
        <LinkRow icon="globe" title={t("overview.links.browser")} onPress={() => router.push("/settings/browser")} />
        <LinkRow icon="plug" title={t("integrations:title")} value={pluginsWaiting ? String(pluginsWaiting) : undefined} onPress={() => router.push("/settings/integrations")} />
      </Group>

      <Group>
        <LinkRow icon="lock" title={t("admin:security.title")} onPress={() => router.push("/settings/security")} />
        <LinkRow icon="more" title={t("overview.links.advanced")} onPress={() => router.push("/settings/advanced")} />
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
});
