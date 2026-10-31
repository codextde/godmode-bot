import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Link, router, Stack } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import { Alert, RefreshControl, View } from "react-native";
import { useTranslation } from "react-i18next";
import { TASK_STATUSES, type Agent, type Task, type TaskStatus } from "@godmode/shared";
import { HeaderActions } from "@/components/header-actions";
import { HumanTaskRow } from "@/components/human-task-row";
import { FilterChips } from "@/components/filter-chips";
import { GoalsStrip } from "@/components/goals-strip";
import { STATUS_META, TaskRow } from "@/components/task-row";
import { Button, Card, EmptyState, ErrorState, Hairline, SectionTitle, SkeletonRows } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { useAgents, useOpenHumanTasks } from "@/lib/hooks";
import { t } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { tasksInProject, useProjectIndex, useWorkspace } from "@/lib/workspace";
import { space } from "@/lib/theme";

type Item = { kind: "header"; key: string; title: string } | { kind: "task"; key: string; task: Task };
type Shown = "active" | "all" | TaskStatus;

const ACTIVE: readonly TaskStatus[] = ["todo", "in_progress", "in_review", "blocked"];

/** The task board of the picked workspace (or project) as a list, in the desktop's columns: the active ones first. */
export default function Tasks() {
  const { t } = useTranslation(["tabs", "common"]);
  const { id: workspaceId, projectId, workspaces } = useWorkspace();
  const projects = useProjectIndex();
  const mine = useOpenHumanTasks();
  const tasks = useQuery({ queryKey: qk.taskList(workspaceId), queryFn: () => api.tasks.list({ workspaceId }) });
  const { byId: agents } = useAgents();
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const pull = usePullRefresh(() => Promise.all([tasks.refetch(), mine.refetch(), queryClient.invalidateQueries({ queryKey: qk.goals(workspaceId) })]));
  const [view, setView] = useState<Shown>("active");
  const newTask = () => router.push("/new-task");

  const board = useMemo(() => tasksInProject(tasks.data ?? [], projectId), [tasks.data, projectId]);
  const counts = useMemo(() => {
    const n = new Map<TaskStatus, number>();
    for (const t of board) n.set(t.status, (n.get(t.status) ?? 0) + 1);
    return n;
  }, [board]);
  const items = useMemo(() => {
    const statuses = view === "active" ? ACTIVE : view === "all" ? TASK_STATUSES : [view];
    const out: Item[] = [];
    for (const status of statuses) {
      const column = board.filter((t) => t.status === status).sort((a, b) => a.position - b.position || b.number - a.number);
      if (!column.length) continue;
      if (statuses.length > 1) out.push({ kind: "header", key: `h-${status}`, title: `${STATUS_META[status].label} · ${column.length}` });
      for (const task of column) out.push({ kind: "task", key: task.id, task });
    }
    return out;
  }, [board, view]);
  const forYou = mine.data ?? [];
  const activeCount = ACTIVE.reduce((n, s) => n + (counts.get(s) ?? 0), 0);

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
      <Stack.Title large>{t("tasks.title")}</Stack.Title>
      <HeaderActions
        actions={[
          { icon: "person", label: t("tasks.myTasks"), onPress: () => router.push("/my-tasks") },
          { icon: "plus", label: t("home.newTask"), onPress: newTask },
        ]}
        menu={[{ icon: "archive", title: t("tasks.archived"), onPress: () => router.push("/archived-tasks") }]}
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
                <SectionTitle title={t("tasks.myTasksCount", { count: forYou.length })} action={t("common:words.all")} onAction={() => router.push("/my-tasks")} />
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
            <GoalsStrip workspaceId={workspaceId} bleed={space.lg} />
            {board.length > 0 && (
              <FilterChips
                bleed={space.lg}
                value={view}
                onChange={setView}
                filters={[
                  { id: "active", label: t("tasks.filterActive"), count: activeCount },
                  { id: "all", label: t("common:words.all"), count: board.length },
                  ...TASK_STATUSES.map((s) => ({ id: s, label: STATUS_META[s].label, count: counts.get(s) ?? 0 })),
                ]}
              />
            )}
          </View>
        }
        ListEmptyComponent={
          tasks.isLoading ? (
            <View style={{ paddingTop: space.md }}>
              <SkeletonRows count={6} avatar={40} />
            </View>
          ) : tasks.isError ? (
            <ErrorState title={t("tasks.loadError")} error={errorText(tasks.error)} onRetry={() => void tasks.refetch()} />
          ) : board.length ? (
            <EmptyState
              icon="tasks"
              title={view === "active" ? t("tasks.emptyActive.title") : t("tasks.emptyStatus", { status: STATUS_META[view as TaskStatus]?.label ?? t("tasks.thisView") })}
              body={view === "active" ? t("tasks.emptyActive.body") : undefined}
              action={view === "active" ? <Button title={t("home.newTask")} icon="plus" onPress={newTask} /> : undefined}
            />
          ) : (
            <EmptyState
              icon="tasks"
              title={t("tasks.empty.title")}
              body={t("tasks.empty.body")}
              action={<Button title={t("home.newTask")} icon="plus" onPress={newTask} />}
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
    .catch((err) => Alert.alert(t("tabs:tasks.archiveFailed"), errorText(err)))
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
  const { t } = useTranslation("tabs");
  const confirmArchive = () => {
    if (task.status !== "in_progress") return archiveTask(task.id);
    Alert.alert(t("tasks.stopDialog.title"), t("tasks.stopDialog.body", { name: agent?.name ?? t("tasks.stopDialog.theAgent") }), [
      { text: t("tasks.stopDialog.keep"), style: "cancel" },
      { text: t("tasks.stopDialog.confirm"), style: "destructive", onPress: () => archiveTask(task.id) },
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
        <Link.MenuAction title={t("chats.menu.archive")} icon="archivebox" onPress={confirmArchive} />
      </Link.Menu>
    </Link>
  );
});
