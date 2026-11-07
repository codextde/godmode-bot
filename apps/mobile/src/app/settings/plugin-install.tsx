import { router, Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { githubRepoOf, type Mod, type ModCatalogEntry, type ModInstallInput, type ModTemplate } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { NeedsFullAccessScreen } from "@/components/full-access";
import { FullAccessGate, isRefused } from "@/components/admin";
import { ChoiceRow, Group, SwitchRow } from "@/components/form";
import { Icon } from "@/components/icon";
import { ActionRow, TextRow } from "@/components/tool-form";
import { Badge, ErrorState, SkeletonRows, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { usePlugins } from "@/lib/integrations";
import { PickPlugin, pluginsAdmin, putPlugin, usePluginCatalog, usePluginTemplates } from "@/lib/plugins-admin";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space, useColors } from "@/lib/theme";

/** Add a plugin (desktop: install dialog, featured plugins and gallery): from GitHub, from the featured list, or one made by Godmode. */
export default function PluginInstall() {
  const { t } = useTranslation("tools");
  return (
    <>
      <Stack.Screen options={{ title: t("pluginAdmin.add") }} />
      <CloseButton />
      <FullAccessGate locked={<NeedsFullAccessScreen />}>
        <AddPlugin />
      </FullAccessGate>
    </>
  );
}

const open = (mod: Mod) => router.replace({ pathname: "/settings/plugin", params: { id: mod.id } });

function AddPlugin() {
  const { t } = useTranslation(["tools", "common", "components"]);
  const mods = usePlugins();
  const catalog = usePluginCatalog();
  const templates = usePluginTemplates();
  const pull = usePullRefresh(() => Promise.all([catalog.refetch(), templates.refetch(), mods.refetch()]));
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [choices, setChoices] = useState<PickPlugin["plugins"] | null>(null);
  const [plugin, setPlugin] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const installed = mods.data ?? [];

  const trimmed = source.trim();
  const repo = githubRepoOf(trimmed);
  const url = /^(https?:\/\/|ssh:\/\/|git@)/.test(trimmed);
  const problem = trimmed && !repo && !url ? t("pluginAdmin.install.invalid") : null;
  const fail = (title: string, err: unknown) => Alert.alert(isRefused(err) ? t("components:fullAccess.title") : title, isRefused(err) ? undefined : errorText(err));

  const install = async (input: ModInstallInput, key: string, label: string) => {
    if (busy) return;
    setBusy(key);
    try {
      const mod = await pluginsAdmin.install(input);
      putPlugin(mod);
      tap();
      if (mod.check && !mod.check.ok) Alert.alert(t("pluginAdmin.install.refused", { title: mod.title }), mod.check.errors[0]?.message);
      open(mod);
    } catch (err) {
      if (err instanceof PickPlugin && err.plugins.length) {
        setChoices(err.plugins);
        setPlugin(err.plugins[0]!.name);
      } else fail(t("pluginAdmin.install.failed", { name: label }), err);
    } finally {
      setBusy(null);
    }
  };
  const installRepo = () => {
    if (!trimmed || problem) return;
    void install({ source: trimmed, ref: ref.trim() || undefined, plugin: plugin || undefined, enabled }, "repo", repo ?? trimmed);
  };
  const add = async (template: ModTemplate) => {
    if (busy) return;
    setBusy(template.id);
    try {
      const mod = await pluginsAdmin.create({ templateId: template.id });
      putPlugin(mod);
      tap();
      open(mod);
    } catch (err) {
      fail(t("pluginAdmin.gallery.addFailed"), err);
    } finally {
      setBusy(null);
    }
  };
  const confirmInstall = (entry: ModCatalogEntry) =>
    Alert.alert(t("pluginAdmin.featured.confirmTitle", { title: entry.title }), t("pluginAdmin.install.warning"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("pluginAdmin.featured.install"), onPress: () => void install({ source: entry.repo, catalogId: entry.id }, entry.id, entry.title) },
    ]);
  const fromCatalog = (entry: ModCatalogEntry) => installed.find((m) => m.source?.repo.toLowerCase() === entry.repo.toLowerCase());
  const fromTemplate = (template: ModTemplate) => installed.find((m) => m.templateId === template.id);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      refreshControl={<RefreshControl {...pull} />}
    >
      <Group title={t("pluginAdmin.install.title")} footer={problem ?? (repo ? `github.com/${repo}` : t("pluginAdmin.install.hint"))}>
        <TextRow
          label={t("pluginAdmin.install.repository")}
          value={source}
          onChange={(v) => {
            setSource(v);
            setChoices(null);
            setPlugin("");
          }}
          placeholder="owner/repo"
          keyboardType="url"
          mono
        />
        <TextRow label={t("pluginAdmin.install.ref")} value={ref} onChange={setRef} placeholder="main" keyboardType="url" mono />
        <SwitchRow title={t("pluginAdmin.install.enable")} value={enabled} onChange={setEnabled} />
      </Group>
      {choices ? (
        <Group title={t("pluginAdmin.install.choices", { count: choices.length })}>
          {choices.map((x) => (
            <ChoiceRow key={x.name} title={x.name} detail={x.description || undefined} selected={plugin === x.name} onPress={() => setPlugin(x.name)} />
          ))}
        </Group>
      ) : null}
      <Group footer={t("pluginAdmin.install.warning")}>
        <ActionRow icon="external" title={busy === "repo" ? t("pluginAdmin.install.pending") : t("pluginAdmin.install.install")} busy={busy === "repo"} onPress={installRepo} />
      </Group>

      <Group title={t("pluginAdmin.featured.title")}>
        {catalog.isLoading ? (
          <SkeletonRows count={2} avatar={30} />
        ) : catalog.isError ? (
          <ErrorState title={t("pluginAdmin.featured.loadFailed")} error={errorText(catalog.error)} onRetry={() => void catalog.refetch()} />
        ) : (
          (catalog.data ?? []).map((entry) => {
            const mod = fromCatalog(entry);
            return (
              <AddRow
                key={entry.id}
                title={entry.title}
                detail={[entry.description, `${entry.repo}${entry.requires.length ? ` · ${t("pluginAdmin.featured.needs", { list: entry.requires.join(", ") })}` : ""}`].join("\n")}
                state={mod ? "added" : busy === entry.id ? "busy" : "add"}
                action={t("pluginAdmin.featured.install")}
                onPress={() => (mod ? open(mod) : confirmInstall(entry))}
              />
            );
          })
        )}
      </Group>

      <Group title={t("pluginAdmin.gallery.title")} footer={t("pluginAdmin.gallery.footer")}>
        {templates.isLoading ? (
          <SkeletonRows count={3} avatar={30} />
        ) : templates.isError ? (
          <ErrorState title={t("pluginAdmin.gallery.loadFailed")} error={errorText(templates.error)} onRetry={() => void templates.refetch()} />
        ) : (
          (templates.data ?? []).map((template) => {
            const mod = fromTemplate(template);
            return (
              <AddRow
                key={template.id}
                title={template.title}
                detail={`${t(`pluginAdmin.categories.${template.category}`)} · ${template.description}`}
                state={mod ? "added" : busy === template.id ? "busy" : "add"}
                action={t("pluginAdmin.gallery.add")}
                onPress={() => (mod ? open(mod) : void add(template))}
              />
            );
          })
        )}
      </Group>
    </ScrollView>
  );
}

/** One plugin to add. Only the button adds it (it runs in every agent's turns); a plugin already here opens from anywhere in its row. */
function AddRow({ title, detail, state, action, onPress }: { title: string; detail: string; state: "add" | "added" | "busy"; action: string; onPress: () => void }) {
  const c = useColors();
  const { t } = useTranslation("tools");
  const press = () => {
    tap();
    onPress();
  };
  return (
    <Pressable accessibilityRole={state === "added" ? "button" : undefined} disabled={state !== "added"} onPress={press} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}>
      <View style={[styles.tile, { backgroundColor: c.sunken }]}>
        <Icon name="puzzle" size={15} color={c.text} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="callout" style={{ fontWeight: "500" }} numberOfLines={1}>
          {title}
        </T>
        <T variant="footnote" muted numberOfLines={3}>
          {detail}
        </T>
      </View>
      {state === "busy" ? (
        <ActivityIndicator size="small" color={c.textMuted} />
      ) : state === "added" ? (
        <Badge label={t("pluginAdmin.gallery.added")} tone="success" />
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={`${action}: ${title}`} hitSlop={6} onPress={press} style={({ pressed }) => [styles.pill, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}>
          <T variant="footnote" style={{ fontWeight: "600" }}>
            {action}
          </T>
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 56,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  tile: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  pill: {
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    justifyContent: "center",
  },
});
