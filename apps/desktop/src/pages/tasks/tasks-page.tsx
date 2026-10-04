import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, FolderGit2, ListFilter, Plus, Search, SquareKanban } from "lucide-react";
import { toast } from "sonner";
import type { Task, TaskPriority, TaskStatus, Workspace } from "@godmode/shared";
import { TASK_PRIORITIES, isOverdue, localDay } from "@godmode/shared";
import { AgentAvatar, EmptyState, PageHeader } from "@/components/common";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LabelChip } from "@/components/tasks/task-fields";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArchivedTasks } from "@/components/tasks/archived-tasks";
import { useArchiveTasks } from "@/components/tasks/task-actions";
import { TaskBoard } from "@/components/tasks/task-board";
import { TaskDialog } from "@/components/tasks/task-dialog";
import { TaskSheet } from "@/components/tasks/task-sheet";
import { PRIORITY_META, PriorityIcon, STATUS_META, isWorking, needsConfirm, workspaceRepos } from "@/components/tasks/task-meta";
import { followupWhen } from "@/components/chat/followup";
import { toastApiError } from "@/components/vault/vault-utils";
import { WorkspaceDialog } from "@/components/workspaces/workspace-dialog";
import { api, errorMessage } from "@/lib/api";
import { useAllAgents, useArchivedTasks, useTasks, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { upsertTask } from "@/lib/realtime";
import { useUi } from "@/stores/ui";

const ALL = "all";
const UNASSIGNED = "unassigned";
const ARCHIVED = "archived";

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest("[role=dialog]"));
}

/** Where a moved card lands in the cached list until the server answers (same rule as the core). */
function optimisticPosition(list: Task[], task: Task, status: TaskStatus, beforeId: string | null): number {
  const column = list.filter((t) => t.status === status && t.id !== task.id).sort((a, b) => a.position - b.position);
  const idx = beforeId ? column.findIndex((t) => t.id === beforeId) : -1;
  if (idx < 0) return (column.at(-1)?.position ?? 0) + 1024;
  const next = column[idx]!.position;
  const prev = idx > 0 ? column[idx - 1]!.position : next - 2048;
  return (prev + next) / 2;
}

export default function TasksPage() {
  const qc = useQueryClient();
  const scope = useUi((s) => s.workspace);
  const [params, setParams] = useSearchParams();
  const tasksQ = useTasks();
  const archivedQ = useArchivedTasks();
  const { setArchived } = useArchiveTasks();
  const { data: agents = [] } = useAllAgents();
  const { data: workspaceList = [] } = useWorkspaces();
  // Filters live in the address: they survive opening a ticket's chat and coming back.
  const search = params.get("q") ?? "";
  const agentFilter = params.get("agent") ?? ALL;
  const priorities = useMemo(() => new Set((params.get("priority") ?? "").split(",").filter(Boolean) as TaskPriority[]), [params]);
  const dueFilter = params.get("due") as "overdue" | "week" | "none" | null;
  const labelFilter = useMemo(() => new Set((params.get("label") ?? "").split(",").filter(Boolean)), [params]);
  const setFilter = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    if (value) p.set(key, value);
    else p.delete(key);
    setParams(p, { replace: true });
  };
  const setSearch = (q: string) => setFilter("q", q || null);
  const setAgentFilter = (a: string) => setFilter("agent", a === ALL ? null : a);
  const toggleIn = (key: "priority" | "label", set: Set<string>, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setFilter(key, [...next].join(",") || null);
  };
  const filtersOn = priorities.size + labelFilter.size + (dueFilter ? 1 : 0);
  const clearFilters = () => {
    const p = new URLSearchParams(params);
    for (const k of ["q", "agent", "priority", "due", "label"]) p.delete(k);
    setParams(p, { replace: true });
  };
  const [creating, setCreating] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null);
  /** A move, an archive or a new agent that would end something: asked first. `reassignTo` set = a new agent. */
  const [stopping, setStopping] = useState<{ task: Task; status: TaskStatus; beforeId: string | null; archive?: boolean; reassignTo?: string | null } | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);

  const workspace = workspaceList.find((w) => w.id === scope) ?? null;
  const repos = workspaceRepos(workspace);
  const workspaces = useMemo(() => new Map(workspaceList.map((w) => [w.id, w])), [workspaceList]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const listKey = qk.taskList(scope);
  const tasks = useMemo(() => tasksQ.data ?? [], [tasksQ.data]);
  const archived = useMemo(
    () => [...(archivedQ.data ?? [])].sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? "") || b.number - a.number),
    [archivedQ.data],
  );
  const view = params.get("view") === ARCHIVED ? ARCHIVED : "board";
  const setView = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === ARCHIVED) p.set("view", ARCHIVED);
    else p.delete("view");
    setParams(p, { replace: true });
  };

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const today = localDay();
    const week = localDay(new Date(Date.now() + 7 * 86_400_000));
    return (t: Task) => {
      if (agentFilter === UNASSIGNED ? t.agentId : agentFilter !== ALL && t.agentId !== agentFilter) return false;
      if (priorities.size && !priorities.has(t.priority)) return false;
      if (dueFilter === "overdue" && !isOverdue(t, today)) return false;
      if (dueFilter === "week" && !(t.dueDate && t.dueDate >= today && t.dueDate <= week)) return false;
      if (dueFilter === "none" && t.dueDate) return false;
      if (labelFilter.size && !t.labels.some((l) => labelFilter.has(l))) return false;
      if (!q) return true;
      return `#${t.number} ${t.title} ${t.description} ${t.labels.join(" ")} ${t.agentId ? (agentById.get(t.agentId)?.name ?? "") : ""}`.toLowerCase().includes(q);
    };
  }, [search, agentFilter, agentById, priorities, dueFilter, labelFilter]);
  const labelsInUse = useMemo(() => [...new Set(tasks.flatMap((t) => t.labels))].sort((a, b) => a.localeCompare(b)), [tasks]);
  const overdueCount = useMemo(() => tasks.filter((t) => isOverdue(t)).length, [tasks]);
  const visible = useMemo(() => tasks.filter(matches), [tasks, matches]);
  const visibleArchived = useMemo(() => archived.filter(matches), [archived, matches]);

  const selectedId = params.get("task");
  const selected = selectedId ? (tasks.find((t) => t.id === selectedId) ?? archived.find((t) => t.id === selectedId) ?? null) : null;
  const openTask = (task: Task | null) => {
    const next = new URLSearchParams(params);
    if (task) next.set("task", task.id);
    else next.delete("task");
    setParams(next, { replace: !task });
  };
  useEffect(() => {
    if (!selectedId || !tasksQ.data || !(archivedQ.data || archivedQ.isError) || selected) return;
    // A link from a notification: the task may live in another scope.
    api.tasks
      .get(selectedId)
      .then((t) => {
        useUi.getState().setWorkspace(t.workspaceId ?? "global");
      })
      .catch(() => openTask(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, tasksQ.data, archivedQ.data, archivedQ.isError, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A key the app already used ("G then C" goes to Chat) isn't "new ticket".
      if (e.key.toLowerCase() !== "c" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
      e.preventDefault();
      setCreating(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const move = useMutation({
    mutationFn: ({ task, status, beforeId }: { task: Task; status: TaskStatus; beforeId: string | null }) => api.tasks.update(task.id, { status, beforeId }),
    onMutate: ({ task, status, beforeId }) => {
      // Moving an archived task brings it back on top of its new column.
      if (task.archivedAt) {
        const top = Math.min(1024, ...tasks.filter((t) => t.status === status).map((t) => t.position)) - 1024;
        return upsertTask(qc, { ...task, status, archivedAt: null, position: top });
      }
      qc.setQueryData<Task[]>(listKey, (list) =>
        list?.map((t) => (t.id === task.id ? { ...t, status, position: optimisticPosition(list, task, status, beforeId) } : t)),
      );
    },
    onSuccess: (t, { status, task }) => {
      upsertTask(qc, t);
      if ((status === "todo" || status === "in_progress") && !t.agentId) {
        toast("Assign an agent to start it", { action: { label: "Assign", onClick: () => openTask(t) } });
      }
      if (status === "blocked" && task.status !== "blocked") {
        toast(`#${t.number} moved to Blocked`, { action: { label: "Add a reason", onClick: () => openTask(t) } });
      }
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      toastApiError(e, "Could not move the task", qc);
    },
  });

  const requestMove = (task: Task, status: TaskStatus, beforeId: string | null = null) => {
    if (needsConfirm(task) && status !== "in_progress") setStopping({ task, status, beforeId });
    else move.mutate({ task, status, beforeId });
  };

  const archive = (list: Task[]) => {
    const working = list.find(needsConfirm);
    if (working && list.length === 1) setStopping({ task: working, status: "backlog", beforeId: null, archive: true });
    else setArchived(list, true);
  };

  const reassign = useMutation({
    mutationFn: ({ task, agentId }: { task: Task; agentId: string | null }) => api.tasks.update(task.id, { agentId }),
    onMutate: ({ task, agentId }) =>
      qc.setQueriesData<Task[]>({ queryKey: qk.tasks }, (list) => list?.map((t) => (t.id === task.id ? { ...t, agentId } : t))),
    onSuccess: (t) => upsertTask(qc, t),
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      toastApiError(e, "Could not change the agent", qc);
    },
  });
  const requestReassign = (task: Task, agentId: string | null) => {
    if (agentId === task.agentId) return;
    if (needsConfirm(task)) setStopping({ task, status: task.status, beforeId: null, reassignTo: agentId });
    else reassign.mutate({ task, agentId });
  };

  const quickAdd = useMutation({
    mutationFn: ({ status, title }: { status: TaskStatus; title: string }) =>
      api.tasks.create({ workspaceId: workspace?.id ?? null, title, status }),
    onSuccess: (t) => qc.setQueryData<Task[]>(listKey, (list) => (list && !list.some((x) => x.id === t.id) ? [...list, t] : list)),
    onError: (e) => toastApiError(e, "Could not add the task", qc),
  });

  const remove = useMutation({
    mutationFn: (task: Task) => api.tasks.delete(task.id),
    onSuccess: (_r, task) => {
      qc.setQueriesData<Task[]>({ queryKey: qk.tasks }, (list) => list?.filter((t) => t.id !== task.id));
      if (selectedId === task.id) openTask(null);
      toast.success(`#${task.number} deleted`);
    },
    onError: (e) => toastApiError(e, "Could not delete the task", qc),
  });

  const stopCopyOf = stopping ? stopCopy(stopping, (id) => (id ? (agentById.get(id)?.name ?? "The agent") : "The agent")) : null;
  const running = tasks.filter(isWorking).length;
  const review = tasks.filter((t) => t.status === "in_review").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const scoped = workspace ? agents.filter((a) => a.workspaceId === null || a.workspaceId === workspace.id) : agents;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        icon={<SquareKanban />}
        title="Tasks"
        description={
          workspace
            ? `${workspace.icon} ${workspace.name} — create tickets, assign an agent, and it gets to work.`
            : scope === "global"
              ? "Global tasks — create tickets, assign an agent, and it gets to work."
              : "Every workspace's board. Create tickets, assign an agent, and it gets to work."
        }
        actions={
          <>
            {workspace && (
              <Button variant="outline" className="max-w-64 font-normal" onClick={() => setEditingWorkspace(workspace)}>
                <FolderGit2 className="text-muted-foreground" />
                {repos[0] ? (
                  <span className="truncate font-mono text-[13px]">
                    {repos[0].name}
                    {repos[0].branch && <span className="text-muted-foreground"> · {repos[0].branch}</span>}
                    {repos.length > 1 && <span className="text-muted-foreground"> +{repos.length - 1}</span>}
                  </span>
                ) : (
                  "Connect a repository"
                )}
              </Button>
            )}
            <Button onClick={() => setCreating(true)}>
              <Plus /> New task
              <kbd className="ml-1 font-mono text-[10px] opacity-60">C</kbd>
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 px-5 pb-4 @2xl:px-8">
        <Tabs value={view} onValueChange={setView}>
          <TabsList className="group-data-[orientation=horizontal]/tabs:h-8">
            <TabsTrigger value="board" className="gap-1.5 px-2.5 text-[13px]">
              <SquareKanban className="size-3.5" /> Board
            </TabsTrigger>
            <TabsTrigger value={ARCHIVED} className="gap-1.5 px-2.5 text-[13px]">
              <Archive className="size-3.5" /> Archived
              {archived.length > 0 && (
                <span className="rounded-[4px] bg-foreground/[0.06] px-1.5 font-mono text-[10px] text-muted-foreground tabular-nums">{archived.length}</span>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full max-w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter tasks…" aria-label="Filter tasks" className="h-8 pl-8" />
        </div>
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="h-8 w-44" aria-label="Agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={ALL}>All agents</SelectItem>
            <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
            {scoped.length > 0 && <SelectSeparator />}
            {scoped.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <AgentAvatar agent={a} size="sm" still className="size-4" /> {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 font-normal">
              <ListFilter className="text-muted-foreground" /> Filter
              {filtersOn > 0 && <span className="rounded-[4px] bg-primary px-1.5 font-mono text-[10px] text-primary-foreground tabular-nums">{filtersOn}</span>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Priority</DropdownMenuLabel>
            {TASK_PRIORITIES.map((p) => (
              <DropdownMenuCheckboxItem key={p} checked={priorities.has(p)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => toggleIn("priority", priorities as Set<string>, p)}>
                <PriorityIcon priority={p} /> {PRIORITY_META[p].label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Due</DropdownMenuLabel>
            {(
              [
                ["overdue", "Overdue"],
                ["week", "Due in 7 days"],
                ["none", "No due date"],
              ] as const
            ).map(([v, label]) => (
              <DropdownMenuCheckboxItem key={v} checked={dueFilter === v} onSelect={(e) => e.preventDefault()} onCheckedChange={(on) => setFilter("due", on ? v : null)}>
                {label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Labels</DropdownMenuLabel>
            {labelsInUse.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No labels yet</p>
            ) : (
              labelsInUse.map((l) => (
                <DropdownMenuCheckboxItem key={l} checked={labelFilter.has(l)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => toggleIn("label", labelFilter, l)}>
                  <LabelChip label={l} />
                </DropdownMenuCheckboxItem>
              ))
            )}
            {filtersOn > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={clearFilters}>Clear filters</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {view === ARCHIVED ? (
          <p className="ml-auto text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{archived.length}</span> archived · restoring puts a task back on top of its column
          </p>
        ) : (
          <p className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            {(filtersOn > 0 || !!search.trim() || agentFilter !== ALL) && (
              <span>
                Showing <span className="font-mono tabular-nums">{visible.length}</span> of <span className="font-mono tabular-nums">{tasks.length}</span> ·{" "}
                <button type="button" className="underline-offset-2 hover:underline" onClick={clearFilters}>
                  Clear filters
                </button>
              </span>
            )}
            {overdueCount > 0 && <span className="font-medium text-rose-600 dark:text-rose-400">{overdueCount} overdue</span>}
            {running > 0 && <span className="text-amber-700 dark:text-amber-300">{running} running</span>}
            {review > 0 && <span>{review} {STATUS_META.in_review.label.toLowerCase()}</span>}
            {blocked > 0 && <span className="text-rose-600 dark:text-rose-400">{blocked} blocked</span>}
            <span className="font-mono tabular-nums">{tasks.length} total</span>
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {view === ARCHIVED ? (
          archivedQ.isPending ? (
            <div className="max-w-4xl space-y-2 px-5 @2xl:px-8">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          ) : (
            <ArchivedTasks
              tasks={visibleArchived}
              agents={agentById}
              workspaces={workspace ? undefined : workspaces}
              filtered={archived.length > 0 && (!!search.trim() || agentFilter !== ALL || filtersOn > 0)}
              onClearFilters={clearFilters}
              onOpen={openTask}
              onRestore={(t) => setArchived(t, false)}
              onDelete={setDeleting}
            />
          )
        ) : tasksQ.isPending ? (
          <div className="flex h-full gap-3 overflow-hidden px-5 pb-5 @2xl:px-8">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-full w-[272px] shrink-0 rounded-xl" />
            ))}
          </div>
        ) : tasksQ.isError ? (
          <div className="px-5 @2xl:px-8">
            <EmptyState
              icon={<SquareKanban />}
              title="Couldn't load the board"
              description={errorMessage(tasksQ.error)}
              action={
                <Button variant="outline" onClick={() => tasksQ.refetch()}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : tasks.length > 0 && visible.length === 0 ? (
          <div className="px-5 @2xl:px-8">
            <EmptyState
              icon={<ListFilter />}
              title="No tasks match"
              description="Nothing on this board fits the filters."
              action={
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : (
          <TaskBoard
            tasks={visible}
            agents={agentById}
            workspaces={workspace ? undefined : workspaces}
            onOpen={openTask}
            onMove={requestMove}
            onQuickAdd={(status, title) => quickAdd.mutateAsync({ status, title })}
            onArchive={archive}
            onDelete={setDeleting}
          />
        )}
      </div>

      <TaskDialog
        open={creating}
        onOpenChange={setCreating}
        workspaces={workspaceList}
        agents={agents}
        defaultWorkspaceId={workspace?.id ?? null}
      />
      <TaskSheet
        task={selected}
        agents={agents}
        workspaces={workspaces}
        onClose={() => openTask(null)}
        onMove={(task, status) => requestMove(task, status)}
        onArchive={(task, value) => (value ? archive([task]) : setArchived(task, false))}
        onDelete={setDeleting}
        onReassign={requestReassign}
      />
      {editingWorkspace && (
        <WorkspaceDialog open onOpenChange={(open) => !open && setEditingWorkspace(null)} workspace={editingWorkspace} focus="sources" />
      )}

      <AlertDialog open={!!stopping} onOpenChange={(open) => !open && setStopping(null)}>
        <AlertDialogContent>
          {stopCopyOf && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{stopCopyOf.title}</AlertDialogTitle>
                <AlertDialogDescription>{stopCopyOf.text}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel autoFocus>{stopCopyOf.keep}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => {
                    if (stopping?.reassignTo !== undefined) reassign.mutate({ task: stopping.task, agentId: stopping.reassignTo });
                    else if (stopping?.archive) setArchived(stopping.task, true);
                    else if (stopping) move.mutate(stopping);
                    setStopping(null);
                  }}
                >
                  {stopCopyOf.confirm}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete #{deleting?.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              The task is gone for good{deleting?.branch ? " and its worktree is removed (a pushed branch and pull request stay)" : ""}. The agent's conversation is kept.
              {deleting && !deleting.archivedAt && " To just get it off the board, archive it — you can restore it anytime."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {deleting && !deleting.archivedAt && (
              <AlertDialogCancel
                onClick={() => {
                  archive([deleting]);
                  setDeleting(null);
                }}
              >
                <Archive /> Archive instead
              </AlertDialogCancel>
            )}
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) remove.mutate(deleting);
                setDeleting(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type Stopping = { task: Task; status: TaskStatus; beforeId: string | null; archive?: boolean; reassignTo?: string | null };

/** What the confirm dialog says: what would end (a run working, standing still, waiting for an answer, a follow-up). */
function stopCopy(s: Stopping, agentName: (id: string | null) => string): { title: string; text: string; keep: string; confirm: string } {
  const t = s.task;
  const who = agentName(t.agentId);
  const what = s.archive ? "Archiving it" : `Moving it to ${STATUS_META[s.status].label}`;
  const state = isWorking(t) ? "working" : t.pause?.reason === "question" ? "question" : t.pause?.reason === "limit" ? "limit" : t.pause ? "paused" : "waiting";
  if (s.reassignTo !== undefined) {
    if (s.reassignTo === null) return { title: `Take ${who} off #${t.number}?`, text: "The run stops and the task is parked in the Backlog.", keep: `Keep ${who}`, confirm: "Take off" };
    const next = agentName(s.reassignTo);
    const ends = state === "working" ? `${who}'s run stops` : state === "waiting" ? `${who}'s follow-up is cancelled` : `${who}'s run ends`;
    return { title: `Hand #${t.number} to ${next}?`, text: `${who} is still on it. ${ends} and ${next} starts over.`, keep: `Keep ${who}`, confirm: "Hand over" };
  }
  const parked = s.archive ? " and parks the task in the Backlog" : "";
  switch (state) {
    case "working":
      return { title: "Stop the agent?", text: `${who} is still working on #${t.number}. ${what} stops the run${parked}.`, keep: "Keep working", confirm: s.archive ? "Stop and archive" : "Stop and move" };
    case "question":
      return {
        title: "Drop the question?",
        text: `${who} is waiting for your answer on #${t.number}. ${what} ends the run${parked} — it can't be continued afterwards.`,
        keep: "Keep waiting",
        confirm: s.archive ? "End and archive" : "End and move",
      };
    case "limit":
      return {
        title: "End the waiting run?",
        text: `#${t.number} waits for Claude's ${t.pause?.limit ?? "usage limit"} to reset. ${what} ends the run${parked} — it can't be continued afterwards.`,
        keep: "Keep waiting",
        confirm: s.archive ? "End and archive" : "End and move",
      };
    case "paused":
      return {
        title: "End the paused run?",
        text: `#${t.number} is paused. ${what} ends the run${parked} — it can't be continued afterwards.`,
        keep: "Keep it paused",
        confirm: s.archive ? "End and archive" : "End and move",
      };
    default:
      return {
        title: "Cancel the follow-up?",
        text: `${who} plans to continue #${t.number}${t.followup ? ` ${followupWhen(t.followup.dueAt)}` : ""}. ${what} cancels that${parked}.`,
        keep: "Keep waiting",
        confirm: s.archive ? "Cancel and archive" : "Cancel and move",
      };
  }
}
