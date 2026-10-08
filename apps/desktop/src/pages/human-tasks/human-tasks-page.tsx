import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router";
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
import { CircleCheck, CircleDashed, ListTodo, Plus, Search, Timer } from "lucide-react";
import type { Agent, HumanTask } from "@godmode/shared";
import { MASCOT_CHARACTER, MASCOT_COLOR, isHumanTaskActive } from "@godmode/shared";
import { EmptyState, PageHeader } from "@/components/common";
import { Character } from "@/components/character";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HumanTaskCard } from "@/components/human-tasks/human-task-card";
import { HumanTaskSheet, useHumanTaskActions } from "@/components/human-tasks/human-task-sheet";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { useAllAgents, useHumanTasks } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

type ColumnId = "open" | "doing" | "closed";
type Columns = Record<ColumnId, string[]>;

const COLUMN_ID = "col:";
const COLUMNS: { id: ColumnId; label: string; hint: string; icon: ReactNode }[] = [
  { id: "open", label: "To do", hint: "What your agents need you to do shows up here.", icon: <CircleDashed className="size-3.5 text-muted-foreground" /> },
  { id: "doing", label: "Doing", hint: "Drag a task here while you work on it.", icon: <Timer className="size-3.5 text-brand-strong" /> },
  { id: "closed", label: "Done", hint: "Drop a task here to close it — its agent picks up from there.", icon: <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" /> },
];

function columnOfTask(t: HumanTask): ColumnId {
  return t.status === "open" || t.status === "doing" ? t.status : "closed";
}

function group(tasks: HumanTask[]): Columns {
  const cols: Columns = { open: [], doing: [], closed: [] };
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

export default function HumanTasksPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data = [], isLoading } = useHumanTasks();
  const { data: agents = [] } = useAllAgents();
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const [search, setSearch] = useState("");
  const [focusNote, setFocusNote] = useState(false);
  const [adding, setAdding] = useState(false);
  const { update } = useHumanTaskActions();

  const tasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter((t) => `H-${t.number} ${t.title} ${t.body} ${t.agentName ?? ""} ${t.conversationTitle ?? ""}`.toLowerCase().includes(q));
  }, [data, search]);
  const openId = params.get("task");
  const selected = openId ? (data.find((t) => t.id === openId) ?? null) : null;
  const open = (t: HumanTask, note = false) => {
    setFocusNote(note);
    const p = new URLSearchParams(params);
    p.set("task", t.id);
    setParams(p, { replace: true });
  };
  const closeSheet = () => {
    const p = new URLSearchParams(params);
    p.delete("task");
    setParams(p, { replace: true });
    setFocusNote(false);
  };

  const create = useMutation({
    mutationFn: (title: string) => api.humanTasks.create({ title }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.humanTasks }),
    onError: (e) => toastApiError(e, "Couldn't add the task", qc),
  });

  const waiting = data.filter((t) => t.status === "open").length;
  const agentsWaiting = new Set(data.filter((t) => isHumanTaskActive(t) && t.agentId).map((t) => t.agentId)).size;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        icon={<ListTodo />}
        title="My tasks"
        description={
          waiting
            ? `${waiting} waiting for you${agentsWaiting ? ` · ${agentsWaiting} agent${agentsWaiting === 1 ? "" : "s"} on hold until you're done` : ""}. Mark a task done and its agent picks up where it left off.`
            : "What your agents can't do without you — a passkey, a CAPTCHA, a signature. Mark it done and the agent picks up where it left off."
        }
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> New task
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 px-5 pb-4 @2xl:px-8">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks" className="h-8 pl-8 text-[13px]" aria-label="Search tasks" />
        </div>
      </div>

      {!isLoading && data.length === 0 && !adding ? (
        <div className="px-5 @2xl:px-8">
          <EmptyState
            art={<Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={72} follow />}
            title="Nothing waits for you"
            description="When an agent can't go on without you — a passkey, a CAPTCHA, a login only you have — it puts the task here and tells you. Once you mark it done, the agent continues by itself."
            action={
              <Button variant="outline" onClick={() => setAdding(true)}>
                <Plus /> Add one of your own
              </Button>
            }
          />
        </div>
      ) : (
        <Board
          tasks={tasks}
          agents={agentById}
          adding={adding}
          onAdding={setAdding}
          onAdd={(title) => create.mutateAsync(title)}
          onOpen={(t) => open(t)}
          onMove={(t, status, beforeId) => update.mutate({ id: t.id, patch: { status, beforeId } })}
          onDropDone={(t) => open(t, true)}
        />
      )}

      <HumanTaskSheet task={selected} agent={selected?.agentId ? agentById.get(selected.agentId) : undefined} focusNote={focusNote} onClose={closeSheet} />
    </div>
  );
}

function Board({
  tasks,
  agents,
  adding,
  onAdding,
  onAdd,
  onOpen,
  onMove,
  onDropDone,
}: {
  tasks: HumanTask[];
  agents: Map<string, Agent>;
  adding: boolean;
  onAdding: (on: boolean) => void;
  onAdd: (title: string) => Promise<unknown>;
  onOpen: (t: HumanTask) => void;
  onMove: (t: HumanTask, status: "open" | "doing", beforeId: string | null) => void;
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
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pb-5 @2xl:px-8">
        {COLUMNS.map((col) => (
          <Column
            key={col.id}
            column={col}
            ids={columns[col.id]}
            byId={byId}
            agents={agents}
            dragging={!!drag}
            activeId={drag?.id ?? null}
            onOpen={onOpen}
            adding={col.id === "open" && adding}
            onAdding={col.id === "open" ? onAdding : undefined}
            onAdd={onAdd}
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
  dragging: boolean;
  activeId: string | null;
  onOpen: (t: HumanTask) => void;
  adding: boolean;
  onAdding?: (on: boolean) => void;
  onAdd: (title: string) => Promise<unknown>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_ID}${column.id}` });
  const tasks = ids.map((id) => byId.get(id)).filter((t): t is HumanTask => !!t);
  const closed = column.id === "closed";
  return (
    <section
      aria-label={column.label}
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
              <span className="truncate">{column.label}</span>
              <span className="font-mono text-[11.5px] font-normal text-muted-foreground tabular-nums">{tasks.length}</span>
            </h2>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-60">
            {column.hint}
          </TooltipContent>
        </Tooltip>
        {onAdding && (
          <Button variant="ghost" size="icon" className="ml-auto size-7 text-muted-foreground opacity-70 group-hover/col:opacity-100" aria-label="Add a task" onClick={() => onAdding(true)}>
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
        {!tasks.length && !adding && (
          <p className={cn("m-1 rounded-lg border border-dashed px-3 py-5 text-center text-xs text-muted-foreground/80", dragging && "border-foreground/20")}>
            {dragging ? (closed ? "Drop to mark it done" : "Drop here") : column.hint}
          </p>
        )}
      </div>
    </section>
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
      setTitle("");
      ref.current?.focus();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border bg-card p-2 shadow-card">
      <Textarea
        ref={ref}
        rows={2}
        value={title}
        disabled={busy}
        placeholder="What do you need to do?"
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
        <span className="text-[11px] text-muted-foreground">Enter to add · Esc to close</span>
        <Button size="sm" className="h-7" disabled={!title.trim() || busy} onMouseDown={(e) => e.preventDefault()} onClick={() => void submit()}>
          Add
        </Button>
      </div>
    </div>
  );
}
