import type Stripe from 'stripe';
import { vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { testDb } from './d1';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const sec = (ms: number) => Math.floor(ms / 1000);

export type Sent = { to: string; subject: string; text: string; html: string; headers?: Record<string, string> };

/** Fresh bindings for one test: a migrated database, a recording mailer and test-mode Stripe secrets. */
export function setupEnv() {
  const db = testDb();
  const sent: Sent[] = [];
  Object.assign(env, {
    DB: db,
    STRIPE_SECRET_KEY: 'sk_test_recovery',
    STRIPE_WEBHOOK_SECRET: 'whsec_recovery_test',
    SESSION_SECRET: 'test-session-secret',
    LIFECYCLE_EMAILS: 'on',
    EMAIL: {
      send: vi.fn(async (m: Sent) => {
        sent.push(m);
        return { messageId: `<m${sent.length}@usegodmode.com>` };
      }),
    },
  });
  return { db, sent };
}

/** An expired Godmode checkout as Stripe sends it in `checkout.session.expired`. */
export function expiredSession(over: Partial<Stripe.Checkout.Session> = {}, expiredAt = Date.now()): Stripe.Checkout.Session {
  return {
    id: 'cs_test_abandoned1',
    object: 'checkout.session',
    created: sec(expiredAt - DAY),
    expires_at: sec(expiredAt),
    livemode: false,
    mode: 'subscription',
    status: 'expired',
    payment_status: 'unpaid',
    amount_total: 3900,
    currency: 'usd',
    customer: null,
    subscription: null,
    payment_intent: null,
    customer_email: null,
    customer_details: { email: 'Ann@Example.com', name: null, address: null, phone: null, tax_exempt: 'none', tax_ids: [] },
    consent: { promotions: 'opt_in', terms_of_service: null },
    after_expiration: {
      recovery: {
        enabled: true,
        allow_promotion_codes: true,
        url: 'https://buy.stripe.com/r/test_recover1',
        expires_at: sec(expiredAt + 30 * DAY),
      },
    },
    metadata: { plan: 'yearly', license_key: 'GM-TEST-KEY1', utm_source: 'chatgpt.com', utm_campaign: 'launch' },
    ...over,
  } as unknown as Stripe.Checkout.Session;
}
