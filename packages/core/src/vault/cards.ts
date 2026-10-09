/**
 * Payment cards in the vault and the purchases agents make with them.
 *
 * Number, security code and billing address are sealed (`payment_cards.number:<id>`, `.cvc:`, `.billing:`); brand,
 * last four digits, expiry, holder, limits and who may use a card are in clear so lists work while the vault is locked.
 *
 * Agents never read a card. They ask to pay (`requestPurchase`): the amount is checked against the card's limits —
 * the ledger below counts what waits, what is approved, what was paid this month and renewals of subscriptions — and
 * above the card's threshold the human approves first. Only then does Godmode type the details into the checkout
 * page (mcp/tools.ts `vault_fill_card`), bound to the site the purchase was requested on and the payment providers
 * that site embeds (`cardFillHosts`).
 */
import type { Agent, CardBilling, CardPurchase, CardPurchasePatch, PaymentCard, PaymentCardInput, PaymentCardSecrets, PurchaseRecurrence, PurchaseStatus } from "@godmode/shared";
import { CARD_BRAND_LABELS, cardBrand, cardDigits, cardExpired, formatMoney, luhnValid } from "@godmode/shared";
import { all, get, insert, run, tx, update } from "../db";
import { bus } from "../events/bus";
import { badRequest, domainMatches, forbidden, hostnameOf, HttpError, locked, newId, notFound, now, parseJson } from "../util";
import { agentScopeCondition, assertWorkspace, inAgentScope, matchesSearch, scopeCondition, type ScopeFilter } from "./credentials";
import * as vault from "./vault";

interface CardRow {
  id: string;
  workspace_id: string | null;
  name: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  holder_name: string;
  number_enc: string;
  cvc_enc: string | null;
  billing_enc: string | null;
  billing_country: string;
  currency: string;
  limit_per_purchase: number | null;
  limit_monthly: number | null;
  ask_above: number | null;
  agent_ids: string | null;
  allowed_sites: string;
  frozen: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PurchaseRow {
  id: string;
  card_id: string;
  agent_id: string | null;
  run_id: string | null;
  conversation_id: string | null;
  question_id: string | null;
  amount: number;
  currency: string;
  merchant: string;
  description: string;
  site: string;
  recurrence: PurchaseRecurrence;
  status: PurchaseStatus;
  approved_by: "limit" | "human" | null;
  filled_at: string | null;
  settled_at: string | null;
  settled_by: "agent" | "human" | null;
  ended_at: string | null;
  note: string;
  created_at: string;
  updated_at: string;
}

const numberContext = (id: string) => `payment_cards.number:${id}`;
const cvcContext = (id: string) => `payment_cards.cvc:${id}`;
const billingContext = (id: string) => `payment_cards.billing:${id}`;

/** An approved purchase whose card was never typed in lapses after this long. */
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;
/** A purchase waiting for a question that was never asked (the run ended first) is dropped after this long. */
const UNASKED_TTL_MS = 10 * 60_000;
const MAX_AMOUNT = 100_000_000;

/**
 * Payment pages embed their card fields from these providers (iframes) or send the buyer there: the card may be typed
 * into them as well as into the site the purchase was requested on. Subdomains count.
 */
export const PAYMENT_PROVIDER_HOSTS = [
  "stripe.com",
  "stripecdn.com",
  "adyen.com",
  "adyenpayments.com",
  "braintreegateway.com",
  "braintree-api.com",
  "paypal.com",
  "checkout.com",
  "paddle.com",
  "mollie.com",
  "shopifycs.com",
  "squarecdn.com",
  "squareup.com",
  "recurly.com",
  "chargebee.com",
  "fastspring.com",
  "lemonsqueezy.com",
  "2checkout.com",
  "authorize.net",
  "cybersource.com",
  "spreedly.com",
  "unzer.com",
  "pay1.de",
  "computop.com",
  "worldpay.com",
  "klarna.com",
];

/* ------------------------------------------------------------------ */
/* Normalization                                                        */
/* ------------------------------------------------------------------ */

function normalizeNumber(raw: string): string {
  const digits = cardDigits(raw ?? "");
  if (!/^\d{12,19}$/.test(digits) || !luhnValid(digits)) throw badRequest("That card number isn't valid. Check the digits.");
  return digits;
}

function normalizeExpiry(month: number | undefined, year: number | undefined): { month: number; year: number } {
  const m = Number(month);
  let y = Number(year);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw badRequest("Expiry month must be 1–12");
  if (Number.isInteger(y) && y >= 0 && y < 100) y += 2000;
  const thisYear = new Date().getFullYear();
  if (!Number.isInteger(y) || y < thisYear - 1 || y > thisYear + 30) throw badRequest("Expiry year looks wrong");
  return { month: m, year: y };
}

function normalizeCvc(raw: string): string {
  const cvc = raw.trim();
  if (!/^\d{3,4}$/.test(cvc)) throw badRequest("The security code has 3 or 4 digits");
  return cvc;
}

function normalizeCurrency(raw: string | undefined): string {
  const c = (raw ?? "EUR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw badRequest("Currency must be a 3-letter code like EUR");
  return c;
}

function normalizeAmount(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > MAX_AMOUNT) throw badRequest(`${label} must be a whole number of cents between 0 and ${MAX_AMOUNT}`);
  return value;
}

function normalizeBilling(b: CardBilling): CardBilling {
  const t = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const country = t(b.country, 2).toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw badRequest("Country must be a 2-letter code like DE");
  return { line1: t(b.line1, 200), line2: t(b.line2, 200), postalCode: t(b.postalCode, 20), city: t(b.city, 100), state: t(b.state, 100), country };
}

function normalizeSites(sites: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const s of sites ?? []) {
    const host = hostnameOf(s.trim().replace(/^\*\./, ""));
    if (host) out.add(host);
  }
  return [...out];
}

/** The agent_ids column: NULL = every agent that sees the card's workspace. */
function agentIdsColumn(ids: string[] | null | undefined): string | null {
  if (ids === null || ids === undefined) return null;
  const unique = [...new Set(ids)];
  for (const id of unique) {
    if (!get<{ id: string }>("SELECT id FROM agents WHERE id = ?", id)) throw notFound("Agent");
  }
  return JSON.stringify(unique);
}

/* ------------------------------------------------------------------ */
/* Spending                                                             */
/* ------------------------------------------------------------------ */

function monthStartIso(at = new Date()): string {
  return new Date(at.getFullYear(), at.getMonth(), 1).toISOString();
}

/** Lapse approvals nobody used, and take over the human's decisions on purchases that waited for one. */
function settleStale(): void {
  const ts = now();
  const waiting = all<{ id: string; created_at: string; q_status: string | null }>(
    `SELECT p.id, p.created_at, q.status AS q_status FROM card_purchases p LEFT JOIN questions q ON q.id = p.question_id
     WHERE p.status = 'pending'`,
  );
  let changed = false;
  for (const p of waiting) {
    let next: PurchaseStatus | null = null;
    if (p.q_status === "approved") next = "approved";
    else if (p.q_status === "declined") next = "declined";
    else if (p.q_status && p.q_status !== "open") next = "cancelled";
    else if (!p.q_status && Date.now() - Date.parse(p.created_at) > UNASKED_TTL_MS) next = "cancelled";
    if (!next) continue;
    run(
      "UPDATE card_purchases SET status = ?, approved_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      next,
      next === "approved" ? "human" : null,
      ts,
      p.id,
    );
    changed = true;
  }
  const lapsed = run(
    "UPDATE card_purchases SET status = 'expired', updated_at = ? WHERE status = 'approved' AND filled_at IS NULL AND updated_at < ?",
    ts,
    new Date(Date.now() - APPROVAL_TTL_MS).toISOString(),
  ).changes;
  if (changed || lapsed) bus.changed("payment-cards");
}

/**
 * What a card has committed this calendar month: purchases waiting, approved or paid since the 1st (and failures only
 * the agent reported after the card was typed in), plus renewals of subscriptions paid before that and not ended
 * (monthly ones every month, yearly ones in their month).
 */
function committedThisMonth(cardId: string, at = new Date()): number {
  const start = monthStartIso(at);
  const direct =
    get<{ s: number | null }>(
      `SELECT SUM(amount) AS s FROM card_purchases WHERE card_id = ? AND created_at >= ?
       AND (status IN ('pending', 'approved', 'paid') OR (status = 'failed' AND filled_at IS NOT NULL AND settled_by = 'agent'))`,
      cardId,
      start,
    )?.s ?? 0;
  let renewals = 0;
  for (const r of all<{ amount: number; recurrence: PurchaseRecurrence; created_at: string }>(
    "SELECT amount, recurrence, created_at FROM card_purchases WHERE card_id = ? AND status = 'paid' AND recurrence != 'once' AND ended_at IS NULL AND created_at < ?",
    cardId,
    start,
  )) {
    if (r.recurrence === "monthly" || new Date(r.created_at).getMonth() === at.getMonth()) renewals += r.amount;
  }
  return direct + renewals;
}

/* ------------------------------------------------------------------ */
/* Cards                                                                */
/* ------------------------------------------------------------------ */

function toModel(r: CardRow): PaymentCard {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    brand: r.brand as PaymentCard["brand"],
    last4: r.last4,
    expMonth: r.exp_month,
    expYear: r.exp_year,
    holderName: r.holder_name,
    hasCvc: !!r.cvc_enc,
    hasBilling: !!r.billing_enc,
    billingCountry: r.billing_country,
    currency: r.currency,
    limitPerPurchase: r.limit_per_purchase,
    limitMonthly: r.limit_monthly,
    askAbove: r.ask_above,
    agentIds: r.agent_ids === null ? null : parseJson<string[]>(r.agent_ids, []),
    allowedSites: parseJson<string[]>(r.allowed_sites, []),
    frozen: r.frozen === 1,
    spentThisMonth: committedThisMonth(r.id),
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function getRow(id: string): CardRow {
  const row = get<CardRow>("SELECT * FROM payment_cards WHERE id = ?", id);
  if (!row) throw notFound("Card");
  return row;
}

export function listCards(opts: { workspaceId?: ScopeFilter; search?: string } = {}): PaymentCard[] {
  settleStale();
  const scope = scopeCondition(opts.workspaceId);
  return all<CardRow>(`SELECT * FROM payment_cards WHERE ${scope.sql} ORDER BY name COLLATE NOCASE, created_at`, ...scope.params)
    .filter((r) => matchesSearch(opts.search, [r.name, r.last4, r.brand, r.holder_name]))
    .map(toModel);
}

export function getCard(id: string): PaymentCard {
  settleStale();
  return toModel(getRow(id));
}

/** The sealed details, for the human (the route audits it). Agents never get these. */
export function revealCard(id: string): PaymentCardSecrets {
  const row = getRow(id);
  if (!vault.isUnlocked()) throw locked();
  const billing = vault.openOptional(row.billing_enc, billingContext(row.id));
  return {
    number: vault.open(row.number_enc, numberContext(row.id)),
    cvc: vault.openOptional(row.cvc_enc, cvcContext(row.id)),
    billing: billing ? (JSON.parse(billing) as CardBilling) : null,
  };
}

export function createCard(input: PaymentCardInput): PaymentCard {
  if (!vault.isUnlocked()) throw locked();
  const number = normalizeNumber(input.number ?? "");
  const expiry = normalizeExpiry(input.expMonth, input.expYear);
  const workspaceId = input.workspaceId ?? null;
  assertWorkspace(workspaceId);
  const id = newId("card");
  const ts = now();
  const billing = input.billing ? normalizeBilling(input.billing) : null;
  const brand = cardBrand(number);
  insert("payment_cards", {
    id,
    workspace_id: workspaceId,
    name: (input.name ?? "").trim().slice(0, 100) || `${CARD_BRAND_LABELS[brand]} ${number.slice(-4)}`,
    brand,
    last4: number.slice(-4),
    exp_month: expiry.month,
    exp_year: expiry.year,
    holder_name: (input.holderName ?? "").trim().slice(0, 100),
    number_enc: vault.seal(number, numberContext(id)),
    cvc_enc: input.cvc ? vault.seal(normalizeCvc(input.cvc), cvcContext(id)) : null,
    billing_enc: billing ? vault.seal(JSON.stringify(billing), billingContext(id)) : null,
    billing_country: billing?.country ?? "",
    currency: normalizeCurrency(input.currency),
    limit_per_purchase: normalizeAmount(input.limitPerPurchase, "Limit per purchase"),
    limit_monthly: normalizeAmount(input.limitMonthly, "Monthly limit"),
    ask_above: input.askAbove === undefined ? 0 : normalizeAmount(input.askAbove, "Approval threshold"),
    agent_ids: agentIdsColumn(input.agentIds),
    allowed_sites: JSON.stringify(normalizeSites(input.allowedSites)),
    frozen: input.frozen ? 1 : 0,
    last_used_at: null,
    created_at: ts,
    updated_at: ts,
  });
  vault.rememberCardNumber(number);
  bus.changed("payment-cards");
  return getCard(id);
}

export function updateCard(id: string, input: Partial<PaymentCardInput>): PaymentCard {
  const row = getRow(id);
  const patch: Record<string, string | number | null> = { updated_at: now() };
  if (input.name !== undefined) patch.name = input.name.trim().slice(0, 100) || row.name;
  if (input.workspaceId !== undefined) {
    assertWorkspace(input.workspaceId);
    patch.workspace_id = input.workspaceId ?? null;
  }
  const sealed = input.number !== undefined || (input.cvc !== undefined && input.cvc !== "") || input.billing !== undefined;
  if (sealed && !vault.isUnlocked()) throw locked();
  let number: string | null = null;
  if (input.number !== undefined) {
    number = normalizeNumber(input.number);
    patch.number_enc = vault.seal(number, numberContext(id));
    patch.brand = cardBrand(number);
    patch.last4 = number.slice(-4);
  }
  if (input.expMonth !== undefined || input.expYear !== undefined) {
    const expiry = normalizeExpiry(input.expMonth ?? row.exp_month, input.expYear ?? row.exp_year);
    patch.exp_month = expiry.month;
    patch.exp_year = expiry.year;
  }
  if (input.holderName !== undefined) patch.holder_name = input.holderName.trim().slice(0, 100);
  if (input.cvc !== undefined) patch.cvc_enc = input.cvc === "" ? null : vault.seal(normalizeCvc(input.cvc), cvcContext(id));
  if (input.billing !== undefined) {
    const billing = input.billing ? normalizeBilling(input.billing) : null;
    patch.billing_enc = billing ? vault.seal(JSON.stringify(billing), billingContext(id)) : null;
    patch.billing_country = billing?.country ?? "";
  }
  if (input.currency !== undefined) patch.currency = normalizeCurrency(input.currency);
  if (input.limitPerPurchase !== undefined) patch.limit_per_purchase = normalizeAmount(input.limitPerPurchase, "Limit per purchase");
  if (input.limitMonthly !== undefined) patch.limit_monthly = normalizeAmount(input.limitMonthly, "Monthly limit");
  if (input.askAbove !== undefined) patch.ask_above = normalizeAmount(input.askAbove, "Approval threshold");
  if (input.agentIds !== undefined) patch.agent_ids = agentIdsColumn(input.agentIds);
  if (input.allowedSites !== undefined) patch.allowed_sites = JSON.stringify(normalizeSites(input.allowedSites));
  if (input.frozen !== undefined) patch.frozen = input.frozen ? 1 : 0;
  update("payment_cards", id, patch);
  if (number) vault.rememberCardNumber(number);
  bus.changed("payment-cards");
  return getCard(id);
}

export function deleteCard(id: string): void {
  getRow(id);
  run("DELETE FROM payment_cards WHERE id = ?", id);
  bus.changed("payment-cards");
}

/* ------------------------------------------------------------------ */
/* Agents                                                               */
/* ------------------------------------------------------------------ */

function agentMayUse(agent: Agent, r: Pick<CardRow, "workspace_id" | "agent_ids">): boolean {
  if (!inAgentScope(agent, r.workspace_id)) return false;
  const allowed = r.agent_ids === null ? null : parseJson<string[]>(r.agent_ids, []);
  return allowed === null || allowed.includes(agent.id);
}

/** Cards the agent may pay with (frozen ones included, so it can tell the human). No secrets. */
export function cardsForAgent(agent: Agent): PaymentCard[] {
  settleStale();
  const scope = agentScopeCondition(agent);
  return all<CardRow>(`SELECT * FROM payment_cards WHERE ${scope.sql} ORDER BY name COLLATE NOCASE, created_at`, ...scope.params)
    .filter((r) => agentMayUse(agent, r))
    .map(toModel);
}

export function hasCardsForAgent(agent: Agent): boolean {
  const scope = agentScopeCondition(agent);
  return all<Pick<CardRow, "workspace_id" | "agent_ids">>(`SELECT workspace_id, agent_ids FROM payment_cards WHERE ${scope.sql}`, ...scope.params).some((r) =>
    agentMayUse(agent, r),
  );
}

export interface PurchaseRequest {
  cardId: string;
  /** Minor units of the card's currency */
  amount: number;
  currency: string;
  merchant: string;
  description: string;
  recurrence: PurchaseRecurrence;
  /** Host of the checkout page */
  site: string;
  runId: string;
  conversationId: string;
}

/**
 * Check a purchase against the card and its limits and book it: `approved` right away when it stays at or below the
 * card's threshold, otherwise `pending` until the human decides (the caller asks and sets the question id).
 */
export function requestPurchase(agent: Agent, req: PurchaseRequest): { purchase: CardPurchase; card: PaymentCard; needsApproval: boolean } {
  settleStale();
  const row = getRow(req.cardId);
  if (!agentMayUse(agent, row)) throw forbidden("This card is not available to you.");
  const card = toModel(row);
  if (card.frozen) throw new HttpError(409, `"${card.name}" is frozen. The human has to unfreeze it in the vault before anything can be paid with it.`);
  if (cardExpired(card)) throw new HttpError(409, `"${card.name}" expired (${String(card.expMonth).padStart(2, "0")}/${card.expYear}). Ask the human to update it.`);
  if (!vault.isUnlocked()) throw locked();
  if (!Number.isInteger(req.amount) || req.amount <= 0 || req.amount > MAX_AMOUNT) throw badRequest("The amount must be more than 0.");
  if (req.currency.toUpperCase() !== card.currency) {
    throw badRequest(
      `This card's limits are in ${card.currency}. Convert the price to ${card.currency} (round up and add about 3% for exchange fees), pass that with currency "${card.currency}" and put the original price in the description.`,
    );
  }
  const site = hostnameOf(req.site);
  if (!site) throw badRequest("Open the checkout page in the browser first: the card is bound to the site it is used on.");
  if (card.allowedSites.length && !card.allowedSites.some((d) => domainMatches(site, d))) {
    throw forbidden(`"${card.name}" may only be used on ${card.allowedSites.join(", ")} — not on ${site}.`);
  }
  if (card.limitPerPurchase !== null && req.amount > card.limitPerPurchase) {
    throw forbidden(`${formatMoney(req.amount, card.currency)} is above the card's limit of ${formatMoney(card.limitPerPurchase, card.currency)} per purchase. Ask the human to raise it or to pay this one themselves.`);
  }
  if (card.limitMonthly !== null && card.spentThisMonth + req.amount > card.limitMonthly) {
    throw forbidden(
      `${formatMoney(req.amount, card.currency)} doesn't fit the card's monthly limit: ${formatMoney(card.spentThisMonth, card.currency)} of ${formatMoney(card.limitMonthly, card.currency)} is already committed this month. Ask the human to raise it or to pay this one themselves.`,
    );
  }
  const needsApproval = card.askAbove !== null && req.amount > card.askAbove;
  const id = newId("pur");
  const ts = now();
  insert("card_purchases", {
    id,
    card_id: card.id,
    agent_id: agent.id,
    run_id: req.runId,
    conversation_id: req.conversationId,
    question_id: null,
    amount: req.amount,
    currency: card.currency,
    merchant: req.merchant.trim().slice(0, 200),
    description: req.description.trim().slice(0, 1000),
    site,
    recurrence: req.recurrence,
    status: needsApproval ? "pending" : "approved",
    approved_by: needsApproval ? null : "limit",
    filled_at: null,
    settled_at: null,
    settled_by: null,
    ended_at: null,
    note: "",
    created_at: ts,
    updated_at: ts,
  });
  bus.changed("payment-cards");
  return { purchase: getPurchase(id), card: getCard(card.id), needsApproval };
}

/** The question the human answers for a pending purchase. */
export function attachQuestion(purchaseId: string, questionId: string): void {
  run("UPDATE card_purchases SET question_id = ? WHERE id = ?", questionId, purchaseId);
}

/** Drop a purchase that never got its question (asking was refused). */
export function dropPurchase(purchaseId: string): void {
  run("DELETE FROM card_purchases WHERE id = ? AND status = 'pending'", purchaseId);
  bus.changed("payment-cards");
}

/**
 * What Godmode types for a purchase the agent may complete now: its own, from the same chat, approved. Throws with a
 * message for the agent otherwise.
 */
export function purchaseForFill(agent: Agent, purchaseId: string, conversationId: string): { purchase: CardPurchase; row: CardRow } {
  settleStale();
  const p = get<PurchaseRow>("SELECT * FROM card_purchases WHERE id = ?", purchaseId);
  if (!p || p.agent_id !== agent.id || p.conversation_id !== conversationId) throw notFound("Purchase");
  const row = getRow(p.card_id);
  if (!agentMayUse(agent, row)) throw forbidden("This card is no longer available to you.");
  if (row.frozen) throw new HttpError(409, `"${row.name}" was frozen. Don't pay; tell the human.`);
  const refusals: Partial<Record<PurchaseStatus, string>> = {
    pending: "This purchase still waits for the human's OK.",
    declined: "The human declined this purchase. Don't buy it.",
    cancelled: "This purchase was withdrawn. Ask again with vault_card_purchase if it is still needed.",
    expired: "The approval lapsed (a day passed without using it). Ask again with vault_card_purchase.",
    paid: "This purchase is already paid.",
    failed: "This purchase was reported as failed. Ask again with vault_card_purchase to retry.",
  };
  const refusal = refusals[p.status];
  if (refusal) throw new HttpError(409, refusal);
  if (!vault.isUnlocked()) throw locked();
  return { purchase: toPurchase(p), row };
}

/** The value of one checkout field, for Godmode to type. Never hand it to the model. */
export function cardFieldValue(row: CardRow, field: CardField): string | null {
  const mm = String(row.exp_month).padStart(2, "0");
  switch (field) {
    case "number":
      return vault.open(row.number_enc, numberContext(row.id));
    case "cvc":
      return vault.openOptional(row.cvc_enc, cvcContext(row.id));
    case "expiry":
      return `${mm}/${row.exp_year}`;
    case "exp_month":
      return mm;
    case "exp_year":
      return String(row.exp_year);
    case "name":
      return row.holder_name || null;
  }
  const raw = vault.openOptional(row.billing_enc, billingContext(row.id));
  if (!raw) return null;
  const billing = JSON.parse(raw) as CardBilling;
  const value = { address_line1: billing.line1, address_line2: billing.line2, postal_code: billing.postalCode, city: billing.city, state: billing.state }[field];
  return value || null;
}

export const CARD_FIELDS = ["number", "expiry", "exp_month", "exp_year", "cvc", "name", "address_line1", "address_line2", "postal_code", "city", "state"] as const;
export type CardField = (typeof CARD_FIELDS)[number];

/** Hosts a purchase's card may be typed on: its checkout site and the payment providers. */
export function cardFillHosts(purchase: Pick<CardPurchase, "site">): string[] {
  return [purchase.site, ...PAYMENT_PROVIDER_HOSTS];
}

export function markFilled(purchaseId: string, cardId: string): void {
  const ts = now();
  run("UPDATE card_purchases SET filled_at = COALESCE(filled_at, ?), updated_at = ? WHERE id = ?", ts, ts, purchaseId);
  run("UPDATE payment_cards SET last_used_at = ? WHERE id = ?", ts, cardId);
  bus.changed("payment-cards");
}

/** The agent reports how the payment went. A final amount replaces the approved one (the caller tells the human if it is higher). */
export function settlePurchase(
  agent: Agent,
  purchaseId: string,
  outcome: "paid" | "failed",
  opts: { amount?: number; note?: string } = {},
): CardPurchase {
  const p = get<PurchaseRow>("SELECT * FROM card_purchases WHERE id = ?", purchaseId);
  if (!p || p.agent_id !== agent.id) throw notFound("Purchase");
  if (p.status !== "approved") throw new HttpError(409, `This purchase is ${p.status}; only an approved one can be reported.`);
  if (opts.amount !== undefined && (!Number.isInteger(opts.amount) || opts.amount < 0 || opts.amount > MAX_AMOUNT)) throw badRequest("The amount must be a positive number.");
  const ts = now();
  run(
    "UPDATE card_purchases SET status = ?, amount = ?, note = ?, settled_at = ?, settled_by = 'agent', updated_at = ? WHERE id = ?",
    outcome,
    outcome === "paid" && opts.amount !== undefined ? opts.amount : p.amount,
    (opts.note ?? "").trim().slice(0, 500),
    ts,
    ts,
    purchaseId,
  );
  bus.changed("payment-cards");
  return getPurchase(purchaseId);
}

/* ------------------------------------------------------------------ */
/* Purchases                                                            */
/* ------------------------------------------------------------------ */

function toPurchase(r: PurchaseRow): CardPurchase {
  return {
    id: r.id,
    cardId: r.card_id,
    agentId: r.agent_id,
    conversationId: r.conversation_id,
    amount: r.amount,
    currency: r.currency,
    merchant: r.merchant,
    description: r.description,
    site: r.site,
    recurrence: r.recurrence,
    status: r.status,
    questionId: r.question_id,
    approvedBy: r.approved_by,
    filledAt: r.filled_at,
    settledAt: r.settled_at,
    settledBy: r.settled_by,
    endedAt: r.ended_at,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getPurchase(id: string): CardPurchase {
  const r = get<PurchaseRow>("SELECT * FROM card_purchases WHERE id = ?", id);
  if (!r) throw notFound("Purchase");
  return toPurchase(r);
}

export function listPurchases(opts: { cardId?: string; limit?: number } = {}): CardPurchase[] {
  settleStale();
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 500);
  const rows = opts.cardId
    ? all<PurchaseRow>(`SELECT * FROM card_purchases WHERE card_id = ? ORDER BY created_at DESC LIMIT ${limit}`, opts.cardId)
    : all<PurchaseRow>(`SELECT * FROM card_purchases ORDER BY created_at DESC LIMIT ${limit}`);
  return rows.map(toPurchase);
}

/** The human corrects a purchase: paid or not after all, or a subscription ended (no longer counts toward later months). */
export function updatePurchase(id: string, patch: CardPurchasePatch): CardPurchase {
  const p = get<PurchaseRow>("SELECT * FROM card_purchases WHERE id = ?", id);
  if (!p) throw notFound("Purchase");
  const ts = now();
  tx(() => {
    if (patch.status) {
      if (!["approved", "paid", "failed"].includes(p.status)) throw badRequest(`A ${p.status} purchase can't be marked as ${patch.status}.`);
      run("UPDATE card_purchases SET status = ?, settled_at = ?, settled_by = 'human', updated_at = ? WHERE id = ?", patch.status, ts, ts, id);
    }
    if (patch.ended !== undefined) {
      if (p.recurrence === "once") throw badRequest("Only a subscription can end.");
      run("UPDATE card_purchases SET ended_at = ?, updated_at = ? WHERE id = ?", patch.ended ? ts : null, ts, id);
    }
  });
  bus.changed("payment-cards");
  return getPurchase(id);
}

/**
 * Whether a change lets agents spend more or elsewhere with the card: higher or removed limits, fewer approvals, more
 * agents, sites or workspaces, unfreezing, another currency. Those need the vault passphrase (routes/cards.ts).
 */
export function widensSpending(card: PaymentCard, input: Partial<PaymentCardInput>): boolean {
  const looser = (next: number | null | undefined, prev: number | null) => next !== undefined && prev !== null && (next === null || next > prev);
  if (looser(input.limitPerPurchase, card.limitPerPurchase) || looser(input.limitMonthly, card.limitMonthly) || looser(input.askAbove, card.askAbove)) return true;
  if (input.workspaceId !== undefined && (input.workspaceId ?? null) !== card.workspaceId) return true;
  if (input.currency !== undefined && input.currency.trim().toUpperCase() !== card.currency) return true;
  if (input.frozen === false && card.frozen) return true;
  if (input.agentIds !== undefined && card.agentIds !== null && (input.agentIds === null || input.agentIds.some((id) => !card.agentIds!.includes(id)))) return true;
  if (input.allowedSites !== undefined && card.allowedSites.length > 0) {
    const next = normalizeSites(input.allowedSites);
    if (next.length === 0 || next.some((s) => !card.allowedSites.includes(s))) return true;
  }
  return false;
}
