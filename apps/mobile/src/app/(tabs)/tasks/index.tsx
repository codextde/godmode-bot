import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Link, router, Stack } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import { Alert, RefreshControl, View } from "react-native";
import { useTranslation } from "react-i18next";
import { isOverdue, localDay, TASK_PRIORITIES, TASK_STATUSES, type Agent, type Task, type TaskStatus } from "@godmode/shared";
import { FilterToolbar } from "@/components/filter-toolbar";
import { HumanTaskRow } from "@/components/human-task-row";
import { FilterChips } from "@/components/filter-chips";
import { GoalsStrip } from "@/components/goals-strip";
import { STATUS_META, TaskRow } from "@/components/task-row";
import { Button, Card, EmptyState, ErrorState, Hairline, SectionTitle, SkeletonRows } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { PRIORITY_LABEL } from "@/lib/desktop-parity";
import { useAgents, useOpenHumanTasks } from "@/lib/hooks";
import { t } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { tasksInProject, useProjectIndex, useWorkspace } from "@/lib/workspace";
import { space } from "@/lib/theme";

type Item = { kind: "header"; key: string; title: string } | { kind: "task"; key: string; task: Task };
type Shown = "active" | "all" | TaskStatus;

const ACTIVE: readonly TaskStatus[] = ["todo", "in_progress", "in_review", "blocked"];

const ALL = "all";
const UNASSIGNED = "unassigned";
type Due = typeof ALL | "overdue" | "week" | "none";

/** The desktop board's filters: agent, priority, due day, label and words. */
function matcher(q: { search: string; agent: string; priority: string; due: Due; label: string }, agentName: (id: string | null) => string) {
  const text = q.search.trim().toLowerCase();
  const today = localDay();
  const week = localDay(new Date(Date.now() + 7 * 86_400_000));
  return (t: Task) => {
    if (q.agent === UNASSIGNED ? t.agentId : q.agent !== ALL && t.agentId !== q.agent) return false;
    if (q.priority !== ALL && t.priority !== q.priority) return false;
    if (q.due === "overdue" && !isOverdue(t, today)) return false;
    if (q.due === "week" && !(t.dueDate && t.dueDate >= today && t.dueDate <= week)) return false;
    if (q.due === "none" && t.dueDate) return false;
    if (q.label !== ALL && !(t.labels ?? []).includes(q.label)) return false;
    if (!text) return true;
    return `#${t.number} ${t.title} ${t.summary ?? ""} ${(t.labels ?? []).join(" ")} ${agentName(t.agentId)}`.toLowerCase().includes(text);
  };
}

/** The task board of the picked workspace (or project) as a list, in the desktop's columns: the active ones first. */
export default function Tasks() {
  const { t } = useTranslation(["tabs", "common", "tasks"]);
  const { id: workspaceId, projectId, workspaces } = useWorkspace();
  const projects = useProjectIndex();
  const mine = useOpenHumanTasks();
  const tasks = useQuery({ queryKey: qk.taskList(workspaceId), queryFn: () => api.tasks.list({ workspaceId }) });
  const { byId: agents } = useAgents();
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const pull = usePullRefresh(() => Promise.all([tasks.refetch(), mine.refetch(), queryClient.invalidateQueries({ queryKey: qk.goals(workspaceId) })]));
  const [view, setView] = useState<Shown>("active");
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState(ALL);
  const [priority, setPriority] = useState(ALL);
  const [due, setDue] = useState<Due>(ALL);
  const [label, setLabel] = useState(ALL);
  const newTask = () => router.push("/new-task");

  const onBoard = useMemo(() => tasksInProject(tasks.data ?? [], projectId), [tasks.data, projectId]);
  const narrowed = !!search.trim() || agent !== ALL || priority !== ALL || due !== ALL || label !== ALL;
  const board = useMemo(
    () => (narrowed ? onBoard.filter(matcher({ search, agent, priority, due, label }, (id) => (id ? (agents.get(id)?.name ?? "") : ""))) : onBoard),
    [onBoard, narrowed, search, agent, priority, due, label, agents],
  );
  const clearFilters = () => {
    setSearch("");
    setAgent(ALL);
    setPriority(ALL);
    setDue(ALL);
    setLabel(ALL);
  };
  const filterOptions = useMemo(() => {
    const ids = [...new Set(onBoard.map((t) => t.agentId).filter((id): id is string => !!id))];
    const named = ids.map((id) => ({ value: id, label: agents.get(id)?.name ?? t("tasks:task.anAgent") })).sort((a, b) => a.label.localeCompare(b.label));
    const labels = [...new Set(onBoard.flatMap((t) => t.labels ?? []))].sort((a, b) => a.localeCompare(b));
    return {
      agents: [{ value: ALL, label: t("tasks:list.allAgents") }, ...named, ...(onBoard.some((t) => !t.agentId) ? [{ value: UNASSIGNED, label: t("tasks:list.unassigned") }] : [])],
      labels: [{ value: ALL, label: t("tasks:list.allLabels") }, ...labels.map((l) => ({ value: l, label: l }))],
    };
  }, [onBoard, agents, t]);
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
      <Stack.SearchBar placeholder={t("tasks:list.search")} hideWhenScrolling onChangeText={(e) => setSearch(e.nativeEvent.text)} onCancelButtonPress={() => setSearch("")} />
      <FilterToolbar
        actions={[
          { icon: "person", label: t("tasks.myTasks"), onPress: () => router.push("/my-tasks") },
          { icon: "plus", label: t("home.newTask"), onPress: newTask },
        ]}
        filters={[
          { id: "agent", title: t("tasks:list.agent"), icon: "agents", value: agent, options: filterOptions.agents, onChange: setAgent },
          {
            id: "priority",
            title: t("tasks:list.priority"),
            icon: "flag",
            value: priority,
            options: [{ value: ALL, label: t("tasks:list.anyPriority") }, ...TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))],
            onChange: setPriority,
          },
          {
            id: "due",
            title: t("tasks:list.due"),
            icon: "calendar",
            value: due,
            options: (["all", "overdue", "week", "none"] as const).map((d) => ({ value: d, label: d === ALL ? t("tasks:list.anyDue") : t(`tasks:list.${d}`) })),
            onChange: (v) => setDue(v as Due),
          },
          { id: "label", title: t("tasks:list.label"), icon: "tag", value: label, options: filterOptions.labels, onChange: setLabel },
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
            {onBoard.length > 0 && (
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
          ) : narrowed && onBoard.length ? (
            <EmptyState icon="search" title={t("tasks:list.noMatch")} action={<Button title={t("tasks:list.clearFilters")} variant="secondary" onPress={clearFilters} />} />
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
