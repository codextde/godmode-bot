import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { RefreshControl, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Routine, RoutineTriggerType } from "@godmode/shared";
import { DescribeAutomation } from "@/components/describe-automation";
import { FilterChips } from "@/components/filter-chips";
import { FollowupsSection } from "@/components/followup-row";
import { FilterToolbar } from "@/components/filter-toolbar";
import { RoutineRow, TRIGGER_TITLES } from "@/components/routine-row";
import { Button, EmptyState, ErrorState, Hairline, SkeletonRows } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { isFailingRoutine } from "@/lib/desktop-parity";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { useWorkspace } from "@/lib/workspace";
import { space } from "@/lib/theme";

type Filter = "all" | "active" | "paused" | "failing";

const ALL = "all";
const TRIGGERS: readonly RoutineTriggerType[] = ["schedule", "app", "condition", "webhook"];

/** On first, then the next to run, then by name. */
function nextFirst(a: Routine, b: Routine): number {
  return Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? "9999").localeCompare(b.nextRunAt ?? "9999") || a.name.localeCompare(b.name);
}

/** Automations with a run in them right now, re-rendering only when that set changes. */
function useWorkingRoutines(): Set<string> {
  const key = useLive((s) => [...new Set(Object.values(s.runs).flatMap(({ run }) => (run.routineId ? [run.routineId] : [])))].sort().join("\n"));
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}

const openNew = () => router.push("/automation-edit");

/** Every automation of the picked workspace's agents (or project's), the ones that are on first, and the chats they'll pick up again. */
export default function Automations() {
  const { t } = useTranslation(["automations", "common"]);
  const { id: workspaceId, projectId } = useWorkspace();
  const list = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list() });
  const followups = useQuery({ queryKey: qk.followups, queryFn: () => api.followups.list() });
  const agents = useAgents();
  const { byId } = agents;
  const working = useWorkingRoutines();
  const pull = usePullRefresh(() => Promise.all([list.refetch(), followups.refetch()]));
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState(ALL);
  const [trigger, setTrigger] = useState(ALL);
  // A workspace's automations are known once its agents are.
  const loading = list.isLoading || (!!workspaceId && agents.isLoading);

  // Follow-ups move with the chats they belong to: fresh each time the screen comes back to the front.
  const shown = useRef(false);
  const refetchFollowups = followups.refetch;
  useFocusEffect(
    useCallback(() => {
      if (shown.current) void refetchFollowups();
      shown.current = true;
    }, [refetchFollowups]),
  );

  const inScope = useCallback(
    (agentId: string) => {
      if (!workspaceId) return true;
      const agent = byId.get(agentId);
      if (!agent) return false;
      return projectId ? agent.projectId === projectId : !agent.workspaceId || agent.workspaceId === workspaceId;
    },
    [workspaceId, projectId, byId],
  );
  const inWorkspace = useMemo(() => (list.data ?? []).filter((r) => inScope(r.agentId)), [list.data, inScope]);
  const narrowed = !!search.trim() || agent !== ALL || trigger !== ALL;
  const scoped = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inWorkspace.filter(
      (r) =>
        (agent === ALL || r.agentId === agent) &&
        (trigger === ALL || r.trigger.type === trigger) &&
        (!q || `${r.name} ${r.prompt} ${byId.get(r.agentId)?.name ?? ""}`.toLowerCase().includes(q)),
    );
  }, [inWorkspace, search, agent, trigger, byId]);
  const agentOptions = useMemo(() => {
    const ids = [...new Set(inWorkspace.map((r) => r.agentId))];
    return [
      { value: ALL, label: t("filters.allAgents") },
      ...ids.map((id) => ({ value: id, label: byId.get(id)?.name ?? id })).sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [inWorkspace, byId, t]);
  const clearFilters = () => {
    setFilter("all");
    setSearch("");
    setAgent(ALL);
    setTrigger(ALL);
  };
  const scopedFollowups = useMemo(() => (followups.data ?? []).filter((f) => inScope(f.agentId)), [followups.data, inScope]);
  const visible = useMemo(
    () =>
      scoped
        .filter((r) => (filter === "active" ? r.enabled : filter === "paused" ? !r.enabled : filter === "failing" ? isFailingRoutine(r) : true))
        .sort(nextFirst),
    [scoped, filter],
  );

  const renderItem: ListRenderItem<Routine> = useCallback(
    ({ item }) => <RoutineRow routine={item} agent={byId.get(item.agentId)} working={working.has(item.id)} />,
    [byId, working],
  );

  return (
    <>
      <Stack.Title>{t("list.title")}</Stack.Title>
      <Stack.SearchBar placeholder={t("filters.search")} hideWhenScrolling onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />
      <FilterToolbar
        actions={[{ icon: "plus", label: t("list.new"), onPress: openNew }]}
        filters={[
          { id: "agent", title: t("filters.agent"), icon: "agents", value: agent, options: agentOptions, onChange: setAgent },
          {
            id: "trigger",
            title: t("filters.trigger"),
            icon: "bolt",
            value: trigger,
            options: [{ value: ALL, label: t("filters.allTriggers") }, ...TRIGGERS.map((type) => ({ value: type, label: TRIGGER_TITLES[type] }))],
            onChange: setTrigger,
          },
        ]}
        menu={[{ icon: "history", title: t("events.menu"), onPress: () => router.push("/automation-events") }]}
      />
      <FlashList
        data={loading ? [] : visible}
        keyExtractor={(r) => r.id}
        renderItem={renderItem}
        extraData={working}
        ItemSeparatorComponent={Separator}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.sm, paddingVertical: space.sm, gap: space.md }}>
            <WorkspaceChip />
            {loading ? null : <DescribeAutomation open={!inWorkspace.length} />}
            <FollowupsSection followups={scopedFollowups} agents={byId} />
            {scoped.length > 0 && (
              <FilterChips
                bleed={space.lg}
                value={filter}
                onChange={setFilter}
                filters={[
                  { id: "all", label: t("common:words.all"), count: scoped.length },
                  { id: "active", label: t("status.active"), count: scoped.filter((r) => r.enabled).length },
                  { id: "paused", label: t("status.paused"), count: scoped.filter((r) => !r.enabled).length },
                  { id: "failing", label: t("status.failing"), count: scoped.filter(isFailingRoutine).length },
                ]}
              />
            )}
          </View>
        }
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListEmptyComponent={
          loading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={6} avatar={40} />
            </View>
          ) : list.isError ? (
            <ErrorState title={t("list.loadFailed")} error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : scoped.length || narrowed ? (
            <EmptyState icon="search" title={t("list.noMatch")} action={<Button title={t("list.clearFilters")} variant="secondary" onPress={clearFilters} />} />
          ) : (
            <EmptyState
              icon="clock"
              title={t("list.emptyTitle")}
              body={t("list.emptyBody")}
              action={<Button title={t("list.new")} icon="plus" variant="outline" onPress={openNew} />}
            />
          )
        }
      />
    </>
  );
}

const Separator = () => <Hairline inset={72} />;
