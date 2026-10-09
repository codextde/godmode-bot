import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, CardPurchase, PaymentCard } from "@godmode/shared";
import { fills, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import * as vault from "../src/vault/vault";
import { maskCardNumbers } from "../src/vault/cardMask";
import { attachQuestion, createCard, getCard, listPurchases, requestPurchase, revealCard, updateCard, widensSpending } from "../src/vault/cards";
import { createConversation } from "../src/services/conversations";
import { issueRunToken, revokeRunToken } from "../src/mcp/tokens";
import { listNotifications } from "../src/services/notifications";
import { getAccessToken } from "../src/server/auth";
import { all, get, insert, run } from "../src/db";

const PASSPHRASE = "correct horse battery staple";
const VISA = "4242424242424242";
const AMEX = "378282246310005";

let env: TestEnv;
let buyer: Agent;
let other: Agent;
let buyerChat: string;
const tokens: string[] = [];

function tokenFor(agent: Agent, conversationId: string): string {
  const t = issueRunToken({ runId: `run_cards_${agent.slug}_${tokens.length}`, agentId: agent.id, conversationId, workspaceId: agent.workspaceId, depth: 0 });
  tokens.push(t);
  return t;
}

async function rpc(token: string, method: string, params?: unknown) {
  const res = await fetch(`${env.baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  const text = await res.text();
  const data = text.startsWith("event:") || text.includes("\ndata: ") ? text.split("\n").find((l) => l.startsWith("data: "))!.slice(6) : text;
  return JSON.parse(data);
}

async function call(token: string, name: string, args: unknown = {}) {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  return res.result as { content: { text: string }[]; isError?: boolean };
}

async function toolNames(token: string): Promise<string[]> {
  const res = await rpc(token, "tools/list");
  return (res.result.tools as { name: string }[]).map((t) => t.name);
}

async function api<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${getAccessToken()}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

async function grant(): Promise<Record<string, string>> {
  const res = await api<{ grant: string }>("POST", "/api/vault/grant", { passphrase: PASSPHRASE });
  return { "x-godmode-grant": res.data.grant };
}

const purchaseIdOf = (text: string) => /(pur_[A-Za-z0-9]+)/.exec(text)![1]!;

beforeAll(async () => {
  env = await setupEnv("godmode-cards-");
  await vault.setup(PASSPHRASE, false);
  buyer = await makeAgent({ name: "Buyer", browser: { enabled: true } });
  other = await makeAgent({ name: "Other", browser: { enabled: true } });
  buyerChat = createConversation({ agentId: buyer.id }).id;
});

afterAll(async () => {
  for (const t of tokens) revokeRunToken(t);
  await env.close();
});

describe("cards in the vault", () => {
  test("validates the number and expiry and keeps the details sealed", () => {
    expect(() => createCard({ name: "Bad", number: "4242424242424241", expMonth: 8, expYear: 2030 })).toThrow("isn't valid");
    expect(() => createCard({ name: "Bad", number: VISA, expMonth: 13, expYear: 2030 })).toThrow("month");
    const card = createCard({
      name: "Team Visa",
      number: "4242 4242 4242 4242",
      expMonth: 8,
      expYear: 30,
      cvc: "123",
      holderName: "Ada Lovelace",
      billing: { line1: "Hauptstr. 1", line2: "", postalCode: "74549", city: "Wolpertshausen", state: "", country: "de" },
    });
    expect(card).toMatchObject({ brand: "visa", last4: "4242", expYear: 2030, hasCvc: true, hasBilling: true, billingCountry: "DE", askAbove: 0, agentIds: null });
    expect(JSON.stringify(card)).not.toContain(VISA);
    const row = get<Record<string, unknown>>("SELECT * FROM payment_cards WHERE id = ?", card.id)!;
    expect(JSON.stringify(row)).not.toContain(VISA);
    expect(JSON.stringify(row)).not.toContain("Hauptstr");
    expect(revealCard(card.id)).toEqual({
      number: VISA,
      cvc: "123",
      billing: { line1: "Hauptstr. 1", line2: "", postalCode: "74549", city: "Wolpertshausen", state: "", country: "DE" },
    });
  });

  test("masks saved numbers in transcripts, pushes and what agents read from the browser", () => {
    createCard({ name: "Amex", number: AMEX, expMonth: 1, expYear: 2031 });
    expect(vault.redact(`paid with 4242 4242 4242 4242 and ${AMEX}`)).not.toMatch(/4242 4242|378282/);
    expect(vault.withoutSecrets(`const n = "${AMEX}";`)).not.toContain(AMEX);
    expect(maskCardNumbers(`{"value":"4242-4242-4242-4242","other":"3782 822463 10005"}`)).toBe(`{"value":"•••• 4242","other":"•••• 0005"}`);
  });

  test("knows which changes loosen a card", () => {
    const card = { limitPerPurchase: 5000, limitMonthly: 20000, askAbove: 0, workspaceId: null, currency: "EUR", frozen: true, agentIds: ["a"], allowedSites: ["openai.com"] } as PaymentCard;
    expect(widensSpending(card, { limitPerPurchase: 4000, limitMonthly: 10000, askAbove: 0, frozen: true, name: "x" } as never)).toBe(false);
    expect(widensSpending(card, { agentIds: [], allowedSites: ["openai.com"] })).toBe(false);
    expect(widensSpending(card, { limitPerPurchase: 6000 })).toBe(true);
    expect(widensSpending(card, { limitMonthly: null })).toBe(true);
    expect(widensSpending(card, { askAbove: null })).toBe(true);
    expect(widensSpending(card, { askAbove: 1000 })).toBe(true);
    expect(widensSpending(card, { frozen: false })).toBe(true);
    expect(widensSpending(card, { agentIds: null })).toBe(true);
    expect(widensSpending(card, { agentIds: ["a", "b"] })).toBe(true);
    expect(widensSpending(card, { allowedSites: [] })).toBe(true);
    expect(widensSpending(card, { workspaceId: "ws_x" })).toBe(true);
    expect(widensSpending(card, { currency: "usd" })).toBe(true);
  });
});

describe("paying as an agent", () => {
  let card: PaymentCard;
  let token: string;

  beforeAll(() => {
    card = createCard({
      name: "Buyer card",
      number: "5555555555554444",
      expMonth: 12,
      expYear: 2032,
      cvc: "987",
      holderName: "Ada Lovelace",
      limitPerPurchase: 5000,
      limitMonthly: 7000,
      askAbove: null,
      agentIds: [buyer.id],
    });
    // The earlier cards are for every agent: keep this suite to one.
    for (const { id } of all<{ id: string }>("SELECT id FROM payment_cards WHERE id != ?", card.id)) updateCard(id, { agentIds: [other.id] });
    token = tokenFor(buyer, buyerChat);
  });

  test("card tools are only there for agents with a card", async () => {
    const lonely = await makeAgent({ name: "No card", browser: { enabled: true } });
    expect(await toolNames(tokenFor(lonely, createConversation({ agentId: lonely.id }).id))).not.toContain("vault_card_purchase");
    expect(await toolNames(token)).toEqual(expect.arrayContaining(["vault_list_cards", "vault_card_purchase", "vault_fill_card", "vault_card_purchase_result"]));
  });

  test("lists its card without any secret", async () => {
    const r = await call(token, "vault_list_cards");
    const text = r.content[0]!.text;
    expect(text).toContain("Mastercard •••• 4444");
    expect(text).toContain("EUR 50.00");
    expect(text).not.toContain("5555555555554444");
    expect(text).not.toContain("987");
    expect(text).not.toContain("Ada Lovelace");
  });

  test("buys within the limits and Godmode types the card on the checkout site only", async () => {
    const r = await call(token, "vault_card_purchase", { cardId: card.id, amount: 29.99, currency: "eur", merchant: "Acme · Pro plan", description: "The task needs the Pro API.", recurrence: "monthly" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("approved within the limits");
    const purchaseId = purchaseIdOf(r.content[0]!.text);

    const before = fills.length;
    for (const field of ["number", "expiry", "cvc", "name"]) {
      const f = await call(token, "vault_fill_card", { purchaseId, field });
      expect(f.isError).toBeUndefined();
      expect(f.content[0]!.text).not.toMatch(/5555|987|Lovelace/);
    }
    const typed = fills.slice(before);
    expect(typed.map((f) => [f.kind, f.text])).toEqual([
      ["cc-number", "5555555555554444"],
      ["cc-exp", "12/2032"],
      ["cc-csc", "987"],
      ["cc-name", "Ada Lovelace"],
    ]);
    expect(typed[0]!.allowedHosts).toContain("app.example.com");
    expect(typed[0]!.allowedHosts).toContain("stripe.com");
    expect(typed[0]!.submit).toBeUndefined();
    expect(listNotifications().some((n) => n.title.includes("is paying EUR 29.99"))).toBe(true);

    const missing = await call(token, "vault_fill_card", { purchaseId, field: "postal_code" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("no billing postal code");

    const done = await call(token, "vault_card_purchase_result", { purchaseId, outcome: "paid", note: "Invoice 42" });
    expect(done.content[0]!.text).toContain("Recorded");
    expect(getCard(card.id).spentThisMonth).toBe(2999);
    const again = await call(token, "vault_fill_card", { purchaseId, field: "number" });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toContain("already paid");
  });

  test("refuses what breaks the card's rules", async () => {
    const perPurchase = await call(token, "vault_card_purchase", { cardId: card.id, amount: 60, currency: "EUR", merchant: "Big", description: "x" });
    expect(perPurchase.isError).toBe(true);
    expect(perPurchase.content[0]!.text).toContain("limit of EUR 50.00 per purchase");
    const monthly = await call(token, "vault_card_purchase", { cardId: card.id, amount: 50, currency: "EUR", merchant: "Big", description: "x" });
    expect(monthly.isError).toBe(true);
    expect(monthly.content[0]!.text).toContain("monthly limit");
    const currency = await call(token, "vault_card_purchase", { cardId: card.id, amount: 5, currency: "USD", merchant: "Small", description: "x" });
    expect(currency.isError).toBe(true);
    expect(currency.content[0]!.text).toContain("Convert the price to EUR");

    const stranger = await call(tokenFor(other, createConversation({ agentId: other.id }).id), "vault_card_purchase", {
      cardId: card.id,
      amount: 5,
      currency: "EUR",
      merchant: "Small",
      description: "x",
    });
    expect(stranger.isError).toBe(true);

    updateCard(card.id, { frozen: true });
    const frozen = await call(token, "vault_card_purchase", { cardId: card.id, amount: 5, currency: "EUR", merchant: "Small", description: "x" });
    expect(frozen.isError).toBe(true);
    expect(frozen.content[0]!.text).toContain("frozen");
    updateCard(card.id, { frozen: false });
  });

  test("a run that can't ask doesn't get to buy above the threshold", async () => {
    updateCard(card.id, { askAbove: 1000 });
    const before = listPurchases({ cardId: card.id }).length;
    const r = await call(token, "vault_card_purchase", { cardId: card.id, amount: 20, currency: "EUR", merchant: "Mid", description: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("needs the human's OK");
    expect(listPurchases({ cardId: card.id }).length).toBe(before);
    updateCard(card.id, { askAbove: null });
  });

  test("a failure reported after typing the card keeps counting until the human confirms it", async () => {
    const r = await call(token, "vault_card_purchase", { cardId: card.id, amount: 10, currency: "EUR", merchant: "Flaky", description: "x" });
    const purchaseId = purchaseIdOf(r.content[0]!.text);
    await call(token, "vault_fill_card", { purchaseId, field: "number" });
    const failed = await call(token, "vault_card_purchase_result", { purchaseId, outcome: "failed" });
    expect(failed.content[0]!.text).toContain("keeps counting");
    expect(getCard(card.id).spentThisMonth).toBe(3999);

    const noGrant = await api("PATCH", `/api/card-purchases/${purchaseId}`, { status: "failed" });
    expect(noGrant.status).toBe(403);
    const confirmed = await api<CardPurchase>("PATCH", `/api/card-purchases/${purchaseId}`, { status: "failed" }, await grant());
    expect(confirmed.status).toBe(200);
    expect(confirmed.data.settledBy).toBe("human");
    expect(getCard(card.id).spentThisMonth).toBe(2999);
  });

  test("subscriptions count again every month until they end", () => {
    const lastMonth = new Date();
    lastMonth.setDate(1);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const ts = lastMonth.toISOString();
    const base = { card_id: card.id, agent_id: buyer.id, run_id: null, conversation_id: null, question_id: null, currency: "EUR", merchant: "Sub", description: "", site: "x.com", status: "paid", approved_by: "limit", filled_at: ts, settled_at: ts, settled_by: "agent", ended_at: null, note: "", created_at: ts, updated_at: ts };
    insert("card_purchases", { ...base, id: "pur_sub_monthly", amount: 700, recurrence: "monthly" });
    insert("card_purchases", { ...base, id: "pur_sub_once", amount: 900, recurrence: "once" });
    expect(getCard(card.id).spentThisMonth).toBe(2999 + 700);
    run("UPDATE card_purchases SET ended_at = ? WHERE id = 'pur_sub_monthly'", ts);
    expect(getCard(card.id).spentThisMonth).toBe(2999);
  });
});

describe("approval by the human", () => {
  test("a purchase above the threshold waits, then follows the human's decision", () => {
    const card = createCard({ name: "Approval card", number: "4000056655665556", expMonth: 3, expYear: 2033, askAbove: 0, agentIds: [buyer.id] });
    const conversationId = createConversation({ agentId: buyer.id }).id;
    const ask = (status: string) => {
      const { purchase, needsApproval } = requestPurchase(buyer, {
        cardId: card.id,
        amount: 1500,
        currency: "EUR",
        merchant: "Acme",
        description: "x",
        recurrence: "once",
        site: "acme.com",
        runId: "run_x",
        conversationId,
      });
      expect(needsApproval).toBe(true);
      expect(purchase.status).toBe("pending");
      const qid = `qst_${status}_${purchase.id}`;
      const ts = new Date().toISOString();
      insert("questions", { id: qid, kind: "approval", agent_id: buyer.id, run_id: "run_x", conversation_id: conversationId, message_id: "msg_x", title: "Pay", status, created_at: ts, updated_at: ts });
      attachQuestion(purchase.id, qid);
      return purchase.id;
    };
    const approved = ask("approved");
    const declined = ask("declined");
    const byId = new Map(listPurchases({ cardId: card.id }).map((p) => [p.id, p]));
    expect(byId.get(approved)).toMatchObject({ status: "approved", approvedBy: "human" });
    expect(byId.get(declined)?.status).toBe("declined");
    expect(getCard(card.id).spentThisMonth).toBe(1500);
  });
});

describe("routes", () => {
  test("loosening a card needs the vault passphrase, tightening doesn't", async () => {
    const created = await api<PaymentCard>("POST", "/api/cards", { name: "Route card", number: "6011111111111117", expMonth: 5, expYear: 2031, limitPerPurchase: 2000 });
    expect(created.status).toBe(200);
    expect(created.data.brand).toBe("discover");
    const id = created.data.id;
    expect((await api("PATCH", `/api/cards/${id}`, { limitPerPurchase: 1000, frozen: true })).status).toBe(200);
    const unfreeze = await api<{ code: string }>("PATCH", `/api/cards/${id}`, { frozen: false });
    expect(unfreeze.status).toBe(403);
    expect(unfreeze.data.code).toBe("grant_required");
    expect((await api("PATCH", `/api/cards/${id}`, { limitPerPurchase: 9000 })).status).toBe(403);
    const loosened = await api<PaymentCard>("PATCH", `/api/cards/${id}`, { frozen: false, limitPerPurchase: 9000 }, await grant());
    expect(loosened.status).toBe(200);
    expect(loosened.data).toMatchObject({ frozen: false, limitPerPurchase: 9000 });
    expect((await api("POST", `/api/cards/${id}/reveal`, {})).status).toBe(403);
    const revealed = await api<{ number: string }>("POST", `/api/cards/${id}/reveal`, {}, await grant());
    expect(revealed.data.number).toBe("6011111111111117");
    const list = await api<PaymentCard[]>("GET", "/api/cards");
    expect(JSON.stringify(list.data)).not.toContain("6011111111111117");
    expect((await api("DELETE", `/api/cards/${id}`)).status).toBe(200);
  });
});
