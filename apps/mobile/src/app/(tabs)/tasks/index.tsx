import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Link, router, Stack } from "expo-router";
import { memo, useCallback, useMemo } from "react";
import { Alert, RefreshControl, View } from "react-native";
import type { Agent, Task, TaskStatus } from "@godmode/shared";
import { HeaderActions } from "@/components/header-actions";
import { HumanTaskRow } from "@/components/human-task-row";
import { TaskRow } from "@/components/task-row";
import { Button, Card, EmptyState, ErrorState, Hairline, SectionTitle, SkeletonRows } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { useAgents, useOpenHumanTasks } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { tasksInProject, useProjectIndex, useWorkspace } from "@/lib/workspace";
import { space } from "@/lib/theme";

type Item = { kind: "header"; key: string; title: string } | { kind: "task"; key: string; task: Task };

const GROUPS: { title: string; statuses: TaskStatus[] }[] = [
  { title: "Needs you", statuses: ["in_review", "blocked"] },
  { title: "In progress", statuses: ["in_progress", "todo"] },
  { title: "Backlog", statuses: ["backlog"] },
  { title: "Done", statuses: ["done", "cancelled"] },
];

/** The task board of the picked workspace (or project), as a list: what agents need you to do, then what needs you first. */
export default function Tasks() {
  const { id: workspaceId, projectId, workspaces } = useWorkspace();
  const projects = useProjectIndex();
  const mine = useOpenHumanTasks();
  const tasks = useQuery({ queryKey: qk.taskList(workspaceId), queryFn: () => api.tasks.list({ workspaceId }) });
  const { byId: agents } = useAgents();
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const pull = usePullRefresh(() => Promise.all([tasks.refetch(), mine.refetch()]));
  const newTask = () => router.push("/new-task");

  const items = useMemo(() => {
    const list = [...tasksInProject(tasks.data ?? [], projectId)].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const out: Item[] = [];
    for (const g of GROUPS) {
      const group = list.filter((t) => g.statuses.includes(t.status));
      if (!group.length) continue;
      out.push({ kind: "header", key: `h-${g.title}`, title: g.title });
      for (const task of group) out.push({ kind: "task", key: task.id, task });
    }
    return out;
  }, [tasks.data, projectId]);
  const forYou = mine.data ?? [];

  const renderItem: ListRenderItem<Item> = useCallback(
    ({ item, index }) => {
      if (item.kind === "header") return <GroupTitle title={item.title} />;
      const t = item.task;
      return (
        <TaskItem
          task={t}
          agent={t.agentId ? agents.get(t.agentId) : undefined}
          workspaceName={workspaceId ? undefined : names.get(t.workspaceId ?? "")}
          projectName={projectId || !t.projectId ? undefined : projects.get(t.projectId)?.project.name}
          divided={items[index - 1]?.kind === "task"}
        />
      );
    },
    [agents, workspaceId, names, projectId, projects, items],
  );

  return (
    <>
      <Stack.Title large>Tasks</Stack.Title>
      <HeaderActions
        actions={[
          { icon: "person", label: "My tasks", onPress: () => router.push("/my-tasks") },
          { icon: "plus", label: "New task", onPress: newTask },
        ]}
        menu={[{ icon: "archive", title: "Archived tasks", onPress: () => router.push("/archived-tasks") }]}
      />
      <FlashList
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 140 }}
        refreshControl={<RefreshControl {...pull} />}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.sm, paddingTop: space.sm, gap: space.lg }}>
            <WorkspaceChip />
            {forYou.length > 0 && (
              <View>
                <SectionTitle title={`For you · ${forYou.length}`} action="All" onAction={() => router.push("/my-tasks")} />
                <Card style={{ paddingVertical: 4 }}>
                  {forYou.slice(0, 3).map((t, i) => (
                    <View key={t.id}>
                      {i > 0 && <Hairline inset={72} />}
                      <HumanTaskRow task={t} agent={t.agentId ? agents.get(t.agentId) : undefined} />
                    </View>
                  ))}
                </Card>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          tasks.isLoading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={6} avatar={40} />
            </View>
          ) : tasks.isError ? (
            <ErrorState title="Couldn't load the tasks" error={errorText(tasks.error)} onRetry={() => void tasks.refetch()} />
          ) : (
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

function GroupTitle({ title }: { title: string }) {
  return (
    <View style={{ paddingHorizontal: space.sm, paddingTop: space.lg }}>
      <SectionTitle title={title} />
    </View>
  );
}

function archiveTask(id: string) {
  api.tasks
    .update(id, { archived: true })
    .catch((err) => Alert.alert("Couldn't archive the task", errorText(err)))
    .finally(() => void queryClient.invalidateQueries({ queryKey: qk.tasks }));
}

/** Long press on iOS: archive the task (off the board, restorable on the computer). */
const TaskItem = memo(function TaskItem({
  task,
  agent,
  workspaceName,
  projectName,
  divided,
}: {
  task: Task;
  agent?: Agent;
  workspaceName?: string;
  projectName?: string;
  divided: boolean;
}) {
  const confirmArchive = () => {
    if (task.status !== "in_progress") return archiveTask(task.id);
    Alert.alert("Stop the agent?", `${agent?.name ?? "The agent"} is still working on it. Archiving it stops the run.`, [
      { text: "Keep working", style: "cancel" },
      { text: "Stop and archive", style: "destructive", onPress: () => archiveTask(task.id) },
    ]);
  };

  const row = (
    <>
      {divided && <Hairline inset={72} />}
      <TaskRow task={task} agent={agent} workspaceName={workspaceName} projectName={projectName} />
    </>
  );
  if (process.env.EXPO_OS !== "ios") return row;
  return (
    <Link href={{ pathname: "/task/[id]", params: { id: task.id } }} asChild>
      <Link.Trigger>
        <View>{row}</View>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        <Link.MenuAction title="Archive" icon="archivebox" onPress={confirmArchive} />
      </Link.Menu>
    </Link>
  );
});
