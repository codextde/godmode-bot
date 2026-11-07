import { Stack, router, useLocalSearchParams } from "expo-router";
import { useState, type ReactNode } from "react";
import { Alert, Linking, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MOD_HOOKS_PATH, MOD_MANIFEST_PATH, type Mod, type ModCatalogEntry, type ModOption, type ModTemplate } from "@godmode/shared";
import { FullAccessGate, isRefused } from "@/components/admin";
import { CloseButton } from "@/components/close-button";
import { Group, LinkRow, PickerRow } from "@/components/form";
import { NeedsFullAccessScreen } from "@/components/full-access";
import { Icon } from "@/components/icon";
import { pluginIcon } from "@/components/plugin-parts";
import { CopyButton } from "@/components/secret-parts";
import { Badge, Button, ErrorState, LoadingState, Row, T, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { usePlugins } from "@/lib/integrations";
import { pluginsAdmin, putPlugin, usePluginCatalog, usePluginTemplates } from "@/lib/plugins-admin";
import { copyPlain } from "@/lib/secrets";
import { fonts, radius, space, useColors } from "@/lib/theme";

const open = (mod: Mod) => router.replace({ pathname: "/settings/plugin", params: { id: mod.id } });

/** A plugin before it is added: what it does and, for Godmode's own, its options and code. Like the desktop's dialogs. */
export default function PluginPreview() {
  const { kind, id } = useLocalSearchParams<{ kind: "featured" | "template"; id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: "", headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate locked={<NeedsFullAccessScreen />}>{kind === "template" ? <TemplateLoader id={id} /> : <FeaturedLoader id={id} />}</FullAccessGate>
    </>
  );
}

function FeaturedLoader({ id }: { id: string }) {
  const { t } = useTranslation("tools");
  const catalog = usePluginCatalog();
  const entry = catalog.data?.find((e) => e.id === id);
  if (entry) return <Featured entry={entry} />;
  if (catalog.isLoading) return <LoadingState />;
  return <ErrorState title={t("pluginAdmin.featured.loadFailed")} error={catalog.isError ? errorText(catalog.error) : t("pluginAdmin.maybeDeleted")} onRetry={() => void catalog.refetch()} />;
}

function TemplateLoader({ id }: { id: string }) {
  const { t } = useTranslation("tools");
  const templates = usePluginTemplates();
  const template = templates.data?.find((x) => x.id === id);
  if (template) return <Template template={template} />;
  if (templates.isLoading) return <LoadingState />;
  return <ErrorState title={t("pluginAdmin.gallery.loadFailed")} error={templates.isError ? errorText(templates.error) : t("pluginAdmin.maybeDeleted")} onRetry={() => void templates.refetch()} />;
}

function Hero({ icon, title, description, children }: { icon: Mod["icon"]; title: string; description: string; children?: ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.hero}>
      <View style={[styles.icon, { backgroundColor: c.sunken }]}>
        <Icon name={pluginIcon(icon)} size={26} color={c.text} />
      </View>
      <T variant="title" style={{ textAlign: "center" }}>
        {title}
      </T>
      {children}
      <T variant="subhead" muted style={{ textAlign: "center" }}>
        {description}
      </T>
    </View>
  );
}

function Highlights({ items }: { items: string[] }) {
  const c = useColors();
  const { t } = useTranslation("tools");
  if (!items.length) return null;
  return (
    <Group title={t("pluginAdmin.featured.whatItDoes")}>
      {items.map((h) => (
        <View key={h} style={styles.line}>
          <Icon name="check" size={14} color={c.textMuted} style={{ marginTop: 3 }} />
          <T variant="subhead" style={{ flex: 1 }}>
            {h}
          </T>
        </View>
      ))}
    </Group>
  );
}

function Featured({ entry }: { entry: ModCatalogEntry }) {
  const c = useColors();
  const { t } = useTranslation(["tools", "components"]);
  const mods = usePlugins();
  const installed = mods.data?.find((m) => m.source?.repo.toLowerCase() === entry.repo.toLowerCase());
  const [busy, setBusy] = useState(false);
  const install = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const mod = await pluginsAdmin.install({ source: entry.repo, catalogId: entry.id });
      putPlugin(mod);
      tap();
      if (mod.check && !mod.check.ok) Alert.alert(t("pluginAdmin.install.refused", { title: mod.title }), mod.check.errors[0]?.message);
      open(mod);
    } catch (err) {
      Alert.alert(isRefused(err) ? t("components:fullAccess.title") : t("pluginAdmin.install.failed", { name: entry.title }), isRefused(err) ? undefined : errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: entry.title }} />
      <Hero icon={entry.icon} title={entry.title} description={entry.description}>
        <T variant="caption" muted numberOfLines={1}>
          {entry.repo} · {t("pluginAdmin.featured.byAuthor", { author: entry.author })}
        </T>
      </Hero>
      <Highlights items={entry.highlights} />
      {entry.usage ? (
        <Group title={t("pluginAdmin.featured.tryInChat")}>
          <Row style={styles.usage}>
            <T variant="subhead" selectable numberOfLines={2} style={{ flex: 1, fontFamily: fonts.mono }}>
              {entry.usage}
            </T>
            <CopyButton label={t("pluginAdmin.featured.tryInChat")} copy={() => copyPlain(entry.usage!)} />
          </Row>
        </Group>
      ) : null}
      {entry.requires.length ? (
        <Group title={t("pluginAdmin.featured.needsOnComputer")} footer={t("pluginAdmin.featured.missingHint")}>
          <View style={styles.line}>
            <T variant="subhead" style={{ flex: 1 }}>
              {entry.requires.join(" · ")}
            </T>
          </View>
        </Group>
      ) : null}
      <View style={[styles.notice, { backgroundColor: c.warningSoft }]}>
        <T variant="footnote">{entry.license ? t("pluginAdmin.featured.warningLicense", { license: entry.license }) : t("pluginAdmin.featured.warning")}</T>
      </View>
      <Group>
        <LinkRow icon="external" title={t("pluginAdmin.featured.viewOnGitHub")} chevron={false} onPress={() => void Linking.openURL(`https://github.com/${entry.repo}`).catch(() => undefined)} />
      </Group>
      {installed ? (
        <Button title={t("pluginAdmin.open")} onPress={() => open(installed)} />
      ) : (
        <Button title={busy ? t("pluginAdmin.install.pending") : t("pluginAdmin.featured.installPlugin")} icon="download" loading={busy} onPress={() => void install()} />
      )}
    </ScrollView>
  );
}

/** The default an option starts with, in words; null when it has none to show. */
function defaultText(o: ModOption, on: string, off: string): string | null {
  if (o.sensitive) return null;
  if (typeof o.default === "boolean") return o.default ? on : off;
  if (Array.isArray(o.default)) return o.default.length ? o.default.join("  ·  ") : null;
  if (o.default === null || o.default === "") return null;
  return String(o.default);
}

function sortedPaths(files: Record<string, string>): string[] {
  const rank = (p: string) => (p === MOD_MANIFEST_PATH ? 0 : p === MOD_HOOKS_PATH ? 1 : 2);
  return Object.keys(files).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function Template({ template: x }: { template: ModTemplate }) {
  const c = useColors();
  const { t } = useTranslation(["tools", "components", "common"]);
  const mods = usePlugins();
  const installed = mods.data?.find((m) => m.templateId === x.id);
  const [busy, setBusy] = useState(false);
  const paths = sortedPaths(x.files);
  const [picked, setPicked] = useState<string | null>(null);
  const path = picked && picked in x.files ? picked : (paths.find((p) => /\.[cm]?[jt]sx?$/.test(p)) ?? paths.find((p) => p !== MOD_MANIFEST_PATH) ?? paths[0] ?? null);
  const add = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const mod = await pluginsAdmin.create({ templateId: x.id });
      putPlugin(mod);
      tap();
      open(mod);
    } catch (err) {
      Alert.alert(isRefused(err) ? t("components:fullAccess.title") : t("pluginAdmin.gallery.addFailed"), isRefused(err) ? undefined : errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: x.title }} />
      <Hero icon={x.icon} title={x.title} description={x.description}>
        <Row style={{ justifyContent: "center" }}>
          <Badge label={t(`pluginAdmin.categories.${x.category}`)} dot={false} />
        </Row>
      </Hero>
      <Highlights items={x.highlights} />
      {x.options.length ? (
        <Group title={t("pluginAdmin.gallery.options")}>
          {x.options.map((o) => {
            const fallback = defaultText(o, t("common:status.on"), t("common:status.off"));
            return (
              <View key={o.key} style={styles.option}>
                <T variant="callout" style={{ fontWeight: "500" }}>
                  {o.title}
                </T>
                {o.description ? (
                  <T variant="footnote" muted>
                    {o.description}
                  </T>
                ) : null}
                <T variant="footnote" muted selectable>
                  {o.sensitive ? t("pluginAdmin.gallery.secretOption") : fallback ? t("pluginAdmin.gallery.default", { value: fallback }) : t("pluginAdmin.gallery.noDefault")}
                </T>
              </View>
            );
          })}
        </Group>
      ) : null}
      {path ? (
        <View style={{ gap: space.sm }}>
          {paths.length > 1 ? (
            <Group title={t("pluginAdmin.gallery.code")}>
              <PickerRow icon="doc" title={t("pluginAdmin.gallery.file")} value={path} options={paths.map((p) => ({ value: p, label: p.split("/").pop() ?? p, detail: p }))} onChange={setPicked} />
            </Group>
          ) : null}
          <View style={[styles.code, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Row style={[styles.codeHead, { borderBottomColor: c.border }]}>
              <T variant="caption" numberOfLines={1} style={{ flex: 1, fontFamily: fonts.mono }}>
                {path}
              </T>
              <CopyButton label={t("pluginAdmin.code.copyFile")} copy={() => copyPlain(x.files[path] ?? "")} />
            </Row>
            <T variant="mono" selectable style={styles.codeText}>
              {(x.files[path] ?? "").replace(/\n$/, "")}
            </T>
          </View>
        </View>
      ) : null}
      <T variant="footnote" muted style={{ textAlign: "center" }}>
        {installed ? t("pluginAdmin.gallery.alreadyAdded") : t("pluginAdmin.gallery.setAfterAdding")}
      </T>
      {installed ? (
        <Button title={t("pluginAdmin.open")} onPress={() => open(installed)} />
      ) : (
        <Button title={t("pluginAdmin.gallery.addPlugin")} icon="plus" loading={busy} onPress={() => void add()} />
      )}
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
    gap: space.sm,
    paddingTop: space.md,
  },
  icon: {
    width: 60,
    height: 60,
    borderRadius: 18,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  line: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  usage: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  notice: {
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  option: {
    gap: 2,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  code: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  codeHead: {
    gap: space.sm,
    paddingLeft: space.md,
    paddingRight: space.sm,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  codeText: {
    fontSize: 12,
    lineHeight: 17,
    padding: space.md,
  },
});
