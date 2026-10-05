// Everything a marketer might want to change lives here: prices, offer wording, links, legal
// details and tracking IDs. Tracking IDs come from PUBLIC_* build-time env vars (see .env.example).

export const SITE = {
  name: 'Godmode',
  product: 'Godmode Bot',
  url: import.meta.env.SITE ?? 'https://usegodmode.com',
  title: 'Godmode — the AI coworker that works like a human on your Mac',
  description:
    'Godmode turns Claude Opus 5.5 into a coworker that uses your computer like you do: your browser and logins, apps in the background, even its own Mac. Hand over the work. Get it back done.',
  email: 'kontakt@codext.de',
  model: 'Claude Opus 5.5',
} as const;

export type Plan = 'monthly' | 'yearly' | 'lifetime';

export const isPlan = (v: unknown): v is Plan => v === 'monthly' || v === 'yearly' || v === 'lifetime';

const LIFETIME_CAP = 100;

export const PRICING = {
  currency: 'USD',
  trialDays: 7,
  guaranteeDays: 14,
  // Founder Lifetime is sold to the first `lifetimeCap` buyers only (paid, non-comp orders).
  lifetimeCap: LIFETIME_CAP,
  plans: {
    monthly: {
      id: 'monthly' as Plan,
      name: 'Pro Monthly',
      price: 39,
      perMonth: 39,
      interval: 'month',
      lookupKey: 'godmode_pro_monthly_usd',
    },
    yearly: {
      id: 'yearly' as Plan,
      name: 'Pro Yearly',
      price: 348,
      perMonth: 29,
      interval: 'year',
      lookupKey: 'godmode_pro_yearly_usd',
    },
    lifetime: {
      id: 'lifetime' as Plan,
      name: 'Founder Lifetime',
      price: 499,
      perMonth: null,
      interval: null,
      lookupKey: 'godmode_founder_lifetime_usd',
    },
  },
  founderNote:
    `Founder Lifetime is limited to the first ${LIFETIME_CAP} licenses and won’t come back once they’re gone. Every license already sold stays valid for good.`,
} as const;

/** Percent saved by paying yearly instead of monthly, rounded down so the claim is never overstated. */
export const yearlySavings = Math.floor((1 - PRICING.plans.yearly.price / (PRICING.plans.monthly.price * 12)) * 100);

/** Short price line for a plan, e.g. "$39/month", "$348/year", "$499 once". */
export function priceLabel(plan: Plan): string {
  const p = PRICING.plans[plan];
  return p.interval ? `$${p.price}/${p.interval}` : `$${p.price} once`;
}

/**
 * The last calendar day (UTC) on which a trial started now can safely be cancelled. One day earlier than the
 * real end, so the date is never too late in any time zone.
 */
export function trialCancelBy(from = Date.now()): string {
  return new Date(from + (PRICING.trialDays - 1) * 86400000).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export const FOUNDER = {
  name: 'Daniel Ehrhardt',
  role: 'Founder, Codext GmbH',
} as const;

export const LEGAL = {
  company: 'Codext GmbH',
  street: 'Frankenstraße 10',
  city: '74549 Wolpertshausen',
  country: 'Germany',
  registry: 'HRB 772091, Amtsgericht Stuttgart',
  director: 'Daniel Ehrhardt',
  vatId: 'DE327501500',
  phone: '+49 7904 5203106',
  email: 'kontakt@codext.de',
  // Bump by hand only when the legal texts change.
  updated: 'October 5, 2026',
} as const;

export const TRACKING = {
  // X (Twitter) pixel: base pixel ID + event IDs from X Ads → Tools → Events manager.
  xPixelId: import.meta.env.PUBLIC_X_PIXEL_ID ?? '',
  xEvents: {
    purchase: import.meta.env.PUBLIC_X_EVENT_PURCHASE ?? '',
    checkout: import.meta.env.PUBLIC_X_EVENT_CHECKOUT ?? '',
    lead: import.meta.env.PUBLIC_X_EVENT_LEAD ?? '',
    pricing: import.meta.env.PUBLIC_X_EVENT_PRICING ?? '',
  },
  // Optional: Cloudflare Web Analytics beacon token (cookieless).
  cfBeacon: import.meta.env.PUBLIC_CF_BEACON ?? '',
} as const;
