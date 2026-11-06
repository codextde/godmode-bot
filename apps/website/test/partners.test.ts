import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type Stripe from 'stripe';
import { env } from 'cloudflare:workers';
import { cryptoProvider, stripe } from '@/lib/stripe';
import { POST } from '@/pages/api/stripe-webhook';
import {
  addMonths,
  approvePayout,
  cancelPayoutChecked,
  markPayoutPaid,
  normalizeClipUrl,
  proposePayouts,
  recordCommission,
  referralFromSession,
  releaseHeld,
  reverseCommission,
  runPartners,
  executeApprovedPayouts,
} from '@/lib/partners';
import { consumeLoginToken, loginToken, safePath } from '@/lib/partner-auth';
import { DAY, sec, setupEnv, type Sent } from './fixtures';

let db: ReturnType<typeof setupEnv>['db'];
let sent: Sent[];
beforeEach(() => ({ db, sent } = setupEnv()));

// Stripe calls are replaced per test; anything not stubbed fails loudly instead of reaching the network.
const restore: (() => void)[] = [];
function stub(resource: string, method: string, fn: (...args: any[]) => unknown) {
  const target = (stripe() as any)[resource];
  const original = target[method];
  target[method] = fn;
  restore.push(() => (target[method] = original));
}
afterEach(() => {
  while (restore.length) restore.pop()!();
  delete (env as Record<string, unknown>).PARTNER_PAYOUT_MONTHLY_CAP_EUR;
});
const offline = () => {
  throw new Error('unexpected Stripe call');
};

const NOW = Date.UTC(2026, 10, 6, 12);

function partner(over: Record<string, unknown> = {}) {
  const p = {
    email: 'mia@example.com',
    name: 'Mia Clips',
    code: 'MIA',
    country: 'DE',
    status: 'active',
    rate_bps: 2000,
    email_verified_at: NOW,
    payout_method: null,
    paypal_email: null,
    stripe_account_id: null,
    stripe_payouts_enabled: 0,
    promotion_code_id: null,
    created_at: NOW - 60 * DAY,
    ...over,
  };
  const keys = Object.keys(p);
  const r = db.sql.query(`INSERT INTO partners (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...(Object.values(p) as any[]));
  return Number(r.lastInsertRowid);
}

function referral(partnerId: number, over: Record<string, unknown> = {}) {
  const r = {
    partner_id: partnerId,
    session_id: 'cs_test_1',
    subscription_id: 'sub_1',
    customer_id: 'cus_1',
    email: 'buyer@example.com',
    source: 'link',
    plan: 'private',
    status: 'active',
    first_paid_at: null,
    created_at: NOW - 40 * DAY,
    livemode: 0,
    ...over,
  };
  const keys = Object.keys(r);
  const res = db.sql.query(`INSERT INTO partner_referrals (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...(Object.values(r) as any[]));
  return Number(res.lastInsertRowid);
}

function commission(partnerId: number, over: Record<string, unknown> = {}) {
  const c = {
    partner_id: partnerId,
    referral_id: null,
    invoice_id: `in_${Math.random().toString(36).slice(2)}`,
    kind: 'sale',
    charge_id: null,
    base_cents: 4900,
    amount_cents: 980,
    status: 'available',
    available_at: NOW - DAY,
    payout_id: null,
    created_at: NOW - 31 * DAY,
    livemode: 0,
    ...over,
  };
  const keys = Object.keys(c);
  const res = db.sql.query(`INSERT INTO partner_commissions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...(Object.values(c) as any[]));
  return Number(res.lastInsertRowid);
}

const rows = (sql: string, ...args: any[]) => db.sql.query(sql).all(...args) as Record<string, any>[];
const row = (sql: string, ...args: any[]) => db.sql.query(sql).get(...args) as Record<string, any>;

function session(over: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: 'cs_test_1',
    object: 'checkout.session',
    mode: 'subscription',
    status: 'complete',
    payment_status: 'paid',
    livemode: false,
    subscription: 'sub_1',
    customer: 'cus_1',
    customer_email: null,
    customer_details: { email: 'Buyer@Example.com' },
    discounts: [],
    metadata: { plan: 'private', license_key: 'GM-TEST-KEY1' },
    ...over,
  } as unknown as Stripe.Checkout.Session;
}

let n = 0;
async function deliver(type: string, object: unknown) {
  const payload = JSON.stringify({ id: `evt_partner_${++n}`, object: 'event', type, data: { object } });
  const signature = await stripe().webhooks.generateTestHeaderStringAsync({ payload, secret: 'whsec_recovery_test', cryptoProvider });
  const request = new Request('https://usegodmode.com/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': signature }, body: payload });
  return (POST as (ctx: { request: Request }) => Promise<Response>)({ request });
}

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: 'in_1',
    object: 'invoice',
    amount_paid: 4900,
    currency: 'eur',
    customer: 'cus_1',
    customer_email: 'buyer@example.com',
    billing_reason: 'subscription_cycle',
    livemode: false,
    total_taxes: [],
    status_transitions: { paid_at: sec(NOW) },
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: { plan: 'private', license_key: 'GM-TEST-KEY1' } } },
    ...over,
  };
}

/** The charge behind invoice in_1: Stripe's invoice payment → PaymentIntent → latest charge with its balance transaction. */
function chargeStub(charge: { id?: string; amount?: number; bt?: { currency: string; amount: number; exchange_rate: number | null } } = {}) {
  stub('invoicePayments', 'list', async () => ({ data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_1' } }] }));
  stub('paymentIntents', 'retrieve', async () => ({
    id: 'pi_1',
    latest_charge: {
      id: charge.id ?? 'ch_1',
      amount: charge.amount ?? 4900,
      balance_transaction: charge.bt ?? { currency: 'eur', amount: charge.amount ?? 4900, exchange_rate: null },
    },
  }));
}

describe('attribution', () => {
  it('a partner code at checkout wins over the link cookie', async () => {
    const link = partner({ email: 'link@example.com', code: 'LINKY' });
    const coder = partner({ email: 'code@example.com', code: 'CODY', promotion_code_id: 'promo_cody' });
    const r = await referralFromSession(session({ metadata: { plan: 'private', license_key: 'K', partner: 'LINKY' }, discounts: [{ promotion_code: 'promo_cody' }] as any }));
    expect(r).toMatchObject({ partner_id: coder, status: 'active' });
    expect(row('SELECT source FROM partner_referrals')).toMatchObject({ source: 'code' });
    expect(link).not.toBe(coder);
  });

  it('falls back to the link cookie and tags the order', async () => {
    const id = partner();
    db.sql.run(`INSERT INTO orders (session_id, created_at, plan, mode, status, livemode) VALUES ('cs_test_1', 1, 'private', 'subscription', 'paid', 0)`);
    const r = await referralFromSession(session({ metadata: { plan: 'private', license_key: 'K', partner: 'MIA' } }));
    expect(r).toMatchObject({ partner_id: id, status: 'active' });
    expect(row('SELECT source, email, plan FROM partner_referrals')).toMatchObject({ source: 'link', email: 'buyer@example.com', plan: 'private' });
    expect(row(`SELECT partner_id FROM orders WHERE session_id = 'cs_test_1'`)).toMatchObject({ partner_id: id });
  });

  it('ignores the link of a paused partner', async () => {
    partner({ status: 'paused' });
    expect(await referralFromSession(session({ metadata: { plan: 'private', license_key: 'K', partner: 'MIA' } }))).toBeNull();
    expect(rows('SELECT * FROM partner_referrals')).toHaveLength(0);
  });

  it('rejects self-referrals and never pays them', async () => {
    partner({ email: 'buyer@example.com' });
    const r = await referralFromSession(session({ metadata: { plan: 'private', license_key: 'K', partner: 'MIA' } }));
    expect(r?.status).toBe('rejected');
    const paid = await recordCommission({ invoiceId: 'in_1', subscriptionId: 'sub_1', amountPaid: 4900, tax: 0, currency: 'eur', paidAt: NOW, chargeId: 'ch_1', eurRate: 1, livemode: false });
    expect(paid).toBeNull();
    expect(rows('SELECT * FROM partner_commissions')).toHaveLength(0);
  });

  it('records a referral once, whichever event comes first', async () => {
    const id = partner();
    await referralFromSession(session({ metadata: { plan: 'private', license_key: 'K', partner: 'MIA' } }));
    await referralFromSession(session({ id: 'cs_test_other', metadata: { plan: 'company', license_key: 'K', partner: 'MIA' } }));
    expect(rows('SELECT partner_id, session_id, plan FROM partner_referrals')).toEqual([{ partner_id: id, session_id: 'cs_test_1', plan: 'private' }]);
  });
});

describe('invoice.paid', () => {
  it('earns 20% of a EUR payment, held 30 days, and tells the partner', async () => {
    const id = partner();
    referral(id);
    chargeStub();
    expect((await deliver('invoice.paid', invoice())).status).toBe(200);
    expect(row('SELECT * FROM partner_commissions')).toMatchObject({
      partner_id: id,
      invoice_id: 'in_1',
      kind: 'sale',
      charge_id: 'ch_1',
      base_cents: 4900,
      amount_cents: 980,
      status: 'pending',
      available_at: NOW + 30 * DAY,
    });
    expect(row('SELECT first_paid_at FROM partner_referrals').first_paid_at).toBe(NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'mia@example.com', subject: 'New sale: you earned €9.80' });
  });

  it('takes tax off and converts other currencies at the balance transaction rate', async () => {
    const id = partner();
    referral(id);
    chargeStub({ amount: 5831, bt: { currency: 'eur', amount: 5364, exchange_rate: 0.92 } });
    await deliver('invoice.paid', invoice({ currency: 'usd', amount_paid: 5831, total_taxes: [{ amount: 931, tax_behavior: 'exclusive' }] }));
    // (58.31 − 9.31 tax) USD × 0.92 = €45.08 → 20% = €9.02
    expect(row('SELECT base_cents, amount_cents FROM partner_commissions')).toMatchObject({ base_cents: 4508, amount_cents: 902 });
  });

  it('pays each invoice once', async () => {
    const id = partner();
    referral(id);
    chargeStub();
    await deliver('invoice.paid', invoice());
    await deliver('invoice.paid', invoice());
    expect(rows('SELECT * FROM partner_commissions')).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('stops 12 months after the first payment', async () => {
    const id = partner();
    const first = Date.UTC(2025, 10, 6, 12);
    referral(id, { first_paid_at: first });
    const base = { subscriptionId: 'sub_1', amountPaid: 4900, tax: 0, currency: 'eur', chargeId: null, eurRate: 1, livemode: false };
    expect(await recordCommission({ ...base, invoiceId: 'in_m12', paidAt: addMonths(first, 11) + 3_600_000 })).not.toBeNull();
    expect(await recordCommission({ ...base, invoiceId: 'in_m13', paidAt: addMonths(first, 12) + 3_600_000 })).toBeNull();
    expect(rows('SELECT invoice_id FROM partner_commissions').map((r) => r.invoice_id)).toEqual(['in_m12']);
  });

  it('skips free invoices and subscriptions nobody referred, without calling Stripe', async () => {
    partner();
    stub('invoicePayments', 'list', offline);
    stub('subscriptions', 'retrieve', offline);
    await deliver('invoice.paid', invoice());
    referral(1, { subscription_id: 'sub_2', session_id: 'cs_2' });
    await deliver('invoice.paid', invoice({ id: 'in_2', amount_paid: 0, parent: { subscription_details: { subscription: 'sub_2', metadata: {} } } }));
    expect(rows('SELECT * FROM partner_commissions')).toHaveLength(0);
  });

  it('attributes from the invoice when the first invoice beats checkout.session.completed', async () => {
    const id = partner();
    chargeStub();
    stub('invoices', 'retrieve', async () => ({ id: 'in_1', discounts: [] }));
    const parent = { subscription_details: { subscription: 'sub_1', metadata: { plan: 'private', license_key: 'K', partner: 'MIA' } } };
    await deliver('invoice.paid', invoice({ billing_reason: 'subscription_create', parent }));
    expect(row('SELECT partner_id, session_id, source FROM partner_referrals')).toMatchObject({ partner_id: id, session_id: null, source: 'link' });
    expect(row('SELECT amount_cents FROM partner_commissions').amount_cents).toBe(980);
    await referralFromSession(session({ metadata: { plan: 'private', license_key: 'K' } }));
    expect(row('SELECT session_id FROM partner_referrals').session_id).toBe('cs_test_1');
  });

  it('takes the partner code from the first invoice’s discounts', async () => {
    partner({ email: 'link@example.com', code: 'LINKY' });
    const coder = partner({ email: 'code@example.com', code: 'CODY', promotion_code_id: 'promo_cody' });
    chargeStub({ amount: 3920 });
    stub('invoices', 'retrieve', async () => ({ id: 'in_1', discounts: [{ id: 'di_1', promotion_code: 'promo_cody' }] }));
    const parent = { subscription_details: { subscription: 'sub_1', metadata: { plan: 'private', license_key: 'K', partner: 'LINKY' } } };
    await deliver('invoice.paid', invoice({ billing_reason: 'subscription_create', amount_paid: 3920, parent }));
    expect(row('SELECT partner_id, source FROM partner_referrals')).toMatchObject({ partner_id: coder, source: 'code' });
    expect(row('SELECT partner_id, amount_cents FROM partner_commissions')).toMatchObject({ partner_id: coder, amount_cents: 784 });
  });

  it('lets a code seen later replace a link while nothing was earned', async () => {
    partner({ email: 'link@example.com', code: 'LINKY' });
    const coder = partner({ email: 'code@example.com', code: 'CODY', promotion_code_id: 'promo_cody' });
    await referralFromSession(session({ metadata: { plan: 'private', license_key: 'K', partner: 'LINKY' } }));
    await referralFromSession(session({ metadata: { plan: 'private', license_key: 'K', partner: 'LINKY' }, discounts: [{ promotion_code: 'promo_cody' }] as any }));
    expect(row('SELECT partner_id, source FROM partner_referrals')).toMatchObject({ partner_id: coder, source: 'code' });
  });

  it('reverses right away when the refund was processed first', async () => {
    const id = partner();
    referral(id);
    stub('invoicePayments', 'list', async () => ({ data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_1' } }] }));
    stub('paymentIntents', 'retrieve', async () => ({ id: 'pi_1', latest_charge: { id: 'ch_1', amount: 4900, amount_refunded: 4900, balance_transaction: null } }));
    await deliver('invoice.paid', invoice());
    expect(row(`SELECT status FROM partner_commissions WHERE kind = 'sale'`).status).toBe('reversed');
  });
});

describe('refunds and disputes', () => {
  it('reverses commission that was not paid out yet', async () => {
    const id = partner();
    commission(id, { invoice_id: 'in_1', charge_id: 'ch_1', status: 'pending' });
    db.sql.run(`INSERT INTO orders (session_id, created_at, plan, mode, status, payment_intent_id, livemode) VALUES ('cs_x', 1, 'private', 'subscription', 'paid', 'pi_1', 0)`);
    await deliver('charge.refunded', { id: 'ch_1', object: 'charge', amount: 4900, amount_refunded: 4900, refunded: true, payment_intent: 'pi_1' });
    expect(rows('SELECT kind, amount_cents, status FROM partner_commissions')).toEqual([{ kind: 'sale', amount_cents: 980, status: 'reversed' }]);
  });

  it('takes back a proportional share of a partial refund', async () => {
    const id = partner();
    commission(id, { invoice_id: 'in_1', charge_id: 'ch_1', status: 'pending', available_at: NOW + 20 * DAY });
    await reverseCommission('ch_1', 0.5, 'refund:2450', NOW);
    await reverseCommission('ch_1', 0.5, 'refund:2450', NOW);
    expect(rows(`SELECT amount_cents, status, available_at FROM partner_commissions WHERE kind <> 'sale'`)).toEqual([
      { amount_cents: -490, status: 'pending', available_at: NOW + 20 * DAY },
    ]);
    await reverseCommission('ch_1', 1, 'refund:4900', NOW);
    expect(rows('SELECT status FROM partner_commissions').map((r) => r.status)).toEqual(['reversed', 'reversed']);
  });

  it('deducts a refund of commission already paid out from the next payout', async () => {
    const id = partner();
    commission(id, { invoice_id: 'in_1', charge_id: 'ch_1', status: 'paid' });
    await reverseCommission('ch_1', 1, 'refund:4900', NOW);
    await reverseCommission('ch_1', 1, 'dispute', NOW);
    expect(rows(`SELECT kind, amount_cents, status FROM partner_commissions WHERE kind <> 'sale'`)).toEqual([
      { kind: 'refund:4900', amount_cents: -980, status: 'available' },
    ]);
    expect(row(`SELECT status FROM partner_commissions WHERE kind = 'sale'`).status).toBe('paid');
  });

  it('reverses on a lost dispute', async () => {
    const id = partner();
    commission(id, { invoice_id: 'in_1', charge_id: 'ch_1', status: 'available' });
    stub('charges', 'retrieve', async () => ({ id: 'ch_1', amount: 4900, payment_intent: 'pi_1', refunded: false }));
    db.sql.run(`INSERT INTO orders (session_id, created_at, plan, mode, status, payment_intent_id, livemode) VALUES ('cs_x', 1, 'private', 'subscription', 'paid', 'pi_1', 0)`);
    await deliver('charge.dispute.closed', { id: 'dp_1', object: 'dispute', status: 'lost', charge: 'ch_1' });
    expect(row(`SELECT status FROM partner_commissions WHERE kind = 'sale'`).status).toBe('reversed');
  });

  it('shrinks a proposed payout when one of its commissions is refunded', async () => {
    const id = partner({ paypal_email: 'mia@paypal.test' });
    commission(id, { invoice_id: 'in_1', charge_id: 'ch_1' });
    commission(id, { invoice_id: 'in_2', charge_id: 'ch_2', amount_cents: 2000 });
    const [payout] = await proposePayouts(NOW);
    expect(row('SELECT amount_cents FROM partner_payouts WHERE id = ?', payout).amount_cents).toBe(2980);
    await reverseCommission('ch_1', 1, 'refund:4900', NOW);
    expect(row('SELECT amount_cents, status FROM partner_payouts WHERE id = ?', payout)).toMatchObject({ amount_cents: 2000, status: 'proposed' });
  });
});

describe('monthly payouts', () => {
  it('proposes one payout per partner with €25 available, a confirmed email and a way to pay', async () => {
    const ready = partner({ email: 'a@x.test', code: 'AAA', paypal_email: 'a@paypal.test' });
    const small = partner({ email: 'b@x.test', code: 'BBB', paypal_email: 'b@paypal.test' });
    const unverified = partner({ email: 'c@x.test', code: 'CCC', paypal_email: 'c@paypal.test', email_verified_at: null });
    const noMethod = partner({ email: 'd@x.test', code: 'DDD' });
    const stripePending = partner({ email: 'e@x.test', code: 'EEE', stripe_account_id: 'acct_e', stripe_payouts_enabled: 0 });
    const stripeReady = partner({ email: 'f@x.test', code: 'FFF', stripe_account_id: 'acct_f', stripe_payouts_enabled: 1 });
    for (const p of [ready, unverified, noMethod, stripePending, stripeReady]) {
      commission(p, { amount_cents: 2000 });
      commission(p, { amount_cents: 1000 });
    }
    commission(small, { amount_cents: 2499 });
    commission(ready, { amount_cents: 5000, status: 'pending', available_at: NOW + DAY });

    await proposePayouts(NOW);
    expect(rows('SELECT partner_id, amount_cents, method, status FROM partner_payouts ORDER BY partner_id')).toEqual([
      { partner_id: ready, amount_cents: 3000, method: 'paypal', status: 'proposed' },
      { partner_id: stripeReady, amount_cents: 3000, method: 'stripe', status: 'proposed' },
    ]);
    expect(row(`SELECT COUNT(*) AS c FROM partner_commissions WHERE partner_id = ? AND payout_id IS NOT NULL`, ready).c).toBe(2);

    // Later runs in the same month leave the proposal as it is; next month a waiting one takes in what became available.
    await releaseHeld(NOW + 2 * DAY);
    await proposePayouts(NOW + 2 * DAY);
    expect(rows('SELECT amount_cents FROM partner_payouts WHERE partner_id = ?', ready)).toEqual([{ amount_cents: 3000 }]);
    await proposePayouts(Date.UTC(2026, 11, 1, 0, 17));
    expect(rows('SELECT amount_cents FROM partner_payouts WHERE partner_id = ?', ready)).toEqual([{ amount_cents: 8000 }]);
  });

  it('nets refunds of paid commission against the balance', async () => {
    const id = partner({ paypal_email: 'a@paypal.test' });
    commission(id, { amount_cents: 3000 });
    commission(id, { amount_cents: -980, kind: 'refund:4900' });
    expect(await proposePayouts(NOW)).toHaveLength(0);
  });

  it('proposes on the 1st of the month only', async () => {
    const id = partner({ paypal_email: 'a@paypal.test', promotion_code_id: 'promo_mia' });
    commission(id, { amount_cents: 3000 });
    await runPartners(Date.UTC(2026, 10, 2, 9));
    expect(rows('SELECT * FROM partner_payouts')).toHaveLength(0);
    await runPartners(Date.UTC(2026, 11, 1, 0, 17));
    expect(rows('SELECT * FROM partner_payouts')).toHaveLength(1);
  });

  it('releases held commission after 30 days', async () => {
    const id = partner();
    commission(id, { status: 'pending', available_at: NOW + 30 * DAY });
    await releaseHeld(NOW + 29 * DAY);
    expect(row('SELECT status FROM partner_commissions').status).toBe('pending');
    await releaseHeld(NOW + 30 * DAY);
    expect(row('SELECT status FROM partner_commissions').status).toBe('available');
  });
});

describe('approving and paying', () => {
  it('only approves or marks paid the amount the admin saw', async () => {
    const id = partner({ paypal_email: 'a@paypal.test' });
    commission(id, { amount_cents: 3000, charge_id: 'ch_1', invoice_id: 'in_1' });
    commission(id, { amount_cents: 2000, charge_id: 'ch_2', invoice_id: 'in_2' });
    const [payout] = await proposePayouts(NOW);
    await reverseCommission('ch_2', 1, 'refund:4900', NOW);
    expect(await approvePayout(payout, 'admin', 5000)).toBe(false);
    expect(await markPayoutPaid(payout, { reference: 'PP-1', amount: 5000 }, NOW)).toBe(false);
    expect(await approvePayout(payout, 'admin', 3000)).toBe(true);
  });

  it('keeps an approved payout fixed and takes a later refund off the next one', async () => {
    const id = partner({ paypal_email: 'a@paypal.test' });
    commission(id, { amount_cents: 3000, charge_id: 'ch_1', invoice_id: 'in_1' });
    const [payout] = await proposePayouts(NOW);
    await approvePayout(payout, 'admin', 3000);
    await reverseCommission('ch_1', 1, 'refund:15000', NOW);
    expect(row('SELECT amount_cents, status FROM partner_payouts').amount_cents).toBe(3000);
    expect(rows('SELECT kind, amount_cents, status, payout_id FROM partner_commissions ORDER BY id')).toEqual([
      { kind: 'sale', amount_cents: 3000, status: 'available', payout_id: payout },
      { kind: 'refund:15000', amount_cents: -3000, status: 'available', payout_id: null },
    ]);
  });
});

describe('Stripe payouts', () => {
  function approved(partnerId: number, amount: number) {
    const payout = Number(
      db.sql
        .query(`INSERT INTO partner_payouts (partner_id, amount_cents, method, status, created_at, approved_at, livemode) VALUES (?, ?, 'stripe', 'approved', ?, ?, 0)`)
        .run(partnerId, amount, NOW, NOW).lastInsertRowid,
    );
    commission(partnerId, { amount_cents: amount, payout_id: payout });
    return payout;
  }

  it('sends approved payouts up to the monthly cap; the rest wait', async () => {
    env.PARTNER_PAYOUT_MONTHLY_CAP_EUR = '1000';
    const a = partner({ email: 'a@x.test', code: 'AAA', stripe_account_id: 'acct_a', stripe_payouts_enabled: 1 });
    const b = partner({ email: 'b@x.test', code: 'BBB', stripe_account_id: 'acct_b', stripe_payouts_enabled: 1 });
    const first = approved(a, 60000);
    const second = approved(b, 50000);
    const calls: { params: any; options: any }[] = [];
    stub('transfers', 'list', async () => ({ data: [] }));
    stub('transfers', 'create', async (params: any, options: any) => {
      calls.push({ params, options });
      return { id: `tr_${calls.length}` };
    });

    expect(await executeApprovedPayouts(NOW)).toEqual([first]);
    expect(calls).toEqual([
      {
        params: expect.objectContaining({ amount: 60000, currency: 'eur', destination: 'acct_a', transfer_group: `partner_payout_${first}` }),
        options: { idempotencyKey: `partner_payout_${first}` },
      },
    ]);
    expect(row('SELECT status, stripe_transfer_id FROM partner_payouts WHERE id = ?', first)).toMatchObject({ status: 'paid', stripe_transfer_id: 'tr_1' });
    expect(row('SELECT status FROM partner_commissions WHERE payout_id = ?', first).status).toBe('paid');
    expect(row('SELECT status, error FROM partner_payouts WHERE id = ?', second)).toMatchObject({ status: 'approved', error: 'over monthly cap' });
    expect(sent.map((m) => m.subject)).toEqual(['Payout sent: €600.00']);

    // Next month there is room again.
    expect(await executeApprovedPayouts(Date.UTC(2026, 11, 1, 1))).toEqual([second]);
  });

  it('records a transfer that already exists instead of sending it twice', async () => {
    const a = partner({ stripe_account_id: 'acct_a', stripe_payouts_enabled: 1 });
    const payout = approved(a, 3000);
    stub('transfers', 'list', async () => ({ data: [{ id: 'tr_earlier' }] }));
    stub('transfers', 'create', offline);
    await executeApprovedPayouts(NOW);
    expect(row('SELECT status, stripe_transfer_id FROM partner_payouts WHERE id = ?', payout)).toMatchObject({ status: 'paid', stripe_transfer_id: 'tr_earlier' });
  });

  it('pays active partners only', async () => {
    const a = partner({ stripe_account_id: 'acct_a', stripe_payouts_enabled: 1, status: 'banned' });
    const payout = approved(a, 3000);
    stub('transfers', 'create', offline);
    expect(await executeApprovedPayouts(NOW)).toEqual([]);
    expect(row('SELECT status, error FROM partner_payouts WHERE id = ?', payout)).toMatchObject({ status: 'approved', error: 'partner is banned' });
  });

  it('marks a payout paid instead of canceling it when its transfer went out', async () => {
    const a = partner({ stripe_account_id: 'acct_a', stripe_payouts_enabled: 1 });
    const payout = approved(a, 3000);
    stub('transfers', 'list', async () => ({ data: [{ id: 'tr_lost' }] }));
    expect(await cancelPayoutChecked(payout, NOW)).toBe('paid');
    expect(row('SELECT status, stripe_transfer_id FROM partner_payouts').stripe_transfer_id).toBe('tr_lost');
    expect(row('SELECT status FROM partner_commissions').status).toBe('paid');
  });

  it('leaves PayPal payouts to be marked paid by hand', async () => {
    const a = partner({ paypal_email: 'a@paypal.test' });
    commission(a, { amount_cents: 3000 });
    const [payout] = await proposePayouts(NOW);
    stub('transfers', 'create', offline);
    db.sql.run(`UPDATE partner_payouts SET status = 'approved'`);
    expect(await executeApprovedPayouts(NOW)).toEqual([]);
    expect(await markPayoutPaid(payout, { reference: 'PP-123' }, NOW)).toBe(true);
    expect(row('SELECT status, reference FROM partner_payouts').status).toBe('paid');
    expect(sent.at(-1)?.text).toContain('PayPal');
  });
});

describe('partner sign-in links', () => {
  it('work once', async () => {
    const id = partner({ last_login_at: 5, email_verified_at: null });
    const token = await loginToken({ id, last_login_at: 5 });
    expect(await consumeLoginToken(token, NOW)).toBe(id);
    expect(row('SELECT email_verified_at FROM partners').email_verified_at).toBe(NOW);
    expect(await consumeLoginToken(token, NOW + 1000)).toBeNull();
  });
});

describe('redirects', () => {
  it('stay on this site', () => {
    expect(safePath('/download?x=1#a')).toBe('/download?x=1#a');
    for (const evil of ['//evil.com', '/.//evil.com', '/..//evil.com', '/%2e//evil.com', 'https://evil.com', '/\\evil.com', '']) {
      expect(safePath(evil)).toBe('/');
    }
  });
});

describe('clip links', () => {
  it('drop tracking parameters so a clip is only added once', () => {
    expect(normalizeClipUrl('https://www.tiktok.com/@mia/video/123?is_from_webapp=1&sender_device=pc')).toEqual({ url: 'https://tiktok.com/@mia/video/123', platform: 'TikTok' });
    expect(normalizeClipUrl('https://youtube.com/watch?v=abc&t=3')).toEqual({ url: 'https://youtube.com/watch?v=abc', platform: 'YouTube' });
    expect(normalizeClipUrl('javascript:alert(1)')).toBeNull();
  });
});
