// Formatting for every page. English only; one fixed locale per kind so the server and the browser print the same.
// Numbers and money use en-US ("$9.00", "€9.00", "1,234"); dates use en-GB ("4 Oct 2026, 14:05"), which is
// unambiguous and 24-hour.

export type DateInput = Date | string | number;

const NUMBER_LOCALE = "en-US";
const DATE_LOCALE = "en-GB";

export function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** 1536 → "1.5 KB". Binary steps (1 KB = 1024 B), like the desktop app and most operating systems. */
export function formatBytes(bytes: number, opts: { decimals?: number } = {}): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  // Decimal units (1 GB = 10^9 bytes), the way plan allowances count relay traffic.
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), BYTE_UNITS.length - 1);
  const value = bytes / 1000 ** exp;
  if (exp === 0) return `${Math.round(value)} B`;
  const decimals = opts.decimals ?? (value >= 100 ? 0 : 1);
  return `${new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: decimals }).format(value)} ${BYTE_UNITS[exp]}`;
}

const moneyFormats = new Map<string, Intl.NumberFormat>();

function moneyFormat(currency: string, trim: boolean): Intl.NumberFormat {
  const key = `${currency}:${trim}`;
  let f = moneyFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(NUMBER_LOCALE, {
      style: "currency",
      currency: currency.toUpperCase(),
      ...(trim ? { minimumFractionDigits: 0 } : {}),
    });
    moneyFormats.set(key, f);
  }
  return f;
}

/**
 * Amounts as Stripe stores them (in the currency's minor unit): formatMoney(1900, "eur") → "€19.00".
 * `trimZero` drops ".00" on whole amounts ("€19") — for plan cards, not for tables where amounts line up.
 */
export function formatMoney(amountMinor: number, currency: string, opts: { trimZero?: boolean } = {}): string {
  let f: Intl.NumberFormat;
  try {
    f = moneyFormat(currency, false);
  } catch {
    // Unknown currency code: show the number with the code rather than throwing in a page.
    return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
  const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
  const amount = amountMinor / 10 ** digits;
  if (opts.trimZero && Number.isInteger(amount)) return moneyFormat(currency, true).format(amount);
  return f.format(amount);
}

/** 1234 → "1,234"; with `compact`, 12900 → "12.9K". */
export function formatNumber(value: number, opts: { compact?: boolean; maximumFractionDigits?: number } = {}): string {
  return new Intl.NumberFormat(NUMBER_LOCALE, {
    notation: opts.compact ? "compact" : "standard",
    maximumFractionDigits: opts.maximumFractionDigits ?? (opts.compact ? 1 : 2),
  }).format(value);
}

const DATE_STYLES = {
  date: { day: "numeric", month: "short", year: "numeric" },
  datetime: { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
  time: { hour: "2-digit", minute: "2-digit" },
  month: { month: "long", year: "numeric" },
  day: { day: "numeric", month: "short" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DateStyle = keyof typeof DATE_STYLES;

/**
 * "4 Oct 2026" (date), "4 Oct 2026, 14:05" (datetime), "14:05" (time), "October 2026" (month), "4 Oct" (day).
 * Server components print in the server's time zone; `RelativeTime` re-renders in the browser's.
 */
export function formatDate(value: DateInput, style: DateStyle = "date", opts: { timeZone?: string } = {}): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(DATE_LOCALE, { ...DATE_STYLES[style], timeZone: opts.timeZone }).format(d);
}

const relative = new Intl.RelativeTimeFormat(NUMBER_LOCALE, { numeric: "auto" });

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.345],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/** "just now", "5 minutes ago", "yesterday", "in 3 days", "2 months ago". */
export function formatRelative(value: DateInput, now: DateInput = Date.now()): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "—";
  let delta = (d.getTime() - toDate(now).getTime()) / 1000;
  if (Math.abs(delta) < 45) return "just now";
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(delta) < size) return relative.format(Math.round(delta), unit);
    delta /= size;
  }
  return formatDate(d);
}
