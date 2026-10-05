import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { isLicenseKey } from '@/lib/license';
import { minLivemode } from '@/lib/entitlement';

export const prerender = false;

type Status = 'trialing' | 'active' | 'past_due' | 'canceled' | 'refunded' | 'expired' | 'pending';

type Row = {
  plan: string;
  mode: string;
  status: string;
  sub_status: string | null;
  trial_end: number | null;
  period_end: number | null;
  cancel_at_period_end: number | null;
  comp: number | null;
  customer_id: string | null;
};

const headers = { 'cache-control': 'no-store' };

/** Order state → the license status the app understands. */
function statusOf(row: Row): Status {
  if (row.status === 'refunded') return 'refunded';
  if (row.status === 'open' || row.status === 'pending') return 'pending';
  if (row.status === 'expired' || row.status === 'failed') return 'expired';
  if (row.comp || row.mode !== 'subscription') return row.status === 'paid' ? 'active' : 'expired';
  switch (row.sub_status) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
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

/** For the desktop app: GET /api/license?key=GM-… (response shape in the pricing contract, v2). */
export const GET: APIRoute = async ({ url }) => {
  const key = url.searchParams.get('key')?.trim().toUpperCase();
  if (!isLicenseKey(key)) return Response.json({ valid: false, reason: 'malformed' }, { status: 400, headers });
  const row = await db()
    .prepare(
      `SELECT plan, mode, status, sub_status, trial_end, period_end, cancel_at_period_end, comp, customer_id
       FROM orders WHERE license_key = ? AND livemode >= ?`,
    )
    .bind(key, minLivemode())
    .first<Row>();
  if (!row) return Response.json({ valid: false, reason: 'unknown' }, { status: 404, headers });

  const status = statusOf(row);
  const valid = status === 'trialing' || status === 'active' || status === 'past_due';
  const subscription = row.mode === 'subscription' && !row.comp;
  const plan = row.plan === 'yearly' || row.plan === 'monthly' ? row.plan : 'lifetime';
  return Response.json(
    {
      valid,
      plan,
      status,
      trialEndsAt: subscription && status === 'trialing' ? (row.trial_end ?? null) : null,
      renewsAt: subscription && valid ? (row.period_end ?? null) : null,
      cancelAtPeriodEnd: subscription && Boolean(row.cancel_at_period_end),
      manageUrl: row.customer_id ? `${url.origin}/api/portal?key=${key}` : null,
    },
    { headers },
  );
};
