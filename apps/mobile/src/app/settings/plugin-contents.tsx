import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Linking, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatBytes, MOD_HOOKS_PATH, MOD_MANIFEST_PATH, type Mod } from "@godmode/shared";
import { FullAccessGate } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, PickerRow } from "@/components/form";
import { NeedsFullAccessScreen } from "@/components/full-access";
import { NameList } from "@/components/plugin-parts";
import { InfoRow } from "@/components/status-rows";
import { ErrorState, LoadingState, T } from "@/components/ui";
import { errorText } from "@/lib/api";
import { intlLocale } from "@/lib/i18n";
import { usePlugins } from "@/lib/integrations";
import { fonts, radius, space, useColors } from "@/lib/theme";

const rank = (p: string) => (p === MOD_MANIFEST_PATH ? 0 : p === MOD_HOOKS_PATH ? 1 : 2);

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text.replace(/\n$/, "");
  }
}

/** What a plugin from a repository brings, and its manifest and hooks to read, like the desktop's Contents tab. */
export default function PluginContents() {
  const { t } = useTranslation("tools");
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = usePlugins();
  const mod = list.data?.find((m) => m.id === id);
  return (
    <>
      <Stack.Screen options={{ title: t("pluginAdmin.contents"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate locked={<NeedsFullAccessScreen />}>
        {mod?.source ? (
          <Contents mod={mod} />
        ) : list.isLoading ? (
          <LoadingState />
        ) : (
          <ErrorState title={list.isError ? t("pluginAdmin.loadFailed") : t("pluginAdmin.notFound")} error={list.isError ? errorText(list.error) : t("pluginAdmin.maybeDeleted")} onRetry={() => void list.refetch()} />
        )}
      </FullAccessGate>
    </>
  );
}

function Contents({ mod }: { mod: Mod }) {
  const c = useColors();
  const { t } = useTranslation("tools");
  const source = mod.source!;
  const contents = mod.contents;
  const paths = Object.keys(mod.files).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const [picked, setPicked] = useState<string | null>(null);
  const path = picked && picked in mod.files ? picked : (paths[0] ?? null);
  const browse = source.web?.startsWith("https://github.com/") ? `${source.web}/tree/${source.commit}${source.path ? `/${source.path}` : ""}` : null;
  const empty = contents && !contents.skills.length && !contents.agents.length && !contents.commands.length && !contents.hooks.length && !contents.mcpServers.length;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {contents ? (
        <>
          <Group>
            <InfoRow label={t("pluginAdmin.contentsView.version")} value={source.version ?? "-"} mono />
            <InfoRow label={t("pluginAdmin.contentsView.commit")} value={source.commit.slice(0, 7)} mono />
            <InfoRow label={t("pluginAdmin.contentsView.files")} value={`${contents.files.toLocaleString(intlLocale())} · ${formatBytes(contents.bytes)}`} mono />
            {contents.alwaysOnTokens != null ? <InfoRow label={t("pluginAdmin.contentsView.everySession")} value={`${contents.alwaysOnTokens.toLocaleString(intlLocale())} tokens`} mono /> : null}
          </Group>
          <NameList title={t("pluginAdmin.contentsView.skills")} names={contents.skills} />
          <NameList title={t("pluginAdmin.contentsView.subagents")} names={contents.agents} />
          <NameList title={t("pluginAdmin.contentsView.commands")} names={contents.commands} prefix="/" />
          <NameList title={t("pluginAdmin.contentsView.hooks")} names={contents.hooks} />
          <NameList title={t("pluginAdmin.contentsView.mcpServers")} names={contents.mcpServers} />
          {empty ? (
            <T variant="footnote" muted>
              {t("pluginAdmin.contentsView.nothingFound")}
            </T>
          ) : null}
        </>
      ) : (
        <T variant="footnote" muted>
          {t("pluginAdmin.contentsView.unknown")}
        </T>
      )}

      {path ? (
        <Group title={t("pluginAdmin.contentsView.manifestAndHooks")}>
          {paths.length > 1 ? <PickerRow title={t("pluginAdmin.code.file")} value={path} options={paths.map((p) => ({ value: p, label: p.split("/").pop() ?? p, detail: p }))} onChange={setPicked} /> : null}
          <View style={[styles.code, { backgroundColor: c.sunken }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <T selectable style={[styles.text, { color: c.text }]}>
                {pretty(mod.files[path] ?? "")}
              </T>
            </ScrollView>
          </View>
          {browse ? <LinkRow icon="link" title={t("pluginAdmin.contentsView.browseGitHub")} onPress={() => void Linking.openURL(browse)} /> : null}
        </Group>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingBottom: 60, gap: space.xl },
  code: { margin: space.md, padding: space.md, borderRadius: radius.md, borderCurve: "continuous" },
  text: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 17 },
});
