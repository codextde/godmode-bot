import { beforeEach, describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { cryptoProvider, stripe } from '@/lib/stripe';
import { POST } from '@/pages/api/stripe-webhook';
import { expiredSession, setupEnv } from './fixtures';

let db: ReturnType<typeof setupEnv>['db'];
beforeEach(() => ({ db } = setupEnv()));

let n = 0;
async function deliver(session: Stripe.Checkout.Session, type = 'checkout.session.expired') {
  const payload = JSON.stringify({ id: `evt_test_${++n}`, object: 'event', type, data: { object: session } });
  const signature = await stripe().webhooks.generateTestHeaderStringAsync({
    payload,
    secret: 'whsec_recovery_test',
    cryptoProvider,
  });
  const request = new Request('https://usegodmode.com/api/stripe-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: payload,
  });
  return (POST as (ctx: { request: Request }) => Promise<Response>)({ request });
}

const recovery = (id = 'cs_test_abandoned1') =>
  db.sql.prepare('SELECT * FROM checkout_recovery WHERE session_id = ?').get(id) as Record<string, unknown> | undefined;

describe('checkout.session.expired', () => {
  it('stores email, plan, recovery link, consent and attribution', async () => {
    const res = await deliver(expiredSession());
    expect(res.status).toBe(200);
    expect(recovery()).toMatchObject({
      email: 'ann@example.com',
      plan: 'yearly',
      consent: 'opt_in',
      consent_source: 'stripe',
      recovery_url: 'https://buy.stripe.com/r/test_recover1',
      utm_source: 'chatgpt.com',
      utm_campaign: 'launch',
      livemode: 0,
    });
    expect(recovery()!.expired_at).toEqual(expect.any(Number));
    expect(db.sql.prepare("SELECT status FROM orders WHERE session_id = 'cs_test_abandoned1'").get()).toMatchObject({ status: 'expired' });
  });

  it('keeps sessions without email or consent, with consent left empty', async () => {
    await deliver(expiredSession({ customer_details: null, consent: null }));
    expect(recovery()).toMatchObject({ email: null, consent: null, consent_source: null });
  });

  it('records an opt-out as such', async () => {
    await deliver(expiredSession({ consent: { promotions: 'opt_out', terms_of_service: null } }));
    expect(recovery()).toMatchObject({ consent: 'opt_out', consent_source: null });
  });

  it('ignores checkouts this site did not open', async () => {
    await deliver(expiredSession({ metadata: {} }));
    expect(recovery()).toBeUndefined();
  });

  it('processes a retried event once', async () => {
    const payload = expiredSession();
    await deliver(payload);
    db.sql.exec("UPDATE checkout_recovery SET email = 'changed@example.com'");
    n--;
    const res = await deliver(payload);
    expect(await res.text()).toBe('ok (duplicate)');
    expect(recovery()!.email).toBe('changed@example.com');
  });

  it('keeps an opt-in given on /checkout/canceled', async () => {
    db.sql.exec(`INSERT INTO checkout_recovery (session_id, created_at, plan, email, consent, consent_source, livemode)
      VALUES ('cs_test_abandoned1', 1, 'yearly', 'site@example.com', 'opt_in', 'site', 0)`);
    await deliver(expiredSession({ customer_details: null, consent: null }));
    expect(recovery()).toMatchObject({
      email: 'site@example.com',
      consent: 'opt_in',
      consent_source: 'site',
      recovery_url: 'https://buy.stripe.com/r/test_recover1',
    });
  });

  it('stores no recovery link for sessions created without recovery', async () => {
    await deliver(expiredSession({ after_expiration: null }));
    expect(recovery()!.recovery_url).toBeNull();
  });
});
