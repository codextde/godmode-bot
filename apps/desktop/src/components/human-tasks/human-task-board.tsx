import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import { Circle, CircleCheck, CircleDashed, ListTodo, Plus, Search, Timer } from "lucide-react";
import type { Agent, HumanTask, HumanTaskLane } from "@godmode/shared";
import { MASCOT_CHARACTER, MASCOT_COLOR, isHumanTaskActive } from "@godmode/shared";
import { EmptyState } from "@/components/common";
import { Character } from "@/components/character";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HumanTaskCard } from "@/components/human-tasks/human-task-card";
import { useHumanTaskActions } from "@/components/human-tasks/human-task-sheet";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { useAllAgents, useBootstrap, useHumanTasks } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

type ColumnId = HumanTaskLane | "closed";
type Columns = Record<ColumnId, string[]>;

const COLUMN_ID = "col:";
const COLUMNS: { id: ColumnId; icon: ReactNode }[] = [
  { id: "backlog", icon: <CircleDashed className="size-3.5 text-muted-foreground/70" /> },
  { id: "open", icon: <Circle className="size-3.5 text-muted-foreground" /> },
  { id: "doing", icon: <Timer className="size-3.5 text-brand-strong" /> },
  { id: "closed", icon: <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" /> },
];

function columnOfTask(t: HumanTask): ColumnId {
  return isHumanTaskActive(t) ? (t.status as HumanTaskLane) : "closed";
}

function group(tasks: HumanTask[]): Columns {
  const cols: Columns = { backlog: [], open: [], doing: [], closed: [] };
  const active = tasks.filter(isHumanTaskActive).sort((a, b) => a.position - b.position || a.number - b.number);
  for (const t of active) cols[columnOfTask(t)].push(t.id);
  cols.closed = tasks
    .filter((t) => !isHumanTaskActive(t))
    .sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt))
    .map((t) => t.id);
  return cols;
}

function columnOf(id: string, cols: Columns): ColumnId | null {
  if (id.startsWith(COLUMN_ID)) return id.slice(COLUMN_ID.length) as ColumnId;
  return (Object.keys(cols) as ColumnId[]).find((c) => cols[c].includes(id)) ?? null;
}

/** My tasks as a board (Backlog, To do, Doing, Done): the Inbox's Board view. Opening a card is up to the page (it holds the sheet). */
export function HumanTaskBoard({
  adding,
  onAdding,
  onOpen,
}: {
  adding: "backlog" | "open" | null;
  onAdding: (to: "backlog" | "open" | null) => void;
  onOpen: (t: HumanTask, focusNote?: boolean) => void;
}) {
  const { t } = useTranslation(["humanTasks", "common"]);
  const qc = useQueryClient();
  const tasksQ = useHumanTasks();
  const { data = [] } = tasksQ;
  const { data: boot } = useBootstrap();
  const { data: agents = [] } = useAllAgents();
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const [search, setSearch] = useState("");
  const { update } = useHumanTaskActions();

  const tasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter((t) => `H-${t.number} ${t.title} ${t.body} ${t.agentName ?? ""} ${t.conversationTitle ?? ""}`.toLowerCase().includes(q));
  }, [data, search]);

  const create = useMutation({
    mutationFn: ({ title, status }: { title: string; status: "backlog" | "open" }) => api.humanTasks.create({ title, status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.humanTasks }),
    onError: (e) => toastApiError(e, t("board.addError"), qc),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-5 pb-4 @2xl:px-8">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("board.search")} className="h-8 pl-8 text-[13px]" aria-label={t("board.search")} />
        </div>
        {tasksQ.isError && tasksQ.data && (
          <p className="text-xs text-muted-foreground" role="status">
            {t("board.refreshError")} ·{" "}
            <button type="button" className="text-foreground underline-offset-2 hover:underline" onClick={() => tasksQ.refetch()}>
              {t("common:actions.tryAgain")}
            </button>
          </p>
        )}
      </div>

      {tasksQ.isError && !tasksQ.data ? (
        <div className="px-5 @2xl:px-8">
          <EmptyState
            icon={<ListTodo />}
            title={t("board.loadError")}
            description={errorMessage(tasksQ.error)}
            action={
              <Button variant="outline" onClick={() => tasksQ.refetch()}>
                {t("common:actions.tryAgain")}
              </Button>
            }
          />
        </div>
      ) : tasksQ.data && data.length === 0 && !adding ? (
        <div className="px-5 @2xl:px-8">
          <EmptyState
            art={<Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={72} follow />}
            title={t("board.emptyTitle")}
            description={t("board.emptyDescription")}
            action={
              <Button variant="outline" onClick={() => onAdding("open")}>
                <Plus /> {t("board.addOwn")}
              </Button>
            }
          />
        </div>
      ) : (
        <Board
          tasks={tasks}
          agents={agentById}
          loading={tasksQ.isPending ? { backlog: 0, open: Math.min(boot?.counts.attention?.todo ?? 2, 4), doing: 0, closed: 2 } : undefined}
          adding={adding}
          onAdding={onAdding}
          onAdd={(title, status) => create.mutateAsync({ title, status })}
          onOpen={(t) => onOpen(t)}
          onMove={(t, status, beforeId) => update.mutate({ id: t.id, patch: { status, beforeId } })}
          onDropDone={(t) => onOpen(t, true)}
        />
      )}
    </div>
  );
}

function Board({
  tasks,
  agents,
  loading,
  adding,
  onAdding,
  onAdd,
  onOpen,
  onMove,
  onDropDone,
}: {
  tasks: HumanTask[];
  agents: Map<string, Agent>;
  /** The list isn't here yet: placeholder cards per column (as many to do as the sidebar counts). */
  loading?: Record<ColumnId, number>;
  adding: "backlog" | "open" | null;
  onAdding: (to: "backlog" | "open" | null) => void;
  onAdd: (title: string, status: "backlog" | "open") => Promise<unknown>;
  onOpen: (t: HumanTask) => void;
  onMove: (t: HumanTask, status: HumanTaskLane, beforeId: string | null) => void;
  onDropDone: (t: HumanTask) => void;
}) {
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const grouped = useMemo(() => group(tasks), [tasks]);
  const [drag, setDrag] = useState<{ id: string; columns: Columns } | null>(null);
  const columns = drag?.columns ?? grouped;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] } }),
  );

  const onDragStart = ({ active }: DragStartEvent) => setDrag({ id: String(active.id), columns: grouped });

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || !drag) return;
    const id = String(active.id);
    const overId = String(over.id);
    const from = columnOf(id, drag.columns);
    const to = columnOf(overId, drag.columns);
    if (!from || !to || from === to || to === "closed") return;
    setDrag((d) => {
      if (!d || !d.columns[from].includes(id)) return d;
      const target = [...d.columns[to]];
      const at = overId.startsWith(COLUMN_ID) ? target.length : Math.max(0, target.indexOf(overId));
      target.splice(at, 0, id);
      return { ...d, columns: { ...d.columns, [from]: d.columns[from].filter((x) => x !== id), [to]: target } };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const d = drag;
    setDrag(null);
    if (!d || !over) return;
    const id = String(active.id);
    const task = byId.get(id);
    if (!task || !isHumanTaskActive(task)) return;
    const overId = String(over.id);
    if (columnOf(overId, d.columns) === "closed" || (!overId.startsWith(COLUMN_ID) && grouped.closed.includes(overId))) {
      onDropDone(task);
      return;
    }
    const to = columnOf(id, d.columns);
    if (!to || to === "closed") return;
    let list = d.columns[to];
    const oldIndex = list.indexOf(id);
    const newIndex = overId.startsWith(COLUMN_ID) ? oldIndex : list.indexOf(overId);
    if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex) list = arrayMove(list, oldIndex, newIndex);
    const beforeId = list[list.indexOf(id) + 1] ?? null;
    const original = grouped[columnOfTask(task)];
    if (to === task.status && (original[original.indexOf(id) + 1] ?? null) === beforeId) return;
    onMove(task, to, beforeId);
  };

  const active = drag ? byId.get(drag.id) : undefined;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setDrag(null)}>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pb-5 @2xl:px-8" aria-busy={!!loading}>
        {COLUMNS.map((col) => (
          <Column
            key={col.id}
            column={col}
            ids={columns[col.id]}
            byId={byId}
            agents={agents}
            placeholders={loading?.[col.id]}
            dragging={!!drag}
            activeId={drag?.id ?? null}
            onOpen={onOpen}
            adding={adding === col.id}
            onAdding={col.id === "open" || col.id === "backlog" ? (on: boolean) => onAdding(on ? (col.id as "backlog" | "open") : null) : undefined}
            onAdd={(title) => onAdd(title, col.id === "backlog" ? "backlog" : "open")}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
        {active ? <HumanTaskCard task={active} agent={active.agentId ? agents.get(active.agentId) : undefined} overlay className="w-[288px]" /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  column,
  ids,
  byId,
  agents,
  placeholders,
  dragging,
  activeId,
  onOpen,
  adding,
  onAdding,
  onAdd,
}: {
  column: (typeof COLUMNS)[number];
  ids: string[];
  byId: Map<string, HumanTask>;
  agents: Map<string, Agent>;
  placeholders?: number;
  dragging: boolean;
  activeId: string | null;
  onOpen: (t: HumanTask) => void;
  adding: boolean;
  onAdding?: (on: boolean) => void;
  onAdd: (title: string) => Promise<unknown>;
}) {
  const { t } = useTranslation("humanTasks");
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_ID}${column.id}` });
  const tasks = ids.map((id) => byId.get(id)).filter((t): t is HumanTask => !!t);
  const closed = column.id === "closed";
  const loading = placeholders !== undefined;
  return (
    <section
      aria-label={t(`columns.${column.id}.label`)}
      className={cn(
        "flex max-h-full w-[304px] shrink-0 flex-col rounded-xl bg-foreground/[0.028] ring-1 ring-border/70 transition-colors dark:bg-foreground/[0.035]",
        isOver && "bg-foreground/[0.05] ring-foreground/20",
        closed && dragging && "ring-emerald-500/40",
      )}
    >
      <header className="group/col flex h-11 shrink-0 items-center gap-2 pr-1.5 pl-3.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <h2 className="flex min-w-0 cursor-default items-center gap-2 text-[13px] font-medium">
              {column.icon}
              <span className="truncate">{t(`columns.${column.id}.label`)}</span>
              {!loading && <span className="font-mono text-[11.5px] font-normal text-muted-foreground tabular-nums">{tasks.length}</span>}
            </h2>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-60">
            {t(`columns.${column.id}.hint`)}
          </TooltipContent>
        </Tooltip>
        {onAdding && (
          <Button variant="ghost" size="icon" className="ml-auto size-7 text-muted-foreground opacity-70 group-hover/col:opacity-100" aria-label={t("board.addTask")} onClick={() => onAdding(true)}>
            <Plus className="size-4" />
          </Button>
        )}
      </header>

      <div ref={setNodeRef} className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {adding && onAdding && <QuickAdd onSubmit={onAdd} onClose={() => onAdding(false)} />}
        {closed ? (
          tasks.map((t) => <StaticCard key={t.id} task={t} agent={t.agentId ? agents.get(t.agentId) : undefined} onOpen={onOpen} />)
        ) : (
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {tasks.map((t) => (
              <SortableCard key={t.id} task={t} agent={t.agentId ? agents.get(t.agentId) : undefined} ghost={t.id === activeId} onOpen={onOpen} />
            ))}
          </SortableContext>
        )}
        {loading && Array.from({ length: placeholders }, (_, i) => <CardSkeleton key={i} />)}
        {!loading && !tasks.length && !adding && (
          <p className={cn("m-1 rounded-lg border border-dashed px-3 py-5 text-center text-xs text-muted-foreground/80", dragging && "border-foreground/20")}>
            {dragging ? (closed ? t("board.dropDone") : t("board.dropHere")) : t(`columns.${column.id}.hint`)}
          </p>
        )}
      </div>
    </section>
  );
}

function CardSkeleton() {
  return (
    <div className="rounded-lg border bg-card p-3 shadow-card" aria-hidden>
      <Skeleton className="h-3 w-10" />
      <Skeleton className="mt-2.5 h-3.5 w-4/5" />
      <Skeleton className="mt-1.5 h-3 w-3/5" />
      <div className="mt-3.5 flex items-center gap-1.5">
        <Skeleton className="size-5 rounded-[5px]" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}

function SortableCard({ task, agent, ghost, onOpen }: { task: HumanTask; agent?: Agent; ghost: boolean; onOpen: (t: HumanTask) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: task.id });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onOpen(task);
      return;
    }
    listeners?.onKeyDown?.(e);
  };
  return (
    <HumanTaskCard
      ref={setNodeRef}
      task={task}
      agent={agent}
      ghost={ghost}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onKeyDown={onKeyDown}
      onClick={() => onOpen(task)}
    />
  );
}

function StaticCard({ task, agent, onOpen }: { task: HumanTask; agent?: Agent; onOpen: (t: HumanTask) => void }) {
  return (
    <HumanTaskCard
      task={task}
      agent={agent}
      onClick={() => onOpen(task)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(task);
      }}
    />
  );
}

function QuickAdd({ onSubmit, onClose }: { onSubmit: (title: string) => Promise<unknown>; onClose: () => void }) {
  const { t } = useTranslation(["humanTasks", "common"]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await onSubmit(t);
    } catch (err) {
      setBusy(false);
      throw err;
    }
    setTitle("");
    ref.current?.focus();
    setBusy(false);
  };
  return (
    <div className="rounded-lg border bg-card p-2 shadow-card">
      <Textarea
        ref={ref}
        rows={2}
        value={title}
        disabled={busy}
        placeholder={t("board.quickAddPlaceholder")}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => !title.trim() && onClose()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") onClose();
        }}
        className="min-h-0 resize-none border-0 p-1 text-[13.5px] shadow-none focus-visible:ring-0"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{t("board.quickAddHint")}</span>
        <Button size="sm" className="h-7" disabled={!title.trim() || busy} onMouseDown={(e) => e.preventDefault()} onClick={() => void submit()}>
          {t("common:actions.add")}
        </Button>
      </div>
    </div>
  );
}
