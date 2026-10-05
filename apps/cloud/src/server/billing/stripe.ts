/**
 * The Stripe client and everything that sets the Stripe account up: key check, webhook endpoint, billing portal
 * configuration, and products/prices for the plans. The account may be shared with other products, so every object
 * created here carries `metadata.product = "godmode_cloud"` and nothing account-wide (such as the default portal
 * configuration) is ever changed.
 */
import Stripe from "stripe";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { actorOf, audit, SYSTEM } from "../audit";
import type { SessionContext } from "../auth/sessions";
import { config } from "../config";
import { db, planPrices, plans, users, type Plan } from "../db";
import { AppError, badRequest, notFound } from "../errors";
import { getSettings, getSettingsWithSecrets, writeSettings } from "../settings";
import { assertCanManageBilling, PRODUCT_TAG } from "./plans";

/** The events the webhook endpoint subscribes to; each one makes the handler re-fetch the subscription. */
export const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
];

let testClient: Stripe | null = null;
let cached: { key: string; client: Stripe } | null = null;

/** Tests hand in a fake that records calls; `null` goes back to the real client. */
export function setStripeClientForTests(client: Stripe | null): void {
  testClient = client;
}

function createClient(secretKey: string): Stripe {
  return testClient ?? new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "Godmode Cloud" } });
}

/** Null when no secret key is stored. The client is kept until the key changes. */
export async function getStripe(): Promise<Stripe | null> {
  const { stripeSecretKey } = await getSettingsWithSecrets("billing");
  if (!stripeSecretKey) return null;
  if (testClient) return testClient;
  if (cached?.key !== stripeSecretKey) cached = { key: stripeSecretKey, client: createClient(stripeSecretKey) };
  return cached.client;
}

export async function requireStripe(): Promise<Stripe> {
  const stripe = await getStripe();
  if (!stripe) throw new AppError("Stripe is not connected. Add the secret key under Settings → Billing.", "stripe_not_connected", 409);
  return stripe;
}

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

// Checked by name rather than `instanceof`: Next and the custom server are separate bundles.
export function isStripeError(err: unknown): err is Stripe.errors.StripeError {
  const type = err instanceof Error ? (err as Error & { type?: unknown }).type : undefined;
  return typeof type === "string" && type.startsWith("Stripe");
}

/** Stripe says the object does not exist (deleted, or made with the other mode's key). */
export function isStripeMissing(err: unknown): boolean {
  return isStripeError(err) && err.code === "resource_missing";
}

/** A Stripe failure as a sentence for the person; `action` completes "Stripe could not …". */
export function stripeErrorMessage(err: unknown, action: string): string {
  if (!isStripeError(err)) return `Could not ${action}. Try again in a minute.`;
  switch (err.type) {
    case "StripeConnectionError":
    case "StripeAPIError":
      return `Could not reach Stripe to ${action}. Try again in a minute.`;
    case "StripeRateLimitError":
      return `Stripe is busy and could not ${action}. Try again in a minute.`;
    case "StripeAuthenticationError":
      return "Stripe did not accept the secret key. Check it under Settings → Billing.";
    case "StripePermissionError":
      return `The Stripe key is not allowed to ${action}. Give the key that permission in the Stripe Dashboard.`;
    default: {
      const detail = err.message?.trim();
      return detail ? `Stripe could not ${action}: ${detail.replace(/\.?$/, ".")}` : `Stripe could not ${action}.`;
    }
  }
}

/** A Stripe error as an AppError with a calm sentence; anything else is returned unchanged. */
export function asAppError(err: unknown, action: string): unknown {
  if (!isStripeError(err)) return err;
  console.warn(`[billing] Stripe could not ${action}:`, [err.type, err.code, err.message].filter(Boolean).join(" "));
  const status = err.type === "StripeInvalidRequestError" || err.type === "StripeCardError" ? 400 : 503;
  return new AppError(stripeErrorMessage(err, action), "stripe_error", status);
}

/** Runs one Stripe call; a Stripe error becomes an AppError with a calm sentence. */
export async function stripeCall<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asAppError(err, action);
  }
}

/** Like `stripeCall`, but "no such object" gives null instead of an error. */
async function stripeCallOrMissing<T>(action: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (isStripeMissing(err)) return null;
    throw asAppError(err, action);
  }
}

/* ------------------------------------------------------------------ */
/* Account setup                                                        */
/* ------------------------------------------------------------------ */

/** Checks a secret key against Stripe and stores the account name and mode it belongs to. */
export async function checkStripeKey(
  secretKey: string,
): Promise<{ ok: true; livemode: boolean; accountName: string; defaultCurrency: string | null } | { ok: false; error: string }> {
  const key = secretKey.trim();
  if (!/^(sk|rk)_(test|live)_\S+$/.test(key)) {
    return { ok: false, error: "That is not a Stripe secret key. It starts with sk_ (or rk_ for a restricted key)." };
  }
  const client = createClient(key);
  let accountName = "";
  let defaultCurrency: string | null = null;
  try {
    const account = await client.accounts.retrieveCurrent();
    accountName = account.settings?.dashboard?.display_name || account.business_profile?.name || account.email || account.id;
    defaultCurrency = account.default_currency ?? null;
  } catch (err) {
    if (!isStripeError(err) || err.type !== "StripePermissionError") return { ok: false, error: stripeErrorMessage(err, "check the key") };
    // A restricted key may lack the account permission; it is good enough when it can read products.
    try {
      await client.products.list({ limit: 1 });
    } catch (inner) {
      return { ok: false, error: stripeErrorMessage(inner, "check the key") };
    }
  }
  const livemode = key.includes("_live_");
  const previous = (await getSettings("billing")).livemode;
  await writeSettings("billing", { stripeAccountName: accountName, livemode }, SYSTEM);
  // Customers exist in one Stripe mode only: after switching between test and live, everyone gets a new one at checkout.
  if (previous !== null && previous !== livemode) {
    await db.update(users).set({ stripeCustomerId: null, updatedAt: new Date() }).where(isNotNull(users.stripeCustomerId));
  }
  return { ok: true, livemode, accountName, defaultCurrency };
}

function isApiVersionRefusal(err: unknown): boolean {
  return isStripeError(err) && err.type === "StripeInvalidRequestError" && (err.param === "api_version" || /api[ _]?version/i.test(err.message ?? ""));
}

/**
 * Creates (or repairs) our webhook endpoint at `<publicUrl>/api/stripe/webhook` and stores its signing secret, which
 * Stripe returns only at creation.
 */
export async function ensureWebhook(
  ctx: SessionContext,
): Promise<{ ok: true; endpointId: string } | { ok: false; error: string; manual: true }> {
  assertCanManageBilling(ctx);
  const { publicUrl } = config();
  const url = `${publicUrl}/api/stripe/webhook`;
  const stripe = await getStripe();
  if (!stripe) return { ok: false, manual: true, error: "Connect Stripe first: save the secret key, then set up the webhook." };
  if (!publicUrl.startsWith("https://")) {
    return {
      ok: false,
      manual: true,
      error: `Stripe only sends events to https addresses, and this cloud runs at ${publicUrl}. Open it at its https address, or add ${url} in the Stripe Dashboard yourself.`,
    };
  }
  const settings = await getSettingsWithSecrets("billing");
  const metadata = { product: PRODUCT_TAG };
  try {
    if (settings.webhookEndpointId && settings.webhookSecret) {
      const existing = await stripeCallOrMissing("read the webhook", () => stripe.webhookEndpoints.retrieve(settings.webhookEndpointId));
      if (existing) {
        await stripe.webhookEndpoints.update(existing.id, { url, enabled_events: WEBHOOK_EVENTS, disabled: false, metadata });
        await audit(actorOf(ctx), "billing.webhook", { type: "webhook", id: existing.id }, { url, repaired: true });
        return { ok: true, endpointId: existing.id };
      }
    }
    // An endpoint of ours whose secret we no longer have would deliver every event twice; replace it.
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    for (const endpoint of endpoints.data) {
      if (endpoint.url === url && endpoint.metadata?.product === PRODUCT_TAG) await stripe.webhookEndpoints.del(endpoint.id);
    }
    const params: Stripe.WebhookEndpointCreateParams = { url, enabled_events: WEBHOOK_EVENTS, description: "Godmode Cloud", metadata };
    let created: Stripe.WebhookEndpoint;
    try {
      created = await stripe.webhookEndpoints.create({ ...params, api_version: Stripe.API_VERSION });
    } catch (err) {
      // An account can only use three API versions on its live endpoints; fall back to the account's default.
      if (!isApiVersionRefusal(err)) throw err;
      created = await stripe.webhookEndpoints.create(params);
    }
    if (!created.secret) {
      return { ok: false, manual: true, error: "Stripe did not return the signing secret. Delete the endpoint in the Stripe Dashboard and try again." };
    }
    await writeSettings("billing", { webhookEndpointId: created.id, webhookSecret: created.secret }, actorOf(ctx));
    await audit(actorOf(ctx), "billing.webhook", { type: "webhook", id: created.id }, { url, apiVersion: created.api_version });
    return { ok: true, endpointId: created.id };
  } catch (err) {
    if (!isStripeError(err)) throw err;
    return { ok: false, manual: true, error: stripeErrorMessage(err, "set up the webhook") };
  }
}

/** Public, unarchived paid plans with their synced prices: what the portal lets people switch between. */
async function portalProducts(): Promise<{ product: string; prices: string[] }[]> {
  const rows = await db
    .select()
    .from(plans)
    .where(and(eq(plans.archived, false), eq(plans.isPublic, true), eq(plans.isFree, false)))
    .orderBy(asc(plans.sort));
  const synced = rows.filter((p): p is Plan & { stripeProductId: string } => p.stripeProductId !== null);
  if (synced.length === 0) return [];
  const prices = await db
    .select()
    .from(planPrices)
    .where(and(inArray(planPrices.planId, synced.map((p) => p.id)), eq(planPrices.active, true)));
  return synced
    .map((plan) => ({
      product: plan.stripeProductId,
      prices: prices.filter((p) => p.planId === plan.id && p.stripePriceId).map((p) => p.stripePriceId!),
    }))
    .filter((p) => p.prices.length > 0);
}

function httpUrl(value: string): string | undefined {
  return /^https?:\/\/\S+$/i.test(value) ? value : undefined;
}

/**
 * Our own portal configuration (never the account default, which other products use): invoices, payment method,
 * tax details, cancel at period end, and switching only between Godmode Cloud prices. Returns its id.
 */
export async function ensurePortalConfiguration(): Promise<string> {
  const stripe = await requireStripe();
  const [billing, general, products] = await Promise.all([getSettingsWithSecrets("billing"), getSettings("general"), portalProducts()]);
  const features: Stripe.BillingPortal.ConfigurationCreateParams.Features = {
    customer_update: { enabled: true, allowed_updates: ["address", "name", "tax_id"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    subscription_update:
      products.length > 0
        ? { enabled: true, default_allowed_updates: ["price"], products, proration_behavior: "create_prorations" }
        : { enabled: false },
  };
  const businessProfile = {
    headline: general.appName || undefined,
    privacy_policy_url: httpUrl(general.privacyUrl),
    terms_of_service_url: httpUrl(general.termsUrl),
  };
  const returnUrl = `${config().publicUrl}/billing`;
  const metadata = { product: PRODUCT_TAG };
  if (billing.portalConfigurationId) {
    const updated = await stripeCallOrMissing("update the billing portal", () =>
      stripe.billingPortal.configurations.update(billing.portalConfigurationId, {
        active: true,
        features,
        business_profile: businessProfile,
        default_return_url: returnUrl,
        metadata,
      }),
    );
    if (updated) return updated.id;
  }
  const created = await stripeCall("set up the billing portal", () =>
    stripe.billingPortal.configurations.create({ features, business_profile: businessProfile, default_return_url: returnUrl, metadata, name: "Godmode Cloud" }),
  );
  await writeSettings("billing", { portalConfigurationId: created.id }, SYSTEM);
  return created.id;
}

function productName(plan: Plan): string {
  return plan.name.startsWith("Godmode Cloud") ? plan.name : `Godmode Cloud ${plan.name}`;
}

/**
 * Creates or updates the plan's Stripe product and gives every active price row a Stripe price
 * (lookup key `godmode_cloud_<planKey>_<interval>_<currency>`). Deactivated rows lose their Stripe price for new
 * subscriptions; archived plans get an inactive product. Then the portal is told which prices may be switched to.
 */
export async function syncPlanToStripe(planId: string, ctx: SessionContext): Promise<void> {
  assertCanManageBilling(ctx);
  const stripe = await requireStripe();
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) throw notFound("This plan does not exist.");
  if (plan.isFree) throw badRequest("The free plan is not sold, so it has no Stripe product.");
  const { taxBehavior } = await getSettings("billing");
  const metadata = { product: PRODUCT_TAG, plan_id: plan.id, plan_key: plan.key };

  let productId = plan.stripeProductId;
  let freshProduct = false;
  if (productId) {
    const id = productId;
    const updated = await stripeCallOrMissing("update the product", () =>
      stripe.products.update(id, { name: productName(plan), description: plan.description, active: !plan.archived, metadata }),
    );
    if (!updated) productId = null;
  }
  if (!productId) {
    const created = await stripeCall("create the product", () =>
      stripe.products.create({ name: productName(plan), description: plan.description || undefined, active: !plan.archived, metadata }),
    );
    productId = created.id;
    freshProduct = true;
    await db.update(plans).set({ stripeProductId: productId, updatedAt: new Date() }).where(eq(plans.id, plan.id));
  }

  const prices = await db.select().from(planPrices).where(eq(planPrices.planId, plan.id)).orderBy(asc(planPrices.createdAt));
  for (const price of prices) {
    if (price.active && !plan.archived && (freshProduct || !price.stripePriceId)) {
      // A new product (first sync, or the old one is gone in this Stripe mode) needs new prices too.
      const product = productId;
      const created = await stripeCall("create a price", () =>
        stripe.prices.create({
          product,
          currency: price.currency,
          unit_amount: price.amount,
          recurring: { interval: price.interval },
          tax_behavior: taxBehavior,
          lookup_key: `${PRODUCT_TAG}_${plan.key}_${price.interval}_${price.currency}`,
          transfer_lookup_key: true,
          metadata: { product: PRODUCT_TAG, plan_id: plan.id, price_id: price.id },
        }),
      );
      await db.update(planPrices).set({ stripePriceId: created.id }).where(eq(planPrices.id, price.id));
    } else if (!price.active && price.stripePriceId && !freshProduct) {
      const stripePriceId = price.stripePriceId;
      await stripeCallOrMissing("deactivate an old price", () => stripe.prices.update(stripePriceId, { active: false }));
    }
  }

  await ensurePortalConfiguration();
  await audit(actorOf(ctx), "plan.sync", { type: "plan", id: plan.id }, { product: productId });
}
