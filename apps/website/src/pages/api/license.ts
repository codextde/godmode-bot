import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { isLicenseKey } from '@/lib/license';
import { minLivemode } from '@/lib/entitlement';
import { licenseVerdict, type LicenseOrder } from '@/lib/license-status';

export const prerender = false;

type Row = LicenseOrder & {
  cancel_at_period_end: number | null;
  customer_id: string | null;
};

const headers = { 'cache-control': 'no-store' };

/** Activation for /admin and the lifecycle emails: only the app's own checks count, at most one write an hour. */
async function markSeen(key: string, userAgent: string | null) {
  const version = userAgent?.match(/^GodmodeBot\/([\w.+-]{1,40})/)?.[1];
  if (!version) return;
  const now = Date.now();
  await db()
    .prepare(
      `UPDATE orders SET first_seen_at = COALESCE(first_seen_at, ?1), last_seen_at = ?1, app_version = ?2
       WHERE license_key = ?3 AND (last_seen_at IS NULL OR last_seen_at < ?4 OR app_version IS NOT ?2)`,
    )
    .bind(now, version, key, now - 3_600_000)
    .run();
}

/** For the desktop app: GET /api/license?key=GM-… (response shape in the pricing contract, v2). */
export const GET: APIRoute = async ({ url, request }) => {
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
  await markSeen(key, request.headers.get('user-agent')).catch((e) => console.error('license seen update failed', e));

  const { valid, status, reason } = licenseVerdict(row, Date.now());
  const subscription = row.mode === 'subscription' && !row.comp;
  const plan = row.plan === 'yearly' || row.plan === 'monthly' ? row.plan : 'lifetime';
  const owes = subscription && (row.sub_status === 'past_due' || row.sub_status === 'unpaid');
  return Response.json(
    {
      valid,
      plan,
      status,
      reason,
      trialEndsAt: subscription && (status === 'trialing' || reason === 'trial_ended') ? (row.trial_end ?? null) : null,
      renewsAt: subscription && valid ? (row.period_end ?? null) : null,
      cancelAtPeriodEnd: subscription && Boolean(row.cancel_at_period_end),
      manageUrl: row.customer_id ? `${url.origin}/api/portal?key=${key}${owes ? '&pay=1' : ''}` : null,
    },
    { headers },
  );
};
