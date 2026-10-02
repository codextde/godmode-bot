#!/usr/bin/env node
// Idempotent Stripe setup for the Godmode website:
//   • products + prices (looked up by lookup_key, so re-running never duplicates them)
//   • the webhook endpoint for /api/stripe-webhook (prints the signing secret once, on creation)
//   • a customer-portal configuration (cancel subscription, update card, invoices)
//
// Usage:
//   STRIPE_SECRET_KEY=sk_test_… SITE_URL=https://godmode.codext.de node scripts/stripe-setup.mjs
//   (use a live key for production; it's safe to run again)
//   STRIPE_WEBHOOK_API_VERSION=… pins the webhook's payload version — needed when the account already has live
//   webhooks on 3 other API versions (Stripe's limit); the handler only reads fields that are stable across versions.

import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
const site = (process.env.SITE_URL ?? 'https://godmode.codext.de').replace(/\/$/, '');
if (!key) {
  console.error('Set STRIPE_SECRET_KEY');
  process.exit(1);
}
const stripe = new Stripe(key);
const mode = key.includes('_live_') ? 'LIVE' : 'TEST';
const webhookApiVersion = process.env.STRIPE_WEBHOOK_API_VERSION ?? '2026-09-30.endive';

const PLANS = [
  {
    lookup_key: 'godmode_lifetime_usd',
    product: {
      name: 'Godmode Bot — Lifetime',
      description: 'Lifetime license for Godmode Bot, the AI coworker that works like a human on your computer. All updates included.',
      metadata: { plan: 'lifetime' },
    },
    price: { unit_amount: 50000, currency: 'usd', tax_behavior: 'inclusive' },
  },
  {
    lookup_key: 'godmode_monthly_usd',
    product: {
      name: 'Godmode Bot — Monthly',
      description: 'Monthly subscription to Godmode Bot, the AI coworker that works like a human on your computer. Cancel anytime.',
      metadata: { plan: 'monthly' },
    },
    price: { unit_amount: 5000, currency: 'usd', tax_behavior: 'inclusive', recurring: { interval: 'month' } },
  },
];

const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.refunded',
  'charge.dispute.closed',
];

console.log(`Stripe setup (${mode} mode) for ${site}\n`);

for (const plan of PLANS) {
  const existing = await stripe.prices.list({ lookup_keys: [plan.lookup_key], active: true, limit: 1 });
  if (existing.data[0]) {
    console.log(`✓ price ${plan.lookup_key} exists: ${existing.data[0].id}`);
    continue;
  }
  const product = await stripe.products.create({ ...plan.product, tax_code: 'txcd_10202000' });
  const price = await stripe.prices.create({ ...plan.price, product: product.id, lookup_key: plan.lookup_key });
  console.log(`+ created ${plan.product.name}: product ${product.id}, price ${price.id}`);
}

const url = `${site}/api/stripe-webhook`;
const hooks = await stripe.webhookEndpoints.list({ limit: 100 });
const hook = hooks.data.find((h) => h.url === url);
if (hook) {
  const missing = WEBHOOK_EVENTS.filter((e) => !hook.enabled_events.includes(e) && !hook.enabled_events.includes('*'));
  if (missing.length) {
    await stripe.webhookEndpoints.update(hook.id, { enabled_events: WEBHOOK_EVENTS });
    console.log(`~ webhook ${hook.id} updated with ${missing.join(', ')}`);
  } else console.log(`✓ webhook exists: ${hook.id} (its signing secret is in the Dashboard)`);
} else {
  const created = await stripe.webhookEndpoints.create({
    url,
    api_version: webhookApiVersion,
    enabled_events: WEBHOOK_EVENTS,
    description: 'Godmode website — orders, licenses, subscriptions',
  });
  console.log(`+ webhook ${created.id} → ${url}`);
  console.log(`\n  STRIPE_WEBHOOK_SECRET=${created.secret}\n  (store it: pnpm wrangler secret put STRIPE_WEBHOOK_SECRET)\n`);
}

const portals = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
const portalFeatures = {
  customer_update: { enabled: true, allowed_updates: ['address', 'tax_id', 'name'] },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: true, mode: 'at_period_end' },
};
if (portals.data[0]) {
  // The default portal is account-wide (other products on the account use it too), so never rewrite it — only
  // check that what /api/portal relies on is on. Sessions pass their own return_url.
  const p = portals.data[0];
  const off = Object.keys(portalFeatures).filter((f) => !p.features[f]?.enabled);
  if (off.length) console.warn(`! customer portal ${p.id} exists but has ${off.join(', ')} off — enable in the Dashboard`);
  else console.log(`✓ customer portal exists: ${p.id}`);
} else {
  const c = await stripe.billingPortal.configurations.create({
    features: portalFeatures,
    business_profile: { headline: 'Godmode — manage your subscription and invoices' },
    default_return_url: site,
  });
  console.log(`+ customer portal configured (${c.id})`);
}

console.log('\nDone.');
