import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { router, Stack } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent, Workspace } from "@godmode/shared";
import { HeaderActions } from "@/components/header-actions";
import { Icon } from "@/components/icon";
import { AgentRow } from "@/components/rows";
import { FilterChips } from "@/components/filter-chips";
import { Button, EmptyState, ErrorState, Hairline, SkeletonRows, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { WorkspaceChip } from "@/components/workspace-chip";
import { useAgents } from "@/lib/hooks";
import { useSettings } from "@/lib/setup";
import { useRunCounts } from "@/lib/live";
import { qk } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { agentsFor, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const NONE = { running: 0, queued: 0 };

function openAgent(id: string) {
  tap();
  router.push({ pathname: "/agent/[id]", params: { id } });
}

const AgentItem = memo(function AgentItem({ agent, running, queued }: { agent: Agent; running: number; queued: number }) {
  return <AgentRow agent={agent} running={running} queued={queued} onPress={() => openAgent(agent.id)} />;
});

type Filter = "all" | "running" | "needs" | "scheduled" | "disabled";

type Item = { kind: "group"; key: string; title: string; icon: string | null; count: number } | { kind: "agent"; key: string; agent: Agent; divided: boolean };

const matches = (a: Agent, query: string) => `${a.name} ${a.role} ${a.description} ${a.instructions}`.toLowerCase().includes(query);

export default function Agents() {
  const { t } = useTranslation(["tabs", "common"]);
  const agents = useAgents();
  const { id: workspaceId, projectId, workspaces } = useWorkspace();
  // Working means running; a run waiting its turn is only queued.
  const counts = useRunCounts();
  const routines = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list() });
  const missing = useQuery({ queryKey: qk.missingLogins, queryFn: api.missingLogins.open });
  const pull = usePullRefresh(agents.refetch);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();

  const scoped = useMemo(() => agentsFor(agents.data ?? [], workspaceId), [agents.data, workspaceId]);
  const automated = useMemo(() => new Set((routines.data ?? []).map((r) => r.agentId)), [routines.data]);
  const missingFor = useMemo(() => new Set((missing.data ?? []).map((m) => m.agentId)), [missing.data]);
  const tests = useMemo(() => {
    const isRunning = (a: Agent) => !!counts.get(a.id)?.running || a.status === "running";
    const needsYou = (a: Agent) => a.enabled && ((a.openQuestions ?? 0) > 0 || !!a.failedRunId || missingFor.has(a.id));
    return {
      all: () => true,
      running: isRunning,
      needs: needsYou,
      scheduled: (a: Agent) => automated.has(a.id),
      disabled: (a: Agent) => !a.enabled,
    } satisfies Record<Filter, (a: Agent) => boolean>;
  }, [counts, missingFor, automated]);

  const visible = useMemo(
    () =>
      scoped
        .filter((a) => tests[filter](a) && (!query || matches(a, query)))
        .sort(
          (a, b) =>
            Number(!!projectId && b.projectId === projectId) - Number(!!projectId && a.projectId === projectId) ||
            Number(b.isDefault) - Number(a.isDefault) ||
            Number(tests.running(b)) - Number(tests.running(a)) ||
            Number(b.enabled) - Number(a.enabled) ||
            (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "") ||
            a.name.localeCompare(b.name),
        ),
    [scoped, tests, filter, query, projectId],
  );

  // In all workspaces, like the desktop, everyone sits under their workspace (global first).
  const grouped = !workspaceId && scoped.some((a) => a.workspaceId);
  const items = useMemo(() => {
    const rows = (list: Agent[]): Item[] => list.map((agent, i) => ({ kind: "agent", key: agent.id, agent, divided: i > 0 }));
    if (!grouped) return rows(visible);
    const order = new Map<string | null, number>([[null, -1], ...workspaces.map((w, i): [string, number] => [w.id, i])]);
    const groups = new Map<string | null, Agent[]>();
    for (const a of visible) groups.set(a.workspaceId, [...(groups.get(a.workspaceId) ?? []), a]);
    return [...groups.entries()]
      .sort(([a], [b]) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))
      .flatMap(([id, list]): Item[] => {
        const workspace: Workspace | undefined = workspaces.find((w) => w.id === id);
        const title = id ? (workspace?.name ?? t("agents.workspace")) : t("agents.global");
        return [{ kind: "group", key: `g-${id ?? "global"}`, title, icon: id ? workspace?.icon || "🗂️" : null, count: list.length }, ...rows(list)];
      });
  }, [grouped, visible, workspaces, t]);

  const renderItem: ListRenderItem<Item> = useCallback(
    ({ item }) => {
      if (item.kind === "group") return <GroupTitle title={item.title} icon={item.icon} count={item.count} />;
      const n = counts.get(item.agent.id) ?? NONE;
      return (
        <>
          {item.divided && <Hairline inset={78} />}
          <AgentItem agent={item.agent} running={n.running} queued={n.queued} />
        </>
      );
    },
    [counts],
  );
  // A computer from before the switch has no activity setting: Activity stays.
  const activityOn = useSettings().data?.activity?.enabled !== false;
  const newAgent = () => router.push({ pathname: "/settings/new", params: { kind: "agent", workspaceId: workspaceId ?? "" } });

  return (
    <>
      <Stack.Title large>{t("agents.title")}</Stack.Title>
      <Stack.SearchBar placeholder={t("agents.search")} hideWhenScrolling={false} onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />
      <HeaderActions
        actions={[
          { icon: "orgChart", label: t("agents.orgChart"), onPress: () => router.push("/agents/org") },
          { icon: "clock", label: t("agents.automations"), onPress: () => router.push("/automations") },
          ...(activityOn ? [{ icon: "pulse" as const, label: t("agents.activity"), onPress: () => router.push("/activity") }] : []),
        ]}
      />
      <FlashList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        extraData={counts}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 140 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.sm, paddingVertical: space.sm, gap: space.md }}>
            <WorkspaceChip />
            {scoped.length > 0 && (
              <FilterChips
                bleed={space.lg}
                value={filter}
                onChange={setFilter}
                filters={[
                  { id: "all", label: t("common:words.all") },
                  { id: "running", label: t("agents.filter.running"), count: scoped.filter(tests.running).length },
                  { id: "needs", label: t("agents.filter.needs"), count: scoped.filter(tests.needs).length },
                  { id: "scheduled", label: t("agents.filter.scheduled"), count: scoped.filter(tests.scheduled).length },
                  { id: "disabled", label: t("common:status.off"), count: scoped.filter(tests.disabled).length },
                ]}
              />
            )}
          </View>
        }
        ListFooterComponent={visible.length > 0 && !query ? <NewAgentRow onPress={newAgent} /> : null}
        ListEmptyComponent={
          agents.isLoading ? (
            <SkeletonRows count={7} avatar={46} />
          ) : agents.isError ? (
            <ErrorState title={t("agents.loadError")} error={errorText(agents.error)} onRetry={() => void agents.refetch()} />
          ) : query ? (
            <EmptyState icon="search" title={t("agents.noResults.title")} body={t("agents.noResults.body", { query: search.trim() })} />
          ) : scoped.length ? (
            <EmptyState icon="agents" title={t("agents.noMatch.title")} body={t("agents.noMatch.body")} />
          ) : (
            <EmptyState
              icon="agents"
              title={t("agents.empty.title")}
              body={t("agents.empty.body")}
              action={<Button title={t("agents.newAgent")} icon="plus" onPress={newAgent} />}
            />
          )
        }
      />
    </>
  );
}

function GroupTitle({ title, icon, count }: { title: string; icon: string | null; count: number }) {
  const c = useColors();
  return (
    <View style={styles.group}>
      {icon ? <T style={{ fontSize: 13 }}>{icon}</T> : <Icon name="globe" size={12} color={c.textMuted} />}
      <T variant="eyebrow" muted numberOfLines={1} style={{ flexShrink: 1 }}>
        {title}
      </T>
      <T variant="caption" color={c.textFaint} style={{ fontVariant: ["tabular-nums"] }}>
        {count}
      </T>
    </View>
  );
}

function NewAgentRow({ onPress }: { onPress: () => void }) {
  const c = useColors();
  const { t } = useTranslation("tabs");
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.newRow, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={[styles.newTile, { borderColor: c.borderStrong }]}>
        <Icon name="plus" size={16} color={c.textMuted} />
      </View>
      <T variant="callout" muted style={{ fontWeight: "500" }}>
        {t("agents.newAgent")}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  newRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    marginTop: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  newTile: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
});
