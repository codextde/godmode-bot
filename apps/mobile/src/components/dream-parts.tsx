import { addDays, format, isThisYear, isToday, isTomorrow, isYesterday, startOfDay } from "date-fns";
import type { Dream, DreamChangeKind, DreamReason, DreamStatus } from "@godmode/shared";
import { Icon, type IconName } from "./icon";
import { Badge, toneColors, type Tone } from "./ui";
import { useColors } from "@/lib/theme";

export const ACTIVE_DREAM: DreamStatus[] = ["queued", "running"];
/** Dreams that ended early: the core rolled their memory changes back, so their changes describe an attempt. */
export const ROLLED_BACK: DreamStatus[] = ["failed", "cancelled", "paused"];

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** "940" · "7.8k" · "21k" */
export function shortChars(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

/** "MEMORY.md", "MEMORY.md and memory/people.md", "3 memory files" */
export function fileList(files: string[]): string {
  if (files.length <= 2) return files.join(" and ");
  return `${files.length} memory files`;
}

/** "1 workspace entry", "12 workspace entries" */
export function entryCount(n: number): string {
  return `${n.toLocaleString()} workspace ${n === 1 ? "entry" : "entries"}`;
}

/** What the dream read: "Reviewed 14 exchanges in 5 chats". */
export function reviewedLabel(dream: Pick<Dream, "exchanges" | "conversations" | "status">): string {
  const active = ACTIVE_DREAM.includes(dream.status);
  const ended = ROLLED_BACK.includes(dream.status);
  if (!dream.exchanges) {
    if (active) return "Nothing new to read — tidying up and refreshing dates";
    return ended ? "Set out to tidy up and refresh dates" : "No new conversations — tidied up and refreshed dates";
  }
  const what = `${plural(dream.exchanges, "exchange")} in ${plural(dream.conversations, "chat")}`;
  return active ? `Reviewing ${what}` : ended ? `Set out to review ${what}` : `Reviewed ${what}`;
}

/** "Today, 03:00" · "Yesterday, 03:00" · "Mon, Sep 22, 03:00" */
export function dreamWhen(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return `Today, ${format(d, "HH:mm")}`;
  if (isYesterday(d)) return `Yesterday, ${format(d, "HH:mm")}`;
  return format(d, isThisYear(d) ? "EEE, MMM d, HH:mm" : "MMM d, yyyy, HH:mm");
}

/** "due now" · "tonight at 03:00" · "today at 15:00" · "tomorrow at 15:00" · "Saturday at 04:00" · "Mon, Oct 12 at 03:00" */
export function upcomingWhen(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (d.getTime() <= now) return "due now";
  const time = format(d, "HH:mm");
  const hour = d.getHours();
  // "Tonight" is this evening or the small hours after it — never tomorrow evening.
  if ((isToday(d) && hour >= 20) || (isTomorrow(d) && hour < 6)) return `tonight at ${time}`;
  if (isToday(d)) return `today at ${time}`;
  if (isTomorrow(d)) return `tomorrow at ${time}`;
  if (d < addDays(startOfDay(now), 7)) return `${format(d, "EEEE")} at ${time}`;
  return `${format(d, isThisYear(d) ? "EEE, MMM d" : "MMM d, yyyy")} at ${time}`;
}

const STATUS_META: Record<DreamStatus, { label: string; tone: Tone }> = {
  queued: { label: "Waiting", tone: "neutral" },
  running: { label: "Running", tone: "dream" },
  succeeded: { label: "Consolidated", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  paused: { label: "Paused", tone: "warning" },
  reverted: { label: "Undone", tone: "neutral" },
};

export function DreamStatusBadge({ status }: { status: DreamStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.queued;
  return <Badge label={meta.label} tone={meta.tone} live={status === "running"} />;
}

const REASON_META: Record<DreamReason, { label: string; icon: IconName }> = {
  schedule: { label: "Scheduled", icon: "clock" },
  manual: { label: "Manual", icon: "hand" },
  size: { label: "Memory full", icon: "gauge" },
};

export function DreamReasonBadge({ reason }: { reason: DreamReason }) {
  const c = useColors();
  const meta = REASON_META[reason] ?? REASON_META.manual;
  return <Badge label={meta.label} icon={<Icon name={meta.icon} size={10} color={c.textMuted} />} />;
}

export const CHANGE_KINDS: Record<DreamChangeKind, { label: string; icon: IconName; tone: Tone }> = {
  added: { label: "Added", icon: "plus", tone: "emerald" },
  updated: { label: "Updated", icon: "pencil", tone: "sky" },
  merged: { label: "Merged", icon: "merge", tone: "violet" },
  corrected: { label: "Corrected", icon: "checkCircle", tone: "amber" },
  removed: { label: "Removed", icon: "minus", tone: "rose" },
  dated: { label: "Dated", icon: "clock", tone: "dream" },
};

export const CHANGE_KIND_ORDER: DreamChangeKind[] = ["added", "updated", "merged", "corrected", "dated", "removed"];

/** Small coloured chip for a kind of memory change; with `count` it reads "3 added". */
export function ChangeKindChip({ kind, count }: { kind: DreamChangeKind; count?: number }) {
  const c = useColors();
  const meta = CHANGE_KINDS[kind] ?? CHANGE_KINDS.updated;
  return (
    <Badge
      label={count === undefined ? meta.label : `${count} ${meta.label.toLowerCase()}`}
      tone={meta.tone}
      icon={<Icon name={meta.icon} size={10} color={toneColors(c, meta.tone).fg} weight="semibold" />}
    />
  );
}

/** How many entries of each kind a dream changed, in the desktop's order. */
export function changeCounts(dream: Pick<Dream, "changes">): { kind: DreamChangeKind; n: number }[] {
  return CHANGE_KIND_ORDER.map((kind) => ({ kind, n: dream.changes.filter((ch) => ch.kind === kind).length })).filter((ch) => ch.n > 0);
}
