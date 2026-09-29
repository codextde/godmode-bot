import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import { env } from 'cloudflare:workers';
import { PRICING, type Plan } from '@/config/site';
import { flag, priceFor, stripe } from '@/lib/stripe';
import { newLicenseKey } from '@/lib/license';
import { insertOpenOrder, type Attribution } from '@/lib/db';
import { allowed, BOTS } from '@/lib/limit';

export const prerender = false;

// Tags every session from this site so it can be filtered in the Stripe Dashboard.
const INTEGRATION_ID = 'godmode_site_checkout_qmtrzvkb';
const ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'twclid', 'referrer', 'landing'] as const;

async function readInput(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v ?? '')]));
  }
  const form = await request.formData();
  return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}

export const POST: APIRoute = async ({ request, url }) => {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  let plan: Plan = 'lifetime';

  try {
    if (!(await allowed('CHECKOUT_LIMIT', request))) {
      return wantsJson
        ? Response.json({ error: 'rate_limited' }, { status: 429 })
        : new Response(null, { status: 303, headers: { location: `/checkout/canceled?plan=${plan}&error=1` } });
    }
    const input = await readInput(request);
    plan = input.plan === 'monthly' ? 'monthly' : 'lifetime';
    const offer = PRICING.plans[plan];
    const attribution: Attribution = {};
    for (const k of ATTR_KEYS) if (input[k]) attribution[k] = input[k].slice(0, 200);

    const licenseKey = newLicenseKey();
    const metadata: Record<string, string> = { plan, license_key: licenseKey, ...attribution };
    const mode = plan === 'monthly' ? 'subscription' : 'payment';
    const managed = flag(env.STRIPE_MANAGED_PAYMENTS);
    const requireTos = flag(env.STRIPE_REQUIRE_TOS);
    // Needs "promotional emails" accepted under Dashboard → Settings → Checkout first.
    const promotions = flag(env.STRIPE_COLLECT_PROMOTIONS);

    const params: Stripe.Checkout.SessionCreateParams = {
      mode,
      line_items: [{ price: await priceFor(plan), quantity: 1 }],
      success_url: `${url.origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${url.origin}/checkout/canceled?plan=${plan}`,
      integration_identifier: INTEGRATION_ID,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      metadata,
      ...(promotions || requireTos
        ? {
            consent_collection: {
              ...(promotions ? { promotions: 'auto' as const } : {}),
              ...(requireTos ? { terms_of_service: 'required' as const } : {}),
            },
          }
        : {}),
      custom_text: {
        submit: {
          message: `Instant access after payment. ${PRICING.guaranteeDays}-day money-back guarantee — just email us.`,
        },
        ...(requireTos
          ? {
              terms_of_service_acceptance: {
                message: `I agree to the [Terms](${url.origin}/legal/terms) and ask Codext GmbH to deliver the software right away. I understand that I lose my statutory right of withdrawal once delivery has begun; the ${PRICING.guaranteeDays}-day money-back guarantee still applies.`,
              },
            }
          : {}),
      },
    };

    if (managed) {
      // Stripe as merchant of record handles tax and invoices itself.
      params.managed_payments = { enabled: true };
    } else {
      params.tax_id_collection = { enabled: true };
      if (flag(env.STRIPE_AUTOMATIC_TAX)) params.automatic_tax = { enabled: true };
    }

    if (mode === 'payment') {
      params.customer_creation = 'always';
      params.payment_intent_data = { metadata, description: `${offer.name} license — Godmode Bot` };
      if (!managed) {
        params.invoice_creation = {
          enabled: true,
          invoice_data: {
            description: 'Godmode Bot — Lifetime license',
            metadata: { license_key: licenseKey },
            footer: `Your license key: ${licenseKey}`,
          },
        };
      }
    } else {
      // Shown in the customer portal, so subscribers can always find their key there.
      params.subscription_data = { metadata, description: `Godmode Bot — Monthly · License ${licenseKey}` };
    }

    const session = await stripe().checkout.sessions.create(params);

    try {
      await insertOpenOrder({ sessionId: session.id, plan, mode, licenseKey, livemode: session.livemode, attribution });
    } catch (e) {
      console.error('could not record open order', e);
    }

    if (wantsJson) return Response.json({ url: session.url });
    return new Response(null, { status: 303, headers: { location: session.url! } });
  } catch (e) {
    console.error('checkout failed:', e instanceof Error ? e.message : e);
    if (wantsJson) return Response.json({ error: 'checkout_unavailable' }, { status: 503 });
    return new Response(null, { status: 303, headers: { location: `/checkout/canceled?plan=${plan}&error=1` } });
  }
};

// A plain GET (e.g. a link in an ad or email) starts checkout too: /api/checkout?plan=monthly.
// Link previewers and scanners get the pricing section instead of a Stripe session.
export const GET: APIRoute = async (ctx) => {
  const plan = ctx.url.searchParams.get('plan') === 'monthly' ? 'monthly' : 'lifetime';
  if (BOTS.test(ctx.request.headers.get('user-agent') ?? '')) {
    return new Response(null, { status: 303, headers: { location: '/#pricing' } });
  }
  const form = new URLSearchParams({ plan });
  for (const k of ATTR_KEYS) {
    const v = ctx.url.searchParams.get(k);
    if (v) form.set(k, v);
  }
  const request = new Request(ctx.request.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  return POST({ ...ctx, request });
};
