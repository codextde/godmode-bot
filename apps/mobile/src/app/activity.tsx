import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { isToday } from "date-fns";
import { Stack } from "expo-router";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import type { Run, RunStatus } from "@godmode/shared";
import { FilterChips } from "@/components/filter-chips";
import { Icon } from "@/components/icon";
import { isLiveRun, RunRow } from "@/components/run-row";
import { SpendStrip } from "@/components/spend-strip";
import { Button, Card, EmptyState, ErrorState, Hairline, LiveDot, Row, SectionTitle, SkeletonRows, T } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { runDayLabel } from "@/lib/desktop-parity";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { WorkspaceChip } from "@/components/workspace-chip";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const LIMIT = 100;

type Filter = "all" | RunStatus;
type Item = { kind: "header"; key: string; title: string } | { kind: "run"; key: string; run: Run; divided: boolean };

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "paused", label: "Paused" },
  { id: "succeeded", label: "Succeeded" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
  { id: "queued", label: "Queued" },
];

interface Stats {
  working: number;
  done: number;
  failed: number;
}

const ended = (run: Run) => run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
const endedToday = (run: Run) => isToday(new Date(run.finishedAt ?? run.createdAt));
const startOf = (run: Run) => run.startedAt ?? run.createdAt;

/** The latest runs of the picked workspace's agents (or project's), with the ones working right now, by day. */
export default function Activity() {
  const [filter, setFilter] = useState<Filter>("all");
  const { id: workspaceId, projectId } = useWorkspace();
  const all = useQuery({ queryKey: [...qk.recentRuns, "all"], queryFn: () => api.runs.list({ limit: LIMIT }) });
  const filtered = useQuery({ queryKey: [...qk.recentRuns, filter], queryFn: () => api.runs.list({ limit: LIMIT, status: filter }), enabled: filter !== "all" });
  const list = filter === "all" ? all : filtered;
  const agents = useAgents();
  const { byId } = agents;
  // The runs themselves, not what they are doing: an activity label of one run doesn't re-render the list.
  const liveRuns = useLive(useShallow((s) => Object.values(s.runs).map((r) => r.run)));
  const pull = usePullRefresh(() => Promise.all([list.refetch(), queryClient.invalidateQueries({ queryKey: ["spend"] })]));
  // A workspace's runs are known once its agents are.
  const loading = list.isLoading || (!!workspaceId && agents.isLoading);

  const scope = useCallback(
    (runs: Run[]) =>
      runs.filter((run) => {
        if (!workspaceId) return true;
        const agent = byId.get(run.agentId);
        if (!agent) return false;
        return projectId ? agent.projectId === projectId : !agent.workspaceId || agent.workspaceId === workspaceId;
      }),
    [workspaceId, projectId, byId],
  );

  const runs = useMemo(() => {
    const merged = new Map((list.data ?? []).map((run) => [run.id, run]));
    // A live run is fresher than the fetched one, unless the list already knows how it ended.
    for (const run of liveRuns) {
      if (filter !== "all" && run.status !== filter) continue;
      const fetched = merged.get(run.id);
      if (!fetched || !ended(fetched)) merged.set(run.id, run);
    }
    return scope([...merged.values()]).sort((a, b) => startOf(b).localeCompare(startOf(a)));
  }, [list.data, liveRuns, filter, scope]);

  const stats = useMemo<Stats>(() => {
    const today = scope(all.data ?? []);
    return {
      working: scope(liveRuns).filter(isLiveRun).length,
      done: today.filter((run) => run.status === "succeeded" && endedToday(run)).length,
      failed: today.filter((run) => run.status === "failed" && endedToday(run)).length,
    };
  }, [all.data, liveRuns, scope]);

  const items = useMemo(() => {
    const out: Item[] = [];
    let day = "";
    for (const run of runs) {
      const label = runDayLabel(new Date(startOf(run)));
      if (label !== day) out.push({ kind: "header", key: `h-${label}`, title: label });
      out.push({ kind: "run", key: run.id, run, divided: label === day });
      day = label;
    }
    return out;
  }, [runs]);

  const renderItem: ListRenderItem<Item> = useCallback(
    ({ item }) =>
      item.kind === "header" ? (
        <DayTitle title={item.title} />
      ) : (
        <>
          {item.divided && <Hairline inset={72} />}
          <RunRow run={item.run} agent={byId.get(item.run.agentId)} />
        </>
      ),
    [byId],
  );

  return (
    <>
      <Stack.Title>Activity</Stack.Title>
      <FlashList
        data={loading ? [] : items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={<ActivityHeader stats={stats} filter={filter} onFilter={setFilter} />}
        ListEmptyComponent={
          loading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={8} avatar={40} />
            </View>
          ) : list.isError ? (
            <ErrorState title="Couldn't load activity" error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : filter !== "all" ? (
            <EmptyState icon="pulse" title="No runs match these filters" action={<Button title="Clear filters" variant="secondary" onPress={() => setFilter("all")} />} />
          ) : (
            <EmptyState icon="pulse" title="No activity yet" body="When your agents chat, run automations or delegate work, every run shows up here — live." />
          )
        }
      />
    </>
  );
}

function DayTitle({ title }: { title: string }) {
  return (
    <View style={{ paddingHorizontal: space.sm, paddingTop: space.lg }}>
      <SectionTitle title={title} />
    </View>
  );
}

/** What the team cost (with spend tracking on), three numbers of the fetched runs, then what to show of them. */
const ActivityHeader = memo(function ActivityHeader({ stats, filter, onFilter }: { stats: Stats; filter: Filter; onFilter: (filter: Filter) => void }) {
  const c = useColors();
  return (
    <View style={styles.header}>
      <SpendStrip />
      <WorkspaceChip />
      <Row style={{ gap: space.sm }}>
        <Stat label="Working now" value={stats.working} mark={<LiveDot size={7} live={stats.working > 0} />} />
        <Stat label="Done today" value={stats.done} mark={<Icon name="check" size={11} color={c.textMuted} weight="semibold" />} />
        <Stat label="Failed today" value={stats.failed} mark={<Icon name="warning" size={11} color={stats.failed > 0 ? c.danger : c.textFaint} />} />
      </Row>
      <FilterChips filters={FILTERS} value={filter} onChange={onFilter} bleed={space.lg} />
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
});
