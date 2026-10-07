// Everything a marketer might want to change lives here: prices, offer wording, links, legal
// details and tracking IDs. Tracking IDs come from PUBLIC_* build-time env vars (see .env.example).

export const SITE = {
  name: 'Godmode',
  product: 'Godmode Bot',
  url: import.meta.env.SITE ?? 'https://usegodmode.com',
  title: 'Godmode — like Grok Bot, but with Claude',
  description:
    'Godmode is like Grok Bot, but with Claude: Claude Opus 5.5 as a coworker that uses your own computer like you do. Your browser and logins, apps in the background, even its own Mac. Hand over the work. Get it back done.',
  email: 'kontakt@codext.de',
  model: 'Claude Opus 5.5',
} as const;

/**
 * Base URL for links handed to Stripe (success/cancel/return URLs). Always the canonical site in production, so a
 * request's Host header can't steer buyers elsewhere; the local origin only in `astro dev`.
 */
export const siteBase = (origin: string) => (import.meta.env.DEV ? origin : SITE.url.replace(/\/$/, ''));

/** Plans on sale. Older orders may also carry `lifetime` (licenses sold before, and free licenses from /admin). */
export type Plan = 'monthly' | 'yearly';

export const isPlan = (v: unknown): v is Plan => v === 'monthly' || v === 'yearly';

export const PRICING = {
  currency: 'USD',
  trialDays: 14,
  guaranteeDays: 14,
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
  },
} as const;

/**
 * Founding 100: the launch offer. Seats are checkouts started after `start` (see foundingTaken). Subscriptions keep
 * their Stripe price, so the price lock holds as long as founders aren't migrated to a new price.
 */
export const FOUNDING = {
  seats: 100,
  // Below this many seats taken the page shows the deadline instead of the seat count.
  showCountFrom: 10,
  start: Date.UTC(2026, 9, 5, 20, 0),
  // End of October 31 in US Pacific time, so the deadline is never early anywhere.
  end: Date.UTC(2026, 10, 1, 7, 0),
  endLabel: 'October 31',
  setupMinutes: 20,
  setupAutomations: 3,
  runningHours: 48,
  outcomeHours: 10,
  outcomeDays: 30,
  listPrice: { monthly: 59, yearly: 49 },
  // Optional scheduling page (Cal.com, Calendly…) for the setup call; without it founders book by email.
  bookingUrl: import.meta.env.PUBLIC_FOUNDING_BOOKING_URL ?? '',
} as const;

/** Launch coupon (Stripe promotion code, Godmode Pro only): expires together with the founding offer. */
export const COUPON = {
  code: 'FOUNDING20',
  percentOff: 20,
  months: 3,
  maxRedemptions: 100,
  expires: FOUNDING.end,
} as const;

export const foundingOpen = (taken: number, now = Date.now()) => now < FOUNDING.end && taken < FOUNDING.seats;

/** Percent saved by paying yearly instead of monthly, rounded down so the claim is never overstated. */
export const yearlySavings = Math.floor((1 - PRICING.plans.yearly.price / (PRICING.plans.monthly.price * 12)) * 100);

/** Short price line for a plan, e.g. "$39/month" or "$348/year". */
export function priceLabel(plan: Plan): string {
  const p = PRICING.plans[plan];
  return `$${p.price}/${p.interval}`;
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
