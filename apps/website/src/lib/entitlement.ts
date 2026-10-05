import { env } from 'cloudflare:workers';
import type { AstroCookies } from 'astro';
import { db } from './db';
import { isLicenseKey } from './license';
import { ORDER_COOKIE, verify } from './signed';

/** While the site runs on Stripe test keys, test-mode purchases count; with live keys only live ones do. */
export const minLivemode = () => (env.STRIPE_SECRET_KEY?.includes('_test_') ? 0 : 1);

/** True when this browser holds a paid order (signed cookie) or the request carries a paid license key. */
export async function entitled(cookies: AstroCookies, key: string | null): Promise<boolean> {
  const sessionId = await verify(cookies.get(ORDER_COOKIE)?.value);
  if (sessionId) {
    const row = await db()
      .prepare(`SELECT 1 FROM orders WHERE session_id = ? AND status = 'paid' AND livemode >= ?`)
      .bind(sessionId, minLivemode())
      .first();
    if (row) return true;
  }
  const normalized = key?.trim().toUpperCase() ?? '';
  if (isLicenseKey(normalized)) {
    const row = await db()
      .prepare(`SELECT 1 FROM orders WHERE license_key = ? AND status = 'paid' AND livemode >= ?`)
      .bind(normalized, minLivemode())
      .first();
    if (row) return true;
  }
  return false;
}
