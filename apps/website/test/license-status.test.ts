import { describe, expect, test } from 'bun:test';
import { PAST_DUE_GRACE_MS, licenseVerdict, periodStart, type LicenseOrder } from '../src/lib/license-status';

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);

const sub = (over: Partial<LicenseOrder>): LicenseOrder => ({
  plan: 'monthly',
  mode: 'subscription',
  status: 'paid',
  sub_status: 'active',
  trial_end: null,
  period_end: null,
  comp: 0,
  ...over,
});

describe('licence verdict', () => {
  const now = at('2026-11-01T10:00:00Z');

  test('trialing and active subscriptions unlock Pro', () => {
    expect(licenseVerdict(sub({ sub_status: 'trialing', trial_end: now + DAY }), now)).toEqual({ valid: true, status: 'trialing', reason: null });
    expect(licenseVerdict(sub({ sub_status: 'active' }), now)).toEqual({ valid: true, status: 'active', reason: null });
  });

  test('cancelled in the trial: the trial ended (Kesler)', () => {
    const trialEnd = at('2026-10-28T14:46:52Z');
    const row = sub({ status: 'canceled', sub_status: 'canceled', trial_end: trialEnd, period_end: trialEnd });
    expect(licenseVerdict(row, now)).toEqual({ valid: false, status: 'canceled', reason: 'trial_ended' });
  });

  test('cancelled after paid periods: the subscription ended', () => {
    const row = sub({ status: 'canceled', sub_status: 'canceled', trial_end: at('2026-08-01T00:00:00Z'), period_end: at('2026-10-01T00:00:00Z') });
    expect(licenseVerdict(row, now)).toEqual({ valid: false, status: 'canceled', reason: 'canceled' });
    expect(licenseVerdict(sub({ status: 'canceled', sub_status: 'incomplete_expired' }), now)).toEqual({ valid: false, status: 'canceled', reason: 'canceled' });
  });

  test('past due: works for 7 days after the failed charge, then the payment failed', () => {
    const failed = at('2026-10-29T13:43:16Z');
    const row = sub({ status: 'past_due', sub_status: 'past_due', trial_end: failed, period_end: at('2026-11-29T13:43:16Z') });
    expect(licenseVerdict(row, now)).toEqual({ valid: true, status: 'past_due', reason: null });
    expect(licenseVerdict(row, failed + PAST_DUE_GRACE_MS - 1).valid).toBe(true);
    expect(licenseVerdict(row, failed + PAST_DUE_GRACE_MS)).toEqual({ valid: false, status: 'expired', reason: 'payment_failed' });
  });

  test('past due on a yearly renewal counts from the renewal', () => {
    const renewal = at('2026-10-30T00:00:00Z');
    const row = sub({ plan: 'yearly', status: 'past_due', sub_status: 'past_due', period_end: at('2027-10-30T00:00:00Z') });
    expect(licenseVerdict(row, renewal + 6 * DAY).valid).toBe(true);
    expect(licenseVerdict(row, renewal + 8 * DAY)).toEqual({ valid: false, status: 'expired', reason: 'payment_failed' });
  });

  test('past due without a known period keeps working (Stripe ends it)', () => {
    expect(licenseVerdict(sub({ status: 'past_due', sub_status: 'past_due' }), now).valid).toBe(true);
    expect(licenseVerdict(sub({ status: 'past_due', sub_status: null }), now)).toEqual({ valid: true, status: 'past_due', reason: null });
  });

  test('unpaid: Stripe gave up on the payment', () => {
    expect(licenseVerdict(sub({ status: 'past_due', sub_status: 'unpaid' }), now)).toEqual({ valid: false, status: 'expired', reason: 'payment_failed' });
  });

  test('paused: the trial ran out without a payment method', () => {
    expect(licenseVerdict(sub({ status: 'past_due', sub_status: 'paused' }), now)).toEqual({ valid: false, status: 'expired', reason: 'trial_ended' });
  });

  test('refunded, pending and expired checkouts', () => {
    expect(licenseVerdict(sub({ status: 'refunded', sub_status: 'canceled' }), now)).toEqual({ valid: false, status: 'refunded', reason: 'refunded' });
    expect(licenseVerdict(sub({ status: 'pending', sub_status: 'incomplete' }), now)).toEqual({ valid: false, status: 'pending', reason: null });
    expect(licenseVerdict(sub({ status: 'expired', sub_status: null }), now)).toEqual({ valid: false, status: 'expired', reason: null });
  });

  test('comp and lifetime keys are untouched by the subscription', () => {
    expect(licenseVerdict(sub({ comp: 1, status: 'paid', sub_status: 'canceled', period_end: now - 30 * DAY }), now)).toEqual({ valid: true, status: 'active', reason: null });
    expect(licenseVerdict(sub({ plan: 'lifetime', mode: 'payment', status: 'paid', sub_status: null }), now)).toEqual({ valid: true, status: 'active', reason: null });
    expect(licenseVerdict(sub({ plan: 'lifetime', mode: 'payment', status: 'refunded', sub_status: null }), now)).toEqual({ valid: false, status: 'refunded', reason: 'refunded' });
  });

  test('orders from before subscription details were stored', () => {
    expect(licenseVerdict(sub({ status: 'paid', sub_status: null }), now).valid).toBe(true);
    expect(licenseVerdict(sub({ status: 'canceled', sub_status: null }), now)).toEqual({ valid: false, status: 'canceled', reason: 'canceled' });
  });

  test('older apps read only canceled, refunded and expired as an ended key', () => {
    const ended = ['canceled', 'refunded', 'expired'];
    const rows = [
      sub({ status: 'canceled', sub_status: 'canceled', trial_end: now - DAY, period_end: now - DAY }),
      sub({ status: 'past_due', sub_status: 'past_due', period_end: now + 10 * DAY }),
      sub({ status: 'past_due', sub_status: 'unpaid' }),
      sub({ status: 'past_due', sub_status: 'paused' }),
    ];
    for (const row of rows) {
      const v = licenseVerdict(row, now);
      expect(v.valid).toBe(false);
      expect(ended).toContain(v.status);
    }
  });
});

describe('period start', () => {
  test('one month or one year before the period end', () => {
    expect(new Date(periodStart('monthly', at('2026-11-24T14:11:46Z'))).toISOString()).toBe('2026-10-24T14:11:46.000Z');
    expect(new Date(periodStart('yearly', at('2027-10-30T00:00:00Z'))).toISOString()).toBe('2026-10-30T00:00:00.000Z');
  });
});
