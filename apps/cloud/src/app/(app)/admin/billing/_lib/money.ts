/** Decimal text ⇄ minor units (what Stripe and `plan_prices.amount` use). Pure; used by the server action and the form. */

const MAX_MINOR = 100_000_000;

/** Fraction digits of a currency: 2 for usd/eur, 0 for jpy. Unknown codes count as 2. */
export function minorUnits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "9.90" in eur → 990. Accepts a comma as the decimal mark. */
export function parseMoney(text: string, currency: string): { ok: true; minor: number } | { ok: false; error: string } {
  const digits = minorUnits(currency);
  const normalized = text.trim().replace(/\s/g, "").replace(",", ".");
  const match = /^(\d+)(?:\.(\d*))?$/.exec(normalized);
  if (!match) return { ok: false, error: "Enter an amount like 9.90." };
  const [, whole, fraction = ""] = match;
  if (fraction.length > digits) {
    return { ok: false, error: digits === 0 ? `${currency.toUpperCase()} has no decimals.` : `Use at most ${digits} decimals.` };
  }
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
  if (!Number.isSafeInteger(minor)) return { ok: false, error: "Enter a smaller amount." };
  if (minor < 1) return { ok: false, error: "A price must be more than zero." };
  if (minor > MAX_MINOR) return { ok: false, error: "Enter a smaller amount." };
  return { ok: true, minor };
}

/** 990 in eur → "9.90", for the form field. */
export function moneyText(minor: number, currency: string): string {
  const digits = minorUnits(currency);
  return (minor / 10 ** digits).toFixed(digits);
}
