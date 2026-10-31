import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Link, Stack } from "expo-router";
import { memo, useCallback, useMemo } from "react";
import { Alert, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent, Task } from "@godmode/shared";
import { TaskRow } from "@/components/task-row";
import { EmptyState, ErrorState, Hairline, SkeletonRows, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { t } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { tasksInProject, useProjectIndex, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

/** Tasks taken off the board of the picked workspace (or project), the latest archived first. */
export default function ArchivedTasks() {
  const { t } = useTranslation("tasks");
  const { id: workspaceId, projectId, workspaces } = useWorkspace();
  const projects = useProjectIndex();
  const tasks = useQuery({ queryKey: qk.taskList(workspaceId, true), queryFn: () => api.tasks.list({ workspaceId, archived: true }) });
  const { byId: agents } = useAgents();
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const pull = usePullRefresh(tasks.refetch);

  const data = useMemo(
    () => [...tasksInProject(tasks.data ?? [], projectId)].sort((a, b) => ((a.archivedAt ?? a.updatedAt) < (b.archivedAt ?? b.updatedAt) ? 1 : -1)),
    [tasks.data, projectId],
  );

  const renderItem: ListRenderItem<Task> = useCallback(
    ({ item: t }) => (
      <ArchivedTask
        task={t}
        agent={t.agentId ? agents.get(t.agentId) : undefined}
        workspaceName={workspaceId ? undefined : names.get(t.workspaceId ?? "")}
        projectName={projectId || !t.projectId ? undefined : projects.get(t.projectId)?.project.name}
      />
    ),
    [agents, workspaceId, names, projectId, projects],
  );

  return (
    <>
      <Stack.Title>{t("archivedTasks.title")}</Stack.Title>
      <FlashList
        data={data}
        keyExtractor={(t) => t.id}
        renderItem={renderItem}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={
          tasks.isLoading ? (
            <SkeletonRows count={6} avatar={40} />
          ) : tasks.isError ? (
            <ErrorState title={t("archivedTasks.loadFailed")} error={errorText(tasks.error)} onRetry={() => void tasks.refetch()} />
          ) : (
            <EmptyState icon="archive" title={t("archivedTasks.emptyTitle")} body={t("archivedTasks.emptyBody")} />
          )
        }
      />
    </>
  );
}

const Separator = () => <Hairline inset={72} />;

/** Out of every cached archive right away; the refetch brings it back if the computer refused. */
function restoreTask(id: string) {
  queryClient.setQueriesData<Task[]>({ queryKey: [...qk.tasks, "list"], predicate: (q) => q.queryKey[3] === "archived" }, (list) => list?.filter((t) => t.id !== id));
  api.tasks
    .update(id, { archived: false })
    .catch((err) => Alert.alert(t("tasks:archivedTasks.restoreFailed"), errorText(err)))
    .finally(() => void queryClient.invalidateQueries({ queryKey: qk.tasks }));
}

/** Long press on iOS: put it back on the board. Android has no such menu, so the row carries a Restore button. */
const ArchivedTask = memo(function ArchivedTask({ task, agent, workspaceName, projectName }: { task: Task; agent?: Agent; workspaceName?: string; projectName?: string }) {
  const c = useColors();
  const { t } = useTranslation("tasks");
  const row = <TaskRow task={task} agent={agent} workspaceName={workspaceName} projectName={projectName} />;
  if (process.env.EXPO_OS !== "ios") {
    return (
      <View style={styles.withAction}>
        <View style={{ flex: 1, minWidth: 0 }}>{row}</View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("archivedTasks.restoreA11y", { title: task.title })}
          hitSlop={8}
          onPress={() => {
            tap();
            restoreTask(task.id);
          }}
          style={({ pressed }) => [styles.action, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
        >
          <T variant="footnote" style={{ fontWeight: "600" }}>
            {t("archivedTasks.restore")}
          </T>
        </Pressable>
      </View>
    );
  }
  return (
    <Link href={{ pathname: "/task/[id]", params: { id: task.id } }} asChild>
      <Link.Trigger>
        <View>{row}</View>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        <Link.MenuAction title={t("archivedTasks.putBack")} icon="arrow.uturn.backward" onPress={() => restoreTask(task.id)} />
      </Link.Menu>
    </Link>
  );
});

const styles = StyleSheet.create({
  withAction: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: space.sm,
  },
  action: {
    height: 30,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    justifyContent: "center",
  },
});
