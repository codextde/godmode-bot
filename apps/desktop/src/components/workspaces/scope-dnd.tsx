import { createContext, useCallback, useContext, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useCombinedRefs } from "@dnd-kit/utilities";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { ArrowRight, Ban, Bot, Check, CornerDownRight, Ellipsis, FolderInput, KeyRound, Layers, LayersPlus, MonitorCog } from "lucide-react";
import type { Project, ScopeMoveCounts, ScopeMoveResult, Workspace } from "@godmode/shared";
import { besideCursor, innermost, swallowNextClick } from "@/components/agents/agent-dnd";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { isGrantCancelled, withGrant } from "@/components/vault/grant";
import { toastApiError } from "@/components/vault/vault-utils";
import { ApiRequestError, api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { WorkspaceTile } from "./workspace-tile";

/** What is picked up: a project, or a whole workspace. */
export type ScopeDragItem = { kind: "project"; project: Project } | { kind: "workspace"; workspace: Workspace };

/** Where it can land: a workspace, the dock's "Make it a workspace", or Global (which only says why not). */
export type ScopeDropTarget = { kind: "workspace"; workspace: Workspace } | { kind: "new" } | { kind: "global" };

/** A project into another workspace or out on its own (`to: null`); a workspace into another, as a project. */
export type ScopeMove =
  | { kind: "project"; project: Project; to: Workspace | null; reviewed?: boolean }
  | { kind: "workspace"; workspace: Workspace; to: Workspace };

type NestMove = Extract<ScopeMove, { kind: "workspace" }>;
type ProjectMove = Extract<ScopeMove, { kind: "project" }>;

/** An agent wrote the project's context: as a workspace's it reaches every run there, so the human reads it first. */
const needsReview = (p: Project) => (p.fillOnly || p.offComputer) && !!(p.instructions.trim() || p.description.trim());

type ScopePlan = { ok: true; move: ScopeMove; label: string; detail?: string } | { ok: false; reason: string };

type DropState = "none" | "available" | "valid" | "invalid";

/** The request behind a move; the server answers with one of these as its undo. */
type MoveCall = ScopeMoveResult["undo"];

const nameOf = (item: ScopeDragItem) => (item.kind === "project" ? item.project.name : item.workspace.name);

/** What dropping `item` on `target` would do; null when it changes nothing. */
function planScopeMove(item: ScopeDragItem, target: ScopeDropTarget): ScopePlan | null {
  if (target.kind === "global") return { ok: false, reason: "Global can't have projects" };
  if (item.kind === "project") {
    const { project } = item;
    if (target.kind === "new") return { ok: true, move: { kind: "project", project, to: null }, label: "Make it a workspace" };
    if (target.workspace.id === project.workspaceId) return null;
    return { ok: true, move: { kind: "project", project, to: target.workspace }, label: `Move to ${target.workspace.name}` };
  }
  if (target.kind === "new" || target.workspace.id === item.workspace.id) return null;
  const n = item.workspace.projects.length;
  return {
    ok: true,
    move: { kind: "workspace", workspace: item.workspace, to: target.workspace },
    label: `Becomes a project of ${target.workspace.name}`,
    detail: n ? `with ${n} project${n === 1 ? "" : "s"}` : undefined,
  };
}

const callOf = (m: ScopeMove): MoveCall =>
  m.kind === "project"
    ? { projectId: m.project.id, input: { workspaceId: m.to?.id ?? null, ...(m.reviewed ? { contextReviewed: true } : {}) } }
    : { workspaceId: m.workspace.id, input: { workspaceId: m.to.id } };

/** The passphrase is asked for only when the core wants it: logins or cards change hands, or an agent's context loses its mark. */
const send = (call: MoveCall, reason: string) =>
  withGrant(
    (grant) => ("projectId" in call ? api.projects.move(call.projectId, call.input, grant) : api.workspaces.move(call.workspaceId, call.input, grant)),
    reason,
  );

function grantReason(m: ScopeMove): string {
  if (m.kind === "workspace") return `Confirm to hand ${m.workspace.name}'s logins, 2FA codes and cards to ${m.to.name}'s agents.`;
  return `Confirm to let runs in ${m.project.name}, whose context an agent wrote, read secrets again.`;
}

const byName = (a: Project, b: Project) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

function doneText(m: ScopeMove) {
  if (m.kind === "workspace") return `${m.workspace.name} is now a project of ${m.to.name}`;
  return m.to ? `Moved ${m.project.name} to ${m.to.name}` : `${m.project.name} is now a workspace`;
}

const NOUNS: [keys: (keyof ScopeMoveCounts)[], one: string, many: string][] = [
  [["agents"], "agent", "agents"],
  [["chats"], "chat", "chats"],
  [["tasks"], "task", "tasks"],
  [["projects"], "project", "projects"],
  [["sources"], "folder or repository", "folders and repositories"],
  [["credentials"], "login", "logins"],
  [["totp"], "2FA code", "2FA codes"],
  [["passkeys"], "passkey", "passkeys"],
  [["mcpServers", "apiTools", "composioConnections"], "integration", "integrations"],
  [["browserProfiles"], "browser profile", "browser profiles"],
  [["paymentCards"], "card", "cards"],
  [["goals"], "goal", "goals"],
];

/** "3 agents, 12 chats and 2 logins came along." */
function cameAlong(moved: ScopeMoveCounts): string | undefined {
  const parts = NOUNS.flatMap(([keys, one, many]) => {
    const n = keys.reduce((sum, k) => sum + (moved[k] ?? 0), 0);
    return n ? [`${n} ${n === 1 ? one : many}`] : [];
  });
  if (!parts.length) return undefined;
  const shown = parts.length > 4 ? [...parts.slice(0, 3), "more"] : parts;
  const last = shown[shown.length - 1];
  return `${shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ` : ""}${last} came along.`;
}

const REFRESH = [
  qk.workspaces,
  qk.bootstrap,
  qk.agents,
  qk.tasks,
  qk.conversationsAll,
  qk.credentials,
  qk.totp,
  qk.passkeys,
  qk.cards,
  qk.mcpServers,
  qk.apiTools,
  qk.composio,
  qk.browserProfiles,
  qk.goals,
  qk.humanTasks,
  qk.questions,
  qk.missingLogins,
  qk.artifacts,
];

/** Runs moves and their undos: the list shows the result right away and the sidebar's scope follows what moved. */
function useScopeMutations(onSettled: () => void, onReview: (m: ProjectMove) => void) {
  const qc = useQueryClient();
  const refresh = () => {
    for (const key of REFRESH) void qc.invalidateQueries({ queryKey: key });
  };

  const settle = (call: MoveCall, res: ScopeMoveResult) => {
    // Projects that left their workspace: the moved one, and on undoing a nest the ones the workspace brought along.
    const gone = new Set("projectId" in call ? [call.projectId, ...(call.input.restore?.projectIds ?? [])] : []);
    qc.setQueryData<Workspace[]>(qk.workspaces, (list) => {
      if (!list) return list;
      const next = list
        .filter((w) => "projectId" in call || w.id !== call.workspaceId)
        .map((w) => (w.id === res.workspace.id ? res.workspace : w.projects.some((p) => gone.has(p.id)) ? { ...w, projects: w.projects.filter((p) => !gone.has(p.id)) } : w));
      return next.some((w) => w.id === res.workspace.id) ? next : [...next, res.workspace];
    });
    const { workspace, project, setWorkspace } = useUi.getState();
    if ("projectId" in call) {
      if (project === call.projectId) setWorkspace(res.workspace.id, res.project?.id);
      else if (project && call.input.restore?.projectIds.includes(project)) setWorkspace(res.workspace.id, project);
    } else if (workspace === call.workspaceId) setWorkspace(res.workspace.id, project ?? res.project?.id);
  };

  const undo = useMutation({
    mutationFn: (call: MoveCall) => send(call, "Confirm to give the logins, 2FA codes and cards back."),
    onSuccess: (res, call) => {
      settle(call, res);
      toast.success("Moved back");
    },
    onError: (err) => !isGrantCancelled(err) && toastApiError(err, "Couldn't move it back", qc),
    onSettled: refresh,
  });

  return useMutation({
    mutationFn: (m: ScopeMove) => send(callOf(m), grantReason(m)),
    // Only the light move shows before the answer: a new workspace or a nest arrives with it.
    onMutate: async (m) => {
      if (m.kind !== "project" || !m.to) return undefined;
      const to = m.to;
      await qc.cancelQueries({ queryKey: qk.workspaces });
      const before = qc.getQueryData<Workspace[]>(qk.workspaces);
      qc.setQueryData<Workspace[]>(qk.workspaces, (list) =>
        list?.map((w) =>
          w.id === m.project.workspaceId
            ? { ...w, projects: w.projects.filter((p) => p.id !== m.project.id) }
            : w.id === to.id
              ? { ...w, projects: [...w.projects, { ...m.project, workspaceId: to.id }].sort(byName) }
              : w,
        ),
      );
      return before;
    },
    onSuccess: (res, m) => {
      settle(callOf(m), res);
      const description = [cameAlong(res.moved), ...res.notes].filter(Boolean).join(" ") || undefined;
      toast.success(doneText(m), { description, duration: res.notes.length ? 12_000 : undefined, action: { label: "Undo", onClick: () => undo.mutate(res.undo) } });
    },
    onError: (err, m, before) => {
      if (before) qc.setQueryData(qk.workspaces, before);
      if (isGrantCancelled(err)) return;
      if (m.kind === "project" && err instanceof ApiRequestError && err.code === "context_review") return onReview(m);
      toastApiError(err, `Couldn't move ${m.kind === "project" ? m.project.name : m.workspace.name}`, qc);
    },
    onSettled: () => {
      refresh();
      onSettled();
    },
  });
}

interface DndState {
  dragged: ScopeDragItem | null;
  /** Where letting go would land right now (a workspace id or "new"): it lights up wherever it shows. */
  landing: string | null;
  workspaces: Workspace[];
  plan: (target: ScopeDropTarget) => ScopePlan | null;
  /** Runs a move; nesting a workspace asks first. */
  move: (m: ScopeMove) => void;
}

const Ctx = createContext<DndState>({ dragged: null, landing: null, workspaces: [], plan: () => null, move: () => {} });

/** The dock floats over the cards: what lies under it isn't what the pointer means. */
const dockFirst: CollisionDetection = (args) => {
  const hits = innermost(args);
  const dock = hits.filter((h) => String(h.id).startsWith("dock"));
  return dock.length ? dock : hits;
};

/**
 * Drag projects onto other workspaces or out into their own, and workspaces into others as projects; the dock that
 * opens while dragging reaches every workspace. Every move can be undone.
 */
export function ScopeDnd({ workspaces, children }: { workspaces: Workspace[]; children: ReactNode }) {
  const [dragged, setDragged] = useState<ScopeDragItem | null>(null);
  const [over, setOver] = useState<ScopeDropTarget | null>(null);
  // Kept after closing, so the dialog keeps its text while it animates out.
  const [nest, setNest] = useState<NestMove | null>(null);
  const [nestOpen, setNestOpen] = useState(false);
  const [review, setReview] = useState<ProjectMove | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const askReview = useCallback((m: ProjectMove) => {
    setReview(m);
    setReviewOpen(true);
  }, []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const run = useScopeMutations(() => {
    setNestOpen(false);
    setReviewOpen(false);
  }, askReview);
  const { mutate } = run;
  const box = useRef<HTMLDivElement>(null);
  const [dockAt, setDockAt] = useState<{ left: number; width: number } | null>(null);
  // Scrolling while the pointer rests on the dock would slide the page under it.
  const [inDock, setInDock] = useState(false);

  const plan = useCallback((target: ScopeDropTarget) => (dragged ? planScopeMove(dragged, target) : null), [dragged]);
  const move = useCallback(
    (m: ScopeMove) => {
      if (m.kind === "project") return !m.to && !m.reviewed && needsReview(m.project) ? askReview(m) : mutate(m);
      setNest(m);
      setNestOpen(true);
    },
    [mutate, askReview],
  );

  const end = () => {
    setDragged(null);
    setOver(null);
    setInDock(false);
    document.body.style.removeProperty("user-select");
  };
  const onDragStart = (e: DragStartEvent) => {
    const item = e.active.data.current?.item as ScopeDragItem | undefined;
    if (!item) return;
    setDragged(item);
    const r = box.current?.getBoundingClientRect();
    setDockAt(r ? { left: r.left, width: r.width } : null);
    document.body.style.userSelect = "none";
  };
  const onDragOver = (e: DragOverEvent) => setOver((e.over?.data.current?.target as ScopeDropTarget | null | undefined) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    const target = e.over?.data.current?.target as ScopeDropTarget | null | undefined;
    const item = dragged;
    end();
    swallowNextClick();
    if (!item || !target) return;
    const p = planScopeMove(item, target);
    if (p?.ok) move(p.move);
    else if (p) toast.error(`Can't move ${nameOf(item)} there`, { description: `${p.reason}.` });
  };

  const current = dragged && over ? planScopeMove(dragged, over) : null;
  const landing = current?.ok ? (current.move.to?.id ?? "new") : null;
  const state = useMemo(() => ({ dragged, landing, workspaces, plan, move }), [dragged, landing, workspaces, plan, move]);
  return (
    <Ctx.Provider value={state}>
      <DndContext
        sensors={sensors}
        collisionDetection={dockFirst}
        autoScroll={inDock ? false : { threshold: { x: 0, y: 0.12 } }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={end}
      >
        <div ref={box}>{children}</div>
        <Dock dragged={dragged} workspaces={workspaces} at={dockAt} onInside={setInDock} />
        <DragOverlay dropAnimation={null} modifiers={[besideCursor]}>
          {dragged && <Ghost item={dragged} plan={current} />}
        </DragOverlay>
      </DndContext>
      <NestDialog
        move={nest}
        open={nestOpen}
        pending={run.isPending && run.variables?.kind === "workspace"}
        onOpenChange={setNestOpen}
        onConfirm={() => nest && mutate(nest)}
      />
      <ReviewDialog
        move={review}
        open={reviewOpen}
        pending={run.isPending && run.variables?.kind === "project" && !!run.variables.reviewed}
        onOpenChange={setReviewOpen}
        onConfirm={() => review && mutate({ ...review, reviewed: true })}
      />
    </Ctx.Provider>
  );
}

/** What is dragged, under the pointer, saying what letting go would do. A workspace shows as a stack: everything in it comes along. */
function Ghost({ item, plan }: { item: ScopeDragItem; plan: ScopePlan | null }) {
  const { name, icon, color } = item.kind === "project" ? item.project : item.workspace;
  return (
    <div className="relative w-max max-w-80 -rotate-2 cursor-grabbing">
      {item.kind === "workspace" && <div aria-hidden className="absolute inset-0 translate-x-1.5 translate-y-1.5 rotate-3 rounded-xl border bg-card/80 shadow-card" />}
      <div
        className={cn(
          "relative flex items-center gap-2.5 rounded-xl border bg-card/95 py-2 pr-3.5 pl-2 shadow-float backdrop-blur-md transition-colors",
          plan?.ok && "border-brand/50",
          plan && !plan.ok && "border-destructive/50",
        )}
      >
        <WorkspaceTile icon={icon} color={color} size="md" className="size-9 text-lg" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium tracking-[-0.01em]">{name}</p>
          <p className={cn("flex items-center gap-1 truncate text-xs text-muted-foreground", plan?.ok && "text-foreground", plan && !plan.ok && "text-destructive")}>
            {plan?.ok ? (
              <>
                <CornerDownRight className="size-3 shrink-0" aria-hidden />
                <span className="truncate">
                  {plan.label}
                  {plan.detail && <span className="text-muted-foreground"> · {plan.detail}</span>}
                </span>
              </>
            ) : plan ? (
              <>
                <Ban className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{plan.reason}</span>
              </>
            ) : item.kind === "project" ? (
              "Drop on a workspace, or make it one"
            ) : (
              "Drop on another workspace"
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Every target while something is dragged, also workspaces scrolled away or filtered out. */
function Dock({
  dragged,
  workspaces,
  at,
  onInside,
}: {
  dragged: ScopeDragItem | null;
  workspaces: Workspace[];
  /** Centred over the page's content, not the window. */
  at: { left: number; width: number } | null;
  onInside: (inside: boolean) => void;
}) {
  const panel = useDroppable({ id: "dock", data: { target: null }, disabled: !dragged });
  const project = dragged?.kind === "project" ? dragged.project : null;
  const from = project ? project.workspaceId : dragged?.kind === "workspace" ? dragged.workspace.id : null;
  const others = workspaces.filter((w) => w.id !== from);
  // A project's own workspace stays in the row, marked, so the row reads like the page.
  const chips = project ? (others.length ? workspaces : []) : others;
  return (
    <AnimatePresence>
      {dragged && (project || chips.length > 0) && (
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
            ref={panel.setNodeRef}
            onPointerEnter={() => onInside(true)}
            onPointerLeave={() => onInside(false)}
            role="group"
            aria-label={project ? `Move ${project.name}` : "Move into workspace"}
            className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-2xl border bg-card/90 p-1.5 shadow-float backdrop-blur-xl"
          >
            {project && <NewWorkspaceTarget />}
            {project && chips.length > 0 && <span aria-hidden className="mx-1 h-6 w-px bg-border" />}
            {chips.length > 0 && (
              <span className="flex shrink-0 items-center gap-1.5 px-2 text-xs text-muted-foreground">
                <FolderInput className="size-3.5" aria-hidden /> {project ? "Move to" : "Move into"}
              </span>
            )}
            {chips.map((w) => (
              <DockTarget key={w.id} workspace={w} here={w.id === from} />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function NewWorkspaceTarget() {
  const drop = useScopeDrop({ kind: "new" }, "dock:new");
  return (
    <div
      ref={drop.ref}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-xl border border-dashed border-brand/40 bg-brand/5 py-1.5 pr-3 pl-1.5 text-sm font-medium text-brand-strong transition-[background-color,border-color,transform] duration-150",
        drop.state === "valid" && "scale-[1.04] border-solid border-brand/60 bg-brand/15",
      )}
    >
      <span aria-hidden className="grid size-6 place-items-center rounded-lg bg-brand/15">
        <LayersPlus className="size-3.5" />
      </span>
      Make it a workspace
    </div>
  );
}

function DockTarget({ workspace, here }: { workspace: Workspace; here: boolean }) {
  const drop = useScopeDrop({ kind: "workspace", workspace }, `dock:${workspace.id}`);
  return (
    <div
      ref={drop.ref}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-xl border border-transparent px-2 py-1.5 text-sm transition-[background-color,border-color,transform] duration-150",
        here ? "text-muted-foreground opacity-50" : "text-foreground",
        drop.state === "valid" && "scale-[1.04] border-brand/50 bg-brand/10",
      )}
    >
      <WorkspaceTile icon={workspace.icon} color={workspace.color} size="sm" className="size-5 rounded-[5px] text-[11px]" />
      <span className="max-w-36 truncate">{workspace.name}</span>
      {here && <span className="text-[11px]">here</span>}
    </div>
  );
}

/** Asks before a workspace becomes a project: a lot moves along, and some of its settings give way. */
function NestDialog({
  move,
  open,
  pending,
  onOpenChange,
  onConfirm,
}: {
  move: NestMove | null;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  if (!move) return null;
  const { workspace: w, to } = move;
  const projects = w.projects.length;
  return (
    <AlertDialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <AlertDialogContent className="rounded-2xl">
        <AlertDialogHeader>
          <div aria-hidden className="mb-2 flex items-center gap-2.5">
            <WorkspaceTile icon={w.icon} color={w.color} size="md" />
            <ArrowRight className="size-4 text-muted-foreground" />
            <WorkspaceTile icon={to.icon} color={to.color} size="md" />
          </div>
          <AlertDialogTitle>
            Move {w.name} into {to.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {w.name} becomes a project of {to.name}. You can undo it right after.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-2.5 rounded-xl border bg-paper-2 p-4 text-sm [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
          <li className="flex gap-2.5">
            <Bot aria-hidden />
            <span>Its agents, chats, tasks and repositories move along.</span>
          </li>
          {projects > 0 && (
            <li className="flex gap-2.5">
              <Layers aria-hidden />
              <span>
                Its {projects === 1 ? "project becomes a project" : `${projects} projects become projects`} of {to.name} too.
              </span>
            </li>
          )}
          <li className="flex gap-2.5">
            <KeyRound aria-hidden />
            <span>
              Its logins, 2FA codes, integrations and browser profiles become {to.name}'s, shared with every agent there.
            </span>
          </li>
          {(w.vmId !== to.vmId || w.autoMerge !== to.autoMerge) && (
            <li className="flex gap-2.5">
              <MonitorCog aria-hidden />
              <span>{to.name}'s VM and auto-merge settings apply to it from then on.</span>
            </li>
          )}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {pending && <Spinner />}
            Move into {to.name}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Before a project whose context an agent wrote becomes a workspace: that context then reaches every run there. */
function ReviewDialog({
  move,
  open,
  pending,
  onOpenChange,
  onConfirm,
}: {
  move: ProjectMove | null;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  if (!move) return null;
  const { project: p } = move;
  return (
    <AlertDialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <AlertDialogContent className="rounded-2xl">
        <AlertDialogHeader>
          <div aria-hidden className="mb-2 flex items-center gap-2.5">
            <WorkspaceTile icon={p.icon} color={p.color} size="md" />
            <ArrowRight className="size-4 text-muted-foreground" />
            <span className="grid size-10 place-items-center rounded-lg border border-dashed text-muted-foreground">
              <LayersPlus className="size-4" />
            </span>
          </div>
          <AlertDialogTitle>Make {p.name} a workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            An agent wrote this project's context. As the workspace's, every agent there follows it, so read it first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-64 space-y-3 overflow-y-auto rounded-xl border bg-paper-2 p-4 text-sm">
          {p.description.trim() && <p className="text-muted-foreground">{p.description}</p>}
          {p.instructions.trim() && <p className="whitespace-pre-wrap">{p.instructions}</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {pending && <Spinner />}
            Make it a workspace
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type DragProps = Pick<HTMLAttributes<HTMLElement>, "onPointerDown" | "onDragStartCapture">;

function useScopeDrag(item: ScopeDragItem | null, id: string) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id, data: { item }, disabled: !item });
  const props: DragProps = listeners
    ? {
        // Menus portalled out of the element bubble here too, through React.
        onPointerDown: (e) => {
          if (e.currentTarget.contains(e.target as Node)) listeners.onPointerDown?.(e);
        },
        // Links and images inside would start the webview's own drag.
        onDragStartCapture: (e) => e.preventDefault(),
      }
    : {};
  return { ref: setNodeRef, isDragging, props };
}

/**
 * A drop target. `state`: "none" when nothing is dragged or dropping here changes nothing, "valid" while letting go
 * would land here (also when the pointer is on another target for the same workspace), "invalid" while the pointer is
 * on a target that can't take it, "available" while it could go here.
 */
function useScopeDrop(target: ScopeDropTarget | null, id: string) {
  const { dragged, landing, plan } = useContext(Ctx);
  const p = dragged && target ? plan(target) : null;
  const { setNodeRef, isOver } = useDroppable({ id, data: { target }, disabled: !p });
  const key = target?.kind === "workspace" ? target.workspace.id : target?.kind;
  const state: DropState = !p ? "none" : !p.ok ? (isOver ? "invalid" : "none") : isOver || landing === key ? "valid" : "available";
  return { ref: setNodeRef, state };
}

/** A workspace card or row: picked up as a whole (when there is another to put it in), and takes what is dropped on it. Global (null) takes nothing. */
export function useWorkspaceDnd(workspace: Workspace | null) {
  const { workspaces } = useContext(Ctx);
  const key = workspace?.id ?? "global";
  const drag = useScopeDrag(workspace && workspaces.length > 1 ? { kind: "workspace", workspace } : null, `workspace:${key}`);
  const drop = useScopeDrop(workspace ? { kind: "workspace", workspace } : { kind: "global" }, `ws:${key}`);
  const ref = useCombinedRefs<HTMLElement | null>(drag.ref, drop.ref);
  return { ref, props: drag.props, isDragging: drag.isDragging, state: drop.state };
}

/**
 * A project chip or row, picked up on its own. Given its workspace (a row in the list), it also takes drops for that
 * workspace and fades while the workspace is dragged.
 */
export function useProjectDnd(project: Project, workspace?: Workspace) {
  const { dragged } = useContext(Ctx);
  const drag = useScopeDrag({ kind: "project", project }, `project:${project.id}`);
  const drop = useScopeDrop(workspace ? { kind: "workspace", workspace } : null, `ws:${project.workspaceId}:${project.id}`);
  const ref = useCombinedRefs<HTMLElement | null>(drag.ref, drop.ref);
  const withWorkspace = !!workspace && dragged?.kind === "workspace" && dragged.workspace.id === workspace.id;
  return { ref, props: drag.props, isDragging: drag.isDragging || withWorkspace, state: drop.state };
}

/** The workspace menu's way to put it into another (the same as dragging it there, confirmation included). */
export function WorkspaceMoveMenu({ workspace }: { workspace: Workspace }) {
  const { workspaces, move } = useContext(Ctx);
  const others = workspaces.filter((w) => w.id !== workspace.id);
  if (!others.length) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput /> Move into…
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-52 overflow-y-auto">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Becomes a project of</DropdownMenuLabel>
        {others.map((w) => (
          <DropdownMenuItem key={w.id} onClick={() => move({ kind: "workspace", workspace, to: w })}>
            <WorkspaceTile icon={w.icon} color={w.color} size="sm" className="size-4.5 rounded-[4px] text-[10px]" />
            <span className="truncate">{w.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** A project's menu: make it a workspace of its own, or move it to another (the same as dragging it). */
export function ProjectMoveMenu({ project, className }: { project: Project; className?: string }) {
  const { workspaces, move } = useContext(Ctx);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Move ${project.name}`} className={cn("text-muted-foreground", className)}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={() => move({ kind: "project", project, to: null })}>
          <LayersPlus /> Make it a workspace
        </DropdownMenuItem>
        {workspaces.length > 1 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInput /> Move to
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-52 overflow-y-auto">
              {workspaces.map((w) => {
                const here = w.id === project.workspaceId;
                return (
                  <DropdownMenuItem key={w.id} disabled={here} onClick={() => move({ kind: "project", project, to: w })}>
                    <WorkspaceTile icon={w.icon} color={w.color} size="sm" className="size-4.5 rounded-[4px] text-[10px]" />
                    <span className="truncate">{w.name}</span>
                    {here && <Check className="ml-auto" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
