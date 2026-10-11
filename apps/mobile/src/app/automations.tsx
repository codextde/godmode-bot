import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useCallback, useMemo } from "react";
import { RefreshControl, View } from "react-native";
import type { Routine } from "@godmode/shared";
import { RoutineRow } from "@/components/routine-row";
import { EmptyState, ErrorState, Hairline, SectionTitle, SkeletonRows } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { useWorkspace } from "@/lib/workspace";
import { space } from "@/lib/theme";

type Item = { kind: "header"; key: string; title: string } | { kind: "routine"; key: string; routine: Routine; divided: boolean };

/** The next to run first, then the ones without a time by name. */
function nextFirst(a: Routine, b: Routine): number {
  if (a.nextRunAt && b.nextRunAt && a.nextRunAt !== b.nextRunAt) return a.nextRunAt < b.nextRunAt ? -1 : 1;
  if (!a.nextRunAt !== !b.nextRunAt) return a.nextRunAt ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Automations with a run in them right now, re-rendering only when that set changes. */
function useWorkingRoutines(): Set<string> {
  const key = useLive((s) => [...new Set(Object.values(s.runs).flatMap(({ run }) => (run.routineId ? [run.routineId] : [])))].sort().join("\n"));
  return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}

/** Every automation of the picked workspace's agents (or project's), the ones that are on first. */
export default function Automations() {
  const { id: workspaceId, projectId } = useWorkspace();
  const list = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list() });
  const agents = useAgents();
  const { byId } = agents;
  const working = useWorkingRoutines();
  const pull = usePullRefresh(list.refetch);
  // A workspace's automations are known once its agents are.
  const loading = list.isLoading || (!!workspaceId && agents.isLoading);

  const items = useMemo(() => {
    const scoped = (list.data ?? []).filter((r) => {
      if (!workspaceId) return true;
      const agent = byId.get(r.agentId);
      if (!agent) return false;
      return projectId ? agent.projectId === projectId : !agent.workspaceId || agent.workspaceId === workspaceId;
    });
    const out: Item[] = [];
    for (const on of [true, false]) {
      const group = scoped.filter((r) => r.enabled === on).sort(nextFirst);
      if (!group.length) continue;
      out.push({ kind: "header", key: on ? "h-on" : "h-off", title: on ? "On" : "Off" });
      group.forEach((routine, i) => out.push({ kind: "routine", key: routine.id, routine, divided: i > 0 }));
    }
    return out;
  }, [list.data, workspaceId, projectId, byId]);

  const renderItem: ListRenderItem<Item> = useCallback(
    ({ item }) => {
      if (item.kind === "header") return <GroupTitle title={item.title} />;
      return (
        <>
          {item.divided && <Hairline inset={72} />}
          <RoutineRow routine={item.routine} agent={byId.get(item.routine.agentId)} working={working.has(item.routine.id)} />
        </>
      );
    },
    [byId, working],
  );

  return (
    <>
      <Stack.Title>Automations</Stack.Title>
      <FlashList
        data={loading ? [] : items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        extraData={working}
        ListHeaderComponent={ScopeHeader}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListEmptyComponent={
          loading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={6} avatar={40} />
            </View>
          ) : list.isError ? (
            <ErrorState title="Couldn't load the automations" error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : (
            <EmptyState icon="clock" title="No automations yet" body="Agents run on a schedule or when something happens. Set them up in Godmode on your computer." />
          )
        }
      />
    </>
  );
}

const ScopeHeader = () => (
  <View style={{ paddingHorizontal: space.sm, paddingTop: space.sm }}>
    <WorkspaceChip />
  </View>
);

function GroupTitle({ title }: { title: string }) {
  return (
    <View style={{ paddingHorizontal: space.sm, paddingTop: space.lg }}>
      <SectionTitle title={title} />
    </View>
  );
}
