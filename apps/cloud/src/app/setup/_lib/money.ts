/** Plan prices as people type them ("10.00") and as they are stored (minor units, 1000). */

/** Decimal places of a currency (2 for eur, 0 for jpy); null when the code is not three letters. Stripe checks the rest. */
export function currencyDigits(currency: string): number | null {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
}

/** 1000 → "10.00" (eur), 1000 → "1000" (jpy). */
export function minorToInput(amount: number, currency: string): string {
  const digits = currencyDigits(currency) ?? 2;
  return (amount / 10 ** digits).toFixed(digits);
}

/** "10", "10.5", "10,50" → minor units; null when it is not a positive amount in that currency. */
export function inputToMinor(value: string, currency: string): number | null {
  const digits = currencyDigits(currency);
  if (digits === null) return null;
  const match = /^(\d{1,9})(?:[.,](\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > digits) return null;
  return Number(match[1]) * 10 ** digits + Number(fraction.padEnd(digits, "0") || 0);
}
