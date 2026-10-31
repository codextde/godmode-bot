import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { router, Stack } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useMemo, useState } from "react";
import { RefreshControl, View } from "react-native";
import type { Agent } from "@godmode/shared";
import { HeaderActions } from "@/components/header-actions";
import { AgentRow } from "@/components/rows";
import { FilterChips } from "@/components/filter-chips";
import { Button, EmptyState, ErrorState, Hairline, SkeletonRows, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { WorkspaceChip } from "@/components/workspace-chip";
import { useAgents } from "@/lib/hooks";
import { useSettings } from "@/lib/setup";
import { useRunCounts } from "@/lib/live";
import { qk } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { agentsFor, useWorkspace } from "@/lib/workspace";
import { space } from "@/lib/theme";

const NONE = { running: 0, queued: 0 };

function openAgent(id: string) {
  tap();
  router.push({ pathname: "/agent/[id]", params: { id } });
}

const AgentItem = memo(function AgentItem({ agent, running, queued }: { agent: Agent; running: number; queued: number }) {
  return <AgentRow agent={agent} running={running} queued={queued} onPress={() => openAgent(agent.id)} />;
});

const Separator = () => <Hairline inset={78} />;

type Filter = "all" | "running" | "needs" | "scheduled" | "disabled";

export default function Agents() {
  const agents = useAgents();
  const { id: workspaceId, projectId } = useWorkspace();
  // Working means running; a run waiting for a free slot is only queued.
  const counts = useRunCounts();
  const routines = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list() });
  const missing = useQuery({ queryKey: qk.missingLogins, queryFn: api.missingLogins.open });
  const pull = usePullRefresh(agents.refetch);
  const [filter, setFilter] = useState<Filter>("all");

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

  const data = useMemo(
    () =>
      scoped
        .filter(tests[filter])
        .sort(
          (a, b) =>
            Number(!!projectId && b.projectId === projectId) - Number(!!projectId && a.projectId === projectId) ||
            Number(b.isDefault) - Number(a.isDefault) ||
            Number(tests.running(b)) - Number(tests.running(a)) ||
            Number(b.enabled) - Number(a.enabled) ||
            (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "") ||
            a.name.localeCompare(b.name),
        ),
    [scoped, tests, filter, projectId],
  );
  const renderItem: ListRenderItem<Agent> = useCallback(
    ({ item }) => {
      const n = counts.get(item.id) ?? NONE;
      return <AgentItem agent={item} running={n.running} queued={n.queued} />;
    },
    [counts],
  );
  // A computer from before the switch has no activity setting: Activity stays.
  const activityOn = useSettings().data?.activity?.enabled !== false;
  const newAgent = () => router.push({ pathname: "/settings/new", params: { kind: "agent", workspaceId: workspaceId ?? "" } });

  return (
    <>
      <Stack.Title large>Agents</Stack.Title>
      <HeaderActions
        actions={[
          { icon: "clock", label: "Automations", onPress: () => router.push("/automations") },
          ...(activityOn ? [{ icon: "pulse" as const, label: "Activity", onPress: () => router.push("/activity") }] : []),
        ]}
      />
      <FlashList
        data={data}
        keyExtractor={(agent) => agent.id}
        renderItem={renderItem}
        extraData={counts}
        contentInsetAdjustmentBehavior="automatic"
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
                  { id: "all", label: "All" },
                  { id: "running", label: "Working", count: scoped.filter(tests.running).length },
                  { id: "needs", label: "Needs you", count: scoped.filter(tests.needs).length },
                  { id: "scheduled", label: "Automated", count: scoped.filter(tests.scheduled).length },
                  { id: "disabled", label: "Off", count: scoped.filter(tests.disabled).length },
                ]}
              />
            )}
          </View>
        }
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={
          agents.isLoading ? (
            <SkeletonRows count={7} avatar={46} />
          ) : agents.isError ? (
            <ErrorState title="Couldn't load agents" error={errorText(agents.error)} onRetry={() => void agents.refetch()} />
          ) : scoped.length ? (
            <EmptyState icon="agents" title="No agents match" body="No agents in this view." />
          ) : (
            <EmptyState
              icon="agents"
              title="Create your first agent"
              body="Agents are coworkers with their own instructions, memory and schedule — e.g. one that downloads your invoices every month."
              action={<Button title="New agent" icon="plus" onPress={newAgent} />}
            />
          )
        }
      />
    </>
  );
}
