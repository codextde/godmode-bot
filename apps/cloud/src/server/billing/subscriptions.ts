/**
 * Subscriptions: checkout, portal, plan changes, cancel/resume, invoices, admin lists and plan grants. The
 * `subscriptions` table mirrors Stripe and is written only by `writeSubscription`, from a subscription object Stripe
 * itself returned (never from an event payload).
 */
import type { CloudInvoice } from "@godmode/shared";
import type Stripe from "stripe";
import { and, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { actorOf, audit, type Actor } from "../audit";
import type { SessionContext } from "../auth/sessions";
import { config } from "../config";
import { newId } from "../crypto";
import { db, planPrices, plans, subscriptions, users, type Plan, type PlanPrice, type Subscription, type User } from "../db";
import { AppError, badRequest, conflict, notFound } from "../errors";
import { getSettings, getSettingsWithSecrets } from "../settings";
import { announceEntitlements, billingEnabled, getSubscription, LIVE_STATUSES } from "./entitlements";
import { assertCanManageBilling, PRODUCT_TAG } from "./plans";
import { asAppError, ensurePortalConfiguration, getStripe, isStripeError, isStripeMissing, requireStripe, stripeCall } from "./stripe";

export { getSubscription };

const LIVE: readonly string[] = LIVE_STATUSES;

function userActor(user: User): Actor {
  return { id: user.id, label: user.email };
}

function toDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === "number" ? new Date(seconds * 1000) : null;
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/** A `plan_prices.id` that may be sold right now, with its plan. Anything else is refused before Stripe sees it. */
async function sellablePrice(priceId: string): Promise<{ price: PlanPrice & { stripePriceId: string }; plan: Plan }> {
  const [row] = await db.select({ price: planPrices, plan: plans }).from(planPrices).innerJoin(plans, eq(planPrices.planId, plans.id)).where(eq(planPrices.id, priceId));
  if (!row || !row.price.active || !row.price.stripePriceId || row.plan.archived || !row.plan.isPublic || row.plan.isFree) {
    throw badRequest("This plan is not available. Reload the page and pick another one.", "plan_unavailable");
  }
  return { price: row.price as PlanPrice & { stripePriceId: string }, plan: row.plan };
}

async function liveSubscription(userId: string): Promise<Subscription | null> {
  const sub = await getSubscription(userId);
  return sub && LIVE.includes(sub.status) ? sub : null;
}

/* ------------------------------------------------------------------ */
/* The single writer                                                    */
/* ------------------------------------------------------------------ */

export type WriteOutcome =
  | { row: Subscription; userId: string }
  | { row: null; reason: "untagged" | "customer_mismatch" | "deleted_user"; userId: string | null };

/**
 * Mirrors a subscription Stripe returned. Only ours (`metadata.product`) and only for the account whose
 * `stripeCustomerId` is the subscription's customer; metadata alone never decides whose plan it is.
 */
export async function writeSubscription(sub: Stripe.Subscription): Promise<WriteOutcome> {
  const metadataUserId = sub.metadata?.user_id ?? null;
  if (sub.metadata?.product !== PRODUCT_TAG) return { row: null, reason: "untagged", userId: null };
  const customerId = idOf(sub.customer);
  const [owner] = customerId ? await db.select({ id: users.id }).from(users).where(eq(users.stripeCustomerId, customerId)) : [];
  if (!owner) {
    const [named] = metadataUserId ? await db.select({ id: users.id }).from(users).where(eq(users.id, metadataUserId)) : [];
    return { row: null, reason: named ? "customer_mismatch" : "deleted_user", userId: metadataUserId };
  }

  const item = sub.items?.data?.[0];
  const stripePrice = item?.price;
  const [known] = stripePrice?.id ? await db.select().from(planPrices).where(eq(planPrices.stripePriceId, stripePrice.id)) : [];
  const recurring = stripePrice?.recurring?.interval;
  const interval: "month" | "year" | null = recurring === "month" ? "month" : recurring === "year" ? "year" : null;
  const values = {
    userId: owner.id,
    planId: known?.planId ?? null,
    priceId: known?.id ?? null,
    stripeCustomerId: customerId!,
    status: sub.status,
    interval,
    amount: stripePrice?.unit_amount ?? null,
    currency: stripePrice?.currency ?? sub.currency ?? null,
    currentPeriodStart: toDate(item?.current_period_start),
    currentPeriodEnd: toDate(item?.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end || Boolean(sub.cancel_at),
    canceledAt: toDate(sub.canceled_at),
    trialEnd: toDate(sub.trial_end),
    livemode: sub.livemode,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(subscriptions)
    .values({ id: newId("sub"), stripeSubscriptionId: sub.id, ...values })
    .onConflictDoUpdate({ target: subscriptions.stripeSubscriptionId, set: values })
    .returning();
  await announceEntitlements(owner.id);
  return { row: row!, userId: owner.id };
}

/** Fetches the subscription from Stripe and mirrors it. Null when it is not ours or belongs to no account. */
export async function syncSubscription(stripeSubscriptionId: string): Promise<Subscription | null> {
  const stripe = await requireStripe();
  const sub = await stripeCall("read the subscription", () => stripe.subscriptions.retrieve(stripeSubscriptionId));
  return (await writeSubscription(sub)).row;
}

/* ------------------------------------------------------------------ */
/* For the person                                                       */
/* ------------------------------------------------------------------ */

/**
 * The person's own Stripe customer, created on first use. Customers are never looked up by e-mail. `replacing` is a
 * stored customer Stripe no longer knows; it gives the new one its own idempotency key.
 */
async function ensureCustomer(stripe: Stripe, user: User, replacing?: string): Promise<string> {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripeCall("create your billing account", () =>
    stripe.customers.create(
      { email: user.email, name: user.name ?? undefined, metadata: { product: PRODUCT_TAG, user_id: user.id } },
      // Two quick clicks on Subscribe must not make two customers.
      { idempotencyKey: `godmode-cloud-customer-${user.id}${replacing ? `-${replacing}` : ""}` },
    ),
  );
  const [stored] = await db
    .update(users)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(and(eq(users.id, user.id), sql`${users.stripeCustomerId} is null`))
    .returning({ stripeCustomerId: users.stripeCustomerId });
  if (stored?.stripeCustomerId) return stored.stripeCustomerId;
  const [current] = await db.select({ stripeCustomerId: users.stripeCustomerId }).from(users).where(eq(users.id, user.id));
  if (!current?.stripeCustomerId) throw notFound("This account no longer exists.");
  return current.stripeCustomerId;
}

/** Stripe Checkout for a `plan_prices.id`. Refused while the person already has a running subscription. */
export async function createCheckout(user: User, priceId: string): Promise<{ url: string }> {
  if (!(await billingEnabled())) throw badRequest("Billing is turned off on this cloud, so everything is already included.", "billing_disabled");
  const stripe = await requireStripe();
  const { price, plan } = await sellablePrice(priceId);
  if (await liveSubscription(user.id)) throw conflict("You already have a subscription. Switch plans instead of subscribing again.", "already_subscribed");

  const [billing, general, [previous]] = await Promise.all([
    getSettingsWithSecrets("billing"),
    getSettings("general"),
    db.select({ n: count() }).from(subscriptions).where(eq(subscriptions.userId, user.id)),
  ]);
  const customer = await ensureCustomer(stripe, user);
  const { publicUrl } = config();
  const tag = { product: PRODUCT_TAG, user_id: user.id };
  // A trial is for the first subscription only.
  const trialDays = billing.trialDays > 0 && (previous?.n ?? 0) === 0 ? billing.trialDays : undefined;
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [{ price: price.stripePriceId, quantity: 1 }],
    success_url: `${publicUrl}/billing?checkout=success`,
    cancel_url: `${publicUrl}/billing?checkout=canceled`,
    metadata: { ...tag, plan_id: plan.id, price_id: price.id },
    subscription_data: { metadata: tag, trial_period_days: trialDays },
    allow_promotion_codes: billing.allowPromotionCodes || undefined,
    automatic_tax: { enabled: billing.automaticTax },
    tax_id_collection: { enabled: billing.taxIdCollection },
    // Lets Checkout save the address and name it collects for tax onto our customer.
    customer_update: { address: "auto", name: "auto" },
    consent_collection: billing.requireTermsConsent && general.termsUrl ? { terms_of_service: "required" } : undefined,
  };
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(params);
  } catch (err) {
    // A customer of the other Stripe mode, or one deleted in the Dashboard: make a new one and try once more.
    if (!isStripeMissing(err) || (err as Stripe.errors.StripeError).param !== "customer") throw asAppError(err, "start the checkout");
    await db
      .update(users)
      .set({ stripeCustomerId: null, updatedAt: new Date() })
      .where(and(eq(users.id, user.id), eq(users.stripeCustomerId, customer)));
    const fresh = await ensureCustomer(stripe, { ...user, stripeCustomerId: null }, customer);
    session = await stripeCall("start the checkout", () => stripe.checkout.sessions.create({ ...params, customer: fresh }));
  }
  if (!session.url) throw new AppError("Stripe did not return a checkout page. Try again in a minute.", "stripe_error", 503);
  await audit(userActor(user), "subscription.checkout", { type: "user", id: user.id }, { plan: plan.id, price: price.id });
  return { url: session.url };
}

/** The Stripe billing portal (payment method, invoices, tax details) with our own configuration. */
export async function createPortal(user: User): Promise<{ url: string }> {
  const stripe = await requireStripe();
  if (!user.stripeCustomerId) throw badRequest("There is no billing account yet. Subscribe to a plan first.", "no_customer");
  const customer = user.stripeCustomerId;
  const returnUrl = `${config().publicUrl}/billing`;
  const stored = (await getSettingsWithSecrets("billing")).portalConfigurationId;
  try {
    const configuration = stored || (await ensurePortalConfiguration());
    const session = await stripe.billingPortal.sessions.create({ customer, configuration, return_url: returnUrl });
    return { url: session.url };
  } catch (err) {
    // A stored configuration from the other Stripe mode, or one switched off in the Dashboard: set ours up again.
    if (!stored || !isStripeError(err) || err.param !== "configuration") throw asAppError(err, "open the billing portal");
  }
  const configuration = await ensurePortalConfiguration();
  const session = await stripeCall("open the billing portal", () => stripe.billingPortal.sessions.create({ customer, configuration, return_url: returnUrl }));
  return { url: session.url };
}

/** Moves a running subscription to another price, with proration. */
export async function changePlan(user: User, priceId: string): Promise<void> {
  const stripe = await requireStripe();
  const { price, plan } = await sellablePrice(priceId);
  const current = await liveSubscription(user.id);
  if (!current) throw badRequest("You have no subscription to change. Subscribe to a plan first.", "no_subscription");
  if (current.priceId === price.id) throw badRequest("You are already on this plan.", "same_plan");
  const sub = await stripeCall("read your subscription", () => stripe.subscriptions.retrieve(current.stripeSubscriptionId));
  const item = sub.items.data[0];
  if (!item) throw new AppError("This subscription has no plan in Stripe. Contact support.", "stripe_error", 409);
  const updated = await stripeCall("change your plan", () =>
    stripe.subscriptions.update(sub.id, { items: [{ id: item.id, price: price.stripePriceId }], proration_behavior: "create_prorations" }),
  );
  await writeSubscription(updated);
  await audit(userActor(user), "subscription.change", { type: "user", id: user.id }, { plan: plan.id, price: price.id, from: current.priceId });
}

/** Cancels at the end of the paid period (reversible with `resumeSubscription`). */
export async function cancelSubscription(user: User, actor: Actor): Promise<Subscription> {
  const stripe = await requireStripe();
  const current = await liveSubscription(user.id);
  if (!current) throw badRequest("There is no running subscription to cancel.", "no_subscription");
  if (current.cancelAtPeriodEnd) return current;
  const updated = await stripeCall("cancel your subscription", () => stripe.subscriptions.update(current.stripeSubscriptionId, { cancel_at_period_end: true }));
  const { row } = await writeSubscription(updated);
  await audit(actor, "subscription.cancel", { type: "user", id: user.id }, { subscription: current.stripeSubscriptionId });
  return row ?? current;
}

/** Undoes a cancellation that has not taken effect yet. */
export async function resumeSubscription(user: User, actor: Actor): Promise<Subscription> {
  const stripe = await requireStripe();
  const current = await liveSubscription(user.id);
  if (!current) throw badRequest("There is no subscription to resume. Subscribe to a plan again.", "no_subscription");
  if (!current.cancelAtPeriodEnd) return current;
  const updated = await stripeCall("resume your subscription", () =>
    stripe.subscriptions.update(current.stripeSubscriptionId, { cancel_at_period_end: false, cancel_at: "" }),
  );
  const { row } = await writeSubscription(updated);
  await audit(actor, "subscription.resume", { type: "user", id: user.id }, { subscription: current.stripeSubscriptionId });
  return row ?? current;
}

/**
 * Ends every running subscription of the account right away (before the account is deleted). Includes ones Stripe
 * has but this database missed. No-op without Stripe; a Stripe error stops the deletion.
 */
export async function cancelNow(userId: string, actor: Actor): Promise<void> {
  const stripe = await getStripe();
  if (!stripe) return;
  const [user] = await db.select({ stripeCustomerId: users.stripeCustomerId }).from(users).where(eq(users.id, userId));
  const ids = new Set(
    (
      await db
        .select({ id: subscriptions.stripeSubscriptionId })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), sql`${subscriptions.status} not in ('canceled', 'incomplete_expired')`))
    ).map((r) => r.id),
  );
  const customer = user?.stripeCustomerId;
  if (customer) {
    const listed = await stripeCall("list the subscriptions", () => stripe.subscriptions.list({ customer, status: "all", limit: 100 }));
    for (const sub of listed.data) {
      if (sub.metadata?.product === PRODUCT_TAG && sub.status !== "canceled" && sub.status !== "incomplete_expired") ids.add(sub.id);
    }
  }
  for (const id of ids) {
    let canceled: Stripe.Subscription;
    try {
      canceled = await stripe.subscriptions.cancel(id);
    } catch (err) {
      if (isStripeMissing(err)) continue;
      throw asAppError(err, "cancel the subscription");
    }
    await writeSubscription(canceled);
    await audit(actor, "subscription.cancel_now", { type: "user", id: userId }, { subscription: id });
  }
}

/** Finalized invoices of the account, newest first. Empty when it never had a Stripe customer. */
export async function listInvoices(user: User, limit = 12): Promise<CloudInvoice[]> {
  if (!user.stripeCustomerId) return [];
  const stripe = await getStripe();
  if (!stripe) return [];
  const customer = user.stripeCustomerId;
  const list = await stripeCall("load your invoices", () => stripe.invoices.list({ customer, limit: Math.min(Math.max(limit, 1), 100) }));
  return list.data
    .filter((invoice) => invoice.status !== "draft")
    .map((invoice) => ({
      id: invoice.id,
      number: invoice.number ?? null,
      date: new Date(invoice.created * 1000).toISOString(),
      total: invoice.total,
      currency: invoice.currency,
      status: invoice.status ?? "open",
      url: invoice.hosted_invoice_url ?? null,
      pdf: invoice.invoice_pdf ?? null,
    }));
}

/* ------------------------------------------------------------------ */
/* For the admin area                                                   */
/* ------------------------------------------------------------------ */

export type SubscriptionRow = Subscription & { user: Pick<User, "id" | "email" | "name">; plan: Pick<Plan, "id" | "name"> | null };

export async function listSubscriptions(
  q: { search?: string; status?: string; page?: number; pageSize?: number } = {},
): Promise<{ rows: SubscriptionRow[]; total: number }> {
  const pageSize = Math.min(Math.max(Math.trunc(q.pageSize ?? 25), 1), 200);
  const page = Math.max(Math.trunc(q.page ?? 1), 1);
  const conditions: SQL[] = [];
  const search = q.search?.trim();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(users.email, like), ilike(users.name, like), ilike(subscriptions.stripeSubscriptionId, like))!);
  }
  if (q.status) conditions.push(eq(subscriptions.status, q.status));
  const where = conditions.length ? and(...conditions) : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select({ sub: subscriptions, user: { id: users.id, email: users.email, name: users.name }, planId: plans.id, planName: plans.name })
      .from(subscriptions)
      .innerJoin(users, eq(subscriptions.userId, users.id))
      .leftJoin(plans, eq(subscriptions.planId, plans.id))
      .where(where)
      .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(subscriptions).innerJoin(users, eq(subscriptions.userId, users.id)).where(where),
  ]);
  return {
    rows: rows.map((r) => ({ ...r.sub, user: r.user, plan: r.planId ? { id: r.planId, name: r.planName! } : null })),
    total: total?.n ?? 0,
  };
}

/**
 * Monthly recurring revenue in minor units of `billing.currency` (yearly prices count a twelfth; trials count
 * nothing; subscriptions in other currencies are left out), plus counts by state. Only the current Stripe mode.
 */
export async function revenueSummary(): Promise<{ mrr: number; currency: string; active: number; trialing: number; pastDue: number; canceling: number }> {
  const billing = await getSettings("billing");
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(inArray(subscriptions.status, [...LIVE_STATUSES]), billing.livemode === null ? undefined : eq(subscriptions.livemode, billing.livemode)));
  let mrr = 0;
  const counts = { active: 0, trialing: 0, pastDue: 0, canceling: 0 };
  for (const sub of rows) {
    if (sub.status === "active") counts.active += 1;
    if (sub.status === "trialing") counts.trialing += 1;
    if (sub.status === "past_due") counts.pastDue += 1;
    if (sub.cancelAtPeriodEnd) counts.canceling += 1;
    if (sub.status === "trialing" || sub.amount === null || sub.currency !== billing.currency) continue;
    mrr += sub.interval === "year" ? sub.amount / 12 : sub.amount;
  }
  return { mrr: Math.round(mrr), currency: billing.currency, ...counts };
}

/** Gives a plan without payment (null removes the grant). It wins over the free plan and loses to a subscription. */
export async function grantPlan(userId: string, planId: string | null, until: Date | null, ctx: SessionContext): Promise<void> {
  assertCanManageBilling(ctx);
  if (planId) {
    const [plan] = await db.select({ archived: plans.archived }).from(plans).where(eq(plans.id, planId));
    if (!plan) throw notFound("This plan does not exist.");
    if (plan.archived) throw badRequest("This plan is archived. Give a current plan instead.");
  }
  if (planId && until && until.getTime() <= Date.now()) throw badRequest("Pick an end date in the future, or none.");
  const [user] = await db
    .update(users)
    .set({ planOverrideId: planId, planOverrideUntil: planId ? until : null, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (!user) throw notFound("This account does not exist.");
  await audit(actorOf(ctx), "plan.grant", { type: "user", id: userId }, { plan: planId, until: planId && until ? until.toISOString() : null });
  await announceEntitlements(userId);
}
