import type { APIRoute } from 'astro';
import { stripe } from '@/lib/stripe';
import { ORDER_COOKIE, verify } from '@/lib/signed';
import { allowed } from '@/lib/limit';

export const prerender = false;

/** Opens the Stripe customer portal for the buyer whose signed order cookie this browser holds. */
export const GET: APIRoute = async ({ url, cookies, request }) => {
  const id = await verify(cookies.get(ORDER_COOKIE)?.value);
  if (!id) return new Response(null, { status: 303, headers: { location: '/checkout/success?expired=1' } });
  if (!(await allowed('CHECKOUT_LIMIT', request))) return new Response('Too many requests', { status: 429 });
  try {
    const session = await stripe().checkout.sessions.retrieve(id);
    const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (!customer) return new Response('No customer for this purchase', { status: 404 });
    const portal = await stripe().billingPortal.sessions.create({ customer, return_url: `${url.origin}/checkout/success` });
    return new Response(null, { status: 303, headers: { location: portal.url } });
  } catch (e) {
    console.error('portal failed', e);
    return new Response('Could not open the billing portal. Please email us.', { status: 502 });
  }
};
