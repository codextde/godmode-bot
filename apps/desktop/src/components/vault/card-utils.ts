import { CARD_BRAND_LABELS, formatMoney, type CardBrand, type PaymentCard } from "@godmode/shared";
import { t } from "@/i18n";

/** Countries offered for billing addresses (ISO 3166-1 alpha-2). */
export const BILLING_COUNTRIES = ["DE", "AT", "CH", "US", "GB", "FR", "NL", "BE", "IT", "ES", "PL", "SE", "DK", "IE", "LU", "PT", "CA", "AU"] as const;

type BillingCountry = (typeof BILLING_COUNTRIES)[number];

export const isBillingCountry = (code: string): code is BillingCountry => (BILLING_COUNTRIES as readonly string[]).includes(code);

export function countryName(code: string): string {
  return isBillingCountry(code) ? t(`vault:countries.${code}`) : code;
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
  if (card.askAbove === null) return t("vault:approval.none");
  if (card.askAbove === 0) return t("vault:approval.always");
  return t("vault:approval.above", { amount: formatMoney(card.askAbove, card.currency) });
}
