import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  closestCorners,
  getFirstCollision,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronsLeftRight, Plus } from "lucide-react";
import type { Agent, Task, TaskStatus, Workspace } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { BOARD_COLUMNS, STATUS_META, StatusIcon } from "./task-meta";
import { TaskCard } from "./task-card";

type Columns = Record<TaskStatus, string[]>;

const QUICK_ADD: ReadonlySet<TaskStatus> = new Set(["backlog", "todo"]);
const COLUMN_ID = "col:";

function group(tasks: Task[]): Columns {
  const cols = Object.fromEntries(BOARD_COLUMNS.map((s) => [s, [] as string[]])) as Columns;
  for (const t of [...tasks].sort((a, b) => a.position - b.position || a.number - b.number)) cols[t.status].push(t.id);
  return cols;
}

function columnOf(id: string, cols: Columns): TaskStatus | null {
  if (id.startsWith(COLUMN_ID)) return id.slice(COLUMN_ID.length) as TaskStatus;
  return BOARD_COLUMNS.find((s) => cols[s].includes(id)) ?? null;
}

export interface TaskBoardProps {
  tasks: Task[];
  agents: Map<string, Agent>;
  /** Given when the board spans several workspaces: cards show theirs. */
  workspaces?: Map<string, Workspace>;
  onOpen: (task: Task) => void;
  onMove: (task: Task, status: TaskStatus, beforeId: string | null) => void;
  onQuickAdd: (status: TaskStatus, title: string) => Promise<unknown>;
}

export function TaskBoard({ tasks, agents, workspaces, onOpen, onMove, onQuickAdd }: TaskBoardProps) {
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const grouped = useMemo(() => group(tasks), [tasks]);
  const [drag, setDrag] = useState<{ id: string; columns: Columns } | null>(null);
  const columns = drag?.columns ?? grouped;
  const collapsed = useUi((s) => s.collapsedColumns);
  const toggleColumn = useUi((s) => s.toggleColumn);
  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const movedToNewColumn = useRef(false);

  // What's under the pointer (the keyboard uses the closest corners); over a column, its closest card. Between columns
  // the last target sticks — re-laid-out columns would otherwise make a card flip back and forth between them.
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      let overId = getFirstCollision(args.pointerCoordinates ? pointerWithin(args) : closestCorners(args), "id");
      if (overId != null) {
        const key = String(overId);
        if (key.startsWith(COLUMN_ID)) {
          const items = columns[key.slice(COLUMN_ID.length) as TaskStatus] ?? [];
          if (items.length) {
            overId =
              closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => items.includes(String(c.id))) })[0]?.id ?? overId;
          }
        }
        lastOverId.current = overId;
        return [{ id: overId }];
      }
      if (movedToNewColumn.current) lastOverId.current = args.active.id;
      return lastOverId.current ? [{ id: lastOverId.current }] : [];
    },
    [columns],
  );

  useEffect(() => {
    requestAnimationFrame(() => {
      movedToNewColumn.current = false;
    });
  }, [columns]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] } }),
  );

  const onDragStart = ({ active }: DragStartEvent) => setDrag({ id: String(active.id), columns: grouped });

  const onDragOver = ({ active, over, activatorEvent, delta }: DragOverEvent) => {
    if (!over || !drag) return;
    const id = String(active.id);
    const overId = String(over.id);
    const from = columnOf(id, drag.columns);
    const to = columnOf(overId, drag.columns);
    // One column change per frame: the columns settle before the next one.
    if (!from || !to || from === to || movedToNewColumn.current) return;
    movedToNewColumn.current = true;
    const startY = activatorEvent instanceof PointerEvent || activatorEvent instanceof MouseEvent ? activatorEvent.clientY : null;
    setDrag((d) => {
      if (!d || !d.columns[from].includes(id)) return d;
      const cols = { ...d.columns, [from]: d.columns[from].filter((x) => x !== id) };
      const target = [...d.columns[to]];
      const overIndex = overId.startsWith(COLUMN_ID) ? -1 : target.indexOf(overId);
      const translated = active.rect.current.translated;
      const y = startY !== null ? startY + delta.y : translated ? translated.top + translated.height / 2 : null;
      const below = y !== null && y > over.rect.top + over.rect.height / 2;
      target.splice(overIndex < 0 ? target.length : overIndex + (below ? 1 : 0), 0, id);
      return { ...d, columns: { ...cols, [to]: target } };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const d = drag;
    if (!d || !over) return setDrag(null);
    const id = String(active.id);
    const overId = String(over.id);
    const to = columnOf(overId, d.columns);
    const task = byId.get(id);
    if (!to || !task) return setDrag(null);
    let list = d.columns[to];
    const oldIndex = list.indexOf(id);
    const newIndex = overId.startsWith(COLUMN_ID) ? oldIndex : list.indexOf(overId);
    if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex) list = arrayMove(list, oldIndex, newIndex);
    // Dropped before its move into this column was applied: land where the pointer is.
    const beforeId = list.includes(id) ? (list[list.indexOf(id) + 1] ?? null) : overId.startsWith(COLUMN_ID) ? null : overId;
    const original = grouped[task.status];
    const unchanged = to === task.status && (original[original.indexOf(id) + 1] ?? null) === beforeId;
    if (!unchanged) onMove(task, to, beforeId);
    setDrag(null);
  };

  const active = drag ? byId.get(drag.id) : undefined;

  return (
    <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setDrag(null)}>
      <div className="flex h-full min-h-0 gap-3 overflow-x-auto px-5 pb-5 @2xl:px-8">
        {BOARD_COLUMNS.map((status) =>
          collapsed.includes(status) ? (
            <CollapsedColumn key={status} status={status} count={columns[status].length} onExpand={() => toggleColumn(status)} />
          ) : (
            <Column
              key={status}
              status={status}
              ids={columns[status]}
              byId={byId}
              agents={agents}
              workspaces={workspaces}
              dragging={!!drag}
              activeId={drag?.id ?? null}
              onOpen={onOpen}
              onCollapse={() => toggleColumn(status)}
              onQuickAdd={QUICK_ADD.has(status) ? (title) => onQuickAdd(status, title) : undefined}
            />
          ),
        )}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
        {active ? (
          <TaskCard
            task={active}
            agent={active.agentId ? agents.get(active.agentId) : undefined}
            workspace={workspaces ? (active.workspaceId ? (workspaces.get(active.workspaceId) ?? null) : null) : undefined}
            overlay
            className="w-[256px]"
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  status,
  ids,
  byId,
  agents,
  workspaces,
  dragging,
  activeId,
  onOpen,
  onCollapse,
  onQuickAdd,
}: {
  status: TaskStatus;
  ids: string[];
  byId: Map<string, Task>;
  agents: Map<string, Agent>;
  workspaces?: Map<string, Workspace>;
  dragging: boolean;
  activeId: string | null;
  onOpen: (task: Task) => void;
  onCollapse: () => void;
  onQuickAdd?: (title: string) => Promise<unknown>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_ID}${status}` });
  const [adding, setAdding] = useState(false);
  const meta = STATUS_META[status];
  const tasks = ids.map((id) => byId.get(id)).filter((t): t is Task => !!t);

  return (
    <section
      aria-label={meta.label}
      className={cn(
        "flex max-h-full w-[272px] shrink-0 flex-col rounded-xl bg-foreground/[0.028] ring-1 ring-border/70 transition-colors dark:bg-foreground/[0.035]",
        isOver && "bg-foreground/[0.05] ring-foreground/20",
      )}
    >
      <header className="group/col flex h-11 shrink-0 items-center gap-2 pr-1.5 pl-3.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <h2 className="flex min-w-0 cursor-default items-center gap-2 text-[13px] font-medium">
              <StatusIcon status={status} />
              <span className="truncate">{meta.label}</span>
              <span className="font-mono text-[11.5px] font-normal text-muted-foreground tabular-nums">{tasks.length}</span>
            </h2>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-60">
            {meta.hint}
          </TooltipContent>
        </Tooltip>
        <div className="ml-auto flex items-center opacity-70 transition group-hover/col:opacity-100">
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={`Fold ${meta.label}`} onClick={onCollapse}>
            <ChevronsLeftRight className="size-3.5" />
          </Button>
          {onQuickAdd && (
            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={`Add a task to ${meta.label}`} onClick={() => setAdding(true)}>
              <Plus className="size-4" />
            </Button>
          )}
        </div>
      </header>

      <div ref={setNodeRef} className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {adding && onQuickAdd && <QuickAdd onSubmit={onQuickAdd} onClose={() => setAdding(false)} />}
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableCard
              key={task.id}
              task={task}
              agent={task.agentId ? agents.get(task.agentId) : undefined}
              workspace={workspaces ? (task.workspaceId ? (workspaces.get(task.workspaceId) ?? null) : null) : undefined}
              ghost={task.id === activeId}
              onOpen={onOpen}
            />
          ))}
        </SortableContext>
        {!tasks.length && !adding && (
          <p className={cn("m-1 rounded-lg border border-dashed px-3 py-5 text-center text-xs text-muted-foreground/80", dragging && "border-foreground/20")}>
            {dragging ? "Drop here" : meta.hint}
          </p>
        )}
      </div>

      {onQuickAdd && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <Plus className="size-3.5" /> Add task
        </button>
      )}
    </section>
  );
}

function SortableCard({
  task,
  agent,
  workspace,
  ghost,
  onOpen,
}: {
  task: Task;
  agent?: Agent;
  workspace?: Workspace | null;
  ghost: boolean;
  onOpen: (task: Task) => void;
}) {
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
    <TaskCard
      ref={setNodeRef}
      task={task}
      agent={agent}
      workspace={workspace}
      ghost={ghost}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onKeyDown={onKeyDown}
      onClick={() => onOpen(task)}
    />
  );
}

function CollapsedColumn({ status, count, onExpand }: { status: TaskStatus; count: number; onExpand: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_ID}${status}` });
  const meta = STATUS_META[status];
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onExpand}
      aria-label={`Show ${meta.label} (${count})`}
      className={cn(
        "flex w-11 shrink-0 flex-col items-center gap-3 rounded-xl bg-foreground/[0.028] py-3.5 ring-1 ring-border/70 transition hover:bg-foreground/[0.05] dark:bg-foreground/[0.035]",
        isOver && "bg-foreground/[0.06] ring-foreground/20",
      )}
    >
      <StatusIcon status={status} />
      <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">{count}</span>
      <span className="text-[13px] font-medium [writing-mode:vertical-rl]">{meta.label}</span>
    </button>
  );
}

function QuickAdd({ onSubmit, onClose }: { onSubmit: (title: string) => Promise<unknown>; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
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
        autoFocus
        rows={2}
        value={title}
        disabled={busy}
        placeholder="What needs to be done?"
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
