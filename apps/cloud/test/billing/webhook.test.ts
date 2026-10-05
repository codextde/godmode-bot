import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { POST } from "@/app/api/stripe/webhook/route";
import { setStripeClientForTests } from "@/server/billing/stripe";
import { handleStripeWebhook, subscriptionIdOf } from "@/server/billing/webhook";
import { auditLog, db, stripeEvents, subscriptions, users } from "@/server/db";
import { SYSTEM } from "@/server/audit";
import { writeSettings } from "@/server/settings";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import {
  connectStripe,
  createUser,
  event,
  fakeStripe,
  freePlan,
  missing,
  paidPlan,
  recordingHub,
  seedRoles,
  signed,
  stripeSubscription,
  type FakeStripe,
} from "./helpers";

let stripe: FakeStripe;
let notices: ReturnType<typeof recordingHub>["notices"];

beforeAll(resetDatabase);
afterAll(async () => {
  setStripeClientForTests(null);
  await closeDatabase();
});
beforeEach(async () => {
  await truncateAll();
  await seedRoles();
  notices = recordingHub().notices;
  stripe = fakeStripe();
  stripe.install();
});

async function setup() {
  await connectStripe();
  await freePlan();
  const { plan, price } = await paidPlan();
  const user = await createUser("payer@example.com", "member", { stripeCustomerId: "cus_payer" });
  const sub = stripeSubscription({ customer: "cus_payer", price: price.stripePriceId!, metadata: { product: "godmode_cloud", user_id: user.id } });
  stripe.subscriptions.set(sub.id, sub);
  return { plan, price, user, sub };
}

async function deliver(payload: unknown) {
  const { body, signature } = signed(payload);
  return handleStripeWebhook(body, signature);
}

describe("verification", () => {
  test("503 without a stored webhook secret, even with a valid signature", async () => {
    await connectStripe({ webhook: false });
    const { body, signature } = signed(event("customer.subscription.updated", { id: "sub_x" }));
    expect(await handleStripeWebhook(body, signature)).toMatchObject({ status: 503, body: { code: "not_configured" } });
  });

  test("400 for a missing, wrong or tampered signature", async () => {
    await setup();
    const payload = event("customer.subscription.updated", { id: "sub_x" });
    const { body, signature } = signed(payload);
    expect((await handleStripeWebhook(body, null)).status).toBe(400);
    expect((await handleStripeWebhook(body, signed(payload, "whsec_someone_else").signature)).status).toBe(400);
    expect((await handleStripeWebhook(body.replace("sub_x", "sub_y"), signature)).status).toBe(400);
    expect((await handleStripeWebhook(body, "t=1,v1=deadbeef")).status).toBe(400);
    expect(stripe.calls).toHaveLength(0);
    expect(await db.select().from(stripeEvents)).toEqual([]);
  });

  test("503 when the key is gone, so Stripe retries later", async () => {
    await setup();
    await writeSettings("billing", { stripeSecretKey: null }, SYSTEM);
    expect((await deliver(event("customer.subscription.updated", { id: "sub_x" }))).status).toBe(503);
    expect(await db.select().from(stripeEvents)).toEqual([]);
  });
});

describe("subscription events", () => {
  test("upserts from the re-fetched subscription, never from the payload, and records the event", async () => {
    const { user, plan, price, sub } = await setup();
    // The payload is stale and shaped by another API version; only its id matters.
    const payload = event("customer.subscription.updated", { id: sub.id, status: "incomplete", current_period_end: 1, metadata: {} });
    expect(await deliver(payload)).toEqual({ status: 200, body: { received: true, ignored: false } });
    expect(stripe.callsOf("subscriptions.retrieve").map((c) => c.args[0])).toEqual([sub.id]);

    const [row] = await db.select().from(subscriptions);
    const item = sub.items.data[0]!;
    expect(row).toMatchObject({
      userId: user.id,
      planId: plan.id,
      priceId: price.id,
      status: "active",
      currentPeriodStart: new Date(item.current_period_start * 1000),
      currentPeriodEnd: new Date(item.current_period_end * 1000),
    });
    expect(await db.select({ id: stripeEvents.id, type: stripeEvents.type }).from(stripeEvents)).toEqual([{ id: payload.id, type: payload.type }]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "billing.webhook"));
    expect(entry).toMatchObject({ actor: "stripe", targetId: user.id, meta: { event: "customer.subscription.updated", subscription: sub.id, status: "active" } });
    expect(notices.map((n) => n.notice.type)).toEqual(["plan", "billing"]);

    // A later change in Stripe arrives as another event and updates the same row.
    stripe.subscriptions.set(sub.id, { ...sub, status: "past_due" } as Stripe.Subscription);
    await deliver(event("customer.subscription.updated", { id: sub.id }));
    expect((await db.select().from(subscriptions)).map((r) => r.status)).toEqual(["past_due"]);
  });

  test("a redelivered event is acknowledged and does nothing", async () => {
    const { sub } = await setup();
    const payload = event("customer.subscription.created", { id: sub.id });
    await deliver(payload);
    expect(await deliver(payload)).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(stripe.callsOf("subscriptions.retrieve")).toHaveLength(1);
  });

  test("a failure answers 500 and is not recorded, so the retry is handled", async () => {
    const { sub } = await setup();
    const payload = event("customer.subscription.updated", { id: sub.id });
    stripe.fail.set("subscriptions.retrieve", new Stripe.errors.StripeAPIError({ message: "Stripe is down" }));
    expect((await deliver(payload)).status).toBe(500);
    expect(await db.select().from(stripeEvents)).toEqual([]);
    stripe.fail.delete("subscriptions.retrieve");
    expect((await deliver(payload)).status).toBe(200);
    expect(await db.select().from(subscriptions)).toHaveLength(1);
  });

  test("subscriptions of other products on the account are ignored", async () => {
    const { price } = await setup();
    const foreign = stripeSubscription({ customer: "cus_payer", price: price.stripePriceId!, metadata: { license_key: "GM-XXXX" } });
    stripe.subscriptions.set(foreign.id, foreign);
    // Even when the event object itself claims to be ours.
    const payload = event("customer.subscription.updated", { id: foreign.id, metadata: { product: "godmode_cloud" } });
    expect(await deliver(payload)).toEqual({ status: 200, body: { received: true, ignored: true } });
    expect(await db.select().from(subscriptions)).toEqual([]);
    expect(await db.select().from(stripeEvents)).toHaveLength(1);
  });

  test("a customer that belongs to no account is ignored, whatever metadata.user_id says", async () => {
    const { user, price } = await setup();
    const forged = stripeSubscription({ customer: "cus_attacker", price: price.stripePriceId!, metadata: { product: "godmode_cloud", user_id: user.id } });
    stripe.subscriptions.set(forged.id, forged);
    expect(await deliver(event("customer.subscription.created", { id: forged.id }))).toEqual({ status: 200, body: { received: true, ignored: true } });
    expect(await db.select().from(subscriptions)).toEqual([]);
  });

  test("an event for a deleted account is acknowledged and recorded", async () => {
    const { user, sub } = await setup();
    await db.delete(users).where(eq(users.id, user.id));
    const payload = event("customer.subscription.deleted", { id: sub.id });
    expect(await deliver(payload)).toEqual({ status: 200, body: { received: true, ignored: true } });
    expect(await db.select().from(stripeEvents)).toHaveLength(1);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "billing.webhook"));
    expect(entry).toMatchObject({ targetId: user.id, meta: { ignored: "The account no longer exists." } });
  });

  test("a price we do not sell is stored with planId null", async () => {
    const { user } = await setup();
    const odd = stripeSubscription({ customer: "cus_payer", price: "price_unknown", amount: 4200, metadata: { product: "godmode_cloud", user_id: user.id } });
    stripe.subscriptions.set(odd.id, odd);
    await deliver(event("customer.subscription.created", { id: odd.id }));
    expect(await db.select().from(subscriptions)).toEqual([expect.objectContaining({ planId: null, priceId: null, amount: 4200 })]);
  });

  test("a subscription Stripe no longer has is acknowledged", async () => {
    await setup();
    stripe.fail.set("subscriptions.retrieve", missing("subscription"));
    expect(await deliver(event("customer.subscription.deleted", { id: "sub_gone" }))).toMatchObject({ status: 200 });
    expect(await db.select().from(stripeEvents)).toHaveLength(1);
  });
});

describe("other event types", () => {
  test("checkout and invoice events find the subscription; others are recorded and ignored", async () => {
    const { sub } = await setup();
    await deliver(event("checkout.session.completed", { id: "cs_1", mode: "subscription", subscription: sub.id }));
    await deliver(event("invoice.paid", { id: "in_1", parent: { type: "subscription_details", subscription_details: { subscription: sub.id } } }));
    // An endpoint on an older API version sends the subscription on the invoice itself.
    await deliver(event("invoice.payment_failed", { id: "in_2", subscription: sub.id }));
    expect(stripe.callsOf("subscriptions.retrieve").map((c) => c.args[0])).toEqual([sub.id, sub.id, sub.id]);

    expect(await deliver(event("checkout.session.completed", { id: "cs_2", mode: "payment", subscription: null }))).toEqual({
      status: 200,
      body: { received: true, ignored: true },
    });
    expect(await deliver(event("charge.refunded", { id: "ch_1" }))).toMatchObject({ status: 200 });
    expect(stripe.callsOf("subscriptions.retrieve")).toHaveLength(3);
    expect(await db.select().from(stripeEvents)).toHaveLength(5);
  });

  test("subscriptionIdOf reads ids and expanded objects", () => {
    expect(subscriptionIdOf({ type: "customer.subscription.paused", data: { object: { id: "sub_1" } } } as never)).toBe("sub_1");
    expect(subscriptionIdOf({ type: "checkout.session.completed", data: { object: { subscription: { id: "sub_2" } } } } as never)).toBe("sub_2");
    expect(subscriptionIdOf({ type: "invoice.paid", data: { object: { parent: null } } } as never)).toBeNull();
  });
});

describe("route handler", () => {
  test("passes the raw body and signature through", async () => {
    const { sub } = await setup();
    const { body, signature } = signed(event("customer.subscription.updated", { id: sub.id }));
    const ok = await POST(new Request("http://localhost:3210/api/stripe/webhook", { method: "POST", body, headers: { "stripe-signature": signature } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ received: true, ignored: false });

    const bad = await POST(new Request("http://localhost:3210/api/stripe/webhook", { method: "POST", body, headers: { "stripe-signature": "t=1,v1=00" } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "bad_signature" });
  });
});
