import { createContext, useCallback, useContext, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Ban, CornerDownRight, FolderInput } from "lucide-react";
import type { Agent, AgentMoveInput, AgentPlacement, Workspace } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { GroupIcon, WorkspaceSection } from "./agent-groups";

/** Where an agent can be dropped: on an agent (it becomes the lead), a workspace, or the built-in agent (no lead of its own). */
export type AgentDropTarget = { kind: "agent"; agent: Agent } | { kind: "workspace"; workspaceId: string | null } | { kind: "hub"; agent: Agent };

export type MovePlan =
  | { ok: true; input: AgentMoveInput; workspaceId: string | null; reportsTo: string | null | undefined; label: string; done: string; team: Agent[] }
  | { ok: false; reason: string };

/** Everyone under `agent`, top-down. */
export function teamOf(agent: Agent, all: Agent[]): Agent[] {
  const out: Agent[] = [];
  const seen = new Set([agent.id]);
  for (let i = -1; i < out.length; i++) {
    const lead = i < 0 ? agent : out[i]!;
    for (const a of all) {
      if (a.reportsTo !== lead.id || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}

const wsName = (id: string | null, workspaces: Workspace[]) => (id ? (workspaces.find((w) => w.id === id)?.name ?? "the workspace") : "Global");

/** What dropping `agent` on `target` would do; null when it changes nothing. */
export function planMove(agent: Agent, target: AgentDropTarget, all: Agent[], workspaces: Workspace[]): MovePlan | null {
  if (agent.isDefault) return null;
  const team = teamOf(agent, all);
  const along = (ws: string | null) => (ws !== agent.workspaceId ? team : []);
  if (target.kind === "hub" || (target.kind === "agent" && target.agent.isDefault)) {
    if (!agent.reportsTo) return null;
    return { ok: true, input: { reportsTo: null }, workspaceId: agent.workspaceId, reportsTo: null, label: `Report to ${target.agent.name}`, done: `${agent.name} now reports to ${target.agent.name}`, team: [] };
  }
  if (target.kind === "workspace") {
    if (target.workspaceId === agent.workspaceId) return null;
    const ws = target.workspaceId;
    return { ok: true, input: { workspaceId: ws }, workspaceId: ws, reportsTo: undefined, label: `Move to ${wsName(ws, workspaces)}`, done: `Moved ${agent.name} to ${wsName(ws, workspaces)}`, team: along(ws) };
  }
  const lead = target.agent;
  if (lead.id === agent.id) return null;
  if (team.some((a) => a.id === lead.id)) return { ok: false, reason: `${lead.name} reports to ${agent.name}` };
  const ws = lead.workspaceId ?? agent.workspaceId;
  if (agent.reportsTo === lead.id && ws === agent.workspaceId) return null;
  return {
    ok: true,
    input: ws !== agent.workspaceId ? { workspaceId: ws, reportsTo: lead.id } : { reportsTo: lead.id },
    workspaceId: ws,
    reportsTo: lead.id,
    label: `Report to ${lead.name}${ws !== agent.workspaceId ? ` in ${wsName(ws, workspaces)}` : ""}`,
    done: `${agent.name} now reports to ${lead.name}${ws !== agent.workspaceId ? ` in ${wsName(ws, workspaces)}` : ""}`,
    team: along(ws),
  };
}

interface DndState {
  dragged: Agent | null;
  plan: (target: AgentDropTarget) => MovePlan | null;
}

const Ctx = createContext<DndState>({ dragged: null, plan: () => null });

/** The smallest target under the pointer: a row inside a panel wins over the panel. */
const innermost: CollisionDetection = (args) => {
  const area = (id: string | number) => {
    const r = args.droppableRects.get(id);
    return r ? r.width * r.height : Infinity;
  };
  return pointerWithin(args).sort((a, b) => area(a.id) - area(b.id));
};

/** The ghost sits beside the pointer, so the row under it stays readable. */
const besideCursor: Modifier = ({ transform, activatorEvent, draggingNodeRect }) => {
  if (!draggingNodeRect || !activatorEvent || !("clientX" in activatorEvent)) return transform;
  const e = activatorEvent as PointerEvent;
  return { ...transform, x: transform.x + e.clientX - draggingNodeRect.left + 14, y: transform.y + e.clientY - draggingNodeRect.top + 10 };
};

/** A click right after a drop would open the agent it started on. */
function swallowNextClick() {
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

function inScope(scope: unknown, workspaceId: string | null) {
  return scope === "all" || (scope === "global" ? workspaceId === null : scope === workspaceId);
}

/** Move an agent (and its team) with an optimistic update and an "Undo" in the toast. */
export function useMoveAgent() {
  const qc = useQueryClient();
  const patchLists = (fn: (list: Agent[], scope: unknown) => Agent[]) => {
    const snapshot = qc.getQueriesData<Agent[]>({ queryKey: ["agents", "list"] });
    for (const [key, data] of snapshot) if (Array.isArray(data)) qc.setQueryData<Agent[]>(key, fn(data, key[2]));
    return snapshot;
  };
  const restore = (snapshot: [QueryKey, Agent[] | undefined][]) => {
    for (const [key, data] of snapshot) qc.setQueryData(key, data);
  };

  const undo = useMutation({
    // Leads first, so each report finds its lead where it was.
    mutationFn: async (previous: AgentPlacement[]) => {
      for (const p of previous) await api.agents.update(p.id, { workspaceId: p.workspaceId, reportsTo: p.reportsTo });
    },
    onSuccess: () => toast.success("Moved back"),
    onError: (err) => toast.error("Couldn't move it back", { description: errorMessage(err) }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.agents }),
  });

  return useMutation({
    mutationFn: ({ agent, plan }: { agent: Agent; plan: Extract<MovePlan, { ok: true }> }) => api.agents.move(agent.id, plan.input),
    onMutate: ({ agent, plan }) => {
      const moving = new Set(plan.team.map((a) => a.id));
      return patchLists((list, scope) =>
        list
          .map((a) =>
            a.id === agent.id
              ? { ...a, workspaceId: plan.workspaceId, ...(plan.reportsTo !== undefined ? { reportsTo: plan.reportsTo } : {}) }
              : moving.has(a.id)
                ? { ...a, workspaceId: plan.workspaceId }
                : a,
          )
          .filter((a) => inScope(scope, a.workspaceId) || a.isDefault),
      );
    },
    onSuccess: (res, { plan }) => {
      const team = res.moved.length - 1;
      toast.success(plan.done, {
        description: team > 0 ? `Its team of ${team} moved along.` : undefined,
        action: { label: "Undo", onClick: () => undo.mutate(res.previous) },
      });
    },
    onError: (err, _vars, snapshot) => {
      if (snapshot) restore(snapshot);
      toast.error("Couldn't move the agent", { description: errorMessage(err) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.agents }),
  });
}

/** Drag agents onto each other, onto workspaces or onto the dock that opens while dragging; every move can be undone. */
export function AgentDnd({ all, workspaces, children }: { all: Agent[]; workspaces: Workspace[]; children: ReactNode }) {
  const [dragged, setDragged] = useState<Agent | null>(null);
  const [over, setOver] = useState<AgentDropTarget | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const plan = useCallback((target: AgentDropTarget) => (dragged ? planMove(dragged, target, all, workspaces) : null), [dragged, all, workspaces]);
  const move = useMoveAgent();
  const box = useRef<HTMLDivElement>(null);
  const [dockAt, setDockAt] = useState<{ left: number; width: number } | null>(null);
  // Scrolling while the pointer rests on the dock would slide the page under it.
  const [inDock, setInDock] = useState(false);

  const end = () => {
    setDragged(null);
    setOver(null);
    setInDock(false);
    document.body.style.removeProperty("user-select");
  };
  const onDragStart = (e: DragStartEvent) => {
    const agent = e.active.data.current?.agent as Agent | undefined;
    if (!agent) return;
    setDragged(agent);
    const r = box.current?.getBoundingClientRect();
    setDockAt(r ? { left: r.left, width: r.width } : null);
    document.body.style.userSelect = "none";
  };
  const onDragOver = (e: DragOverEvent) => setOver((e.over?.data.current?.target as AgentDropTarget | undefined) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    const target = e.over?.data.current?.target as AgentDropTarget | undefined;
    const agent = dragged;
    end();
    swallowNextClick();
    if (!agent || !target) return;
    const p = planMove(agent, target, all, workspaces);
    if (p?.ok) move.mutate({ agent, plan: p });
    else if (p) toast.error(`Can't move ${agent.name} there`, { description: `${p.reason}.` });
  };

  const current = dragged && over ? planMove(dragged, over, all, workspaces) : null;
  const state = useMemo(() => ({ dragged, plan }), [dragged, plan]);
  return (
    <Ctx.Provider value={state}>
      <DndContext
        sensors={sensors}
        collisionDetection={innermost}
        autoScroll={inDock ? false : { threshold: { x: 0, y: 0.12 } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={end}
      >
        <div ref={box}>{children}</div>
        <Dock dragged={dragged} workspaces={workspaces} at={dockAt} onInside={setInDock} />
        <DragOverlay dropAnimation={null} modifiers={[besideCursor]}>{dragged && <Ghost agent={dragged} plan={current} />}</DragOverlay>
      </DndContext>
    </Ctx.Provider>
  );
}

/** The agent under the pointer while it is dragged, saying what letting go would do. */
function Ghost({ agent, plan }: { agent: Agent; plan: MovePlan | null }) {
  return (
    <div
      className={cn(
        "flex w-max max-w-80 -rotate-2 cursor-grabbing items-center gap-2.5 rounded-xl border bg-card/95 py-2 pr-3.5 pl-2 shadow-float backdrop-blur-md transition-colors",
        plan?.ok && "border-brand/50",
        plan && !plan.ok && "border-destructive/50",
      )}
    >
      <AgentAvatar agent={agent} size="md" mood={plan && !plan.ok ? "attention" : "happy"} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium tracking-[-0.01em]">{agent.name}</p>
        <p className={cn("flex items-center gap-1 truncate text-xs text-muted-foreground", plan?.ok && "text-foreground", plan && !plan.ok && "text-destructive")}>
          {plan?.ok ? (
            <>
              <CornerDownRight className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                {plan.label}
                {plan.team.length > 0 && <span className="text-muted-foreground"> · with {plan.team.length} report{plan.team.length === 1 ? "" : "s"}</span>}
              </span>
            </>
          ) : plan ? (
            <>
              <Ban className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{plan.reason}</span>
            </>
          ) : (
            "Drop on an agent or a workspace"
          )}
        </p>
      </div>
    </div>
  );
}

/** Every workspace as a drop target while an agent is dragged, also the ones not on screen. */
function Dock({
  dragged,
  workspaces,
  at,
  onInside,
}: {
  dragged: Agent | null;
  workspaces: Workspace[];
  /** Centred over the page's content, not the window. */
  at: { left: number; width: number } | null;
  onInside: (inside: boolean) => void;
}) {
  return (
    <AnimatePresence>
      {dragged && !dragged.isDefault && (
        <motion.div
          // Fade only: the targets are measured as they appear, a slide would put them off by its distance.
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={at ? { left: at.left, width: at.width } : undefined}
          className={cn("pointer-events-none fixed bottom-5 z-40 flex justify-center px-4", !at && "inset-x-0")}
        >
          <div
            onPointerEnter={() => onInside(true)}
            onPointerLeave={() => onInside(false)}
            className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border bg-card/90 p-1.5 shadow-float backdrop-blur-xl" role="group" aria-label="Move to workspace">
            <span className="flex shrink-0 items-center gap-1.5 px-2 text-xs text-muted-foreground">
              <FolderInput className="size-3.5" aria-hidden /> Move to
            </span>
            <DockTarget workspace={null} here={dragged.workspaceId === null} />
            {workspaces.map((w) => (
              <DockTarget key={w.id} workspace={w} here={dragged.workspaceId === w.id} />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DockTarget({ workspace, here }: { workspace: Workspace | null; here: boolean }) {
  const drop = useAgentDrop({ kind: "workspace", workspaceId: workspace?.id ?? null }, `dock:${workspace?.id ?? "global"}`);
  return (
    <div
      ref={drop.ref}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-xl border border-transparent px-2 py-1.5 text-sm transition-[background-color,border-color,transform] duration-150",
        here ? "text-muted-foreground opacity-50" : "text-foreground",
        drop.state === "valid" && "scale-[1.04] border-brand/50 bg-brand/10",
      )}
    >
      <GroupIcon workspace={workspace} isGlobal={!workspace} className="size-5" />
      <span className="max-w-36 truncate">{workspace?.name ?? "Global"}</span>
      {here && <span className="text-[11px]">here</span>}
    </div>
  );
}

/** Makes an agent draggable; the built-in agent stays put. */
export function useAgentDrag(agent: Agent, id = `agent:${agent.id}`) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id, data: { agent }, disabled: agent.isDefault });
  return {
    ref: setNodeRef,
    isDragging,
    props: agent.isDefault
      ? {}
      : {
          ...listeners,
          // Links and images inside would start the webview's own drag.
          onDragStart: (e: React.DragEvent) => e.preventDefault(),
        },
  };
}

/**
 * A drop target. `state`: "none" when nothing is dragged or dropping here changes nothing, "valid" or "invalid" while
 * the dragged agent is over it, "available" while it could go here.
 */
export function useAgentDrop(target: AgentDropTarget | null, id: string) {
  const { dragged, plan } = useContext(Ctx);
  const p = dragged && target ? plan(target) : null;
  const { setNodeRef, isOver } = useDroppable({ id, data: { target }, disabled: !p });
  const state: "none" | "available" | "valid" | "invalid" = !p ? "none" : isOver ? (p.ok ? "valid" : "invalid") : p.ok ? "available" : "none";
  return { ref: setNodeRef, state, dragging: !!dragged };
}

export function useDraggedAgent() {
  return useContext(Ctx).dragged;
}

/** A workspace (or team) section that takes dropped agents. */
export function DroppableSection({ target, dropId, ...props }: ComponentProps<typeof WorkspaceSection> & { target: AgentDropTarget | null; dropId: string }) {
  const drop = useAgentDrop(target, dropId);
  return <WorkspaceSection {...props} dropRef={drop.ref} dropState={drop.state} />;
}

/** Wraps a card or row so it can be picked up. */
export function DraggableAgent({ agent, className, children }: { agent: Agent; className?: string; children: ReactNode }) {
  const drag = useAgentDrag(agent);
  return (
    <div ref={drag.ref} {...drag.props} className={cn("h-full transition-opacity", drag.isDragging && "opacity-35", className)}>
      {children}
    </div>
  );
}
