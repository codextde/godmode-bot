import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, EllipsisVertical, Pencil, Plus, Target, Trash2, Undo2, XCircle } from "lucide-react";
import type { Goal, GoalInput } from "@godmode/shared";
import { formatUsd } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { dueLabel } from "./task-meta";

/**
 * The goals the work serves, above the board: how far each is (tickets done of all, what it cost), a click filters the
 * board to its tickets. Achieved and dropped goals fold away behind a count.
 */
export function GoalsStrip({ goals, selected, onSelect, workspaceId }: { goals: Goal[]; selected: string | null; onSelect: (id: string | null) => void; workspaceId: string | null }) {
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [showDone, setShowDone] = useState(false);
  const active = goals.filter((g) => g.status === "active");
  const done = goals.filter((g) => g.status !== "active");
  const shown = showDone ? goals : active;
  return (
    <div className="flex items-stretch gap-2 overflow-x-auto px-5 pb-4 @2xl:px-8" role="list" aria-label="Goals">
      {shown.map((g) => (
        <GoalCard key={g.id} goal={g} selected={selected === g.id} onSelect={() => onSelect(selected === g.id ? null : g.id)} onEdit={() => setEditing(g)} />
      ))}
      <div className="flex shrink-0 flex-col justify-center gap-1">
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setEditing("new")}>
          <Plus /> {goals.length ? "Goal" : "Add a goal"}
        </Button>
        {done.length > 0 && (
          <button type="button" className="px-3 text-left text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowDone((v) => !v)}>
            {showDone ? "Hide finished" : `${done.length} finished`}
          </button>
        )}
      </div>
      {!goals.length && (
        <p className="self-center text-xs text-muted-foreground">Goals say what the work is for — tickets that serve one tell their agent why, and you see how far it is.</p>
      )}
      <GoalDialog goal={editing === "new" ? null : editing} open={editing !== null} workspaceId={workspaceId} onClose={() => setEditing(null)} />
    </div>
  );
}

function GoalCard({ goal: g, selected, onSelect, onEdit }: { goal: Goal; selected: boolean; onSelect: () => void; onEdit: () => void }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: Partial<GoalInput>) => api.goals.update(g.id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.goals }),
    onError: (err) => toast.error("Couldn't change the goal", { description: errorMessage(err) }),
  });
  const remove = useMutation({
    mutationFn: () => api.goals.delete(g.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.goals });
      qc.invalidateQueries({ queryKey: qk.tasks });
      toast.success(`“${g.title}” deleted`, { description: "Its tickets stay, serving no goal." });
    },
    onError: (err) => toast.error("Couldn't delete the goal", { description: errorMessage(err) }),
  });
  const share = g.tickets.total ? Math.round((g.tickets.done / g.tickets.total) * 100) : 0;
  return (
    <div
      role="listitem"
      className={cn(
        "group relative flex w-60 shrink-0 flex-col rounded-xl border bg-card px-3 py-2.5 shadow-card transition",
        selected ? "border-foreground/40 ring-2 ring-ring/30" : "hover:border-foreground/20",
        g.status !== "active" && "opacity-70",
      )}
    >
      <button type="button" onClick={onSelect} aria-pressed={selected} className="text-left focus-visible:outline-none" title={g.why || undefined}>
        <span className="flex items-center gap-1.5 pr-6 text-[13px] font-medium">
          {g.status === "achieved" ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" /> : g.status === "dropped" ? <XCircle className="size-3.5 shrink-0 text-muted-foreground" /> : <Target className="size-3.5 shrink-0 text-brand-strong" />}
          <span className="truncate">{g.title}</span>
        </span>
        <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]" aria-hidden>
          <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${share}%` }} />
        </span>
        <span className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
          <span>{g.tickets.total ? `${g.tickets.done} of ${g.tickets.total} done` : "No tickets yet"}</span>
          {g.costUsd > 0 && <span>· {formatUsd(g.costUsd)}</span>}
          {g.targetDate && <span className="ml-auto">{dueLabel(g.targetDate)}</span>}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" className="absolute top-1.5 right-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label={`More for ${g.title}`}>
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil /> Edit
          </DropdownMenuItem>
          {g.status === "active" ? (
            <>
              <DropdownMenuItem onSelect={() => save.mutate({ status: "achieved" })}>
                <CheckCircle2 /> Mark achieved
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => save.mutate({ status: "dropped" })}>
                <XCircle /> Drop it
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onSelect={() => save.mutate({ status: "active" })}>
              <Undo2 /> Make it active again
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => remove.mutate()}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Add or edit a goal: what it is, why it matters (the agents get that), when. */
function GoalDialog({ goal, open, workspaceId, onClose }: { goal: Goal | null; open: boolean; workspaceId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<{ title: string; why: string; targetDate: string }>({ title: "", why: "", targetDate: "" });
  const [seenFor, setSeenFor] = useState<string | null>(null);
  // Fill the form when the dialog opens for a goal (or empty for a new one).
  const key = open ? (goal?.id ?? "new") : null;
  if (key !== seenFor) {
    setSeenFor(key);
    if (key) setForm({ title: goal?.title ?? "", why: goal?.why ?? "", targetDate: goal?.targetDate ?? "" });
  }
  const save = useMutation({
    mutationFn: () => {
      const input = { title: form.title.trim(), why: form.why.trim(), targetDate: form.targetDate || null };
      return goal ? api.goals.update(goal.id, input) : api.goals.create({ ...input, workspaceId });
    },
    onSuccess: (g) => {
      qc.invalidateQueries({ queryKey: qk.goals });
      toast.success(goal ? "Goal saved" : `Goal “${g.title}” added`, { description: goal ? undefined : "File tickets under it — their agents are told why." });
      onClose();
    },
    onError: (err) => toast.error("Couldn't save the goal", { description: errorMessage(err) }),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{goal ? "Edit goal" : "New goal"}</DialogTitle>
          <DialogDescription>What the work is for. Tickets that serve it tell their agent why.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.title.trim()) save.mutate();
          }}
        >
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Goal</span>
            <Input autoFocus value={form.title} maxLength={200} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Launch the new pricing" />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Why it matters</span>
            <Textarea value={form.why} maxLength={2000} rows={3} onChange={(e) => setForm((f) => ({ ...f, why: e.target.value }))} placeholder="Raise revenue per customer by 20% this quarter — the agents get this with every ticket." />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Target date</span>
            <Input type="date" value={form.targetDate} onChange={(e) => setForm((f) => ({ ...f, targetDate: e.target.value }))} className="w-44" />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!form.title.trim() || save.isPending}>
              {save.isPending && <Spinner />} {goal ? "Save" : "Add goal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
