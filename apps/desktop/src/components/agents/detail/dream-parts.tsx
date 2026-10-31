import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { addDays, format, isThisYear, isToday, isTomorrow, isYesterday, startOfDay } from "date-fns";
import { CalendarClock, CheckCheck, Combine, Gauge, Hand, Minus, PencilLine, Plus, Undo2, type LucideIcon } from "lucide-react";
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
import { dateLocale, t } from "@/i18n";

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

/** "940" · "7.8k" · "21k" */
export function shortChars(n: number) {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

/** "MEMORY.md", "MEMORY.md and memory/people.md", "3 memory files" */
export function fileList(files: string[]) {
  if (files.length === 2) return t("agents:dreamParts.fileListTwo", { first: files[0], second: files[1] });
  if (files.length < 2) return files.join("");
  return t("agents:dreamParts.memoryFiles", { count: files.length });
}

/** "1 workspace entry", "12 workspace entries" */
export function entryCount(n: number) {
  return t("agents:dreamParts.workspaceEntries", { count: n });
}

/** What the dream read: "Reviewed 14 exchanges in 5 chats". */
export function reviewedLabel(dream: Pick<Dream, "exchanges" | "conversations" | "status">) {
  const active = ACTIVE_DREAM.includes(dream.status);
  const ended = ROLLED_BACK.includes(dream.status);
  if (!dream.exchanges) {
    if (active) return t("agents:dreamParts.reviewed.nothingActive");
    return ended ? t("agents:dreamParts.reviewed.nothingEnded") : t("agents:dreamParts.reviewed.nothingDone");
  }
  const what = {
    exchanges: t("agents:dreamParts.exchanges", { count: dream.exchanges }),
    chats: t("agents:dreamParts.chats", { count: dream.conversations }),
  };
  return active ? t("agents:dreamParts.reviewed.active", what) : ended ? t("agents:dreamParts.reviewed.ended", what) : t("agents:dreamParts.reviewed.done", what);
}

/** "Today, 3:00 AM" · "Yesterday, 3:00 AM" · "Mon, Sep 22, 3:00 AM" */
export function dreamWhen(iso: string) {
  const d = new Date(iso);
  const locale = dateLocale();
  if (isToday(d)) return t("agents:dreamParts.when.today", { time: format(d, "p", { locale }) });
  if (isYesterday(d)) return t("agents:dreamParts.when.yesterday", { time: format(d, "p", { locale }) });
  return format(d, isThisYear(d) ? t("agents:dreamParts.when.thisYearFormat") : t("agents:dreamParts.when.otherYearFormat"), { locale });
}

/** "due now" · "tonight at 3:00 AM" · "today at 3:00 PM" · "tomorrow at 3:00 PM" · "Saturday at 4:00 AM" · "Mon, Oct 12 at 3:00 AM" */
export function upcomingWhen(iso: string, now = Date.now()) {
  const d = new Date(iso);
  if (d.getTime() <= now) return t("agents:dreamParts.upcoming.dueNow");
  const locale = dateLocale();
  const time = format(d, "p", { locale });
  const hour = d.getHours();
  // "Tonight" is this evening or the small hours after it — never tomorrow evening.
  if ((isToday(d) && hour >= 20) || (isTomorrow(d) && hour < 6)) return t("agents:dreamParts.upcoming.tonight", { time });
  if (isToday(d)) return t("agents:dreamParts.upcoming.today", { time });
  if (isTomorrow(d)) return t("agents:dreamParts.upcoming.tomorrow", { time });
  if (d < addDays(startOfDay(now), 7)) return t("agents:dreamParts.upcoming.onDay", { day: format(d, "EEEE", { locale }), time });
  return t("agents:dreamParts.upcoming.onDay", {
    day: format(d, isThisYear(d) ? t("agents:dreamParts.upcoming.thisYearFormat") : t("agents:dreamParts.upcoming.otherYearFormat"), { locale }),
    time,
  });
}

const STATUS_META: Record<DreamStatus, { className: string; dot: string }> = {
  queued: { className: "border-border bg-secondary text-muted-foreground", dot: "bg-muted-foreground/60" },
  running: { className: "border-dream/25 bg-dream-soft text-dream", dot: "bg-dream motion-safe:animate-dream-dot" },
  succeeded: { className: "border-success/20 bg-success/[0.08] text-success", dot: "bg-success" },
  failed: { className: "border-destructive/20 bg-destructive/[0.06] text-destructive", dot: "bg-destructive" },
  cancelled: { className: "border-border bg-secondary text-muted-foreground", dot: "bg-muted-foreground/60" },
  paused: { className: "border-warning/25 bg-warning/[0.07] text-warning", dot: "bg-warning" },
  reverted: { className: "border-border bg-secondary text-muted-foreground", dot: "bg-muted-foreground/40" },
};

export function DreamStatusBadge({ status, className }: { status: DreamStatus; className?: string }) {
  const { t } = useTranslation("agents");
  const key: DreamStatus = status in STATUS_META ? status : "queued";
  const meta = STATUS_META[key];
  return (
    <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-[5px] border px-1.5 text-[11px] font-medium", meta.className, className)}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {t(`dreamParts.status.${key}`)}
    </span>
  );
}

const REASON_META: Record<DreamReason, { icon: LucideIcon }> = {
  schedule: { icon: CalendarClock },
  manual: { icon: Hand },
  size: { icon: Gauge },
};

export function DreamReasonBadge({ reason }: { reason: DreamReason }) {
  const { t } = useTranslation("agents");
  const key: DreamReason = reason in REASON_META ? reason : "manual";
  const meta = REASON_META[key];
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-[5px] border bg-card px-1.5 text-[11px] font-medium text-muted-foreground">
      <meta.icon className="size-3" />
      {t(`dreamParts.reason.${key}`)}
    </span>
  );
}

export const CHANGE_KINDS: Record<DreamChangeKind, { icon: LucideIcon; className: string }> = {
  added: {
    icon: Plus,
    className: "bg-emerald-500/10 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-300/15",
  },
  updated: {
    icon: PencilLine,
    className: "bg-sky-500/10 text-sky-700 ring-sky-600/15 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-300/15",
  },
  merged: {
    icon: Combine,
    className: "bg-fuchsia-500/10 text-fuchsia-700 ring-fuchsia-600/15 dark:bg-fuchsia-400/10 dark:text-fuchsia-300 dark:ring-fuchsia-300/15",
  },
  corrected: {
    icon: CheckCheck,
    className: "bg-amber-500/12 text-amber-800 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-300/15",
  },
  removed: {
    icon: Minus,
    className: "bg-rose-500/10 text-rose-700 ring-rose-600/15 dark:bg-rose-400/10 dark:text-rose-300 dark:ring-rose-300/15",
  },
  dated: { icon: CalendarClock, className: "bg-dream-soft text-dream ring-dream/20" },
};

export const CHANGE_KIND_ORDER: DreamChangeKind[] = ["added", "updated", "merged", "corrected", "dated", "removed"];

/** Small coloured chip for a kind of memory change; with `count` it reads "3 added". */
export function ChangeKindChip({ kind, count, className }: { kind: DreamChangeKind; count?: number; className?: string }) {
  const { t } = useTranslation("agents");
  const key: DreamChangeKind = kind in CHANGE_KINDS ? kind : "updated";
  const meta = CHANGE_KINDS[key];
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
      {count === undefined ? t(`dreamParts.kind.${key}`) : <span className="tabular-nums">{t(`dreamParts.kindCount.${key}`, { count })}</span>}
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
      const files = dream.files.length;
      const moved = dream.workspace.length;
      const description =
        files && moved
          ? t("agents:dreamParts.undone.both", { files: fileList(dream.files), entries: entryCount(moved) })
          : files
            ? t("agents:dreamParts.undone.files", { count: files, files: fileList(dream.files) })
            : moved
              ? t("agents:dreamParts.undone.entries", { count: moved, entries: entryCount(moved) })
              : undefined;
      toast.success(t("agents:dreamParts.undone.title"), { description });
    },
    onError: (err) => {
      toast.error(t("agents:dreamParts.undone.error"), { description: errorMessage(err) });
      qc.invalidateQueries({ queryKey: qk.dreams });
    },
  });
}

export function UndoDreamDialog({ dream, agentName, onOpenChange }: { dream: Dream | null; agentName: string; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation("agents");
  const revert = useRevertDream();
  const shown = useLastDefined(dream);
  const files = shown?.files ?? [];
  const moved = shown?.workspace.length ?? 0;
  const b = <span className="font-medium text-foreground" />;
  return (
    <AlertDialog open={!!dream} onOpenChange={(open) => !revert.isPending && onOpenChange(open)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("dreamParts.undoDialog.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {files.length || !moved ? (
              <>
                {!files.length ? (
                  t("dreamParts.undoDialog.putMemory")
                ) : moved ? (
                  <Trans
                    t={t}
                    i18nKey="dreamParts.undoDialog.putFilesAndMove"
                    count={files.length}
                    values={{ files: fileList(files), entries: entryCount(moved) }}
                    components={{ b }}
                  />
                ) : (
                  <Trans t={t} i18nKey="dreamParts.undoDialog.putFiles" count={files.length} values={{ files: fileList(files) }} components={{ b }} />
                )}{" "}
                {t("dreamParts.undoDialog.forgotten", { name: agentName })}
              </>
            ) : (
              <Trans t={t} i18nKey="dreamParts.undoDialog.moveOnly" count={moved} values={{ entries: entryCount(moved) }} components={{ b }} />
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revert.isPending}>{t("dreamParts.undoDialog.keep")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={revert.isPending || !dream}
            onClick={(e) => {
              e.preventDefault();
              // Retrying right away can't help either way; the toast says what happened.
              if (dream) revert.mutate(dream.id, { onSettled: () => onOpenChange(false) });
            }}
          >
            {revert.isPending ? <Spinner /> : <Undo2 />}
            {t("dreamParts.undoDialog.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
