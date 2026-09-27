/** Friendly cron helpers: presets ⇄ cron expressions, validation and human-readable descriptions. */

export type CronKind = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

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
}

export const CRON_KIND_LABELS: Record<CronKind, string> = {
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
  monthly: "Every month",
  custom: "Custom (cron)",
};

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const DOW_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

export const DEFAULT_CRON = "0 9 * * *";

const isInt = (s: string) => /^\d+$/.test(s);

export function defaultDraft(): CronDraft {
  return { kind: "daily", minute: 0, hour: 9, weekday: 1, monthDay: 1, custom: DEFAULT_CRON };
}

/** Parse a cron expression into the friendliest matching preset (falls back to "custom"). */
export function parseCron(cron: string): CronDraft {
  const base = defaultDraft();
  const expr = cron.trim().replace(/\s+/g, " ");
  const parts = expr.split(" ");
  const custom = { ...base, kind: "custom" as const, custom: expr || DEFAULT_CRON };
  if (parts.length !== 5) return custom;
  const [m, h, dom, mon, dow] = parts;
  if (!isInt(m) || Number(m) > 59 || mon !== "*") return custom;
  const minute = Number(m);
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

export function buildCron(d: CronDraft): string {
  const m = clamp(d.minute, 0, 59);
  const h = clamp(d.hour, 0, 23);
  switch (d.kind) {
    case "hourly":
      return `${m} * * * *`;
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

function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
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
  else if (isInt(m) && /^\*\/\d+$/.test(h)) time = `Every ${h.slice(2)} hours${m === "0" ? "" : ` at :${m.padStart(2, "0")}`}`;
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
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}
