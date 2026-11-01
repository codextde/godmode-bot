import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { allowed } from '@/lib/limit';
import { sendFreeWelcome } from '@/lib/mail';
import { unsubscribeToken } from '@/lib/signed';

export const prerender = false;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const DAY = 86_400_000;

/** The end of the app's free days: a date (ISO or epoch ms) within the next 60 days, else null. */
function freeEndsAt(v: unknown, now: number): number | null {
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms > now && ms <= now + 60 * DAY ? ms : null;
}

export const POST: APIRoute = async ({ request }) => {
  if (!(await allowed('CHECKOUT_LIMIT', request))) return Response.json({ error: 'rate_limited' }, { status: 429 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) return Response.json({ error: 'invalid_email' }, { status: 400 });
  const s = (v: unknown, n = 120) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  const now = Date.now();
  const source = s(body?.source);

  if (source !== 'app') {
    await db()
      .prepare('INSERT OR IGNORE INTO leads (ts, email, source, utm_source, utm_campaign) VALUES (?, ?, ?, ?, ?)')
      .bind(now, email, source, s(body?.utm_source), s(body?.utm_campaign))
      .run();
    return Response.json({ ok: true });
  }

  // From the app: someone typed their address for reminders before their free days end. An earlier unsubscribe stays
  // (anyone can post any address here).
  const ends = freeEndsAt(body?.free_ends_at, now);
  const locale = body?.locale === 'de' ? 'de' : 'en';
  const lead = await db()
    .prepare(
      `INSERT INTO leads (ts, email, source, free_ends_at, locale, app_version) VALUES (?1, ?2, 'app', ?3, ?4, ?5)
       ON CONFLICT(email) DO UPDATE SET source = 'app', free_ends_at = COALESCE(excluded.free_ends_at, leads.free_ends_at),
         locale = excluded.locale, app_version = COALESCE(excluded.app_version, leads.app_version)
       RETURNING id`,
    )
    .bind(now, email, ends, locale, s(body?.app_version, 40))
    .first<{ id: number }>();
  if (!lead) return Response.json({ error: 'unavailable' }, { status: 503 });
  await sendFreeWelcome(lead.id).catch((e) => console.error('free welcome email failed', e));
  return Response.json({ ok: true, unsubscribe: await unsubscribeToken(lead.id) });
};
