import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { addDays, format, isThisYear, isToday, isTomorrow, isYesterday, startOfDay } from "date-fns";
import { CalendarClock, CheckCheck, Combine, Hand, Minus, PencilLine, Plus, Undo2, type LucideIcon } from "lucide-react";
import type { Dream, DreamChangeKind, DreamReason, DreamStatus } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
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

export const ACTIVE_DREAM: DreamStatus[] = ["queued", "running"];
/** Dreams that ended early: the core rolled their memory changes back, so their changes describe an attempt. */
export const ROLLED_BACK: DreamStatus[] = ["failed", "cancelled", "paused"];

/** The last non-null value — a closing dialog keeps its content through the exit animation. */
export function useLastDefined<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

export function plural(n: number, word: string) {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** "MEMORY.md", "MEMORY.md and memory/people.md", "3 memory files" */
export function fileList(files: string[]) {
  if (files.length <= 2) return files.join(" and ");
  return `${files.length} memory files`;
}

/** What the dream read: "Reviewed 14 exchanges in 5 chats". */
export function reviewedLabel(dream: Pick<Dream, "exchanges" | "conversations" | "status">) {
  const active = ACTIVE_DREAM.includes(dream.status);
  const ended = ROLLED_BACK.includes(dream.status);
  if (!dream.exchanges) {
    if (active) return "Nothing new to read — tidying up and refreshing dates";
    return ended ? "Set out to tidy up and refresh dates" : "No new conversations — tidied up and refreshed dates";
  }
  const what = `${plural(dream.exchanges, "exchange")} in ${plural(dream.conversations, "chat")}`;
  return active ? `Reviewing ${what}` : ended ? `Set out to review ${what}` : `Reviewed ${what}`;
}

/** "Today, 3:00 AM" · "Yesterday, 3:00 AM" · "Mon, Sep 22, 3:00 AM" */
export function dreamWhen(iso: string) {
  const d = new Date(iso);
  if (isToday(d)) return `Today, ${format(d, "p")}`;
  if (isYesterday(d)) return `Yesterday, ${format(d, "p")}`;
  return format(d, isThisYear(d) ? "EEE, MMM d, p" : "MMM d, yyyy, p");
}

/** "due now" · "tonight at 3:00 AM" · "today at 3:00 PM" · "tomorrow at 3:00 PM" · "Saturday at 4:00 AM" · "Mon, Oct 12 at 3:00 AM" */
export function upcomingWhen(iso: string, now = Date.now()) {
  const d = new Date(iso);
  if (d.getTime() <= now) return "due now";
  const time = format(d, "p");
  const hour = d.getHours();
  // "Tonight" is this evening or the small hours after it — never tomorrow evening.
  if ((isToday(d) && hour >= 20) || (isTomorrow(d) && hour < 6)) return `tonight at ${time}`;
  if (isToday(d)) return `today at ${time}`;
  if (isTomorrow(d)) return `tomorrow at ${time}`;
  if (d < addDays(startOfDay(now), 7)) return `${format(d, "EEEE")} at ${time}`;
  return `${format(d, isThisYear(d) ? "EEE, MMM d" : "MMM d, yyyy")} at ${time}`;
}

const STATUS_META: Record<DreamStatus, { label: string; className: string; dot: string }> = {
  queued: { label: "Waiting", className: "border-border bg-secondary text-muted-foreground", dot: "bg-muted-foreground/60" },
  running: { label: "Running", className: "border-dream/25 bg-dream-soft text-dream", dot: "bg-dream motion-safe:animate-dream-dot" },
  succeeded: { label: "Consolidated", className: "border-success/20 bg-success/[0.08] text-success", dot: "bg-success" },
  failed: { label: "Failed", className: "border-destructive/20 bg-destructive/[0.06] text-destructive", dot: "bg-destructive" },
  cancelled: { label: "Cancelled", className: "border-border bg-secondary text-muted-foreground", dot: "bg-muted-foreground/60" },
  paused: { label: "Paused", className: "border-warning/25 bg-warning/[0.07] text-warning", dot: "bg-warning" },
  reverted: { label: "Undone", className: "border-border bg-secondary text-muted-foreground", dot: "bg-muted-foreground/40" },
};

export function DreamStatusBadge({ status, className }: { status: DreamStatus; className?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.queued;
  return (
    <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-[5px] border px-1.5 text-[11px] font-medium", meta.className, className)}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}

const REASON_META: Record<DreamReason, { label: string; icon: LucideIcon }> = {
  schedule: { label: "Scheduled", icon: CalendarClock },
  manual: { label: "Manual", icon: Hand },
};

export function DreamReasonBadge({ reason }: { reason: DreamReason }) {
  const meta = REASON_META[reason] ?? REASON_META.manual;
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-[5px] border bg-card px-1.5 text-[11px] font-medium text-muted-foreground">
      <meta.icon className="size-3" />
      {meta.label}
    </span>
  );
}

export const CHANGE_KINDS: Record<DreamChangeKind, { label: string; icon: LucideIcon; className: string }> = {
  added: {
    label: "Added",
    icon: Plus,
    className: "bg-emerald-500/10 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-300/15",
  },
  updated: {
    label: "Updated",
    icon: PencilLine,
    className: "bg-sky-500/10 text-sky-700 ring-sky-600/15 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-300/15",
  },
  merged: {
    label: "Merged",
    icon: Combine,
    className: "bg-fuchsia-500/10 text-fuchsia-700 ring-fuchsia-600/15 dark:bg-fuchsia-400/10 dark:text-fuchsia-300 dark:ring-fuchsia-300/15",
  },
  corrected: {
    label: "Corrected",
    icon: CheckCheck,
    className: "bg-amber-500/12 text-amber-800 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-300/15",
  },
  removed: {
    label: "Removed",
    icon: Minus,
    className: "bg-rose-500/10 text-rose-700 ring-rose-600/15 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-300/15",
  },
  dated: { label: "Dated", icon: CalendarClock, className: "bg-dream-soft text-dream ring-dream/20" },
};

export const CHANGE_KIND_ORDER: DreamChangeKind[] = ["added", "updated", "merged", "corrected", "dated", "removed"];

/** Small coloured chip for a kind of memory change; with `count` it reads "3 added". */
export function ChangeKindChip({ kind, count, className }: { kind: DreamChangeKind; count?: number; className?: string }) {
  const meta = CHANGE_KINDS[kind] ?? CHANGE_KINDS.updated;
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[11px] font-medium ring-1 ring-inset",
        count === undefined && "w-[5.75rem]",
        meta.className,
        className,
      )}
    >
      <meta.icon className="size-3 shrink-0" aria-hidden />
      {count === undefined ? meta.label : <span className="tabular-nums">{`${count} ${meta.label.toLowerCase()}`}</span>}
    </span>
  );
}

/** Undo a dream: put the memory files it changed back. The core refuses (409) when they were edited since. */
export function useRevertDream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.dreams.revert(id),
    onSuccess: (dream) => {
      qc.invalidateQueries({ queryKey: qk.dreams });
      qc.invalidateQueries({ queryKey: [...qk.agentFilesAll, dream.agentId] });
      qc.invalidateQueries({ queryKey: [...qk.agentFileAll, dream.agentId] });
      qc.invalidateQueries({ queryKey: qk.agentCommits(dream.agentId) });
      toast.success("Dream undone", {
        description: `${fileList(dream.files)} ${dream.files.length === 1 ? "is" : "are"} back the way ${dream.files.length === 1 ? "it was" : "they were"} before.`,
      });
    },
    onError: (err) => {
      toast.error("Couldn't undo the dream", { description: errorMessage(err) });
      qc.invalidateQueries({ queryKey: qk.dreams });
    },
  });
}

export function UndoDreamDialog({ dream, agentName, onOpenChange }: { dream: Dream | null; agentName: string; onOpenChange: (open: boolean) => void }) {
  const revert = useRevertDream();
  const shown = useLastDefined(dream);
  const files = shown?.files ?? [];
  const one = files.length === 1;
  return (
    <AlertDialog open={!!dream} onOpenChange={(open) => !revert.isPending && onOpenChange(open)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Undo this dream?</AlertDialogTitle>
          <AlertDialogDescription>
            Put {files.length ? <span className="font-medium text-foreground">{fileList(files)}</span> : "the memory"} back the way {one ? "it was" : "they were"}{" "}
            before this dream? Whatever {agentName} consolidated in it is forgotten — the dream stays in the journal, marked as undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revert.isPending}>Keep changes</AlertDialogCancel>
          <AlertDialogAction
            disabled={revert.isPending || !dream}
            onClick={(e) => {
              e.preventDefault();
              // Retrying right away can't help either way; the toast says what happened.
              if (dream) revert.mutate(dream.id, { onSettled: () => onOpenChange(false) });
            }}
          >
            {revert.isPending ? <Spinner /> : <Undo2 />}
            Undo dream
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
