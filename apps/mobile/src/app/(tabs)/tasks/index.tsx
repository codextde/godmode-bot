import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { useMemo } from "react";
import { RefreshControl, SectionList, View } from "react-native";
import type { Task, TaskStatus } from "@godmode/shared";
import { HeaderActions } from "@/components/header-actions";
import { TaskRow } from "@/components/task-row";
import { Button, EmptyState, Hairline, SectionTitle } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { useWorkspace } from "@/lib/workspace";
import { space } from "@/lib/theme";

const GROUPS: { title: string; statuses: TaskStatus[] }[] = [
  { title: "Needs you", statuses: ["in_review", "blocked"] },
  { title: "In progress", statuses: ["in_progress", "todo"] },
  { title: "Backlog", statuses: ["backlog"] },
  { title: "Done", statuses: ["done", "cancelled"] },
];

/** The task board of the picked workspace, as a list: what needs you first. */
export default function Tasks() {
  const { id: workspaceId, workspaces } = useWorkspace();
  const tasks = useQuery({ queryKey: qk.taskList(workspaceId), queryFn: () => api.tasks.list({ workspaceId }) });
  const { byId: agents } = useAgents();
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const pull = usePullRefresh(tasks.refetch);
  const newTask = () => router.push("/new-task");

  const sections = useMemo(() => {
    const list = [...(tasks.data ?? [])].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return GROUPS.map((g) => ({ title: g.title, data: list.filter((t) => g.statuses.includes(t.status)) })).filter((s) => s.data.length);
  }, [tasks.data]);

  return (
    <>
      <Stack.Title large>Tasks</Stack.Title>
      <HeaderActions actions={[{ icon: "plus", label: "New task", onPress: newTask }]} />
      <SectionList<Task>
        sections={sections}
        keyExtractor={(t) => t.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 140 }}
        refreshControl={<RefreshControl {...pull} />}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.sm, paddingTop: space.sm }}>
            <WorkspaceChip />
          </View>
        }
        renderSectionHeader={({ section }) => (
          <View style={{ paddingHorizontal: space.sm, paddingTop: space.lg }}>
            <SectionTitle title={section.title} />
          </View>
        )}
        ItemSeparatorComponent={() => <Hairline inset={72} />}
        renderItem={({ item }) => (
          <TaskRow task={item} agent={item.agentId ? agents.get(item.agentId) : undefined} workspaceName={workspaceId ? undefined : names.get(item.workspaceId ?? "")} />
        )}
        ListEmptyComponent={
          tasks.isLoading ? null : (
            <EmptyState
              icon="tasks"
              title="No tasks yet"
              body="Hand an agent a task and follow it here: it works on it, then asks you to review."
              action={<Button title="New task" icon="plus" onPress={newTask} />}
            />
          )
        }
      />
    </>
  );
}
