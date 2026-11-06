import type { APIRoute, APIContext } from 'astro';
import { STRIPE_PAYOUT_COUNTRIES } from '@/config/partners';
import { siteBase } from '@/config/site';
import { db } from '@/lib/db';
import { partnerIdFromCookies, sameOrigin } from '@/lib/partner-auth';
import { partnerById } from '@/lib/partners';
import { stripe } from '@/lib/stripe';

export const prerender = false;

const go = (location: string) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
const back = (state: string) => go(`/partners/dashboard?connect=${state}#payouts`);

/**
 * Stripe payouts for a partner: creates their Stripe Express account (transfers only) and sends them to Stripe's
 * onboarding, or to their Express dashboard once that is done. GET is Stripe's refresh_url for an expired link.
 * Accounts use Stripe's full service agreement: cross-border payouts from the German platform (to the US, UK, EEA,
 * Canada and Switzerland) don't work with the recipient agreement.
 */
async function connect({ request, url, cookies }: APIContext, create: boolean) {
  if (create && !sameOrigin(request, url)) return back('error');
  const id = await partnerIdFromCookies(cookies);
  const p = id ? await partnerById(id) : null;
  if (!p || p.status === 'banned') return go('/partners/login');
  if (!p.country || !STRIPE_PAYOUT_COUNTRIES.has(p.country)) return back('country');

  const base = siteBase(url.origin);
  try {
    let account = p.stripe_account_id;
    if (!account) {
      if (!create) return back('');
      const created = await stripe().accounts.create(
        {
          type: 'express',
          country: p.country,
          email: p.email,
          capabilities: { transfers: { requested: true } },
          business_profile: { product_description: 'Short videos about Godmode (Godmode Partners affiliate)' },
          metadata: { partner_id: String(p.id), partner_code: p.code },
        },
        { idempotencyKey: `partner_connect_${p.id}_${new Date().toISOString().slice(0, 10)}` },
      );
      account = created.id;
      await db()
        .prepare(`UPDATE partners SET stripe_account_id = ?, payout_method = COALESCE(payout_method, 'stripe') WHERE id = ?`)
        .bind(account, p.id)
        .run();
    } else {
      const acct = await stripe().accounts.retrieve(account);
      if (acct.details_submitted) return go((await stripe().accounts.createLoginLink(account)).url);
    }
    const link = await stripe().accountLinks.create({
      account,
      type: 'account_onboarding',
      refresh_url: `${base}/api/partners/connect`,
      return_url: `${base}/partners/dashboard?connect=done#payouts`,
    });
    return go(link.url);
  } catch (e) {
    // Connect isn't switched on for the account yet (or Stripe is down): the dashboard offers PayPal instead.
    console.error('partner connect failed', p.id, e instanceof Error ? e.message : e);
    return back('unavailable');
  }
}

export const POST: APIRoute = (ctx) => connect(ctx, true);
export const GET: APIRoute = (ctx) => connect(ctx, false);
