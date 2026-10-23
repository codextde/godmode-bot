import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { RefreshControl, View } from "react-native";
import type { Routine } from "@godmode/shared";
import { FilterChips } from "@/components/filter-chips";
import { FollowupsSection } from "@/components/followup-row";
import { HeaderActions } from "@/components/header-actions";
import { RoutineRow } from "@/components/routine-row";
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
  const { id: workspaceId, projectId } = useWorkspace();
  const list = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list() });
  const followups = useQuery({ queryKey: qk.followups, queryFn: () => api.followups.list() });
  const agents = useAgents();
  const { byId } = agents;
  const working = useWorkingRoutines();
  const pull = usePullRefresh(() => Promise.all([list.refetch(), followups.refetch()]));
  const [filter, setFilter] = useState<Filter>("all");
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
  const scoped = useMemo(() => (list.data ?? []).filter((r) => inScope(r.agentId)), [list.data, inScope]);
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
      <Stack.Title>Automations</Stack.Title>
      <HeaderActions actions={[{ icon: "plus", label: "New automation", onPress: openNew }]} />
      <FlashList
        data={loading ? [] : visible}
        keyExtractor={(r) => r.id}
        renderItem={renderItem}
        extraData={working}
        ItemSeparatorComponent={Separator}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.sm, paddingVertical: space.sm, gap: space.md }}>
            <WorkspaceChip />
            <FollowupsSection followups={scopedFollowups} agents={byId} />
            {scoped.length > 0 && (
              <FilterChips
                bleed={space.lg}
                value={filter}
                onChange={setFilter}
                filters={[
                  { id: "all", label: "All", count: scoped.length },
                  { id: "active", label: "Active", count: scoped.filter((r) => r.enabled).length },
                  { id: "paused", label: "Paused", count: scoped.filter((r) => !r.enabled).length },
                  { id: "failing", label: "Failing", count: scoped.filter(isFailingRoutine).length },
                ]}
              />
            )}
          </View>
        }
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListEmptyComponent={
          loading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={6} avatar={40} />
            </View>
          ) : list.isError ? (
            <ErrorState title="Couldn't load automations" error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : scoped.length ? (
            <EmptyState icon="search" title="No automations match" action={<Button title="Clear filters" variant="secondary" onPress={() => setFilter("all")} />} />
          ) : (
            <EmptyState
              icon="clock"
              title="No automations yet"
              body="Set one up yourself — a morning inbox summary, a reply draft for every customer email, a watch on competitor pricing."
              action={<Button title="New automation" icon="plus" variant="outline" onPress={openNew} />}
            />
          )
        }
      />
    </>
  );
}

const Separator = () => <Hairline inset={72} />;
