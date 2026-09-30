import { router, Stack } from "expo-router";
import { useMemo } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { AgentRow } from "@/components/rows";
import { EmptyState, Hairline, tap } from "@/components/ui";
import { useAgents } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

export default function Agents() {
  const agents = useAgents();
  const runs = useLive((s) => s.runs);
  const busy = useMemo(() => new Set(Object.values(runs).map((r) => r.run.agentId)), [runs]);
  const pull = usePullRefresh(agents.refetch);
  const data = useMemo(
    () =>
      [...(agents.data ?? [])].sort(
        (a, b) => Number(busy.has(b.id)) - Number(busy.has(a.id)) || Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
      ),
    [agents.data, busy],
  );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 140 }}
      refreshControl={<RefreshControl {...pull} />}
    >
      <Stack.Title large>Agents</Stack.Title>
      {data.map((agent, i) => (
        <View key={agent.id}>
          {i > 0 && <Hairline inset={78} />}
          <AgentRow
            agent={agent}
            running={busy.has(agent.id)}
            onPress={() => {
              tap();
              router.push({ pathname: "/agent/[id]", params: { id: agent.id } });
            }}
          />
        </View>
      ))}
      {!agents.isLoading && data.length === 0 && <EmptyState icon="agents" title="No agents yet" body="Create agents in Godmode on your computer." />}
    </ScrollView>
  );
}
