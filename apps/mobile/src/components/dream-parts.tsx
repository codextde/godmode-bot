import { addDays, format, isThisYear, isToday, isTomorrow, isYesterday, startOfDay } from "date-fns";
import { useTranslation } from "react-i18next";
import type { Dream, DreamChangeKind, DreamReason, DreamStatus } from "@godmode/shared";
import { Icon, type IconName } from "./icon";
import { Badge, toneColors, type Tone } from "./ui";
import { dateLocale, t } from "@/lib/i18n";
import { useColors } from "@/lib/theme";

export const ACTIVE_DREAM: DreamStatus[] = ["queued", "running"];
/** Dreams that ended early: the core rolled their memory changes back, so their changes describe an attempt. */
export const ROLLED_BACK: DreamStatus[] = ["failed", "cancelled", "paused"];

/** "940" · "7.8k" · "21k" */
export function shortChars(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

/** "MEMORY.md", "MEMORY.md and memory/people.md", "3 memory files" */
export function fileList(files: string[]): string {
  if (files.length === 2) return t("components:dreamParts.twoFiles", { first: files[0], second: files[1] });
  if (files.length < 2) return files.join("");
  return t("components:dreamParts.memoryFiles", { count: files.length });
}

/** "1 workspace entry", "12 workspace entries" */
export function entryCount(n: number): string {
  return t("components:dreamParts.workspaceEntries", { count: n });
}

/** What the dream read: "Reviewed 14 exchanges in 5 chats". */
export function reviewedLabel(dream: Pick<Dream, "exchanges" | "conversations" | "status">): string {
  const active = ACTIVE_DREAM.includes(dream.status);
  const ended = ROLLED_BACK.includes(dream.status);
  if (!dream.exchanges) {
    if (active) return t("components:dreamParts.reviewed.nothingNewActive");
    return ended ? t("components:dreamParts.reviewed.nothingNewEnded") : t("components:dreamParts.reviewed.nothingNew");
  }
  const what = { exchanges: t("components:dreamParts.exchanges", { count: dream.exchanges }), chats: t("components:dreamParts.chats", { count: dream.conversations }) };
  return active ? t("components:dreamParts.reviewed.active", what) : ended ? t("components:dreamParts.reviewed.ended", what) : t("components:dreamParts.reviewed.done", what);
}

/** "Today, 03:00" · "Yesterday, 03:00" · "Mon, Sep 22, 03:00" */
export function dreamWhen(iso: string): string {
  const d = new Date(iso);
  const time = format(d, "HH:mm");
  if (isToday(d)) return t("components:dreamParts.todayAt", { time });
  if (isYesterday(d)) return t("components:dreamParts.yesterdayAt", { time });
  return format(d, isThisYear(d) ? t("components:dreamParts.dateTimeFormat") : t("components:dreamParts.dateTimeYearFormat"), { locale: dateLocale() });
}

/** "due now" · "tonight at 03:00" · "today at 15:00" · "tomorrow at 15:00" · "Saturday at 04:00" · "Mon, Oct 12 at 03:00" */
export function upcomingWhen(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (d.getTime() <= now) return t("components:dreamParts.upcoming.dueNow");
  const time = format(d, "HH:mm");
  const hour = d.getHours();
  // "Tonight" is this evening or the small hours after it — never tomorrow evening.
  if ((isToday(d) && hour >= 20) || (isTomorrow(d) && hour < 6)) return t("components:dreamParts.upcoming.tonight", { time });
  if (isToday(d)) return t("components:dreamParts.upcoming.today", { time });
  if (isTomorrow(d)) return t("components:dreamParts.upcoming.tomorrow", { time });
  if (d < addDays(startOfDay(now), 7)) return t("components:dreamParts.upcoming.onDay", { day: format(d, "EEEE", { locale: dateLocale() }), time });
  const date = format(d, isThisYear(d) ? t("components:dreamParts.dateFormat") : t("components:dreamParts.dateYearFormat"), { locale: dateLocale() });
  return t("components:dreamParts.upcoming.onDate", { date, time });
}

const STATUS_META: Record<DreamStatus, { tone: Tone }> = {
  queued: { tone: "neutral" },
  running: { tone: "dream" },
  succeeded: { tone: "success" },
  failed: { tone: "danger" },
  cancelled: { tone: "neutral" },
  paused: { tone: "warning" },
  reverted: { tone: "neutral" },
};

export function DreamStatusBadge({ status }: { status: DreamStatus }) {
  const { t } = useTranslation("components");
  const known = STATUS_META[status] ? status : "queued";
  return <Badge label={t(`dreamParts.status.${known}`)} tone={STATUS_META[known].tone} live={status === "running"} />;
}

const REASON_META: Record<DreamReason, { icon: IconName }> = {
  schedule: { icon: "clock" },
  manual: { icon: "hand" },
  size: { icon: "gauge" },
};

export function DreamReasonBadge({ reason }: { reason: DreamReason }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const known = REASON_META[reason] ? reason : "manual";
  const meta = REASON_META[known];
  return <Badge label={t(`dreamParts.reason.${known}`)} icon={<Icon name={meta.icon} size={10} color={c.textMuted} />} />;
}

export const CHANGE_KINDS: Record<DreamChangeKind, { icon: IconName; tone: Tone }> = {
  added: { icon: "plus", tone: "emerald" },
  updated: { icon: "pencil", tone: "sky" },
  merged: { icon: "merge", tone: "violet" },
  corrected: { icon: "checkCircle", tone: "amber" },
  removed: { icon: "minus", tone: "rose" },
  dated: { icon: "clock", tone: "dream" },
};

export const CHANGE_KIND_ORDER: DreamChangeKind[] = ["added", "updated", "merged", "corrected", "dated", "removed"];

/** Small coloured chip for a kind of memory change; with `count` it reads "3 added". */
export function ChangeKindChip({ kind, count }: { kind: DreamChangeKind; count?: number }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const known = CHANGE_KINDS[kind] ? kind : "updated";
  const meta = CHANGE_KINDS[known];
  return (
    <Badge
      label={count === undefined ? t(`dreamParts.change.${known}`) : t(`dreamParts.changeCount.${known}`, { n: count })}
      tone={meta.tone}
      icon={<Icon name={meta.icon} size={10} color={toneColors(c, meta.tone).fg} weight="semibold" />}
    />
  );
}

/** How many entries of each kind a dream changed, in the desktop's order. */
export function changeCounts(dream: Pick<Dream, "changes">): { kind: DreamChangeKind; n: number }[] {
  return CHANGE_KIND_ORDER.map((kind) => ({ kind, n: dream.changes.filter((ch) => ch.kind === kind).length })).filter((ch) => ch.n > 0);
}
