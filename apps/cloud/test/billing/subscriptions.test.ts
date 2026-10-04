import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { SYSTEM } from "@/server/audit";
import {
  cancelNow,
  cancelSubscription,
  changePlan,
  createCheckout,
  createPortal,
  getSubscription,
  grantPlan,
  listInvoices,
  listSubscriptions,
  resumeSubscription,
  revenueSummary,
  syncSubscription,
} from "@/server/billing/subscriptions";
import { getEntitlements } from "@/server/billing/entitlements";
import { setStripeClientForTests } from "@/server/billing/stripe";
import { newId } from "@/server/crypto";
import { db, planPrices, plans, subscriptions, users, type User } from "@/server/db";
import { writeSettings } from "@/server/settings";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import {
  auditActions,
  connectStripe,
  createUser,
  ctxFor,
  fakeStripe,
  freePlan,
  missing,
  paidPlan,
  recordingHub,
  reloadUser,
  seedRoles,
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

/** A person with a Stripe customer and a running subscription known to Stripe and mirrored here. */
async function subscriber(email = "s@example.com", status: Stripe.Subscription.Status = "active") {
  await connectStripe();
  await freePlan();
  const { plan, price } = await paidPlan();
  const user = await createUser(email, "member", { stripeCustomerId: `cus_${email}` });
  const sub = stripeSubscription({ customer: user.stripeCustomerId!, price: price.stripePriceId!, status, metadata: { product: "godmode_cloud", user_id: user.id } });
  stripe.subscriptions.set(sub.id, sub);
  await syncSubscription(sub.id);
  return { user: await reloadUser(user.id), plan, price, sub };
}

describe("createCheckout", () => {
  test("starts a tagged subscription checkout and creates the customer once", async () => {
    await connectStripe({ patch: { trialDays: 14, automaticTax: true, taxIdCollection: true, allowPromotionCodes: true } });
    await writeSettings("general", { termsUrl: "https://example.com/terms" }, SYSTEM);
    await writeSettings("billing", { requireTermsConsent: true }, SYSTEM);
    const { plan, price } = await paidPlan();
    const user = await createUser("buyer@example.com");

    const { url } = await createCheckout(user, price.id);
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [customerParams, customerOptions] = stripe.callsOf("customers.create")[0]!.args as [Record<string, unknown>, Record<string, unknown>];
    expect(customerParams).toEqual({ email: "buyer@example.com", name: undefined, metadata: { product: "godmode_cloud", user_id: user.id } });
    expect(customerOptions).toEqual({ idempotencyKey: `godmode-cloud-customer-${user.id}` });
    const stored = await reloadUser(user.id);
    expect(stored.stripeCustomerId).toMatch(/^cus_fake/);

    const params = stripe.lastParams<Stripe.Checkout.SessionCreateParams>("checkout.sessions.create");
    expect(params).toMatchObject({
      mode: "subscription",
      customer: stored.stripeCustomerId,
      client_reference_id: user.id,
      line_items: [{ price: price.stripePriceId, quantity: 1 }],
      success_url: "http://localhost:3210/billing?checkout=success",
      cancel_url: "http://localhost:3210/billing?checkout=canceled",
      metadata: { product: "godmode_cloud", user_id: user.id, plan_id: plan.id, price_id: price.id },
      subscription_data: { metadata: { product: "godmode_cloud", user_id: user.id }, trial_period_days: 14 },
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      consent_collection: { terms_of_service: "required" },
    });
    expect(params).not.toHaveProperty("payment_method_types");

    // A second checkout reuses the customer; no trial the second time someone subscribes.
    await db.insert(subscriptions).values({ id: newId("sub"), userId: user.id, stripeSubscriptionId: "sub_old", stripeCustomerId: stored.stripeCustomerId!, status: "canceled" });
    await createCheckout(stored, price.id);
    expect(stripe.callsOf("customers.create")).toHaveLength(1);
    expect(stripe.lastParams<Stripe.Checkout.SessionCreateParams>("checkout.sessions.create").subscription_data?.trial_period_days).toBeUndefined();
    expect(await auditActions()).toContain("subscription.checkout");
  });

  test("refuses unknown, inactive, unsynced, archived, private and free prices before calling Stripe", async () => {
    await connectStripe();
    const user = await createUser("buyer@example.com");
    const { price } = await paidPlan();
    const free = await freePlan();
    const [freePrice] = await db.insert(planPrices).values({ id: newId("price"), planId: free.id, interval: "month", amount: 100, currency: "usd", stripePriceId: "price_free" }).returning();
    const inactive = await paidPlan({ key: "old" });
    await db.update(planPrices).set({ active: false }).where(eq(planPrices.id, inactive.price.id));
    const unsynced = await paidPlan({ key: "unsynced" });
    await db.update(planPrices).set({ stripePriceId: null }).where(eq(planPrices.id, unsynced.price.id));
    const archived = await paidPlan({ key: "archived" });
    await db.update(plans).set({ archived: true }).where(eq(plans.id, archived.plan.id));
    const hidden = await paidPlan({ key: "hidden" });
    await db.update(plans).set({ isPublic: false }).where(eq(plans.id, hidden.plan.id));

    for (const id of ["price_nope", price.stripePriceId!, inactive.price.id, unsynced.price.id, archived.price.id, hidden.price.id, freePrice!.id]) {
      await expect(createCheckout(user, id)).rejects.toMatchObject({ code: "plan_unavailable" });
    }
    expect(stripe.calls).toHaveLength(0);
  });

  test("refuses while a subscription is running, and while billing is off", async () => {
    const { user, price } = await subscriber();
    await expect(createCheckout(user, price.id)).rejects.toMatchObject({ code: "already_subscribed" });
    await writeSettings("billing", { enabled: false }, SYSTEM);
    await expect(createCheckout(user, price.id)).rejects.toMatchObject({ code: "billing_disabled" });
    expect(stripe.callsOf("checkout.sessions.create")).toHaveLength(0);
  });

  test("a running subscription of the other Stripe mode does not block a checkout", async () => {
    const { user, price } = await subscriber();
    await writeSettings("billing", { livemode: true }, SYSTEM);
    expect(await getSubscription(user.id)).toBeNull();
    await createCheckout(user, price.id);
    expect(stripe.callsOf("checkout.sessions.create")).toHaveLength(1);
  });

  test("a stored customer Stripe doesn't know is replaced by a new one, once", async () => {
    await connectStripe();
    const { price } = await paidPlan();
    const user = await createUser("buyer@example.com", "member", { stripeCustomerId: "cus_stale" });
    const create = stripe.client.checkout.sessions.create.bind(stripe.client.checkout.sessions);
    let refused = 0;
    stripe.client.checkout.sessions.create = (async (params: Stripe.Checkout.SessionCreateParams) => {
      if (params.customer === "cus_stale") {
        refused++;
        throw new Stripe.errors.StripeInvalidRequestError({ message: "No such customer: 'cus_stale'", code: "resource_missing", param: "customer" });
      }
      return create(params);
    }) as typeof stripe.client.checkout.sessions.create;

    const { url } = await createCheckout(user, price.id);
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(refused).toBe(1);
    const [, options] = stripe.callsOf("customers.create")[0]!.args as [unknown, { idempotencyKey: string }];
    expect(options.idempotencyKey).toBe(`godmode-cloud-customer-${user.id}-cus_stale`);
    const stored = await reloadUser(user.id);
    expect(stored.stripeCustomerId).toMatch(/^cus_fake/);
    expect(stripe.lastParams<Stripe.Checkout.SessionCreateParams>("checkout.sessions.create").customer).toBe(stored.stripeCustomerId);

    // Any other missing object is not retried.
    stripe.fail.set("checkout.sessions.create", missing("price: price_gone"));
    await expect(createCheckout(stored, price.id)).rejects.toMatchObject({ code: "stripe_error" });
    expect(stripe.callsOf("customers.create")).toHaveLength(1);
  });

  test("a Stripe failure becomes a calm AppError", async () => {
    await connectStripe();
    const { price } = await paidPlan();
    const user = await createUser("buyer@example.com", "member", { stripeCustomerId: "cus_known" });
    stripe.fail.set("checkout.sessions.create", new Stripe.errors.StripeConnectionError({ message: "socket hang up" }));
    await expect(createCheckout(user, price.id)).rejects.toMatchObject({ name: "AppError", code: "stripe_error", message: "Could not reach Stripe to start the checkout. Try again in a minute." });
  });
});

describe("running subscriptions", () => {
  test("syncSubscription mirrors plan, price, period from the item, and notifies the account", async () => {
    const { user, plan, price, sub } = await subscriber();
    const row = await getSubscription(user.id);
    const item = sub.items.data[0]!;
    expect(row).toMatchObject({
      userId: user.id,
      planId: plan.id,
      priceId: price.id,
      stripeSubscriptionId: sub.id,
      stripeCustomerId: user.stripeCustomerId,
      status: "active",
      interval: "month",
      amount: 1000,
      currency: "usd",
      cancelAtPeriodEnd: false,
      currentPeriodStart: new Date(item.current_period_start * 1000),
      currentPeriodEnd: new Date(item.current_period_end * 1000),
    });
    expect(notices.map((n) => [n.userId, n.notice.type])).toEqual([
      [user.id, "plan"],
      [user.id, "billing"],
    ]);
    expect(notices[0]!.notice).toMatchObject({ plan: { id: plan.id } });
  });

  test("cancel and resume at period end", async () => {
    const { user } = await subscriber();
    const actor = { id: user.id, label: user.email };
    const canceled = await cancelSubscription(user, actor);
    expect(canceled.cancelAtPeriodEnd).toBe(true);
    expect(stripe.callsOf("subscriptions.update").map((c) => c.args[1])).toEqual([{ cancel_at_period_end: true }]);
    // Already canceling: nothing more is sent.
    await cancelSubscription(user, actor);
    expect(stripe.callsOf("subscriptions.update")).toHaveLength(1);
    expect((await getEntitlements(user.id)).source).toBe("subscription");

    const resumed = await resumeSubscription(user, actor);
    expect(resumed.cancelAtPeriodEnd).toBe(false);
    expect(stripe.callsOf("subscriptions.update")[1]!.args[1]).toEqual({ cancel_at_period_end: false, cancel_at: "" });
    expect(await auditActions()).toEqual(expect.arrayContaining(["subscription.cancel", "subscription.resume"]));
  });

  test("cancel without a subscription is refused", async () => {
    await connectStripe();
    const user = await createUser("n@example.com");
    await expect(cancelSubscription(user, SYSTEM)).rejects.toMatchObject({ code: "no_subscription" });
    await expect(resumeSubscription(user, SYSTEM)).rejects.toMatchObject({ code: "no_subscription" });
  });

  test("changePlan swaps the item's price with proration", async () => {
    const { user, sub } = await subscriber();
    const other = await paidPlan({ key: "team", amount: 3000 });
    await changePlan(user, other.price.id);
    expect(stripe.callsOf("subscriptions.update")[0]!.args).toEqual([
      sub.id,
      { items: [{ id: sub.items.data[0]!.id, price: other.price.stripePriceId }], proration_behavior: "create_prorations" },
    ]);
    expect(await getSubscription(user.id)).toMatchObject({ planId: other.plan.id, priceId: other.price.id });
    await expect(changePlan(user, other.price.id)).rejects.toMatchObject({ code: "same_plan" });
    expect(await auditActions()).toContain("subscription.change");
  });

  test("cancelNow cancels every running subscription, including one only Stripe knows", async () => {
    const { user, sub, price } = await subscriber();
    const unknown = stripeSubscription({ customer: user.stripeCustomerId!, price: price.stripePriceId!, metadata: { product: "godmode_cloud", user_id: user.id } });
    const foreign = stripeSubscription({ customer: user.stripeCustomerId!, price: "price_other_product", metadata: { product: "website" } });
    stripe.subscriptions.set(unknown.id, unknown);
    stripe.subscriptions.set(foreign.id, foreign);

    await cancelNow(user.id, SYSTEM);
    const canceled = stripe.callsOf("subscriptions.cancel").map((c) => c.args[0]);
    expect(canceled.sort()).toEqual([sub.id, unknown.id].sort());
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
    expect(rows.map((r) => r.status)).toEqual(["canceled", "canceled"]);
    expect((await auditActions()).filter((a) => a === "subscription.cancel_now")).toHaveLength(2);
  });

  test("cancelNow is a no-op without Stripe and stops on a Stripe error", async () => {
    const user = await createUser("x@example.com");
    await cancelNow(user.id, SYSTEM);
    expect(stripe.calls).toHaveLength(0);

    const { user: payer } = await subscriber("p@example.com");
    stripe.fail.set("subscriptions.cancel", new Stripe.errors.StripeAPIError({ message: "boom" }));
    await expect(cancelNow(payer.id, SYSTEM)).rejects.toMatchObject({ code: "stripe_error" });
    stripe.fail.set("subscriptions.cancel", missing("subscription"));
    await expect(cancelNow(payer.id, SYSTEM)).resolves.toBeUndefined();
  });
});

describe("portal and invoices", () => {
  test("createPortal uses our configuration and the stored customer", async () => {
    const { user } = await subscriber();
    const { url } = await createPortal(user);
    expect(url).toBe("https://billing.stripe.com/p/session/test");
    const params = stripe.lastParams("billingPortal.sessions.create");
    expect(params).toEqual({ customer: user.stripeCustomerId, configuration: expect.stringMatching(/^bpc_fake/), return_url: "http://localhost:3210/billing" });

    const nobody = await createUser("n@example.com");
    await expect(createPortal(nobody)).rejects.toMatchObject({ code: "no_customer" });
  });

  test("listInvoices maps Stripe invoices and is empty without a customer", async () => {
    const { user } = await subscriber();
    stripe.invoices.push(
      { id: "in_1", number: "GC-0001", created: 1_760_000_000, total: 1000, currency: "usd", status: "paid", hosted_invoice_url: "https://invoice.stripe.com/i/1", invoice_pdf: "https://pay.stripe.com/1.pdf" },
      { id: "in_draft", number: null, created: 1_760_000_100, total: 1000, currency: "usd", status: "draft" },
    );
    expect(await listInvoices(user)).toEqual([
      { id: "in_1", number: "GC-0001", date: new Date(1_760_000_000_000).toISOString(), total: 1000, currency: "usd", status: "paid", url: "https://invoice.stripe.com/i/1", pdf: "https://pay.stripe.com/1.pdf" },
    ]);
    expect(stripe.lastParams("invoices.list")).toEqual({ customer: user.stripeCustomerId, limit: 12 });
    expect(await listInvoices(await createUser("none@example.com"))).toEqual([]);
  });
});

describe("admin", () => {
  test("grantPlan needs billing.manage, validates and is undone with null", async () => {
    await connectStripe();
    await freePlan();
    const { plan } = await paidPlan();
    const user = await createUser("g@example.com");
    const manager = await ctxFor(await createUser("bm@example.com", "billing"));
    const admin = await ctxFor(await createUser("ad@example.com", "admin"));

    await expect(grantPlan(user.id, plan.id, null, admin)).rejects.toMatchObject({ status: 403 });
    await expect(grantPlan(user.id, plan.id, new Date(Date.now() - 1000), manager)).rejects.toMatchObject({ status: 400 });
    await expect(grantPlan(user.id, "plan_missing", null, manager)).rejects.toMatchObject({ status: 404 });
    const until = new Date(Date.now() + 86_400_000);
    await grantPlan(user.id, plan.id, until, manager);
    expect(await reloadUser(user.id)).toMatchObject({ planOverrideId: plan.id, planOverrideUntil: until });
    expect((await getEntitlements(user.id)).source).toBe("override");
    expect(notices.some((n) => n.userId === user.id && n.notice.type === "plan")).toBe(true);

    await grantPlan(user.id, null, until, manager);
    expect(await reloadUser(user.id)).toMatchObject({ planOverrideId: null, planOverrideUntil: null });
    expect((await auditActions()).filter((a) => a === "plan.grant")).toHaveLength(2);
  });

  test("listSubscriptions searches and pages; revenueSummary counts and sums MRR", async () => {
    await connectStripe({ patch: { currency: "usd" } });
    const { plan } = await paidPlan();
    const make = async (email: string, p: { status: string; interval: "month" | "year"; amount: number; currency?: string; cancel?: boolean }) => {
      const user = await createUser(email);
      await db.insert(subscriptions).values({
        id: newId("sub"),
        userId: user.id,
        planId: plan.id,
        stripeSubscriptionId: `sub_${email}`,
        stripeCustomerId: `cus_${email}`,
        status: p.status,
        interval: p.interval,
        amount: p.amount,
        currency: p.currency ?? "usd",
        cancelAtPeriodEnd: p.cancel ?? false,
      });
      return user;
    };
    await make("anna@example.com", { status: "active", interval: "month", amount: 1000 });
    await make("ben@example.com", { status: "active", interval: "year", amount: 12000, cancel: true });
    await make("cara@example.com", { status: "trialing", interval: "month", amount: 1000 });
    await make("dan@example.com", { status: "past_due", interval: "month", amount: 1000 });
    await make("eve@example.com", { status: "active", interval: "month", amount: 900, currency: "eur" });
    await make("finn@example.com", { status: "canceled", interval: "month", amount: 1000 });

    expect(await revenueSummary()).toEqual({ mrr: 1000 + 1000 + 1000, currency: "usd", active: 3, trialing: 1, pastDue: 1, canceling: 1 });

    const all = await listSubscriptions({ pageSize: 4 });
    expect(all.total).toBe(6);
    expect(all.rows).toHaveLength(4);
    expect(all.rows[0]).toMatchObject({ user: { email: expect.any(String) }, plan: { id: plan.id, name: "Pro" } });
    const found = await listSubscriptions({ search: "BEN" });
    expect(found.rows.map((r) => r.user.email)).toEqual(["ben@example.com"]);
    expect((await listSubscriptions({ status: "past_due" })).rows.map((r) => r.user.email)).toEqual(["dan@example.com"]);
    expect((await listSubscriptions({ search: "%" })).total).toBe(0);
  });
});

describe("writeSubscription guards", () => {
  test("ignores untagged subscriptions and customers of no account", async () => {
    await connectStripe();
    const { price } = await paidPlan();
    const user: User = await createUser("x@example.com", "member", { stripeCustomerId: "cus_mine" });
    const untagged = stripeSubscription({ customer: "cus_mine", price: price.stripePriceId! });
    const strange = stripeSubscription({ customer: "cus_someone", price: price.stripePriceId!, metadata: { product: "godmode_cloud", user_id: user.id } });
    stripe.subscriptions.set(untagged.id, untagged);
    stripe.subscriptions.set(strange.id, strange);
    expect(await syncSubscription(untagged.id)).toBeNull();
    expect(await syncSubscription(strange.id)).toBeNull();
    expect(await db.select().from(subscriptions)).toEqual([]);
    expect(await db.select().from(users).where(eq(users.stripeCustomerId, "cus_someone"))).toEqual([]);
  });
});
