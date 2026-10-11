import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { isToday } from "date-fns";
import { Stack } from "expo-router";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import type { Run } from "@godmode/shared";
import { Icon } from "@/components/icon";
import { isLiveRun, RunRow } from "@/components/run-row";
import { Card, EmptyState, ErrorState, Hairline, LiveDot, Row, SkeletonRows, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { WorkspaceChip } from "@/components/workspace-chip";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const LIMIT = 60;

type Filter = "all" | "failed" | "running";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "running", label: "Running" },
];

const EMPTY: Record<Filter, { title: string; body?: string }> = {
  all: { title: "Nothing ran yet", body: "When your agents chat, run automations or hand over work, every run shows up here." },
  failed: { title: "No failed runs" },
  running: { title: "Nothing is running right now" },
};

interface Stats {
  working: number;
  done: number;
  failed: number;
}

const ended = (run: Run) => run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
const endedToday = (run: Run) => isToday(new Date(run.finishedAt ?? run.createdAt));

/** The latest runs of the picked workspace's agents (or project's), with the ones working right now. */
export default function Activity() {
  const [filter, setFilter] = useState<Filter>("all");
  const { id: workspaceId, projectId } = useWorkspace();
  const list = useQuery({ queryKey: qk.recentRuns, queryFn: () => api.runs.list({ limit: LIMIT }) });
  const agents = useAgents();
  const { byId } = agents;
  // The runs themselves, not what they are doing: an activity label of one run doesn't re-render the list.
  const liveRuns = useLive(useShallow((s) => Object.values(s.runs).map((r) => r.run)));
  const pull = usePullRefresh(list.refetch);
  // A workspace's runs are known once its agents are.
  const loading = list.isLoading || (!!workspaceId && agents.isLoading);

  const runs = useMemo(() => {
    const merged = new Map((list.data ?? []).map((run) => [run.id, run]));
    // A live run is fresher than the fetched one, unless the list already knows how it ended.
    for (const run of liveRuns) {
      const fetched = merged.get(run.id);
      if (!fetched || !ended(fetched)) merged.set(run.id, run);
    }
    return [...merged.values()]
      .filter((run) => {
        if (!workspaceId) return true;
        const agent = byId.get(run.agentId);
        if (!agent) return false;
        return projectId ? agent.projectId === projectId : !agent.workspaceId || agent.workspaceId === workspaceId;
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [list.data, liveRuns, workspaceId, projectId, byId]);

  const stats = useMemo<Stats>(
    () => ({
      working: runs.filter(isLiveRun).length,
      done: runs.filter((run) => run.status === "succeeded" && endedToday(run)).length,
      failed: runs.filter((run) => run.status === "failed" && endedToday(run)).length,
    }),
    [runs],
  );
  const data = useMemo(() => (filter === "all" ? runs : runs.filter((run) => (filter === "failed" ? run.status === "failed" : isLiveRun(run)))), [runs, filter]);

  const renderItem: ListRenderItem<Run> = useCallback(({ item }) => <RunRow run={item} agent={byId.get(item.agentId)} />, [byId]);

  return (
    <>
      <Stack.Title>Activity</Stack.Title>
      <FlashList
        data={loading ? [] : data}
        keyExtractor={(run) => run.id}
        renderItem={renderItem}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={!loading && runs.length > 0 ? <ActivityHeader stats={stats} filter={filter} onFilter={setFilter} /> : null}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={
          loading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={8} avatar={40} />
            </View>
          ) : list.isError ? (
            <ErrorState title="Couldn't load the activity" error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : (
            <EmptyState icon="pulse" title={EMPTY[runs.length ? filter : "all"].title} body={EMPTY[runs.length ? filter : "all"].body} />
          )
        }
      />
    </>
  );
}

const Separator = () => <Hairline inset={72} />;

/** Three numbers of the fetched runs, then what to show of them. */
const ActivityHeader = memo(function ActivityHeader({ stats, filter, onFilter }: { stats: Stats; filter: Filter; onFilter: (filter: Filter) => void }) {
  const c = useColors();
  return (
    <View style={styles.header}>
      <WorkspaceChip />
      <Row style={{ gap: space.sm }}>
        <Stat label="Working now" value={stats.working} mark={<LiveDot size={7} live={stats.working > 0} />} />
        <Stat label="Done today" value={stats.done} mark={<Icon name="check" size={11} color={c.textMuted} weight="semibold" />} />
        <Stat label="Failed today" value={stats.failed} mark={<Icon name="warning" size={11} color={stats.failed > 0 ? c.danger : c.textFaint} />} />
      </Row>
      <Row style={{ gap: space.sm }}>
        {FILTERS.map((f) => (
          <Chip key={f.id} label={f.label} active={f.id === filter} onPress={() => onFilter(f.id)} />
        ))}
      </Row>
    </View>
  );
});

/** The number in the text color; its mark carries the state, so it never reads by color alone. */
function Stat({ label, value, mark }: { label: string; value: number; mark: ReactNode }) {
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={{ flex: 1 }}>
      <Card style={styles.stat}>
        <T variant="title">{value}</T>
        <Row style={{ gap: 5 }}>
          {mark}
          <T variant="caption" muted numberOfLines={1} style={{ flexShrink: 1 }}>
            {label}
          </T>
        </Row>
      </Card>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      hitSlop={4}
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }]}
    >
      <T variant="subhead" color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: space.sm,
    paddingTop: space.md,
    paddingBottom: space.sm,
    gap: space.md,
  },
  stat: {
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    gap: 2,
    borderRadius: radius.md,
  },
  chip: {
    justifyContent: "center",
    height: 32,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
});
