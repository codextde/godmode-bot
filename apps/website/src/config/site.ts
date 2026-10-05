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

export type Plan = 'lifetime' | 'monthly';

export const PRICING = {
  currency: 'USD',
  guaranteeDays: 14,
  plans: {
    lifetime: {
      id: 'lifetime' as Plan,
      name: 'Lifetime',
      price: 500,
      cadence: 'one-time',
      lookupKey: 'godmode_lifetime_usd',
      blurb: 'Pay once. Own it. Every update included.',
      cta: 'Get lifetime access',
    },
    monthly: {
      id: 'monthly' as Plan,
      name: 'Monthly',
      price: 50,
      cadence: 'per month',
      lookupKey: 'godmode_monthly_usd',
      blurb: 'Everything in Godmode. Cancel anytime.',
      cta: 'Start monthly',
    },
  },
  // Shown under the pricing cards. Keep it true: lifetime is a launch offer that can be
  // retired for new buyers at any time (existing lifetime licenses stay valid).
  launchNote: 'Lifetime is a launch offer. When it’s gone, it’s gone — licenses already sold stay valid forever.',
} as const;

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
  updated: 'September 30, 2026',
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
