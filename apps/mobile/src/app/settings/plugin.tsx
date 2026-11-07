import { formatDistanceToNowStrict } from "date-fns";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { modState, modUpdateAvailable, type Mod, type ModProblem, type ModScope } from "@godmode/shared";
import { CloseButton } from "@/components/close-button";
import { NeedsFullAccessScreen } from "@/components/full-access";
import { FullAccessGate, isRefused } from "@/components/admin";
import { CharacterAvatar } from "@/components/character";
import { Group, LinkRow, SwitchRow } from "@/components/form";
import { Icon } from "@/components/icon";
import { InfoRow } from "@/components/status-rows";
import { ActionRow } from "@/components/tool-form";
import { Badge, Button, ErrorState, LoadingState, Row, T, tap, type Tone } from "@/components/ui";
import { errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { dateLocale } from "@/lib/i18n";
import { ik, usePlugins } from "@/lib/integrations";
import { pluginsAdmin, putPlugin } from "@/lib/plugins-admin";
import { queryClient } from "@/lib/query";
import { toolsAdmin } from "@/lib/tools-admin";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

const STATE_TONE = { on: "success", off: "neutral", review: "warning", broken: "danger" } as const satisfies Record<ReturnType<typeof modState>, Tone>;

/** One plugin, like the desktop's plugin sheet: on or off, who runs it, its options, its code or contents, its check, its version. */
export default function Plugin() {
  const { t } = useTranslation("tools");
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = usePlugins();
  const mod = list.data?.find((m) => m.id === id);
  return (
    <>
      <Stack.Screen options={{ title: mod ? mod.title || mod.name : t("pluginAdmin.title"), headerLargeTitleEnabled: false }} />
      <CloseButton />
      <FullAccessGate locked={<NeedsFullAccessScreen />}>
        {mod ? (
          <PluginView mod={mod} />
        ) : list.isLoading ? (
          <LoadingState />
        ) : (
          <ErrorState
            title={list.isError ? t("pluginAdmin.loadFailed") : t("pluginAdmin.notFound")}
            error={list.isError ? errorText(list.error) : t("pluginAdmin.maybeDeleted")}
            onRetry={() => void list.refetch()}
          />
        )}
      </FullAccessGate>
    </>
  );
}

function PluginView({ mod }: { mod: Mod }) {
  const c = useColors();
  const { t } = useTranslation(["tools", "common", "components"]);
  const agents = useAgents();
  const [busy, setBusy] = useState<"check" | "updates" | "upgrade" | "switch" | null>(null);
  const pull = usePullRefresh(() => queryClient.invalidateQueries({ queryKey: ik.plugins }));
  const state = modState(mod);
  const source = mod.source;
  const name = mod.title || mod.name;
  const check = mod.check;
  const fail = (title: string, err: unknown) => Alert.alert(isRefused(err) ? t("components:fullAccess.title") : title, isRefused(err) ? undefined : errorText(err));

  /** One change at a time; the answer goes into the list at once. */
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<Mod | Mod[] | void>, failed: string) => {
    setBusy(kind);
    try {
      const next = await work();
      if (Array.isArray(next)) next.forEach(putPlugin);
      else if (next) putPlugin(next);
      return next;
    } catch (err) {
      fail(failed, err);
    } finally {
      setBusy(null);
    }
  };

  const patch = (change: Parameters<typeof pluginsAdmin.update>[1], failed: string) => {
    // Shows at once and goes back when the computer refuses it.
    queryClient.setQueryData<Mod[]>(ik.plugins, (all) => all?.map((m) => (m.id === mod.id ? { ...m, ...change, files: m.files, values: m.values } : m)));
    pluginsAdmin
      .update(mod.id, change)
      .then(putPlugin)
      .catch((err) => {
        putPlugin(mod);
        fail(failed, err);
      });
  };

  const switchOn = () =>
    Alert.alert(t("plugins.onTitle", { name }), t("plugins.onBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      { text: t("plugins.on"), onPress: () => void run("switch", () => toolsAdmin.plugins.setEnabled(mod, true), t("plugins.onFailed")) },
    ]);
  const toggle = (next: boolean) => (next ? switchOn() : void run("switch", () => toolsAdmin.plugins.setEnabled(mod, false), t("pluginAdmin.switchOffFailed")));

  const checkAgain = () =>
    void run("check", () => pluginsAdmin.check(mod.id), t("pluginAdmin.checkFailed")).then((next) => {
      if (!next || Array.isArray(next)) return;
      if (!next.check) Alert.alert(t("pluginAdmin.notChecked", { title: next.title }), t("pluginAdmin.noClaudeCode"));
      else if (next.check.ok) Alert.alert(t("pluginAdmin.passed", { title: next.title }));
      else Alert.alert(t("pluginAdmin.needsFixing", { title: next.title }), next.check.errors[0] ? `${next.check.errors[0].where}: ${next.check.errors[0].message}` : undefined);
    });

  const checkUpdates = () =>
    void run("updates", () => toolsAdmin.plugins.checkUpdates(), t("plugins.checkFailed")).then((list) => {
      const next = Array.isArray(list) ? list.find((m) => m.id === mod.id) : null;
      if (!next) return;
      if (next.source?.checkError) Alert.alert(t("pluginAdmin.updateCheckFailedFor", { title: next.title }), next.source.checkError);
      else if (!modUpdateAvailable(next)) Alert.alert(t("pluginAdmin.upToDate", { title: next.title }));
    });

  const upgrade = () =>
    void run("upgrade", () => toolsAdmin.plugins.update(mod.id), t("plugins.updateFailed")).then((next) => {
      if (next && !Array.isArray(next)) Alert.alert(next.source?.version ? t("pluginAdmin.updatedTo", { title: next.title, version: next.source.version }) : t("pluginAdmin.updated", { title: next.title }), t("pluginAdmin.newVersionNext"));
    });

  const remove = () =>
    Alert.alert(source ? t("pluginAdmin.uninstallTitle", { name }) : t("plugins.deleteTitle", { name }), t("plugins.deleteBody"), [
      { text: t("common:actions.cancel"), style: "cancel" },
      {
        text: source ? t("pluginAdmin.uninstall") : t("common:actions.delete"),
        style: "destructive",
        onPress: () =>
          void toolsAdmin.plugins
            .remove(mod.id)
            .then(() => {
              queryClient.setQueryData<Mod[]>(ik.plugins, (all) => all?.filter((m) => m.id !== mod.id));
              tap();
              router.back();
            })
            .catch((err) => fail(t("plugins.deleteFailed"), err)),
      },
    ]);

  const setScope = (scope: ModScope) => scope !== mod.scope && patch({ scope }, t("pluginAdmin.saveFailed", { title: name }));
  const toggleAgent = (agentId: string) => {
    // From the cache, which already holds a tap a moment ago that the screen hasn't drawn yet.
    const ids = queryClient.getQueryData<Mod[]>(ik.plugins)?.find((m) => m.id === mod.id)?.agentIds ?? mod.agentIds;
    patch({ agentIds: ids.includes(agentId) ? ids.filter((x) => x !== agentId) : [...ids, agentId] }, t("pluginAdmin.saveFailed", { title: name }));
  };
  const sorted = [...(agents.data ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  const checkedAgo = check ? formatDistanceToNowStrict(new Date(check.checkedAt), { addSuffix: true, locale: dateLocale() }) : null;
  const contents = mod.contents;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} refreshControl={<RefreshControl {...pull} />}>
      <View style={styles.hero}>
        <View style={[styles.icon, { backgroundColor: c.sunken }]}>
          <Icon name="puzzle" size={26} color={mod.enabled ? c.brandStrong : c.text} />
        </View>
        <T variant="title" style={{ textAlign: "center" }}>
          {name}
        </T>
        <Row style={{ gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
          <Badge label={t(`pluginAdmin.state.${state}`)} tone={STATE_TONE[state]} />
          {modUpdateAvailable(mod) ? <Badge label={t("plugins.updateBadge")} tone="warning" dot={false} /> : null}
        </Row>
        {mod.description ? (
          <T variant="subhead" muted style={{ textAlign: "center" }}>
            {mod.description}
          </T>
        ) : null}
      </View>

      {state === "review" || state === "broken" ? (
        <View style={[styles.notice, { backgroundColor: state === "broken" ? c.dangerSoft : c.warningSoft, borderColor: state === "broken" ? c.danger : c.warning }]}>
          <Icon name="warning" size={14} color={state === "broken" ? c.danger : c.warning} />
          <T variant="footnote" style={{ flex: 1 }}>
            {state === "broken" ? (source ? t("pluginAdmin.refusedRepo") : t("pluginAdmin.refusedCode")) : source ? t("pluginAdmin.reviewContents") : t("pluginAdmin.reviewCode")}
          </T>
        </View>
      ) : null}

      <Group footer={t("pluginAdmin.appliesNext")}>
        <SwitchRow icon="puzzle" title={t("pluginAdmin.on")} value={mod.enabled} disabled={busy === "switch"} onChange={toggle} />
      </Group>

      <Group title={t("pluginAdmin.runsFor")} footer={mod.scope === "agents" && mod.agentIds.length === 0 ? t("pluginAdmin.noAgentYet") : mod.scope === "all" ? t("pluginAdmin.everyAgentHint") : undefined}>
        <ScopeRow title={t("pluginAdmin.everyAgent")} selected={mod.scope === "all"} onPress={() => setScope("all")} />
        <ScopeRow title={t("pluginAdmin.onlyThese")} selected={mod.scope === "agents"} onPress={() => setScope("agents")} />
        {mod.scope === "agents"
          ? sorted.map((a) => (
              <Pressable
                key={a.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: mod.agentIds.includes(a.id) }}
                onPress={() => {
                  tap();
                  toggleAgent(a.id);
                }}
                style={({ pressed }) => [styles.row, { paddingLeft: space.xl + space.md }, pressed && { backgroundColor: c.sunken }]}
              >
                <CharacterAvatar agent={a} size={26} />
                <T variant="callout" style={{ flex: 1 }} numberOfLines={1}>
                  {a.name}
                </T>
                {mod.agentIds.includes(a.id) ? <Icon name="check" size={15} color={c.brandStrong} weight="bold" /> : null}
              </Pressable>
            ))
          : null}
      </Group>

      <Group>
        {mod.options.length ? (
          <LinkRow icon="slider" title={t("pluginAdmin.options")} value={String(mod.options.length)} onPress={() => router.push({ pathname: "/settings/plugin-options", params: { id: mod.id } })} />
        ) : null}
        {!source ? (
          <LinkRow icon="code" title={t("pluginAdmin.codeTitle")} value={String(Object.keys(mod.files).length)} onPress={() => router.push({ pathname: "/settings/plugin-code", params: { id: mod.id } })} />
        ) : null}
        {source && contents ? (
          <InfoRow
            icon="layers"
            label={t("pluginAdmin.contents")}
            detail={[
              contents.skills.length ? t("pluginAdmin.skills", { count: contents.skills.length }) : null,
              contents.commands.length ? t("pluginAdmin.commands", { count: contents.commands.length }) : null,
              contents.agents.length ? t("pluginAdmin.subagents", { count: contents.agents.length }) : null,
              contents.hooks.length ? t("pluginAdmin.hooks", { list: contents.hooks.join(", ") }) : null,
              contents.mcpServers.length ? t("pluginAdmin.mcpServers", { list: contents.mcpServers.join(", ") }) : null,
            ]
              .filter(Boolean)
              .join(" · ") || t("pluginAdmin.nothingFound")}
          />
        ) : null}
      </Group>

      {source ? (
        <Group title={t("pluginAdmin.version")} footer={source.checkError ?? undefined}>
          <InfoRow icon="branch" label={source.repo} detail={[source.version ? `v${source.version}` : null, source.commit.slice(0, 7), source.ref].filter(Boolean).join(" · ")} />
          {modUpdateAvailable(mod) ? (
            <ActionRow icon="refresh" title={t("plugins.update", { version: source.latestVersion ?? source.latestCommit?.slice(0, 7) })} busy={busy === "upgrade"} onPress={upgrade} />
          ) : (
            <ActionRow icon="refresh" title={t("plugins.checkUpdates")} busy={busy === "updates"} onPress={checkUpdates} />
          )}
        </Group>
      ) : null}

      <Group title={t("pluginAdmin.checkTitle")}>
        <InfoRow
          icon={!check ? "question" : check.ok ? "checkCircle" : "warning"}
          label={!check ? t("pluginAdmin.notCheckedYet") : check.ok ? t("pluginAdmin.checkPassed") : t("pluginAdmin.checkFailedState")}
          detail={check ? [check.claudeVersion ? `Claude Code ${check.claudeVersion}` : null, checkedAgo].filter(Boolean).join(" · ") : t("pluginAdmin.needsClaude")}
          tone={!check ? undefined : check.ok ? "success" : "danger"}
        />
        {check ? [...check.errors.map((p) => ({ p, error: true })), ...check.warnings.map((p) => ({ p, error: false }))].map(({ p, error }, i) => <ProblemRow key={i} problem={p} error={error} />) : null}
        <ActionRow icon="refresh" title={check ? t("pluginAdmin.checkAgain") : t("pluginAdmin.checkNow")} busy={busy === "check"} onPress={checkAgain} />
      </Group>

      <Button title={source ? t("pluginAdmin.uninstall") : t("pluginAdmin.delete")} icon="trash" variant="danger" onPress={remove} />
    </ScrollView>
  );
}

function ScopeRow({ title, selected, onPress }: { title: string; selected: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <T variant="callout" style={{ flex: 1, fontWeight: "500" }}>
        {title}
      </T>
      {selected ? <Icon name="check" size={15} color={c.brandStrong} weight="bold" /> : null}
    </Pressable>
  );
}

function ProblemRow({ problem, error }: { problem: ModProblem; error: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.row, { alignItems: "flex-start" }]}>
      <Icon name="warning" size={14} color={error ? c.danger : c.warning} />
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="caption" muted style={{ fontWeight: "600" }}>
          {problem.where}
        </T>
        <T variant="footnote" selectable>
          {problem.message}
        </T>
      </View>
    </View>
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
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 48,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
});
