import { env } from 'cloudflare:workers';
import type Stripe from 'stripe';
import { stripe } from './stripe';

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

/** Epoch ms from a Stripe timestamp (seconds), or null. */
const ms = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? v * 1000 : null);

/**
 * Mirrors a subscription's current state (fetched fresh from Stripe, so event order doesn't matter).
 * `status` keeps the coarse license state; `sub_status`, `trial_end`, `period_end` and `cancel_at_period_end`
 * carry Stripe's details for the license API and the dashboard.
 */
export async function syncSubscription(sub: Stripe.Subscription) {
  const status =
    sub.status === 'active' || sub.status === 'trialing'
      ? 'paid'
      : sub.status === 'past_due' || sub.status === 'unpaid' || sub.status === 'paused'
        ? 'past_due'
        : sub.status === 'canceled' || sub.status === 'incomplete_expired'
          ? 'canceled'
          : null;
  // Since the 2025 "basil" API versions the billing period lives on the subscription item.
  const legacy = sub as unknown as { current_period_end?: number | null };
  const periodEnd = ms(sub.items?.data?.[0]?.current_period_end ?? legacy.current_period_end);
  const cancelling = sub.status !== 'canceled' && (sub.cancel_at_period_end || Boolean(sub.cancel_at));
  await db()
    .prepare(
      `UPDATE orders SET
         status = CASE WHEN ?1 IS NULL OR status IN ('open', 'refunded') THEN status ELSE ?1 END,
         sub_status = ?2, trial_end = ?3, period_end = COALESCE(?4, period_end), cancel_at_period_end = ?5
       WHERE subscription_id = ?6`,
    )
    .bind(status, sub.status, ms(sub.trial_end), periodEnd, cancelling ? 1 : 0, sub.id)
    .run();
}

/** How long a started Founder Lifetime checkout holds its place under the cap (its Stripe session expires then). */
export const LIFETIME_HOLD_MS = 31 * 60 * 1000;

/**
 * Founder Lifetime licenses taken: paid (or paying by bank transfer), not free, from the Stripe mode the site runs
 * in — plus checkouts started in the last half hour, so the cap can't be oversold by buyers paying at once.
 */
export async function lifetimeSold(minLivemode: number): Promise<number> {
  const row = await db()
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
       WHERE plan = 'lifetime' AND COALESCE(comp, 0) = 0 AND livemode >= ?
         AND (status IN ('paid', 'pending') OR (status = 'open' AND created_at > ?))`,
    )
    .bind(minLivemode, Date.now() - LIFETIME_HOLD_MS)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** A free license issued from /admin. It never touches Stripe and doesn't count toward revenue or the cap. */
export async function insertComp(o: { email: string; name: string | null; licenseKey: string; livemode: number }) {
  const id = `comp_${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const now = Date.now();
  await db()
    .prepare(
      `INSERT INTO orders (session_id, created_at, paid_at, plan, mode, status, email, name, license_key, livemode, comp)
       VALUES (?, ?, ?, 'lifetime', 'comp', 'paid', ?, ?, ?, ?, 1)`,
    )
    .bind(id, now, now, o.email, o.name, o.licenseKey, o.livemode)
    .run();
  return id;
}

/** The subscription a charge paid for, via its invoice (on the charge in older API versions, else via invoice payments). */
async function subscriptionForCharge(charge: Stripe.Charge, pi: string | null): Promise<string | null> {
  const legacyCharge = charge as unknown as { invoice?: string | { id: string } | null };
  let invoiceId = idOf(legacyCharge.invoice);
  if (!invoiceId && pi) {
    const payments = await stripe().invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: pi }, limit: 1 });
    invoiceId = idOf(payments.data[0]?.invoice as string | { id: string } | null | undefined);
  }
  if (!invoiceId) return null;
  const invoice = await stripe().invoices.retrieve(invoiceId);
  const legacyInvoice = invoice as unknown as { subscription?: string | { id: string } | null };
  return idOf(invoice.parent?.subscription_details?.subscription) ?? idOf(legacyInvoice.subscription);
}

/**
 * Revokes the license behind a refunded or charged-back payment. A lifetime order owns its PaymentIntent and is
 * revoked directly. A subscription charge is traced to its subscription: only a canceled subscription loses its
 * license; a live one (e.g. a goodwill refund of one renewal) keeps whatever state Stripe reports.
 */
export async function revokeForCharge(charge: Stripe.Charge) {
  const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : (charge.payment_intent?.id ?? null);
  if (pi) {
    const res = await db().prepare(`UPDATE orders SET status = 'refunded' WHERE payment_intent_id = ?`).bind(pi).run();
    if (res.meta.changes > 0) return;
  }
  const subId = await subscriptionForCharge(charge, pi);
  if (!subId) return;
  const sub = await stripe().subscriptions.retrieve(subId);
  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
    await db()
      .prepare(`UPDATE orders SET status = 'refunded', sub_status = ? WHERE subscription_id = ? AND status <> 'open'`)
      .bind(sub.status, subId)
      .run();
  } else {
    await syncSubscription(sub);
  }
}
