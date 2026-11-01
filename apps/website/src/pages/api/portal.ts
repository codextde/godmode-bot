import type { APIRoute } from 'astro';
import { stripe } from '@/lib/stripe';
import { db } from '@/lib/db';
import { ORDER_COOKIE, verify } from '@/lib/signed';
import { allowed } from '@/lib/limit';
import { isLicenseKey } from '@/lib/license';
import { minLivemode } from '@/lib/entitlement';
import { siteBase } from '@/config/site';

export const prerender = false;

/** The open invoice of a subscription whose payment failed: paying it there reactivates the subscription at once. */
const openInvoiceUrl = async (subscriptionId: string): Promise<string | null> => {
  const sub = await stripe().subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
  const invoice = sub.latest_invoice;
  if (!invoice || typeof invoice === 'string' || invoice.status !== 'open') return null;
  return invoice.hosted_invoice_url ?? null;
};

const openPortal = async (customer: string, returnUrl: string) => {
  const portal = await stripe().billingPortal.sessions.create({ customer, return_url: returnUrl });
  return new Response(null, { status: 303, headers: { location: portal.url, 'cache-control': 'no-store' } });
};

/**
 * Opens the Stripe customer portal for the buyer whose signed order cookie this browser holds, or for the
 * license in ?key=GM-… (the app's "Manage subscription" button). With &pay=1 (a payment that failed) it opens the
 * subscription's open invoice instead when there is one.
 */
export const GET: APIRoute = async ({ url, cookies, request }) => {
  const rawKey = url.searchParams.get('key');
  if (rawKey !== null) {
    const key = rawKey.trim().toUpperCase();
    if (!isLicenseKey(key)) return new Response('Invalid license key', { status: 400 });
    if (!(await allowed('CHECKOUT_LIMIT', request))) return new Response('Too many requests', { status: 429 });
    try {
      const row = await db()
        .prepare('SELECT customer_id, subscription_id FROM orders WHERE license_key = ? AND livemode >= ?')
        .bind(key, minLivemode())
        .first<{ customer_id: string | null; subscription_id: string | null }>();
      if (!row?.customer_id) return new Response('No billing account for this license', { status: 404 });
      if (url.searchParams.get('pay') === '1' && row.subscription_id) {
        const invoice = await openInvoiceUrl(row.subscription_id).catch((e) => {
          console.error('open invoice lookup failed', e);
          return null;
        });
        if (invoice) return new Response(null, { status: 303, headers: { location: invoice, 'cache-control': 'no-store' } });
      }
      return await openPortal(row.customer_id, `${siteBase(url.origin)}/download`);
    } catch (e) {
      console.error('portal failed', e);
      return new Response('Could not open the billing portal. Please email us.', { status: 502 });
    }
  }

  const id = await verify(cookies.get(ORDER_COOKIE)?.value);
  if (!id) return new Response(null, { status: 303, headers: { location: '/checkout/success?expired=1' } });
  if (!(await allowed('CHECKOUT_LIMIT', request))) return new Response('Too many requests', { status: 429 });
  try {
    const session = await stripe().checkout.sessions.retrieve(id);
    const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (!customer) return new Response('No customer for this purchase', { status: 404 });
    return await openPortal(customer, `${siteBase(url.origin)}/checkout/success`);
  } catch (e) {
    console.error('portal failed', e);
    return new Response('Could not open the billing portal. Please email us.', { status: 502 });
  }
};
