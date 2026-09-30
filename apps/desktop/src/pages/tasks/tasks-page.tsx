import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Plus, Search, SquareKanban } from "lucide-react";
import { toast } from "sonner";
import type { Task, TaskStatus, Workspace } from "@godmode/shared";
import { AgentAvatar, PageHeader } from "@/components/common";
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
import { TaskBoard } from "@/components/tasks/task-board";
import { TaskDialog } from "@/components/tasks/task-dialog";
import { TaskSheet } from "@/components/tasks/task-sheet";
import { STATUS_META, isWorking, workspaceRepos } from "@/components/tasks/task-meta";
import { toastApiError } from "@/components/vault/vault-utils";
import { WorkspaceDialog } from "@/components/workspaces/workspace-dialog";
import { api } from "@/lib/api";
import { useAllAgents, useTasks, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { useUi } from "@/stores/ui";

const ALL = "all";
const UNASSIGNED = "unassigned";

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
  const { data: agents = [] } = useAllAgents();
  const { data: workspaceList = [] } = useWorkspaces();
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState(ALL);
  const [creating, setCreating] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | null>(null);
  const [stopping, setStopping] = useState<{ task: Task; status: TaskStatus; beforeId: string | null } | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);

  const workspace = workspaceList.find((w) => w.id === scope) ?? null;
  const repos = workspaceRepos(workspace);
  const workspaces = useMemo(() => new Map(workspaceList.map((w) => [w.id, w])), [workspaceList]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const listKey = qk.taskList(scope);
  const tasks = useMemo(() => tasksQ.data ?? [], [tasksQ.data]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks.filter((t) => {
      if (agentFilter === UNASSIGNED ? t.agentId : agentFilter !== ALL && t.agentId !== agentFilter) return false;
      if (!q) return true;
      return `#${t.number} ${t.title} ${t.description} ${t.agentId ? (agentById.get(t.agentId)?.name ?? "") : ""}`.toLowerCase().includes(q);
    });
  }, [tasks, search, agentFilter, agentById]);

  const selectedId = params.get("task");
  const selected = selectedId ? (tasks.find((t) => t.id === selectedId) ?? null) : null;
  const openTask = (task: Task | null) => {
    const next = new URLSearchParams(params);
    if (task) next.set("task", task.id);
    else next.delete("task");
    setParams(next, { replace: !task });
  };
  useEffect(() => {
    if (!selectedId || !tasksQ.data || selected) return;
    // A link from a notification: the task may live in another scope.
    api.tasks
      .get(selectedId)
      .then((t) => {
        useUi.getState().setWorkspace(t.workspaceId ?? "global");
      })
      .catch(() => openTask(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, tasksQ.data, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "c" || e.metaKey || e.ctrlKey || e.altKey || typingIn(e.target)) return;
      e.preventDefault();
      setCreating(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const move = useMutation({
    mutationFn: ({ task, status, beforeId }: { task: Task; status: TaskStatus; beforeId: string | null }) => api.tasks.update(task.id, { status, beforeId }),
    onMutate: ({ task, status, beforeId }) => {
      qc.setQueryData<Task[]>(listKey, (list) =>
        list?.map((t) => (t.id === task.id ? { ...t, status, position: optimisticPosition(list, task, status, beforeId) } : t)),
      );
    },
    onSuccess: (t, { status }) => {
      qc.setQueriesData<Task[]>({ queryKey: qk.tasks }, (list) => list?.map((x) => (x.id === t.id ? t : x)));
      if ((status === "todo" || status === "in_progress") && !t.agentId) {
        toast("Assign an agent to start it", { action: { label: "Assign", onClick: () => openTask(t) } });
      }
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      toastApiError(e, "Could not move the task", qc);
    },
  });

  const requestMove = (task: Task, status: TaskStatus, beforeId: string | null = null) => {
    if (isWorking(task) && status !== "in_progress") setStopping({ task, status, beforeId });
    else move.mutate({ task, status, beforeId });
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
        <p className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {running > 0 && <span className="text-amber-700 dark:text-amber-300">{running} running</span>}
          {review > 0 && <span>{review} {STATUS_META.in_review.label.toLowerCase()}</span>}
          {blocked > 0 && <span className="text-rose-600 dark:text-rose-400">{blocked} blocked</span>}
          <span className="font-mono tabular-nums">{tasks.length} total</span>
        </p>
      </div>

      <div className="min-h-0 flex-1">
        {tasksQ.isPending ? (
          <div className="flex h-full gap-3 overflow-hidden px-5 pb-5 @2xl:px-8">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-full w-[272px] shrink-0 rounded-xl" />
            ))}
          </div>
        ) : (
          <TaskBoard
            tasks={visible}
            agents={agentById}
            workspaces={workspace ? undefined : workspaces}
            onOpen={openTask}
            onMove={requestMove}
            onQuickAdd={(status, title) => quickAdd.mutateAsync({ status, title })}
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
        onDelete={setDeleting}
      />
      {editingWorkspace && (
        <WorkspaceDialog open onOpenChange={(open) => !open && setEditingWorkspace(null)} workspace={editingWorkspace} focus="sources" />
      )}

      <AlertDialog open={!!stopping} onOpenChange={(open) => !open && setStopping(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop the agent?</AlertDialogTitle>
            <AlertDialogDescription>
              {stopping &&
                `${stopping.task.agentId ? (agentById.get(stopping.task.agentId)?.name ?? "The agent") : "The agent"} is still working on #${stopping.task.number}. Moving it to ${STATUS_META[stopping.status].label} stops the run.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep working</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (stopping) move.mutate(stopping);
                setStopping(null);
              }}
            >
              Stop and move
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete #{deleting?.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              The task disappears from the board{deleting?.type === "coding" ? " and its local checkout is removed (a pushed branch and pull request stay)" : ""}. The agent's conversation is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
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
