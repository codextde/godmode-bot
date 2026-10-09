import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useMemo } from "react";
import { RefreshControl, SectionList, View } from "react-native";
import type { HumanTask } from "@godmode/shared";
import { HumanTaskRow } from "@/components/human-task-row";
import { EmptyState, ErrorState, Hairline, SectionTitle, SkeletonRows } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { space } from "@/lib/theme";

const DONE_SHOWN = 20;

/** What agents need the human to do: a passkey, a CAPTCHA, a signature. Closing one continues the agent's chat. */
export default function MyTasks() {
  const list = useQuery({ queryKey: qk.humanTaskList("all"), queryFn: () => api.humanTasks.list({ status: "all" }) });
  const { byId } = useAgents();
  const pull = usePullRefresh(list.refetch);

  const sections = useMemo(() => {
    const all = list.data ?? [];
    const urgentFirst = (a: HumanTask, b: HumanTask) => Number(b.priority === "high") - Number(a.priority === "high") || (a.createdAt < b.createdAt ? 1 : -1);
    const closed = all.filter((t) => t.status !== "open" && t.status !== "doing").sort((a, b) => ((a.closedAt ?? a.updatedAt) < (b.closedAt ?? b.updatedAt) ? 1 : -1));
    return [
      { title: "To do", data: all.filter((t) => t.status === "open").sort(urgentFirst) },
      { title: "Doing", data: all.filter((t) => t.status === "doing").sort(urgentFirst) },
      { title: "Done", data: closed.slice(0, DONE_SHOWN) },
    ].filter((s) => s.data.length);
  }, [list.data]);

  return (
    <>
      <Stack.Title>My tasks</Stack.Title>
      <SectionList<HumanTask>
        sections={sections}
        keyExtractor={(t) => t.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <View style={{ paddingHorizontal: space.sm, paddingTop: space.lg }}>
            <SectionTitle title={section.title} />
          </View>
        )}
        ItemSeparatorComponent={() => <Hairline inset={72} />}
        renderItem={({ item }) => <HumanTaskRow task={item} agent={item.agentId ? byId.get(item.agentId) : undefined} />}
        ListEmptyComponent={
          list.isLoading ? (
            <View style={{ paddingTop: space.lg }}>
              <SkeletonRows count={5} avatar={40} />
            </View>
          ) : list.isError ? (
            <ErrorState title="Couldn't load your tasks" error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : (
            <EmptyState
              icon="person"
              title="Nothing for you to do"
              body="When an agent needs you for something only you can do, like a passkey, a CAPTCHA or a signature, it lands here."
            />
          )
        }
      />
    </>
  );
}
