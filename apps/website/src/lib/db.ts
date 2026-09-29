import { env } from 'cloudflare:workers';
import type Stripe from 'stripe';

export const db = () => env.DB;

export type Attribution = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  twclid?: string;
  referrer?: string;
  landing?: string;
};

const clip = (v: unknown, n = 200) => (typeof v === 'string' && v ? v.slice(0, n) : null);

export async function insertOpenOrder(o: {
  sessionId: string;
  plan: string;
  mode: string;
  licenseKey: string;
  livemode: boolean;
  attribution: Attribution;
}) {
  const a = o.attribution;
  await db()
    .prepare(
      `INSERT OR IGNORE INTO orders (session_id, created_at, plan, mode, status, license_key, utm_source, utm_medium,
        utm_campaign, utm_content, twclid, referrer, landing, livemode)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      o.sessionId,
      Date.now(),
      o.plan,
      o.mode,
      o.licenseKey,
      clip(a.utm_source, 120),
      clip(a.utm_medium, 120),
      clip(a.utm_campaign, 120),
      clip(a.utm_content, 120),
      clip(a.twclid),
      clip(a.referrer),
      clip(a.landing),
      o.livemode ? 1 : 0,
    )
    .run();
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : (v?.id ?? null));

/**
 * Records a Checkout Session's outcome. Idempotent: the webhook and the success page both call it.
 * A session only ever moves an order forward out of its pre-payment states (open → pending → paid/failed);
 * once paid, the order's status belongs to subscription, refund and dispute events alone.
 */
export async function upsertFromSession(s: Stripe.Checkout.Session, status: 'paid' | 'pending' | 'failed' | 'expired') {
  const m = s.metadata ?? {};
  const email = s.customer_details?.email ?? s.customer_email ?? null;
  await db()
    .prepare(
      `INSERT INTO orders (session_id, created_at, paid_at, plan, mode, status, amount_total, currency, email, name, country,
         customer_id, subscription_id, payment_intent_id, license_key, utm_source, utm_medium, utm_campaign, utm_content,
         twclid, referrer, landing, livemode)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
       ON CONFLICT(session_id) DO UPDATE SET
         status = CASE WHEN orders.status IN ('open', 'expired') THEN excluded.status
                       WHEN orders.status = 'pending' AND excluded.status IN ('paid', 'failed') THEN excluded.status
                       ELSE orders.status END,
         paid_at = COALESCE(orders.paid_at, excluded.paid_at),
         amount_total = excluded.amount_total, currency = excluded.currency,
         email = COALESCE(excluded.email, orders.email), name = COALESCE(excluded.name, orders.name),
         country = COALESCE(excluded.country, orders.country),
         customer_id = COALESCE(excluded.customer_id, orders.customer_id),
         subscription_id = COALESCE(excluded.subscription_id, orders.subscription_id),
         payment_intent_id = COALESCE(excluded.payment_intent_id, orders.payment_intent_id),
         livemode = excluded.livemode`,
    )
    .bind(
      s.id,
      s.created * 1000,
      status === 'paid' ? Date.now() : null,
      m.plan ?? (s.mode === 'subscription' ? 'monthly' : 'lifetime'),
      s.mode,
      status,
      s.amount_total,
      s.currency,
      email,
      s.customer_details?.name ?? null,
      s.customer_details?.address?.country ?? null,
      idOf(s.customer),
      idOf(s.subscription),
      idOf(s.payment_intent),
      m.license_key ?? null,
      clip(m.utm_source, 120),
      clip(m.utm_medium, 120),
      clip(m.utm_campaign, 120),
      clip(m.utm_content, 120),
      clip(m.twclid),
      clip(m.referrer),
      clip(m.landing),
      s.livemode ? 1 : 0,
    )
    .run();
}

/** Mirrors a subscription's current state (fetched fresh from Stripe, so event order doesn't matter). */
export async function syncSubscription(sub: Stripe.Subscription) {
  const status =
    sub.status === 'active' || sub.status === 'trialing'
      ? 'paid'
      : sub.status === 'past_due' || sub.status === 'unpaid' || sub.status === 'paused'
        ? 'past_due'
        : sub.status === 'canceled' || sub.status === 'incomplete_expired'
          ? 'canceled'
          : null;
  if (!status) return;
  await db()
    .prepare(`UPDATE orders SET status = ? WHERE subscription_id = ? AND status NOT IN ('open', 'refunded')`)
    .bind(status, sub.id)
    .run();
}

/**
 * Revokes the license behind a refunded or charged-back payment: the lifetime order that owns the
 * PaymentIntent, or — for subscription invoices, whose PaymentIntents we don't store — the customer's
 * monthly order.
 */
export async function revokeForCharge(charge: Stripe.Charge) {
  const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  const customer = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
  if (pi) {
    const res = await db().prepare(`UPDATE orders SET status = 'refunded' WHERE payment_intent_id = ?`).bind(pi).run();
    if (res.meta.changes > 0) return;
  }
  if (customer) {
    await db()
      .prepare(`UPDATE orders SET status = 'refunded' WHERE customer_id = ? AND plan = 'monthly' AND status <> 'open'`)
      .bind(customer)
      .run();
  }
}
