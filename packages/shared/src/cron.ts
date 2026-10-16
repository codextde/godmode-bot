/** Cron expressions in words, without a cron library: presets parsed from an expression, validation and descriptions. */
import { formatMinutes } from "./schedule";

export type CronKind = "hourly" | "several" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

/** "Several times a day": N runs at random times between two times, or a run every N hours. */
export type SeveralMode = "random" | "interval";

export interface CronDraft {
  kind: CronKind;
  minute: number;
  hour: number;
  /** Day of week, 0 = Sunday */
  weekday: number;
  /** Day of month 1-31 */
  monthDay: number;
  /** Raw expression for kind = "custom" */
  custom: string;
  /** kind = "several": runs start at `hour:minute` and end by `untilHour:untilMinute` */
  mode: SeveralMode;
  /** Random runs per day */
  times: number;
  /** Hours between interval runs */
  every: number;
  untilHour: number;
  untilMinute: number;
  /** Days of week the runs happen on, 0 = Sunday */
  days: number[];
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const DOW_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

export const DEFAULT_CRON = "0 9 * * *";

const isInt = (s: string) => /^\d+$/.test(s);

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export function defaultDraft(): CronDraft {
  return {
    kind: "daily",
    minute: 0,
    hour: 9,
    weekday: 1,
    monthDay: 1,
    custom: DEFAULT_CRON,
    mode: "random",
    times: 5,
    every: 2,
    untilHour: 21,
    untilMinute: 0,
    days: ALL_DAYS,
  };
}

/** "*", "1-5", "MON,WED", "0,6" → sorted days (0 = Sunday); null when not a plain day list. */
export function parseDays(dow: string): number[] | null {
  if (dow === "*" || dow === "?") return ALL_DAYS;
  const days = new Set<number>();
  for (const item of dow.split(",")) {
    const [a, b, extra] = item.split("-");
    if (extra !== undefined) return null;
    const from = dowValue(a);
    const to = b === undefined ? from : dowValue(b);
    if (from === null || to === null) return null;
    const end = b !== undefined && Number(b) === 7 ? 7 : to;
    if (end < from) return null;
    for (let d = from; d <= end; d++) days.add(d % 7);
  }
  return [...days].sort((x, y) => x - y);
}

export function buildDays(days: number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (!set.length || set.length === 7) return "*";
  if (set.join(",") === "1,2,3,4,5") return "1-5";
  return set.join(",");
}

/** Parse a cron expression into the friendliest matching preset (falls back to "custom"). Runs per window > 1 = random "several". */
export function parseCron(cron: string, startWindowMinutes = 0, runsPerWindow = 1): CronDraft {
  const base = defaultDraft();
  const expr = cron.trim().replace(/\s+/g, " ");
  const parts = expr.split(" ");
  const custom = { ...base, kind: "custom" as const, custom: expr || DEFAULT_CRON };
  if (parts.length !== 5) return custom;
  const [m, h, dom, mon, dow] = parts;
  if (!isInt(m) || Number(m) > 59 || mon !== "*") return custom;
  const minute = Number(m);
  const days = dom === "*" ? parseDays(dow) : null;
  if (days && runsPerWindow > 1 && startWindowMinutes > 0 && isInt(h) && Number(h) <= 23) {
    const end = Math.min(Number(h) * 60 + minute + startWindowMinutes, 23 * 60 + 59);
    return {
      ...base,
      kind: "several",
      mode: "random",
      minute,
      hour: Number(h),
      times: runsPerWindow,
      untilHour: Math.floor(end / 60),
      untilMinute: end % 60,
      days,
      custom: expr,
    };
  }
  const step = days ? /^(?:\*|(\d+)-(\d+))\/(\d+)$/.exec(h) : null;
  if (step && days) {
    const from = step[1] === undefined ? 0 : Number(step[1]);
    const to = step[2] === undefined ? 23 : Number(step[2]);
    const every = Number(step[3]);
    if (from <= to && to <= 23 && every >= 1) {
      return { ...base, kind: "several", mode: "interval", minute, hour: from, every, untilHour: to, untilMinute: minute, days, custom: expr };
    }
  }
  if (h === "*" && dom === "*" && dow === "*") return { ...base, kind: "hourly", minute, custom: expr };
  if (!isInt(h) || Number(h) > 23) return custom;
  const hour = Number(h);
  if (dom === "*" && dow === "*") return { ...base, kind: "daily", minute, hour, custom: expr };
  if (dom === "*" && (dow === "1-5" || dow.toUpperCase() === "MON-FRI")) return { ...base, kind: "weekdays", minute, hour, custom: expr };
  if (dom === "*") {
    const d = dowValue(dow);
    if (d !== null) return { ...base, kind: "weekly", minute, hour, weekday: d, custom: expr };
    return custom;
  }
  if (dow === "*" && isInt(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
    return { ...base, kind: "monthly", minute, hour, monthDay: Number(dom), custom: expr };
  }
  return custom;
}

function dowValue(s: string): number | null {
  if (isInt(s)) {
    const n = Number(s);
    return n >= 0 && n <= 7 ? n % 7 : null;
  }
  const v = DOW_NAMES[s.toUpperCase()];
  return v ?? null;
}

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const FIELDS_5: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day of week", min: 0, max: 7, names: DOW_NAMES },
];
const SECONDS: FieldSpec = { name: "second", min: 0, max: 59 };

function atomValue(atom: string, spec: FieldSpec): number | null {
  if (isInt(atom)) return Number(atom);
  const named = spec.names?.[atom.toUpperCase()];
  return named ?? null;
}

function validateField(field: string, spec: FieldSpec): string | null {
  if (field === "") return `Missing ${spec.name}`;
  for (const item of field.split(",")) {
    if (item === "") return `Empty list item in ${spec.name}`;
    const [range, step, extra] = item.split("/");
    if (extra !== undefined) return `Invalid step in ${spec.name}`;
    if (step !== undefined && (!isInt(step) || Number(step) === 0)) return `Step in ${spec.name} must be a positive number`;
    if (range === "*" || (range === "?" && (spec.name === "day of month" || spec.name === "day of week"))) continue;
    const bounds = range.split("-");
    if (bounds.length > 2) return `Invalid range in ${spec.name}`;
    const values = bounds.map((b) => atomValue(b, spec));
    if (values.some((v) => v === null)) return `“${range}” is not a valid ${spec.name}`;
    for (const v of values as number[]) {
      if (v < spec.min || v > spec.max) return `${cap(spec.name)} must be between ${spec.min} and ${spec.max}`;
    }
    if (values.length === 2 && (values[0] as number) > (values[1] as number)) return `Range in ${spec.name} is reversed`;
  }
  return null;
}

/** Returns a human-readable problem, or null when the expression is valid (5 or 6 fields). */
export function validateCron(cron: string): string | null {
  const expr = cron.trim();
  if (!expr) return "Enter a cron expression";
  const parts = expr.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return `Expected 5 fields (minute hour day month weekday), got ${parts.length}`;
  const specs = parts.length === 6 ? [SECONDS, ...FIELDS_5] : FIELDS_5;
  for (let i = 0; i < parts.length; i++) {
    const err = validateField(parts[i], specs[i]);
    if (err) return err;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Human-readable                                                       */
/* ------------------------------------------------------------------ */

export function formatTime(hour: number, minute: number): string {
  const d = new Date(2000, 0, 1, hour, minute);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function describeDow(dow: string): string | null {
  if (dow === "*" || dow === "?") return null;
  const upper = dow.toUpperCase();
  if (upper === "1-5" || upper === "MON-FRI") return "on weekdays";
  if (["0,6", "6,0", "6,7", "SAT,SUN", "SUN,SAT"].includes(upper)) return "on weekends";
  const items = dow.split(",").map((part) => {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(dowValue);
      if (a !== null && b !== null) return `${WEEKDAYS[a].slice(0, 3)}–${WEEKDAYS[b].slice(0, 3)}`;
      return part;
    }
    const v = dowValue(part);
    return v !== null ? WEEKDAYS[v] : part;
  });
  if (items.length === 1) return `on ${items[0]}`;
  return `on ${items.map((i) => i.slice(0, 3)).join(", ")}`;
}

function describeDom(dom: string): string | null {
  if (dom === "*" || dom === "?") return null;
  if (isInt(dom)) return `on the ${ordinal(Number(dom))}`;
  if (dom === "L") return "on the last day";
  const items = dom.split(",");
  if (items.every(isInt)) return `on the ${items.map((i) => ordinal(Number(i))).join(", ")}`;
  return `on days ${dom}`;
}

function describeMonth(mon: string): string | null {
  if (mon === "*") return null;
  const items = mon.split(",").map((p) => {
    const v = isInt(p) ? Number(p) : MONTH_NAMES[p.toUpperCase()];
    return v ? MONTHS[v - 1] : p;
  });
  return `in ${items.join(", ")}`;
}

/** "Every day at 09:00", "Weekdays at 08:30", "Every 15 minutes", … */
export function cronToHuman(cron: string): string {
  const expr = cron.trim().replace(/\s+/g, " ");
  if (!expr) return "No schedule";
  if (validateCron(expr)) return expr;
  const parts = expr.split(" ");
  const five = parts.length === 6 ? parts.slice(1) : parts;
  const draft = parseCron(five.join(" "));
  if (parts.length === 5 && draft.kind !== "custom") {
    const t = formatTime(draft.hour, draft.minute);
    switch (draft.kind) {
      case "hourly":
        return draft.minute === 0 ? "Every hour" : `Every hour at :${String(draft.minute).padStart(2, "0")}`;
      case "daily":
        return `Every day at ${t}`;
      case "weekdays":
        return `Weekdays at ${t}`;
      case "weekly":
        return `Every ${WEEKDAYS[draft.weekday]} at ${t}`;
      case "monthly":
        return `Monthly on the ${ordinal(draft.monthDay)} at ${t}`;
    }
  }

  const [m, h, dom, mon, dow] = five;
  let time: string;
  if (m === "*" && h === "*") time = "Every minute";
  else if (/^\*\/\d+$/.test(m) && h === "*") time = `Every ${m.slice(2)} minutes`;
  else if (isInt(m) && h === "*") time = `Every hour at :${m.padStart(2, "0")}`;
  else if (isInt(m) && /^\*\/\d+$/.test(h)) time = h === "*/1" ? "Every hour" : `Every ${h.slice(2)} hours${m === "0" ? "" : ` at :${m.padStart(2, "0")}`}`;
  else if (isInt(m) && /^\d+-\d+\/\d+$/.test(h)) {
    const [range, step] = h.split("/");
    const [a, b] = range.split("-").map(Number);
    const n = Number(step);
    const last = a + Math.floor((b - a) / n) * n;
    time = `${n === 1 ? "Every hour" : `Every ${n} hours`} from ${formatTime(a, Number(m))} to ${formatTime(last, Number(m))}`;
  }
  else if (isInt(m) && isInt(h)) time = `At ${formatTime(Number(h), Number(m))}`;
  else if (isInt(m) && h.split(",").every(isInt)) time = `At ${h.split(",").map((x) => formatTime(Number(x), Number(m))).join(" and ")}`;
  else if (isInt(m) && /^\d+-\d+$/.test(h)) {
    const [a, b] = h.split("-").map(Number);
    time = `Hourly at :${m.padStart(2, "0")} from ${formatTime(a, 0)} to ${formatTime(b, 0)}`;
  } else return expr;

  const extras = [describeDom(dom), describeMonth(mon), describeDow(dow)].filter(Boolean);
  return extras.length ? `${time} ${extras.join(" ")}` : time;
}

/* ------------------------------------------------------------------ */
/* Random start window                                                  */
/* ------------------------------------------------------------------ */

/** Like cronToHuman, with the random start window: "Weekdays between 8:00 AM and 9:30 AM", "5 times a day at random times between …". */
export function scheduleToHuman(cron: string, startWindowMinutes = 0, runsPerWindow = 1): string {
  const base = cronToHuman(cron);
  if (!startWindowMinutes || validateCron(cron)) return base;
  const expr = cron.trim().replace(/\s+/g, " ");
  if (runsPerWindow > 1) {
    const d = parseCron(expr, startWindowMinutes, runsPerWindow);
    if (d.kind === "several") {
      const days = describeDow(buildDays(d.days));
      const end = d.hour * 60 + d.minute + startWindowMinutes;
      const range = `between ${formatTime(d.hour, d.minute)} and ${formatTime(Math.floor(end / 60) % 24, end % 60)}`;
      return `${runsPerWindow} times a day at random times ${range}${days ? ` ${days}` : ""}`;
    }
    return `${base} · ${runsPerWindow} runs at random times within ${formatMinutes(startWindowMinutes)}`;
  }
  const d = parseCron(expr);
  if (d.kind === "hourly" && startWindowMinutes === 60) return "Every hour at a random minute";
  if (d.kind !== "custom" && d.kind !== "hourly" && d.kind !== "several") {
    const end = d.hour * 60 + d.minute + startWindowMinutes;
    const range = `between ${formatTime(d.hour, d.minute)} and ${formatTime(Math.floor(end / 60) % 24, end % 60)}`;
    switch (d.kind) {
      case "daily":
        return `Every day ${range}`;
      case "weekdays":
        return `Weekdays ${range}`;
      case "weekly":
        return `Every ${WEEKDAYS[d.weekday]} ${range}`;
      case "monthly":
        return `Monthly on the ${ordinal(d.monthDay)} ${range}`;
    }
  }
  return `${base} · random start within ${formatMinutes(startWindowMinutes)}`;
}
