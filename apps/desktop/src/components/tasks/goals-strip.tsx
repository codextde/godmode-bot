import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { CheckCircle2, EllipsisVertical, Pencil, Plus, Target, Trash2, Undo2, XCircle } from "lucide-react";
import type { Goal, GoalInput } from "@godmode/shared";
import { Button } from "@/components/ui/button";
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
 * The goals the work serves, above the board: how far each is (tickets done of all), a click filters the
 * board to its tickets. Achieved and dropped goals fold away behind a count.
 */
export function GoalsStrip({ goals, selected, onSelect, workspaceId }: { goals: Goal[]; selected: string | null; onSelect: (id: string | null) => void; workspaceId: string | null }) {
  const { t } = useTranslation("tasks");
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [showDone, setShowDone] = useState(false);
  const active = goals.filter((g) => g.status === "active");
  const done = goals.filter((g) => g.status !== "active");
  const shown = showDone ? goals : active;
  return (
    <div className="flex items-stretch gap-2 overflow-x-auto px-5 pb-4 @2xl:px-8">
      {shown.length > 0 && (
        <ul className="flex items-stretch gap-2" aria-label={t("goals.label")}>
          {shown.map((g) => (
            <GoalCard key={g.id} goal={g} selected={selected === g.id} onSelect={() => onSelect(selected === g.id ? null : g.id)} onEdit={() => setEditing(g)} />
          ))}
        </ul>
      )}
      <div className="flex shrink-0 flex-col justify-center gap-1">
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setEditing("new")}>
          <Plus /> {goals.length ? t("goals.goal") : t("goals.add")}
        </Button>
        {done.length > 0 && (
          <button type="button" className="px-3 text-left text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowDone((v) => !v)}>
            {showDone ? t("goals.hideFinished") : t("goals.finished", { count: done.length })}
          </button>
        )}
      </div>
      {!goals.length && (
        <p className="self-center text-xs text-muted-foreground">{t("goals.intro")}</p>
      )}
      <GoalDialog goal={editing === "new" ? null : editing} open={editing !== null} workspaceId={workspaceId} onClose={() => setEditing(null)} />
    </div>
  );
}

function GoalCard({ goal: g, selected, onSelect, onEdit }: { goal: Goal; selected: boolean; onSelect: () => void; onEdit: () => void }) {
  const { t } = useTranslation(["tasks", "common"]);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: Partial<GoalInput>) => api.goals.update(g.id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.goals }),
    onError: (err) => toast.error(t("goals.changeError"), { description: errorMessage(err) }),
  });
  const remove = useMutation({
    mutationFn: () => api.goals.delete(g.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.goals });
      qc.invalidateQueries({ queryKey: qk.tasks });
      toast.success(t("goals.deleted", { title: g.title }), { description: t("goals.deletedDescription") });
    },
    onError: (err) => toast.error(t("goals.deleteError"), { description: errorMessage(err) }),
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const share = g.tickets.total ? Math.round((g.tickets.done / g.tickets.total) * 100) : 0;
  const whyId = `goal-why-${g.id}`;
  return (
    <li
      className={cn(
        "group relative flex w-60 shrink-0 flex-col rounded-xl border bg-card px-3 py-2.5 shadow-card transition",
        selected ? "border-foreground/40 ring-2 ring-ring/30" : "hover:border-foreground/20",
        g.status !== "active" && "opacity-70",
      )}
    >
      <button type="button" onClick={onSelect} aria-pressed={selected} aria-describedby={g.why ? whyId : undefined} className="text-left focus-visible:outline-none" title={g.why || undefined}>
        <span className="flex items-center gap-1.5 pr-6 text-[13px] font-medium">
          {g.status === "achieved" ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" /> : g.status === "dropped" ? <XCircle className="size-3.5 shrink-0 text-muted-foreground" /> : <Target className="size-3.5 shrink-0 text-brand-strong" />}
          <span className="truncate">{g.title}</span>
        </span>
        <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]" aria-hidden>
          <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${share}%` }} />
        </span>
        <span className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
          <span>{g.tickets.total ? t("goals.progress", { done: g.tickets.done, total: g.tickets.total }) : t("goals.noTickets")}</span>
          {g.targetDate && <span className="ml-auto">{dueLabel(g.targetDate)}</span>}
        </span>
        {g.why && (
          <span id={whyId} className="sr-only">
            {g.why}
          </span>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" className="absolute top-1.5 right-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label={t("goals.moreFor", { title: g.title })}>
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil /> {t("common:actions.edit")}
          </DropdownMenuItem>
          {g.status === "active" ? (
            <>
              <DropdownMenuItem onSelect={() => save.mutate({ status: "achieved" })}>
                <CheckCircle2 /> {t("goals.markAchieved")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => save.mutate({ status: "dropped" })}>
                <XCircle /> {t("goals.drop")}
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onSelect={() => save.mutate({ status: "active" })}>
              <Undo2 /> {t("goals.reactivate")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Trash2 /> {t("common:actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("goals.deleteTitle", { title: g.title })}</AlertDialogTitle>
            <AlertDialogDescription>
              {g.tickets.total ? t("goals.deleteDescription", { count: g.tickets.total }) : t("goals.deleteDescriptionEmpty")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("goals.keep")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate()}>{t("common:actions.delete")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** Add or edit a goal: what it is, why it matters (the agents get that), when. */
function GoalDialog({ goal, open, workspaceId, onClose }: { goal: Goal | null; open: boolean; workspaceId: string | null; onClose: () => void }) {
  const { t } = useTranslation(["tasks", "common"]);
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
      toast.success(goal ? t("goals.saved") : t("goals.added", { title: g.title }), { description: goal ? undefined : t("goals.addedDescription") });
      onClose();
    },
    onError: (err) => toast.error(t("goals.saveError"), { description: errorMessage(err) }),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{goal ? t("goals.editTitle") : t("goals.newTitle")}</DialogTitle>
          <DialogDescription>{t("goals.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.title.trim()) save.mutate();
          }}
        >
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">{t("goals.goal")}</span>
            <Input autoFocus value={form.title} maxLength={200} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder={t("goals.titlePlaceholder")} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">{t("goals.why")}</span>
            <Textarea value={form.why} maxLength={2000} rows={3} onChange={(e) => setForm((f) => ({ ...f, why: e.target.value }))} placeholder={t("goals.whyPlaceholder")} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">{t("goals.targetDate")}</span>
            <Input type="date" value={form.targetDate} onChange={(e) => setForm((f) => ({ ...f, targetDate: e.target.value }))} className="w-44" />
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={!form.title.trim() || save.isPending}>
              {save.isPending && <Spinner />} {goal ? t("common:actions.save") : t("goals.addGoal")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
