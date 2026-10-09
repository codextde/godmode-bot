import type { ID, ISODate } from "./models";

/* ------------------------------------------------------------------ */
/* Vault: payment cards and what agents bought with them                */
/* ------------------------------------------------------------------ */

export type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "diners" | "jcb" | "unionpay" | "maestro" | "other";

export const CARD_BRAND_LABELS: Record<CardBrand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  maestro: "Maestro",
  other: "Card",
};

export const CARD_CURRENCIES = ["EUR", "USD", "GBP", "CHF"] as const;

/** Billing address of a card. Sealed in the vault; Godmode types it into checkout forms, agents never read it. */
export interface CardBilling {
  line1: string;
  line2: string;
  postalCode: string;
  city: string;
  state: string;
  /** ISO 3166-1 alpha-2, e.g. "DE" */
  country: string;
}

/**
 * A payment card in the vault. Number, security code and billing address are encrypted; amounts are in minor units
 * (cents) of `currency`.
 */
export interface PaymentCard {
  id: ID;
  workspaceId: ID | null;
  /** The human's label, e.g. "Company Visa" */
  name: string;
  brand: CardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
  holderName: string;
  hasCvc: boolean;
  hasBilling: boolean;
  /** Country of the billing address (agents may pick it in a dropdown) */
  billingCountry: string;
  currency: string;
  /** Most one purchase may cost. null = no limit */
  limitPerPurchase: number | null;
  /** Most all purchases of a calendar month (active subscriptions included) may cost. null = no limit */
  limitMonthly: number | null;
  /** Purchases above this need the human's OK first. 0 = every purchase, null = never (within the limits) */
  askAbove: number | null;
  /** Agents that may pay with it. null = every agent that sees its workspace */
  agentIds: ID[] | null;
  /** Checkout sites it may be used on. Empty = any site */
  allowedSites: string[];
  /** Frozen: no agent can use it until the human unfreezes it */
  frozen: boolean;
  /** Committed this calendar month: purchases waiting, approved or paid plus renewals of active subscriptions */
  spentThisMonth: number;
  lastUsedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface PaymentCardInput {
  workspaceId?: ID | null;
  name: string;
  /** Digits (spaces and dashes are ignored). Required to create; omitted = keep */
  number?: string;
  expMonth?: number;
  expYear?: number;
  holderName?: string;
  /** omitted = keep, "" = remove */
  cvc?: string;
  /** omitted = keep, null = remove */
  billing?: CardBilling | null;
  currency?: string;
  limitPerPurchase?: number | null;
  limitMonthly?: number | null;
  askAbove?: number | null;
  agentIds?: ID[] | null;
  allowedSites?: string[];
  frozen?: boolean;
}

export interface PaymentCardSecrets {
  number: string;
  cvc: string | null;
  billing: CardBilling | null;
}

export type PurchaseRecurrence = "once" | "monthly" | "yearly";

/**
 * pending: waits for the human's OK · approved: the card may be typed in (within limits or OK'd) · declined: the human
 * said no · paid / failed: what the agent (or the human) reported · expired: approved but never used within a day ·
 * cancelled: the question was withdrawn before an answer.
 */
export type PurchaseStatus = "pending" | "approved" | "declined" | "paid" | "failed" | "expired" | "cancelled";

export interface CardPurchase {
  id: ID;
  cardId: ID;
  agentId: ID | null;
  conversationId: ID | null;
  /** Minor units of `currency` */
  amount: number;
  currency: string;
  merchant: string;
  description: string;
  /** Host of the checkout page when the purchase was requested: the card is typed only there (and payment providers) */
  site: string;
  recurrence: PurchaseRecurrence;
  status: PurchaseStatus;
  /** The approval the human answers while the purchase is pending */
  questionId: ID | null;
  /** "limit" = within the card's limits, "human" = the human approved it */
  approvedBy: "limit" | "human" | null;
  filledAt: ISODate | null;
  settledAt: ISODate | null;
  /**
   * Who reported paid / failed. A failure only the agent reported, after the card was typed in, keeps counting toward
   * the limits until the human confirms nothing was charged.
   */
  settledBy: "agent" | "human" | null;
  /** A subscription the human marked as ended: it no longer counts toward later months */
  endedAt: ISODate | null;
  note: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface CardPurchasePatch {
  status?: "paid" | "failed";
  /** Mark a subscription as ended (true) or active again (false) */
  ended?: boolean;
}

/* ------------------------------------------------------------------ */
/* Helpers (shared by the core and the apps)                            */
/* ------------------------------------------------------------------ */

export function cardDigits(number: string): string {
  return number.replace(/[\s-]/g, "");
}

export function cardBrand(number: string): CardBrand {
  const n = cardDigits(number);
  if (/^4/.test(n)) return "visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return "mastercard";
  if (/^3[47]/.test(n)) return "amex";
  if (/^3(0[0-5]|[689])/.test(n)) return "diners";
  if (/^(6011|65|64[4-9])/.test(n)) return "discover";
  if (/^35(2[89]|[3-8])/.test(n)) return "jcb";
  if (/^62/.test(n)) return "unionpay";
  if (/^(5[06-9]|6)/.test(n)) return "maestro";
  return "other";
}

/** Luhn checksum of a card number. */
export function luhnValid(number: string): boolean {
  const n = cardDigits(number);
  if (!/^\d{12,19}$/.test(n)) return false;
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Digit groups as printed on the card: 4-6-5 for American Express and Diners (14), 4-4-4-4(-3) otherwise. */
export function cardGroups(number: string): string[] {
  const n = cardDigits(number);
  const sizes = cardBrand(n) === "amex" ? [4, 6, 5] : n.length === 14 ? [4, 6, 4] : [4, 4, 4, 4, 3];
  const out: string[] = [];
  let at = 0;
  for (const size of sizes) {
    if (at >= n.length) break;
    out.push(n.slice(at, at + size));
    at += size;
  }
  return out;
}

export function cardExpired(card: Pick<PaymentCard, "expMonth" | "expYear">, at = new Date()): boolean {
  return card.expYear < at.getFullYear() || (card.expYear === at.getFullYear() && card.expMonth < at.getMonth() + 1);
}

/** "EUR 29.00" from minor units. */
export function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "code" }).format(minor / 100).replace(/ /g, " ");
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/** "Visa •••• 4242" */
export function cardLabel(card: Pick<PaymentCard, "brand" | "last4">): string {
  return `${CARD_BRAND_LABELS[card.brand]} •••• ${card.last4}`;
}
