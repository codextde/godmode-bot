/**
 * Stripe webhook. The signature is checked on the raw body; an event is recorded in `stripe_events` only after it
 * was handled, so a failed one is retried by Stripe and a redelivered one does nothing. The payload is used only to
 * find the subscription id: the subscription itself is fetched again, because the endpoint's API version may differ
 * from the SDK's and events can arrive out of order.
 */
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { audit, type Actor } from "../audit";
import { db, stripeEvents } from "../db";
import { getSettingsWithSecrets } from "../settings";
import { getStripe, isStripeMissing } from "./stripe";
import { writeSubscription } from "./subscriptions";

const STRIPE_ACTOR: Actor = { id: null, label: "stripe" };

type WebhookResult = { status: number; body: unknown };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  const id = asRecord(value)?.id;
  return typeof id === "string" && id ? id : null;
}

/** The subscription an event is about, read defensively: field names differ between API versions. */
export function subscriptionIdOf(event: Pick<Stripe.Event, "type" | "data">): string | null {
  const object = asRecord(event.data?.object);
  if (!object) return null;
  if (event.type.startsWith("customer.subscription.")) return idOf(object.id);
  if (event.type === "checkout.session.completed") return idOf(object.subscription);
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const details = asRecord(asRecord(object.parent)?.subscription_details);
    // Older API versions put the subscription on the invoice itself.
    return idOf(details?.subscription) ?? idOf(object.subscription);
  }
  return null;
}

async function record(event: Stripe.Event): Promise<void> {
  await db.insert(stripeEvents).values({ id: event.id, type: event.type }).onConflictDoNothing();
}

export async function handleStripeWebhook(rawBody: string, signature: string | null): Promise<WebhookResult> {
  try {
    const { webhookSecret } = await getSettingsWithSecrets("billing");
    // Without a secret nothing can be verified; 503 makes Stripe retry once it is set up.
    if (!webhookSecret) return { status: 503, body: { error: "Stripe webhooks are not set up on this cloud yet.", code: "not_configured" } };
    if (!signature) return { status: 400, body: { error: "The Stripe-Signature header is missing.", code: "bad_signature" } };

    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch {
      return { status: 400, body: { error: "The Stripe signature does not match this webhook's secret.", code: "bad_signature" } };
    }

    const [seen] = await db.select({ id: stripeEvents.id }).from(stripeEvents).where(eq(stripeEvents.id, event.id));
    if (seen) return { status: 200, body: { received: true, duplicate: true } };

    const subscriptionId = subscriptionIdOf(event);
    if (!subscriptionId) {
      await record(event);
      return { status: 200, body: { received: true, ignored: true } };
    }

    const stripe = await getStripe();
    if (!stripe) return { status: 503, body: { error: "Stripe is not connected on this cloud.", code: "not_configured" } };

    let subscription: Stripe.Subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (err) {
      // Deleted (or from the other mode): nothing to mirror. Anything else is retried by Stripe.
      if (!isStripeMissing(err)) throw err;
      await record(event);
      return { status: 200, body: { received: true, ignored: true } };
    }

    const outcome = await writeSubscription(subscription);
    if (outcome.row) {
      await audit(STRIPE_ACTOR, "billing.webhook", { type: "user", id: outcome.userId }, {
        event: event.type,
        subscription: subscription.id,
        status: outcome.row.status,
      });
    } else if (outcome.reason === "deleted_user" && outcome.userId) {
      await audit(STRIPE_ACTOR, "billing.webhook", { type: "user", id: outcome.userId }, {
        event: event.type,
        subscription: subscription.id,
        ignored: "The account no longer exists.",
      });
    } else if (outcome.reason === "customer_mismatch") {
      console.warn(`[billing] ignored ${event.type} for ${subscription.id}: its customer belongs to no account here.`);
    }
    await record(event);
    return { status: 200, body: { received: true, ignored: outcome.row === null } };
  } catch (err) {
    console.error("[billing] webhook failed:", err instanceof Error ? err.message : err);
    return { status: 500, body: { error: "The event could not be processed. Stripe will send it again.", code: "internal" } };
  }
}
