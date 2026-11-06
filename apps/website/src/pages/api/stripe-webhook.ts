import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import { env } from 'cloudflare:workers';
import { cryptoProvider, stripe } from '@/lib/stripe';
import { db, recordExpiredCheckout, revokeForCharge, syncSubscription, upsertFromSession } from '@/lib/db';
import { sendWelcome } from '@/lib/mail';
import { endReferral, handleInvoicePaid, referralFromSession, reverseCommission } from '@/lib/partners';

export const prerender = false;

/**
 * Stripe webhook. Subscribe the endpoint to:
 *   checkout.session.completed, checkout.session.async_payment_succeeded,
 *   checkout.session.async_payment_failed, checkout.session.expired,
 *   customer.subscription.updated, customer.subscription.deleted, charge.refunded, charge.dispute.closed, invoice.paid
 * (scripts/stripe-setup.mjs does this for you).
 */
export const POST: APIRoute = async ({ request }) => {
  const signature = request.headers.get('stripe-signature');
  if (!signature || !env.STRIPE_WEBHOOK_SECRET) return new Response('missing signature', { status: 400 });

  const payload = await request.text();
  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(
      payload,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      cryptoProvider,
    );
  } catch (e) {
    console.warn('invalid webhook signature', e);
    return new Response('invalid signature', { status: 400 });
  }

  const seen = await db().prepare('SELECT 1 FROM stripe_events WHERE id = ?').bind(event.id).first();
  if (seen) return new Response('ok (duplicate)');

  try {
    await handle(event);
  } catch (e) {
    console.error('webhook handling failed', event.type, e);
    // 500 makes Stripe retry later.
    return new Response('handler error', { status: 500 });
  }

  await db()
    .prepare('INSERT OR IGNORE INTO stripe_events (id, type, ts) VALUES (?, ?, ?)')
    .bind(event.id, event.type, Date.now())
    .run();
  return new Response('ok');
};

/** Only sessions created by this site carry a license key; other sales on the account are ignored. */
const ours = (s: Stripe.Checkout.Session) => Boolean(s.metadata?.license_key);

async function handle(event: Stripe.Event) {
  if (event.type.startsWith('checkout.session.') && !ours(event.data.object as Stripe.Checkout.Session)) return;
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';
      await upsertFromSession(s, paid ? 'paid' : 'pending');
      // Trials complete without a payment; store the trial end right away instead of waiting for an update event.
      const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
      if (s.mode === 'subscription' && subId) await syncSubscription(await stripe().subscriptions.retrieve(subId));
      await referralFromSession(s);
      if (paid) await sendWelcome(s.id).catch((e) => console.error('welcome email failed', e));
      break;
    }
    case 'checkout.session.async_payment_succeeded':
      await upsertFromSession(event.data.object, 'paid');
      break;
    case 'checkout.session.async_payment_failed':
      await upsertFromSession(event.data.object, 'failed');
      break;
    case 'checkout.session.expired':
      await upsertFromSession(event.data.object, 'expired');
      await recordExpiredCheckout(event.data.object);
      break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // Stripe doesn't guarantee event order; read the subscription's current state instead.
      const sub = await stripe().subscriptions.retrieve(event.data.object.id);
      await syncSubscription(sub);
      if (sub.status === 'canceled' || sub.status === 'incomplete_expired') await endReferral(sub.id);
      break;
    }
    case 'invoice.paid':
      await handleInvoicePaid(event.data.object);
      break;
    case 'charge.refunded': {
      const charge = event.data.object;
      if (charge.amount > 0) await reverseCommission(charge.id, charge.amount_refunded / charge.amount, `refund:${charge.amount_refunded}`);
      if (charge.refunded) await revokeForCharge(charge);
      break;
    }
    case 'charge.dispute.closed': {
      const dispute = event.data.object;
      if (dispute.status === 'lost') {
        const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id;
        await reverseCommission(chargeId, 1, 'dispute');
        await revokeForCharge(await stripe().charges.retrieve(chargeId));
      }
      break;
    }
    default:
      break;
  }
}
