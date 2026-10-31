/** Friendly cron helpers: presets ⇄ cron expressions, validation and human-readable descriptions. */
import { Cron } from "croner";
import {
  buildDays,
  cronToHuman as sharedCronToHuman,
  formatMinutes as sharedFormatMinutes,
  MAX_START_WINDOW_MINUTES,
  MIN_MINUTES_PER_RUN,
  ordinal as englishOrdinal,
  scheduleToHuman as sharedScheduleToHuman,
  startWindowLimit,
  startWindowTooLong,
  validateCron as sharedValidateCron,
  type CronDraft,
  type CronKind,
} from "@godmode/shared";
import { currentLanguage, intlLocale, t, uses12Hour } from "@/i18n";

export {
  ALL_DAYS,
  buildDays,
  DEFAULT_CRON,
  defaultDraft,
  parseCron,
  parseDays,
  WEEKDAYS,
  type CronDraft,
  type CronKind,
  type SeveralMode,
} from "@godmode/shared";

export const cronKindLabel = (kind: CronKind): string => t(`agents:cron.kinds.${kind}`);

export const SEVERAL_TIMES = [2, 3, 4, 5, 6, 8, 10, 12];
export const SEVERAL_EVERY = [1, 2, 3, 4, 6, 8, 12];

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
    case "custom":
      return d.custom.trim().replace(/\s+/g, " ");
  }
}

/** Latest hour an interval run can start at without passing the end time. */
function lastIntervalHour(d: CronDraft): number {
  const end = d.untilHour * 60 + d.untilMinute;
  return Math.floor((end - d.minute) / 60);
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

/** What is wrong with a "several" draft, or null. */
export function severalProblem(d: CronDraft): string | null {
  if (d.kind !== "several") return null;
  if (!d.days.length) return t("agents:cron.problems.pickDay");
  const span = severalSpan(d);
  if (span <= 0) return t("agents:cron.problems.endAfterStart");
  if (d.mode === "random" && span / d.times < MIN_MINUTES_PER_RUN) {
    return t("agents:cron.problems.tooManyRuns", { times: d.times, minutes: formatMinutes(d.times * MIN_MINUTES_PER_RUN) });
  }
  if (d.mode === "interval" && severalStarts(d).length < 2) return t("agents:cron.problems.onlyOneRun", { hours: d.every });
  return null;
}

function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* ------------------------------------------------------------------ */
/* Random start window                                                  */
/* ------------------------------------------------------------------ */

export const START_WINDOW_PRESETS = [15, 30, 60, 90, 120, 180];

/** Longest start window the schedule leaves room for (same rule as the core). */
export function maxStartWindow(cron: string, timezone: string): number {
  if (validateCron(cron)) return MAX_START_WINDOW_MINUTES;
  try {
    const job = new Cron(cron.trim(), { paused: true, timezone, mode: "5-or-6-parts" });
    return startWindowLimit((after) => job.nextRun(after), timezone);
  } catch {
    return MAX_START_WINDOW_MINUTES;
  }
}

export function startWindowProblem(cron: string, timezone: string, minutes: number): string | null {
  if (!minutes) return null;
  const limit = maxStartWindow(cron, timezone);
  return minutes > limit ? startWindowTooLong(limit, currentLanguage()) : null;
}

/* ------------------------------------------------------------------ */
/* Timezones                                                            */
/* ------------------------------------------------------------------ */

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const FALLBACK_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Zurich",
  "Europe/Vienna",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Istanbul",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
  "America/Sao_Paulo",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Mexico_City",
];

let zonesCache: string[] | null = null;

export function allTimezones(): string[] {
  if (zonesCache) return zonesCache;
  let zones: string[] = [];
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) zones = fn("timeZone");
  } catch {
    zones = [];
  }
  if (!zones.length) zones = FALLBACK_ZONES;
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];
  zonesCache = zones;
  return zones;
}

/** "GMT+2" style offset label for a timezone (best effort). */
export function timezoneOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat(intlLocale(), { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* Human-readable, in the app language                                  */
/* ------------------------------------------------------------------ */

export const validateCron = (cron: string): string | null => sharedValidateCron(cron, currentLanguage());

export const formatMinutes = (minutes: number): string => sharedFormatMinutes(minutes, currentLanguage());

/** "Every day at 09:00", "Weekdays at 08:30", "Every 15 minutes", … */
export const cronToHuman = (cron: string): string => sharedCronToHuman(cron, currentLanguage(), uses12Hour());

/** Like cronToHuman, with the random start window: "Weekdays between 8:00 AM and 9:30 AM", "5 times a day at random times between …". */
export const scheduleToHuman = (cron: string, startWindowMinutes = 0, runsPerWindow = 1): string => sharedScheduleToHuman(cron, startWindowMinutes, runsPerWindow, currentLanguage(), uses12Hour());

export function formatTime(hour: number, minute: number): string {
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit" });
}

export function ordinal(n: number): string {
  return currentLanguage() === "de" ? `${n}.` : englishOrdinal(n);
}

/** Day of week (0 = Sunday) by name in the app language. */
export function weekdayName(day: number): string {
  return new Date(2023, 0, 1 + day).toLocaleDateString(intlLocale(), { weekday: "long" });
}

export function weekdayShort(day: number): string {
  return new Date(2023, 0, 1 + day).toLocaleDateString(intlLocale(), { weekday: "short" }).replace(/\.$/, "");
}
