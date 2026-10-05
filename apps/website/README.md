# Godmode website

The sales site for Godmode — https://usegodmode.com. Astro 7 on Cloudflare Workers, Stripe Checkout for
Godmode Pro ($39/month or $348/year, both with a 7-day free trial), a D1 database for orders and cookieless analytics, and an admin dashboard.

```
src/config/site.ts        prices, guarantee, links, legal details, tracking IDs — edit here first
src/pages/index.astro     the landing page (sections in src/components/sections/)
src/pages/api/checkout    creates the Stripe Checkout Session (form POST or ?plan=… GET)
src/pages/api/stripe-webhook  records orders, subscriptions and refunds (idempotent)
src/pages/checkout/*      success page (license key + downloads) and the abandoned-checkout page
src/pages/admin           sales dashboard (HTTP Basic auth, password = ADMIN_PASSWORD)
src/pages/api/license     license lookup for the desktop app: GET /api/license?key=GM-… (trial/renewal state)
src/pages/api/portal      Stripe customer portal by welcome-page cookie or ?key=GM-…
migrations/               D1 schema (orders, events, leads, stripe_events)
scripts/stripe-setup.mjs  creates products/prices, webhook and customer portal (idempotent)
video/                    HyperFrames sources for the site and ad videos → public/media/
marketing/x-ads-plan.md   X Ads campaigns, targeting, copy and tracking setup
```

## Develop

```bash
cp .dev.vars.example .dev.vars          # Stripe test key, webhook secret, admin password
pnpm db:migrate:local
pnpm dev                                # http://localhost:4321
stripe listen --forward-to localhost:4321/api/stripe-webhook   # prints the local webhook secret
```

## Deploy

```bash
SITE_URL=https://usegodmode.com pnpm deploy   # astro build && wrangler deploy
pnpm db:migrate                                   # after adding a migration
```

Secrets live in Cloudflare (`pnpm wrangler secret put <NAME>`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`ADMIN_PASSWORD`. Public tracking IDs are build-time env vars (`.env`, see `.env.example`).

Feature flags in `wrangler.jsonc` → `vars`:

| Var | Default | Turn on when |
|---|---|---|
| `STRIPE_AUTOMATIC_TAX` | `false` | Stripe Tax has an active registration (otherwise no tax is collected) |
| `STRIPE_MANAGED_PAYMENTS` | `false` | your account is approved for Stripe Managed Payments (Stripe as merchant of record) |
| `STRIPE_REQUIRE_TOS` | `false` | a Terms URL is set in Dashboard → Settings → Public details (adds the terms + EU withdrawal-waiver checkbox) |
| `STRIPE_COLLECT_PROMOTIONS` | `false` | promotional emails are enabled in Dashboard → Settings → Checkout (enables abandoned-cart recovery emails) |

## Going live with Stripe

The site runs live on the Codext GmbH Stripe account (restricted key "Godmode Website", webhook pinned to
`2025-12-15.clover`). To set it up again, or on another account:

1. `stripe login` with the account that should receive payouts.
2. Create a restricted key (write: Products, Prices, Checkout Sessions, Customers, Customer portal, Webhook endpoints;
   read: Charges and Refunds, Subscriptions)
   and run `STRIPE_SECRET_KEY=rk_live_… SITE_URL=https://usegodmode.com pnpm stripe:setup`.
   It prints the new `STRIPE_WEBHOOK_SECRET`. If Stripe answers "maximum of 3 unique versions of live webhook
   endpoints", add `STRIPE_WEBHOOK_API_VERSION=<a version the account's other live webhooks already use>`.
3. `pnpm wrangler secret put STRIPE_SECRET_KEY` and `… STRIPE_WEBHOOK_SECRET` with the live values.
4. In the Stripe Dashboard: public business details, statement descriptor "GODMODE", payment methods, customer
   emails (successful payments + refunds), and — if you want — Stripe Tax, the Terms URL and promotional emails
   (then flip the matching flags above).
5. Start a trial with a real card, check `/admin` (Live), then cancel it in the billing portal (nothing is charged).

## Plans

Prices, the trial length and the guarantee live in `src/config/site.ts`; the Stripe prices are found by lookup key
(`godmode_pro_monthly_usd`, `godmode_pro_yearly_usd`). Lifetime is no longer sold: `/api/checkout?plan=lifetime`
answers 410 / redirects to pricing, and `pnpm stripe:setup` deactivates the old lifetime prices (never deletes them).
Licenses sold earlier (lifetime, and the $50 monthly plan, whose price stays active so it keeps renewing) stay valid.
Free licenses can be issued from `/admin` and don't count toward revenue.

## Analytics

- First-party, cookieless events in D1 (`/api/track`): pageviews, CTA clicks, section views, checkout starts,
  purchases — with UTM source/campaign and whether an X click ID was present. No cookies, no raw IPs.
- The X pixel loads only after the visitor accepts cookies; it reports Checkout initiated, Lead, Pricing viewed
  and Purchase (with value and `conversion_id` = Checkout Session ID for de-duplication).
- UTMs + `twclid` are copied onto every Stripe Checkout Session, so each sale is attributed in `/admin` and in the
  Stripe Dashboard metadata.
