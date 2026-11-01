import type { APIRoute } from 'astro';
import { recordSiteOptIn } from '@/lib/db';
import { allowed } from '@/lib/limit';
import { normalizeEmail } from '@/lib/recovery';
import { checkoutFromCookie } from '@/lib/signed';
import { stripe } from '@/lib/stripe';

export const prerender = false;

/**
 * "Email me this checkout" from /checkout/canceled: an explicit opt-in for the one recovery email. The checkout is
 * the one this browser opened last (signed cookie); it is expired right away, so its recovery link exists and the
 * email goes out about a day later.
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  if (!(await allowed('CHECKOUT_LIMIT', request))) return Response.json({ error: 'rate_limited' }, { status: 429 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const email = normalizeEmail(body?.email);
  if (!email) return Response.json({ error: 'invalid_email' }, { status: 400 });
  if (body?.consent !== true) return Response.json({ error: 'consent_required' }, { status: 400 });

  const sessionId = await checkoutFromCookie(cookies);
  if (!sessionId || !(await recordSiteOptIn(sessionId, email))) return Response.json({ error: 'no_checkout' }, { status: 404 });

  try {
    const s = await stripe().checkout.sessions.retrieve(sessionId);
    if (s.status === 'open') await stripe().checkout.sessions.expire(sessionId);
  } catch (e) {
    console.warn('could not expire checkout for recovery', sessionId, e);
  }
  return Response.json({ ok: true });
};
