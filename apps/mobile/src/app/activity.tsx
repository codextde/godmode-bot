import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { isToday } from "date-fns";
import { Stack } from "expo-router";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { Run, RunStatus, RunTrigger } from "@godmode/shared";
import { FilterChips } from "@/components/filter-chips";
import { FilterToolbar } from "@/components/filter-toolbar";
import { Icon } from "@/components/icon";
import { isLiveRun, RunRow, TRIGGER_LABEL } from "@/components/run-row";
import { Button, Card, EmptyState, ErrorState, Hairline, LiveDot, Row, SectionTitle, SkeletonRows, T } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { runDayLabel } from "@/lib/desktop-parity";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk } from "@/lib/query";
import { WorkspaceChip } from "@/components/workspace-chip";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const LIMIT = 100;

type Filter = "all" | RunStatus;
type Item = { kind: "header"; key: string; title: string } | { kind: "run"; key: string; run: Run; divided: boolean };

const FILTERS: Filter[] = ["all", "running", "paused", "succeeded", "failed", "cancelled", "queued"];
const TRIGGERS: RunTrigger[] = ["chat", "routine", "check", "dream", "review", "delegation", "task", "followup", "heartbeat", "call", "manual", "api"];
const ALL = "all";

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
  const { t } = useTranslation("chat");
  const [filter, setFilter] = useState<Filter>("all");
  const [agent, setAgent] = useState(ALL);
  const [trigger, setTrigger] = useState(ALL);
  const [search, setSearch] = useState("");
  const { id: workspaceId, projectId } = useWorkspace();
  const all = useQuery({ queryKey: [...qk.recentRuns, "all"], queryFn: () => api.runs.list({ limit: LIMIT }) });
  const narrowedServer = filter !== "all" || agent !== ALL;
  const filtered = useQuery({
    queryKey: [...qk.recentRuns, filter, agent],
    queryFn: () => api.runs.list({ limit: LIMIT, ...(filter !== "all" ? { status: filter } : {}), ...(agent !== ALL ? { agentId: agent } : {}) }),
    enabled: narrowedServer,
  });
  const list = narrowedServer ? filtered : all;
  const agents = useAgents();
  const { byId } = agents;
  // The runs themselves, not what they are doing: an activity label of one run doesn't re-render the list.
  const liveRuns = useLive(useShallow((s) => Object.values(s.runs).map((r) => r.run)));
  const pull = usePullRefresh(() => list.refetch());
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
      if (agent !== ALL && run.agentId !== agent) continue;
      const fetched = merged.get(run.id);
      if (!fetched || !ended(fetched)) merged.set(run.id, run);
    }
    const q = search.trim().toLowerCase();
    return scope([...merged.values()])
      .filter((run) => (agent === ALL || run.agentId === agent) && (trigger === ALL || run.trigger === trigger))
      .filter((run) => !q || `${run.prompt} ${run.result ?? ""} ${run.error ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => startOf(b).localeCompare(startOf(a)));
  }, [list.data, liveRuns, filter, agent, trigger, search, scope]);

  // Like the desktop's count: of the runs shown that ended, how many went well.
  const successRate = useMemo(() => {
    const finished = runs.filter((r) => r.status === "succeeded" || r.status === "failed");
    return finished.length ? Math.round((finished.filter((r) => r.status === "succeeded").length / finished.length) * 100) : null;
  }, [runs]);
  const narrowed = narrowedServer || trigger !== ALL || !!search.trim();
  const clearFilters = () => {
    setFilter("all");
    setAgent(ALL);
    setTrigger(ALL);
    setSearch("");
  };
  const agentOptions = useMemo(
    () => [
      { value: ALL, label: t("activity.allAgents") },
      ...scope(all.data ?? [])
        .map((r) => r.agentId)
        .filter((id, i, ids) => ids.indexOf(id) === i)
        .map((id) => ({ value: id, label: byId.get(id)?.name ?? id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      ...(agent !== ALL && !all.data?.some((r) => r.agentId === agent) ? [{ value: agent, label: byId.get(agent)?.name ?? agent }] : []),
    ],
    [all.data, scope, byId, agent, t],
  );

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
      <Stack.Title>{t("activity.title")}</Stack.Title>
      <Stack.SearchBar placeholder={t("activity.search")} hideWhenScrolling onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />
      <FilterToolbar
        filters={[
          { id: "agent", title: t("activity.agent"), icon: "agents", value: agent, options: agentOptions, onChange: setAgent },
          {
            id: "trigger",
            title: t("activity.trigger"),
            icon: "bolt",
            value: trigger,
            options: [{ value: ALL, label: t("activity.anyTrigger") }, ...TRIGGERS.map((id) => ({ value: id, label: TRIGGER_LABEL[id] }))],
            onChange: setTrigger,
          },
        ]}
      />
      <FlashList
        data={loading ? [] : items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={<ActivityHeader stats={stats} filter={filter} onFilter={setFilter} count={loading ? null : runs.length} successRate={successRate} />}
        ListEmptyComponent={
          loading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={8} avatar={40} />
            </View>
          ) : list.isError ? (
            <ErrorState title={t("activity.loadFailed")} error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : narrowed ? (
            <EmptyState icon="pulse" title={t("activity.noMatch")} action={<Button title={t("activity.clearFilters")} variant="secondary" onPress={clearFilters} />} />
          ) : (
            <EmptyState icon="pulse" title={t("activity.emptyTitle")} body={t("activity.emptyBody")} />
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

/** Three numbers of the fetched runs, then what to show of them. */
const ActivityHeader = memo(function ActivityHeader({
  stats,
  filter,
  onFilter,
  count,
  successRate,
}: {
  stats: Stats;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  count: number | null;
  successRate: number | null;
}) {
  const c = useColors();
  const { t } = useTranslation("chat");
  const filters = FILTERS.map((id) => ({ id, label: t(`activity.filters.${id}`) }));
  return (
    <View style={styles.header}>
      <WorkspaceChip />
      <Row style={{ gap: space.sm }}>
        <Stat label={t("activity.workingNow")} value={stats.working} mark={<LiveDot size={7} live={stats.working > 0} />} />
        <Stat label={t("activity.doneToday")} value={stats.done} mark={<Icon name="check" size={11} color={c.textMuted} weight="semibold" />} />
        <Stat label={t("activity.failedToday")} value={stats.failed} mark={<Icon name="warning" size={11} color={stats.failed > 0 ? c.danger : c.textFaint} />} />
      </Row>
      <FilterChips filters={filters} value={filter} onChange={onFilter} bleed={space.lg} />
      {count ? (
        <T variant="footnote" muted style={{ paddingHorizontal: 4 }}>
          {successRate != null ? t("activity.countWithSuccess", { count, rate: successRate }) : t("activity.count", { count })}
        </T>
      ) : null}
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
