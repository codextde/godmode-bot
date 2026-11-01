export type LicenseStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'refunded' | 'expired' | 'pending';

/** Why a key stopped working, for the app's end screen. */
export type EndReason = 'trial_ended' | 'canceled' | 'payment_failed' | 'refunded';

export interface LicenseOrder {
  plan: string;
  mode: string;
  status: string;
  sub_status: string | null;
  trial_end: number | null;
  period_end: number | null;
  comp: number | null;
}

export interface LicenseVerdict {
  valid: boolean;
  /**
   * Apps before 0.2.40 only know `canceled`, `refunded` and `expired` as an ended key; any other refused status reads as
   * a mistyped key there. A payment that failed for good is `expired` for them, `reason` says why.
   */
  status: LicenseStatus;
  reason: EndReason | null;
}

/** Stripe retries a failed payment for weeks; the key keeps working this long after the charge that failed. */
export const PAST_DUE_GRACE_MS = 7 * 86_400_000;

/** Order state → the license status the app understands. */
export function statusOf(row: LicenseOrder): LicenseStatus {
  if (row.status === 'refunded') return 'refunded';
  if (row.status === 'open' || row.status === 'pending') return 'pending';
  if (row.status === 'expired' || row.status === 'failed') return 'expired';
  if (row.comp || row.mode !== 'subscription') return row.status === 'paid' ? 'active' : 'expired';
  switch (row.sub_status) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    // Stripe is still retrying the payment; `unpaid` means it gave up.
    case 'past_due':
      return 'past_due';
    case 'unpaid':
      return 'expired';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'paused':
      return 'expired';
    case 'incomplete':
      return 'pending';
  }
  // Orders from before subscription details were stored.
  if (row.status === 'paid') return 'active';
  if (row.status === 'past_due') return 'past_due';
  if (row.status === 'canceled') return 'canceled';
  return 'expired';
}

/** When the current billing period started, i.e. when the charge that failed was due. */
export function periodStart(plan: string, periodEnd: number): number {
  const start = new Date(periodEnd);
  if (plan === 'yearly') start.setUTCFullYear(start.getUTCFullYear() - 1);
  else start.setUTCMonth(start.getUTCMonth() - 1);
  return start.getTime();
}

/** A subscription that ended before a single paid period: cancelled in the trial, or its trial ran out unpaid. */
function endedInTrial(row: LicenseOrder): boolean {
  return row.trial_end !== null && (row.period_end === null || row.period_end <= row.trial_end);
}

/** A licence unlocks Pro while its subscription is trialing or active, a little while past due, or it is comp or lifetime. */
export function licenseVerdict(row: LicenseOrder, now: number): LicenseVerdict {
  const status = statusOf(row);
  if (status === 'trialing' || status === 'active') return { valid: true, status, reason: null };
  if (status === 'past_due') {
    const since = row.period_end ? periodStart(row.plan, row.period_end) : null;
    if (since === null || now < since + PAST_DUE_GRACE_MS) return { valid: true, status, reason: null };
    return { valid: false, status: 'expired', reason: 'payment_failed' };
  }
  if (status === 'refunded') return { valid: false, status, reason: 'refunded' };
  if (status === 'pending') return { valid: false, status, reason: null };
  if (row.mode !== 'subscription' || row.comp) return { valid: false, status, reason: null };
  if (row.sub_status === 'unpaid') return { valid: false, status, reason: 'payment_failed' };
  if (row.sub_status === 'paused') return { valid: false, status, reason: 'trial_ended' };
  if (status === 'canceled') return { valid: false, status, reason: endedInTrial(row) ? 'trial_ended' : 'canceled' };
  return { valid: false, status, reason: null };
}
