/** Cron expressions in words, without a cron library: presets parsed from an expression, validation and descriptions. */
import { formatMinutes } from "./schedule";

/** Languages the descriptions and problems can be written in. */
export type CronLang = "en" | "de";

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

const FIELD_NAMES_DE: Record<string, string> = { minute: "Minute", hour: "Stunde", "day of month": "Tag im Monat", month: "Monat", "day of week": "Wochentag", second: "Sekunde" };

const VALIDATION = {
  en: {
    empty: "Enter a cron expression",
    fieldCount: (n: number) => `Expected 5 fields (minute hour day month weekday), got ${n}`,
    missing: (f: string) => `Missing ${f}`,
    emptyItem: (f: string) => `Empty list item in ${f}`,
    badStep: (f: string) => `Invalid step in ${f}`,
    stepPositive: (f: string) => `Step in ${f} must be a positive number`,
    badRange: (f: string) => `Invalid range in ${f}`,
    badValue: (v: string, f: string) => `“${v}” is not a valid ${f}`,
    outOfRange: (f: string, min: number, max: number) => `${cap(f)} must be between ${min} and ${max}`,
    reversed: (f: string) => `Range in ${f} is reversed`,
  },
  de: {
    empty: "Gib einen Cron-Ausdruck ein",
    fieldCount: (n: number) => `5 Felder erwartet (Minute Stunde Tag Monat Wochentag), ${n} gefunden`,
    missing: (f: string) => `${f} fehlt`,
    emptyItem: (f: string) => `Leerer Listeneintrag bei ${f}`,
    badStep: (f: string) => `Ungültige Schrittweite bei ${f}`,
    stepPositive: (f: string) => `Schrittweite bei ${f} muss eine positive Zahl sein`,
    badRange: (f: string) => `Ungültiger Bereich bei ${f}`,
    badValue: (v: string, f: string) => `„${v}“ ist kein gültiger Wert für ${f}`,
    outOfRange: (f: string, min: number, max: number) => `${f} muss zwischen ${min} und ${max} liegen`,
    reversed: (f: string) => `Bereich bei ${f} ist umgekehrt`,
  },
};

function validateField(field: string, spec: FieldSpec, lang: CronLang): string | null {
  const V = VALIDATION[lang] ?? VALIDATION.en;
  const name = lang === "de" ? (FIELD_NAMES_DE[spec.name] ?? spec.name) : spec.name;
  if (field === "") return V.missing(name);
  for (const item of field.split(",")) {
    if (item === "") return V.emptyItem(name);
    const [range, step, extra] = item.split("/");
    if (extra !== undefined) return V.badStep(name);
    if (step !== undefined && (!isInt(step) || Number(step) === 0)) return V.stepPositive(name);
    if (range === "*" || (range === "?" && (spec.name === "day of month" || spec.name === "day of week"))) continue;
    const bounds = range.split("-");
    if (bounds.length > 2) return V.badRange(name);
    const values = bounds.map((b) => atomValue(b, spec));
    if (values.some((v) => v === null)) return V.badValue(range, name);
    for (const v of values as number[]) {
      if (v < spec.min || v > spec.max) return V.outOfRange(name, spec.min, spec.max);
    }
    if (values.length === 2 && (values[0] as number) > (values[1] as number)) return V.reversed(name);
  }
  return null;
}

/** Returns a human-readable problem, or null when the expression is valid (5 or 6 fields). */
export function validateCron(cron: string, lang: CronLang = "en"): string | null {
  const V = VALIDATION[lang] ?? VALIDATION.en;
  const expr = cron.trim();
  if (!expr) return V.empty;
  const parts = expr.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return V.fieldCount(parts.length);
  const specs = parts.length === 6 ? [SECONDS, ...FIELDS_5] : FIELDS_5;
  for (let i = 0; i < parts.length; i++) {
    const err = validateField(parts[i], specs[i], lang);
    if (err) return err;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Human-readable                                                       */
/* ------------------------------------------------------------------ */

const WEEKDAYS_DE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MONTHS_DE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

const weekdayName = (i: number, lang: CronLang) => (lang === "de" ? WEEKDAYS_DE : WEEKDAYS)[i] ?? String(i);
const shortWeekday = (i: number, lang: CronLang) => (lang === "de" ? WEEKDAYS_DE[i]?.slice(0, 2) : WEEKDAYS[i]?.slice(0, 3)) ?? String(i);
const monthName = (i: number, lang: CronLang) => (lang === "de" ? MONTHS_DE : MONTHS)[i] ?? String(i + 1);

/** "08:30" or "8:30 AM"; without `hour12` English reads 12-hour and German 24-hour. */
export function formatTime(hour: number, minute: number, lang: CronLang = "en", hour12 = lang !== "de"): string {
  const mm = String(minute).padStart(2, "0");
  if (!hour12) return `${String(hour).padStart(2, "0")}:${mm}`;
  return `${hour % 12 || 12}:${mm} ${hour < 12 ? "AM" : "PM"}`;
}

export function ordinal(n: number, lang: CronLang = "en"): string {
  if (lang === "de") return `${n}.`;
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const PHRASES = {
  en: {
    noSchedule: "No schedule",
    everyHour: "Every hour",
    everyHourAt: (mm: string) => `Every hour at :${mm}`,
    everyDayAt: (t: string) => `Every day at ${t}`,
    weekdaysAt: (t: string) => `Weekdays at ${t}`,
    weeklyAt: (day: string, t: string) => `Every ${day} at ${t}`,
    monthlyAt: (n: string, t: string) => `Monthly on the ${n} at ${t}`,
    everyMinute: "Every minute",
    everyMinutes: (n: string) => `Every ${n} minutes`,
    everyHours: (n: string | number) => `Every ${n} hours`,
    atMinute: (mm: string) => ` at :${mm}`,
    fromTo: (what: string, a: string, b: string) => `${what} from ${a} to ${b}`,
    at: (t: string) => `At ${t}`,
    and: " and ",
    hourlyFromTo: (mm: string, a: string, b: string) => `Hourly at :${mm} from ${a} to ${b}`,
    onWeekdays: "on weekdays",
    onWeekends: "on weekends",
    on: (what: string) => `on ${what}`,
    onThe: (what: string) => `on the ${what}`,
    onLastDay: "on the last day",
    onDays: (dom: string) => `on days ${dom}`,
    inMonths: (what: string) => `in ${what}`,
    between: (a: string, b: string) => `between ${a} and ${b}`,
    timesRandom: (n: number, range: string) => `${n} times a day at random times ${range}`,
    runsRandomWithin: (base: string, n: number, d: string) => `${base} · ${n} runs at random times within ${d}`,
    hourRandomMinute: "Every hour at a random minute",
    everyDayRange: (r: string) => `Every day ${r}`,
    weekdaysRange: (r: string) => `Weekdays ${r}`,
    weeklyRange: (day: string, r: string) => `Every ${day} ${r}`,
    monthlyRange: (n: string, r: string) => `Monthly on the ${n} ${r}`,
    randomStartWithin: (base: string, d: string) => `${base} · random start within ${d}`,
  },
  de: {
    noSchedule: "Kein Zeitplan",
    everyHour: "Jede Stunde",
    everyHourAt: (mm: string) => `Stündlich um :${mm}`,
    everyDayAt: (t: string) => `Täglich um ${t}`,
    weekdaysAt: (t: string) => `Werktags um ${t}`,
    weeklyAt: (day: string, t: string) => `Jeden ${day} um ${t}`,
    monthlyAt: (n: string, t: string) => `Monatlich am ${n} um ${t}`,
    everyMinute: "Jede Minute",
    everyMinutes: (n: string) => `Alle ${n} Minuten`,
    everyHours: (n: string | number) => `Alle ${n} Stunden`,
    atMinute: (mm: string) => ` um :${mm}`,
    fromTo: (what: string, a: string, b: string) => `${what} von ${a} bis ${b}`,
    at: (t: string) => `Um ${t}`,
    and: " und ",
    hourlyFromTo: (mm: string, a: string, b: string) => `Stündlich um :${mm} von ${a} bis ${b}`,
    onWeekdays: "werktags",
    onWeekends: "am Wochenende",
    on: (what: string) => `am ${what}`,
    onThe: (what: string) => `am ${what}`,
    onLastDay: "am letzten Tag",
    onDays: (dom: string) => `an den Tagen ${dom}`,
    inMonths: (what: string) => `im ${what}`,
    between: (a: string, b: string) => `zwischen ${a} und ${b}`,
    timesRandom: (n: number, range: string) => `${n}-mal täglich zu zufälligen Zeiten ${range}`,
    runsRandomWithin: (base: string, n: number, d: string) => `${base} · ${n} Läufe zu zufälligen Zeiten innerhalb von ${d}`,
    hourRandomMinute: "Jede Stunde zu einer zufälligen Minute",
    everyDayRange: (r: string) => `Täglich ${r}`,
    weekdaysRange: (r: string) => `Werktags ${r}`,
    weeklyRange: (day: string, r: string) => `Jeden ${day} ${r}`,
    monthlyRange: (n: string, r: string) => `Monatlich am ${n} ${r}`,
    randomStartWithin: (base: string, d: string) => `${base} · zufälliger Start innerhalb von ${d}`,
  },
};

const phrases = (lang: CronLang) => PHRASES[lang] ?? PHRASES.en;

function describeDow(dow: string, lang: CronLang = "en"): string | null {
  if (dow === "*" || dow === "?") return null;
  const P = phrases(lang);
  const upper = dow.toUpperCase();
  if (upper === "1-5" || upper === "MON-FRI") return P.onWeekdays;
  if (["0,6", "6,0", "6,7", "SAT,SUN", "SUN,SAT"].includes(upper)) return P.onWeekends;
  const items = dow.split(",").map((part) => {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(dowValue);
      if (a !== null && b !== null) return { full: `${shortWeekday(a, lang)}–${shortWeekday(b, lang)}`, short: `${shortWeekday(a, lang)}–${shortWeekday(b, lang)}` };
      return { full: part, short: part };
    }
    const v = dowValue(part);
    return v !== null ? { full: weekdayName(v, lang), short: shortWeekday(v, lang) } : { full: part, short: part };
  });
  if (items.length === 1) return P.on(items[0]!.full);
  return P.on(items.map((i) => i.short).join(", "));
}

function describeDom(dom: string, lang: CronLang = "en"): string | null {
  if (dom === "*" || dom === "?") return null;
  const P = phrases(lang);
  if (isInt(dom)) return P.onThe(ordinal(Number(dom), lang));
  if (dom === "L") return P.onLastDay;
  const items = dom.split(",");
  if (items.every(isInt)) return P.onThe(items.map((i) => ordinal(Number(i), lang)).join(", "));
  return P.onDays(dom);
}

function describeMonth(mon: string, lang: CronLang = "en"): string | null {
  if (mon === "*") return null;
  const items = mon.split(",").map((p) => {
    const v = isInt(p) ? Number(p) : MONTH_NAMES[p.toUpperCase()];
    return v ? monthName(v - 1, lang) : p;
  });
  return phrases(lang).inMonths(items.join(", "));
}

/** "Every day at 09:00", "Weekdays at 08:30", "Every 15 minutes", … (German with lang "de"). */
export function cronToHuman(cron: string, lang: CronLang = "en", hour12 = lang !== "de"): string {
  const P = phrases(lang);
  const time12 = (h: number, m: number) => formatTime(h, m, lang, hour12);
  const expr = cron.trim().replace(/\s+/g, " ");
  if (!expr) return P.noSchedule;
  if (validateCron(expr)) return expr;
  const parts = expr.split(" ");
  const five = parts.length === 6 ? parts.slice(1) : parts;
  const draft = parseCron(five.join(" "));
  if (parts.length === 5 && draft.kind !== "custom") {
    const t = time12(draft.hour, draft.minute);
    switch (draft.kind) {
      case "hourly":
        return draft.minute === 0 ? P.everyHour : P.everyHourAt(String(draft.minute).padStart(2, "0"));
      case "daily":
        return P.everyDayAt(t);
      case "weekdays":
        return P.weekdaysAt(t);
      case "weekly":
        return P.weeklyAt(weekdayName(draft.weekday, lang), t);
      case "monthly":
        return P.monthlyAt(ordinal(draft.monthDay, lang), t);
    }
  }

  const [m, h, dom, mon, dow] = five;
  let time: string;
  if (m === "*" && h === "*") time = P.everyMinute;
  else if (/^\*\/\d+$/.test(m) && h === "*") time = P.everyMinutes(m.slice(2));
  else if (isInt(m) && h === "*") time = P.everyHourAt(m.padStart(2, "0"));
  else if (isInt(m) && /^\*\/\d+$/.test(h)) time = h === "*/1" ? P.everyHour : `${P.everyHours(h.slice(2))}${m === "0" ? "" : P.atMinute(m.padStart(2, "0"))}`;
  else if (isInt(m) && /^\d+-\d+\/\d+$/.test(h)) {
    const [range, step] = h.split("/");
    const [a, b] = range.split("-").map(Number);
    const n = Number(step);
    const last = a + Math.floor((b - a) / n) * n;
    time = P.fromTo(n === 1 ? P.everyHour : P.everyHours(n), time12(a, Number(m)), time12(last, Number(m)));
  }
  else if (isInt(m) && isInt(h)) time = P.at(time12(Number(h), Number(m)));
  else if (isInt(m) && h.split(",").every(isInt)) time = P.at(h.split(",").map((x) => time12(Number(x), Number(m))).join(P.and));
  else if (isInt(m) && /^\d+-\d+$/.test(h)) {
    const [a, b] = h.split("-").map(Number);
    time = P.hourlyFromTo(m.padStart(2, "0"), time12(a, 0), time12(b, 0));
  } else return expr;

  const extras = [describeDom(dom, lang), describeMonth(mon, lang), describeDow(dow, lang)].filter(Boolean);
  return extras.length ? `${time} ${extras.join(" ")}` : time;
}

/* ------------------------------------------------------------------ */
/* Random start window                                                  */
/* ------------------------------------------------------------------ */

/** Like cronToHuman, with the random start window: "Weekdays between 8:00 AM and 9:30 AM", "5 times a day at random times between …". */
export function scheduleToHuman(cron: string, startWindowMinutes = 0, runsPerWindow = 1, lang: CronLang = "en", hour12 = lang !== "de"): string {
  const P = phrases(lang);
  const base = cronToHuman(cron, lang, hour12);
  if (!startWindowMinutes || validateCron(cron)) return base;
  const expr = cron.trim().replace(/\s+/g, " ");
  if (runsPerWindow > 1) {
    const d = parseCron(expr, startWindowMinutes, runsPerWindow);
    if (d.kind === "several") {
      const days = describeDow(buildDays(d.days), lang);
      const end = d.hour * 60 + d.minute + startWindowMinutes;
      const range = P.between(formatTime(d.hour, d.minute, lang, hour12), formatTime(Math.floor(end / 60) % 24, end % 60, lang, hour12));
      return `${P.timesRandom(runsPerWindow, range)}${days ? ` ${days}` : ""}`;
    }
    return P.runsRandomWithin(base, runsPerWindow, formatMinutes(startWindowMinutes, lang));
  }
  const d = parseCron(expr);
  if (d.kind === "hourly" && startWindowMinutes === 60) return P.hourRandomMinute;
  if (d.kind !== "custom" && d.kind !== "hourly" && d.kind !== "several") {
    const end = d.hour * 60 + d.minute + startWindowMinutes;
    const range = P.between(formatTime(d.hour, d.minute, lang, hour12), formatTime(Math.floor(end / 60) % 24, end % 60, lang, hour12));
    switch (d.kind) {
      case "daily":
        return P.everyDayRange(range);
      case "weekdays":
        return P.weekdaysRange(range);
      case "weekly":
        return P.weeklyRange(weekdayName(d.weekday, lang), range);
      case "monthly":
        return P.monthlyRange(ordinal(d.monthDay, lang), range);
    }
  }
  return P.randomStartWithin(base, formatMinutes(startWindowMinutes, lang));
}
