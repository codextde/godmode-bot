import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import { env } from 'cloudflare:workers';
import { cryptoProvider, stripe } from '@/lib/stripe';
import { db, revokeForCharge, syncSubscription, upsertFromSession } from '@/lib/db';

export const prerender = false;

/**
 * Stripe webhook. Subscribe the endpoint to:
 *   checkout.session.completed, checkout.session.async_payment_succeeded,
 *   checkout.session.async_payment_failed, checkout.session.expired,
 *   customer.subscription.updated, customer.subscription.deleted, charge.refunded, charge.dispute.closed
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
      break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      // Stripe doesn't guarantee event order; read the subscription's current state instead.
      await syncSubscription(await stripe().subscriptions.retrieve(event.data.object.id));
      break;
    case 'charge.refunded':
      if (event.data.object.refunded) await revokeForCharge(event.data.object);
      break;
    case 'charge.dispute.closed': {
      const dispute = event.data.object;
      if (dispute.status === 'lost') {
        const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id;
        await revokeForCharge(await stripe().charges.retrieve(chargeId));
      }
      break;
    }
    default:
      break;
  }
}
