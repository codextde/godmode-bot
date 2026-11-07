import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Link, router, Stack, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { isOverdue, localDay, TASK_PRIORITIES, TASK_STATUSES, type Agent, type Task, type TaskStatus } from "@godmode/shared";
import { FilterToolbar } from "@/components/filter-toolbar";
import { useFullAccess } from "@/components/full-access";
import { ActiveFilterChip } from "@/components/filter-chips";
import { GoalsStrip } from "@/components/goals-strip";
import { STATUS_META, TaskRow } from "@/components/task-row";
import { Icon, sfSymbol, type IconName } from "@/components/icon";
import { useMenuSheet } from "@/components/header-actions";
import { Button, EmptyState, ErrorState, Hairline, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { WorkspaceChip } from "@/components/workspace-chip";
import { api, errorText } from "@/lib/api";
import { PRIORITY_LABEL } from "@/lib/desktop-parity";
import { useAgents, useOpenHumanTasks } from "@/lib/hooks";
import { t } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { columnOf, MOVE_ICON, moveTask, taskMoves, type TaskMove } from "@/lib/task-order";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { tasksInProject, useProjectIndex, useWorkspace } from "@/lib/workspace";
import { radius, space, textScale, useColors } from "@/lib/theme";

type Item = { kind: "header"; key: string; title: string; status: TaskStatus; count: number } | { kind: "task"; key: string; task: Task };
type Shown = "active" | "all" | TaskStatus;

const ACTIVE: readonly TaskStatus[] = ["todo", "in_progress", "in_review", "blocked"];
/** The columns that clear with one action, like the desktop's board. */
const ARCHIVE_ALL: ReadonlySet<TaskStatus> = new Set(["done", "cancelled"]);

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
  // Ordering within a column: a full-access phone, like the desktop's drag (limited phones keep today's rules).
  const canMove = useFullAccess().fullAccess === true;
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const goals = useQuery({ queryKey: qk.goals(workspaceId), queryFn: () => api.goals.list(workspaceId) });
  const pull = usePullRefresh(() => Promise.all([tasks.refetch(), mine.refetch(), goals.refetch()]));
  const [view, setView] = useState<Shown>("active");
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState(ALL);
  // Coming from an agent's heartbeat: its tickets. The param goes right away, so the next visit applies it again.
  const { agent: agentParam } = useLocalSearchParams<{ agent?: string }>();
  const [seenParam, setSeenParam] = useState<string | undefined>(undefined);
  if (agentParam !== seenParam) {
    setSeenParam(agentParam);
    if (agentParam) setAgent(agentParam);
  }
  useEffect(() => {
    if (agentParam) router.setParams({ agent: undefined });
  }, [agentParam]);
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
    const ids = [...new Set([...onBoard.map((t) => t.agentId), agent === ALL || agent === UNASSIGNED ? null : agent].filter((id): id is string => !!id))];
    const named = ids.map((id) => ({ value: id, label: agents.get(id)?.name ?? t("tasks:task.anAgent") })).sort((a, b) => a.label.localeCompare(b.label));
    const labels = [...new Set(onBoard.flatMap((t) => t.labels ?? []))].sort((a, b) => a.localeCompare(b));
    return {
      agents: [{ value: ALL, label: t("tasks:list.allAgents") }, ...named, ...(onBoard.some((t) => !t.agentId) ? [{ value: UNASSIGNED, label: t("tasks:list.unassigned") }] : [])],
      labels: [{ value: ALL, label: t("tasks:list.allLabels") }, ...labels.map((l) => ({ value: l, label: l }))],
    };
  }, [onBoard, agents, agent, t]);
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
      if (statuses.length > 1 || ARCHIVE_ALL.has(status)) out.push({ kind: "header", key: `h-${status}`, title: `${STATUS_META[status].label} · ${column.length}`, status, count: column.length });
      for (const task of column) out.push({ kind: "task", key: task.id, task });
    }
    return out;
  }, [board, view]);
  const forYou = mine.data ?? [];
  const activeGoals = (goals.data ?? []).filter((g) => g.status === "active").length;
  const viewOptions = [
    { value: "active", label: t("tasks.filterActive") },
    { value: "all", label: t("common:words.all") },
    ...TASK_STATUSES.map((s) => ({ value: s, label: STATUS_META[s].label })),
  ];
  const priorityOptions = [{ value: ALL, label: t("tasks:list.anyPriority") }, ...TASK_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))];
  const dueOptions = (["all", "overdue", "week", "none"] as const).map((d) => ({ value: d, label: d === ALL ? t("tasks:list.anyDue") : t(`tasks:list.${d}`) }));
  const optionLabel = (options: { value: string; label: string }[], value: string) => options.find((o) => o.value === value)?.label ?? value;
  // What the header's filter menu narrowed the board to, each with a way off, on the one line above the board.
  const picked = [
    view !== "active" && { key: "view", label: optionLabel(viewOptions, view), count: view === "all" ? board.length : (counts.get(view) ?? 0), clear: () => setView("active") },
    agent !== ALL && { key: "agent", label: optionLabel(filterOptions.agents, agent), clear: () => setAgent(ALL) },
    priority !== ALL && { key: "priority", label: optionLabel(priorityOptions, priority), clear: () => setPriority(ALL) },
    due !== ALL && { key: "due", label: optionLabel(dueOptions, due), clear: () => setDue(ALL) },
    label !== ALL && { key: "label", label, clear: () => setLabel(ALL) },
  ].filter((f): f is { key: string; label: string; count?: number; clear: () => void } => !!f);

  const renderItem: ListRenderItem<Item> = useCallback(
    ({ item, index }) => {
      if (item.kind === "header") return <GroupTitle title={item.title} action={ARCHIVE_ALL.has(item.status) ? () => archiveColumn(item.status, board.filter((t) => t.status === item.status)) : undefined} />;
      const t = item.task;
      return (
        <TaskItem
          task={t}
          agent={t.agentId ? agents.get(t.agentId) : undefined}
          workspaceName={workspaceId ? undefined : names.get(t.workspaceId ?? "")}
          projectName={projectId || !t.projectId ? undefined : projects.get(t.projectId)?.project.name}
          divided={items[index - 1]?.kind === "task"}
          board={canMove ? board : undefined}
        />
      );
    },
    [agents, workspaceId, names, projectId, projects, items, board, canMove],
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
          { id: "view", title: t("tasks:list.status"), icon: "tasks", value: view, options: viewOptions, onChange: (v) => setView(v as Shown) },
          { id: "agent", title: t("tasks:list.agent"), icon: "agents", value: agent, options: filterOptions.agents, onChange: setAgent },
          { id: "priority", title: t("tasks:list.priority"), icon: "flag", value: priority, options: priorityOptions, onChange: setPriority },
          { id: "due", title: t("tasks:list.due"), icon: "calendar", value: due, options: dueOptions, onChange: (v) => setDue(v as Due) },
          { id: "label", title: t("tasks:list.label"), icon: "tag", value: label, options: filterOptions.labels, onChange: setLabel },
        ]}
        menu={[
          { icon: "flag", title: t("tasks.newGoal"), onPress: () => router.push(workspaceId ? { pathname: "/goal", params: { workspaceId } } : "/goal") },
          { icon: "archive", title: t("tasks.archived"), onPress: () => router.push("/archived-tasks") },
        ]}
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
          <View style={{ paddingHorizontal: space.sm, paddingVertical: space.sm, gap: space.lg }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -space.lg }} contentContainerStyle={styles.top}>
              <WorkspaceChip />
              {picked.map((f) => (
                <ActiveFilterChip key={f.key} label={f.label} count={f.count} onClear={f.clear} />
              ))}
              {forYou.length > 0 && <TopPill icon="person" label={t("tasks.myTasks")} count={forYou.length} onPress={() => router.push("/my-tasks")} />}
              {activeGoals > 0 && <TopPill icon="flag" label={t("tasks.goals")} count={activeGoals} open={goalsOpen} onPress={() => setGoalsOpen((v) => !v)} />}
            </ScrollView>
            {goalsOpen && <GoalsStrip workspaceId={workspaceId} bleed={space.lg} />}
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

function GroupTitle({ title, action }: { title: string; action?: () => void }) {
  const { t } = useTranslation("tabs");
  return (
    <View style={{ paddingHorizontal: space.sm, paddingTop: space.lg }}>
      <SectionTitle title={title} action={action ? t("tasks.archiveAll") : undefined} onAction={action} />
    </View>
  );
}

/** A short way into what stands beside the board, on the workspace's line. */
function TopPill({ icon, label, count, open, onPress }: { icon: IconName; label: string; count: number; open?: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count}`}
      accessibilityState={open === undefined ? undefined : { expanded: open }}
      hitSlop={6}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [styles.pill, { backgroundColor: open ? c.brandSoft : c.sunken, opacity: pressed ? 0.7 : 1 }]}
    >
      <Icon name={icon} size={12} color={open ? c.brandStrong : c.textMuted} />
      <T variant="subhead" numberOfLines={1} maxScale={textScale.control} style={{ fontWeight: "600" }}>
        {label}
      </T>
      <T variant="footnote" muted maxScale={textScale.control} style={{ fontVariant: ["tabular-nums"] }}>
        {count}
      </T>
    </Pressable>
  );
}

/** Clearing a column: off the board, never deleted. */
function archiveColumn(status: TaskStatus, column: Task[]) {
  if (!column.length) return;
  const label = STATUS_META[status].label;
  Alert.alert(t("tabs:tasks.archiveAllTitle", { count: column.length, status: label }), t("tabs:tasks.archiveAllBody"), [
    { text: t("common:actions.cancel"), style: "cancel" },
    {
      text: t("tabs:tasks.archiveAll"),
      onPress: () =>
        void api.tasks
          .archive(column.map((task) => task.id))
          .catch((err) => Alert.alert(t("tabs:tasks.archiveFailed"), errorText(err)))
          .finally(() => void queryClient.invalidateQueries({ queryKey: qk.tasks })),
    },
  ]);
}

function archiveTask(id: string) {
  api.tasks
    .update(id, { archived: true })
    .catch((err) => Alert.alert(t("tabs:tasks.archiveFailed"), errorText(err)))
    .finally(() => void queryClient.invalidateQueries({ queryKey: qk.tasks }));
}


/** Long press: move it within its column (as the list shows it), or archive it (off the board, restorable on the computer). */
const TaskItem = memo(function TaskItem({
  task,
  agent,
  workspaceName,
  projectName,
  divided,
  board,
}: {
  task: Task;
  agent?: Agent;
  workspaceName?: string;
  projectName?: string;
  divided: boolean;
  /** The board as shown, when this phone may move tickets within their column. */
  board?: Task[];
}) {
  const { t } = useTranslation(["tabs", "tasks"]);
  const menu = useMenuSheet();
  const column = useMemo(() => (board ? columnOf(board, task) : []), [board, task]);
  const moves = useMemo(() => taskMoves(column, task.id), [column, task.id]);
  const move = (m: TaskMove) => void moveTask(task, m, column);
  const confirmArchive = () => {
    if (task.status !== "in_progress") return archiveTask(task.id);
    Alert.alert(t("tasks.stopDialog.title"), t("tasks.stopDialog.body", { name: agent?.name ?? t("tasks.stopDialog.theAgent") }), [
      { text: t("tasks.stopDialog.keep"), style: "cancel" },
      { text: t("tasks.stopDialog.confirm"), style: "destructive", onPress: () => archiveTask(task.id) },
    ]);
  };

  const row = (onLongPress?: () => void) => (
    <>
      {divided && <Hairline inset={72} />}
      <TaskRow task={task} agent={agent} workspaceName={workspaceName} projectName={projectName} onLongPress={onLongPress} />
    </>
  );
  if (process.env.EXPO_OS !== "ios") {
    return (
      <>
        {row(() => {
          tap();
          menu.show(
            [
              ...moves.map((m) => ({ icon: MOVE_ICON[m], title: t(`tasks:order.${m}`), onPress: () => move(m) })),
              { icon: "archive", title: t("chats.menu.archive"), onPress: confirmArchive },
            ],
            task.title,
          );
        })}
        {menu.sheet}
      </>
    );
  }
  return (
    <Link href={{ pathname: "/task/[id]", params: { id: task.id } }} asChild>
      <Link.Trigger>
        <View>{row()}</View>
      </Link.Trigger>
      <Link.Preview />
      <Link.Menu>
        {moves.map((m) => (
          <Link.MenuAction key={m} title={t(`tasks:order.${m}`)} icon={sfSymbol(MOVE_ICON[m])} onPress={() => move(m)} />
        ))}
        <Link.MenuAction title={t("chats.menu.archive")} icon="archivebox" onPress={confirmArchive} />
      </Link.Menu>
    </Link>
  );
});

const styles = StyleSheet.create({
  top: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
});
