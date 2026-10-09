import { router, Stack } from "expo-router";
import { useMemo } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { AgentRow } from "@/components/rows";
import { EmptyState, ErrorState, Hairline, SkeletonRows, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { WorkspaceChip } from "@/components/workspace-chip";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { agentsFor, useWorkspace } from "@/lib/workspace";
import { space } from "@/lib/theme";

export default function Agents() {
  const agents = useAgents();
  const { id: workspaceId, projectId } = useWorkspace();
  const runs = useLive((s) => s.runs);
  // Working means running; a run waiting for a free slot is only queued.
  const counts = useMemo(() => {
    const m = new Map<string, { running: number; queued: number }>();
    for (const { run } of Object.values(runs)) {
      const n = m.get(run.agentId) ?? { running: 0, queued: 0 };
      if (run.status === "running") n.running++;
      else if (run.status === "queued") n.queued++;
      m.set(run.agentId, n);
    }
    return m;
  }, [runs]);
  const busy = useMemo(() => new Set([...counts].flatMap(([id, n]) => (n.running ? [id] : []))), [counts]);
  const pull = usePullRefresh(agents.refetch);
  const data = useMemo(
    () =>
      [...agentsFor(agents.data ?? [], workspaceId)].sort(
        (a, b) =>
          Number(!!projectId && b.projectId === projectId) - Number(!!projectId && a.projectId === projectId) ||
          Number(busy.has(b.id)) - Number(busy.has(a.id)) || Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
      ),
    [agents.data, busy, workspaceId, projectId],
  );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 140 }}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Title large>Agents</Stack.Title>
      <View style={{ paddingHorizontal: space.sm, paddingVertical: space.sm }}>
        <WorkspaceChip />
      </View>
      {data.map((agent, i) => (
        <View key={agent.id}>
          {i > 0 && <Hairline inset={78} />}
          <AgentRow
            agent={agent}
            running={counts.get(agent.id)?.running ?? 0}
            queued={counts.get(agent.id)?.queued ?? 0}
            onPress={() => {
              tap();
              router.push({ pathname: "/agent/[id]", params: { id: agent.id } });
            }}
          />
        </View>
      ))}
      {agents.isLoading ? (
        <SkeletonRows count={7} avatar={46} />
      ) : agents.isError && !data.length ? (
        <ErrorState title="Couldn't load your agents" error={errorText(agents.error)} onRetry={() => void agents.refetch()} />
      ) : data.length === 0 ? (
        <EmptyState icon="agents" title="No agents yet" body="Create agents in Godmode on your computer." />
      ) : null}
    </ScrollView>
  );
}
