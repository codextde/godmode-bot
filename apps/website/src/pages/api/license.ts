import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { isLicenseKey } from '@/lib/license';

export const prerender = false;

/** For the desktop app: GET /api/license?key=GM-… → { valid, plan, status }. */
export const GET: APIRoute = async ({ url }) => {
  const key = url.searchParams.get('key')?.trim().toUpperCase();
  if (!isLicenseKey(key)) return Response.json({ valid: false, reason: 'malformed' }, { status: 400 });
  const row = await db()
    .prepare('SELECT plan, status FROM orders WHERE license_key = ? AND livemode = 1')
    .bind(key)
    .first<{ plan: string; status: string }>();
  if (!row) return Response.json({ valid: false, reason: 'unknown' }, { status: 404 });
  return Response.json(
    { valid: row.status === 'paid', plan: row.plan, status: row.status },
    { headers: { 'cache-control': 'no-store' } },
  );
};
