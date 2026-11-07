import { buildDays, type CronDraft } from "@godmode/shared";

export const SEVERAL_TIMES = [2, 3, 4, 5, 6, 8, 10, 12];
export const SEVERAL_EVERY = [1, 2, 3, 4, 6, 8, 12];

const clamp = (n: number, min: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min);

/** The expression of a preset (desktop: buildCron). */
export function buildCron(d: CronDraft): string {
  const m = clamp(d.minute, 0, 59);
  const h = clamp(d.hour, 0, 23);
  switch (d.kind) {
    case "hourly":
      return `${m} * * * *`;
    case "several": {
      const dow = buildDays(d.days);
      if (d.mode === "random") return `${m} ${h} * * ${dow}`;
      const last = lastIntervalHour(d);
      if (h === 0 && last >= 23 - (23 % d.every) && 24 % d.every === 0) return `${m} */${d.every} * * ${dow}`;
      return `${m} ${h}-${Math.max(h, last)}/${d.every} * * ${dow}`;
    }
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${clamp(d.weekday, 0, 6)}`;
    case "monthly":
      return `${m} ${h} ${clamp(d.monthDay, 1, 31)} * *`;
    default:
      return d.custom.trim().replace(/\s+/g, " ");
  }
}

/** Latest hour an interval run can start at without passing the end time. */
function lastIntervalHour(d: CronDraft): number {
  return Math.floor((d.untilHour * 60 + d.untilMinute - d.minute) / 60);
}

/** Minutes between the first and the last moment of a "several" draft. */
export function severalSpan(d: CronDraft): number {
  return d.untilHour * 60 + d.untilMinute - (d.hour * 60 + d.minute);
}

/** Random start window + runs a "several · random" draft needs; null for every other draft. */
export function severalWindow(d: CronDraft): { startWindowMinutes: number; runsPerWindow: number } | null {
  if (d.kind !== "several" || d.mode !== "random") return null;
  return { startWindowMinutes: Math.max(0, severalSpan(d)), runsPerWindow: d.times };
}

/** Start times (minutes after midnight) of a "several" draft: the start of each random part, or each interval run. */
export function severalStarts(d: CronDraft): number[] {
  const start = d.hour * 60 + d.minute;
  const span = severalSpan(d);
  if (span <= 0) return [];
  if (d.mode === "random") return Array.from({ length: d.times }, (_, i) => start + (span * i) / d.times);
  const out: number[] = [];
  for (let t = start; t <= start + span; t += d.every * 60) out.push(t);
  return out;
}
