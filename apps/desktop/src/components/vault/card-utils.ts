import { CARD_BRAND_LABELS, formatMoney, type CardBrand, type PaymentCard } from "@godmode/shared";

/** Countries offered for billing addresses (ISO 3166-1 alpha-2). */
export const BILLING_COUNTRIES: { code: string; name: string }[] = [
  { code: "DE", name: "Germany" },
  { code: "AT", name: "Austria" },
  { code: "CH", name: "Switzerland" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "BE", name: "Belgium" },
  { code: "IT", name: "Italy" },
  { code: "ES", name: "Spain" },
  { code: "PL", name: "Poland" },
  { code: "SE", name: "Sweden" },
  { code: "DK", name: "Denmark" },
  { code: "IE", name: "Ireland" },
  { code: "LU", name: "Luxembourg" },
  { code: "PT", name: "Portugal" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
];

export function countryName(code: string): string {
  return BILLING_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

/** "08/29" */
export function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, "0")}/${String(year % 100).padStart(2, "0")}`;
}

/** Default label for a card: "Visa 4242". */
export function defaultCardName(brand: CardBrand, last4: string): string {
  return last4 ? `${CARD_BRAND_LABELS[brand]} ${last4}` : CARD_BRAND_LABELS[brand];
}

/** Minor units to the text of a money input: 5000 -> "50.00", null -> "". */
export function toMajorInput(minor: number | null | undefined): string {
  return minor === null || minor === undefined ? "" : (minor / 100).toFixed(2);
}

/**
 * Money input text to minor units. "" = null (no amount), NaN = not a valid amount.
 * Accepts "50", "49.99", "49,99", "1,250.00" and "1.250,00".
 */
export function toMinor(text: string): number | null {
  let s = text.replace(/[\s'’]/g, "");
  if (!s) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+(,\d*)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(",", ".");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100);
}

/** "Asks every time" / "Asks above EUR 20.00" / "No approval within limits" */
export function approvalText(card: Pick<PaymentCard, "askAbove" | "currency">): string {
  if (card.askAbove === null) return "No approval within limits";
  if (card.askAbove === 0) return "Asks every time";
  return `Asks above ${formatMoney(card.askAbove, card.currency)}`;
}
