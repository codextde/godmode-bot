import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { router, Stack } from "expo-router";
import { memo, useCallback, useMemo } from "react";
import { RefreshControl, View } from "react-native";
import type { Agent } from "@godmode/shared";
import { AgentRow } from "@/components/rows";
import { EmptyState, ErrorState, Hairline, SkeletonRows, tap } from "@/components/ui";
import { errorText } from "@/lib/api";
import { WorkspaceChip } from "@/components/workspace-chip";
import { useAgents } from "@/lib/hooks";
import { useRunCounts } from "@/lib/live";
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

const Header = () => (
  <View style={{ paddingHorizontal: space.sm, paddingVertical: space.sm }}>
    <WorkspaceChip />
  </View>
);

export default function Agents() {
  const agents = useAgents();
  const { id: workspaceId, projectId } = useWorkspace();
  // Working means running; a run waiting for a free slot is only queued.
  const counts = useRunCounts();
  const pull = usePullRefresh(agents.refetch);
  const data = useMemo(
    () =>
      [...agentsFor(agents.data ?? [], workspaceId)].sort(
        (a, b) =>
          Number(!!projectId && b.projectId === projectId) - Number(!!projectId && a.projectId === projectId) ||
          Number(!!counts.get(b.id)?.running) - Number(!!counts.get(a.id)?.running) ||
          Number(b.isDefault) - Number(a.isDefault) ||
          a.name.localeCompare(b.name),
      ),
    [agents.data, counts, workspaceId, projectId],
  );
  const renderItem: ListRenderItem<Agent> = useCallback(
    ({ item }) => {
      const n = counts.get(item.id) ?? NONE;
      return <AgentItem agent={item} running={n.running} queued={n.queued} />;
    },
    [counts],
  );

  return (
    <>
      <Stack.Title large>Agents</Stack.Title>
      <FlashList
        data={data}
        keyExtractor={(agent) => agent.id}
        renderItem={renderItem}
        extraData={counts}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 140 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={Header}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={
          agents.isLoading ? (
            <SkeletonRows count={7} avatar={46} />
          ) : agents.isError ? (
            <ErrorState title="Couldn't load your agents" error={errorText(agents.error)} onRetry={() => void agents.refetch()} />
          ) : (
            <EmptyState icon="agents" title="No agents yet" body="Create agents in Godmode on your computer." />
          )
        }
      />
    </>
  );
}
