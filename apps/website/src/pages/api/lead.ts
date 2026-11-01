import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { allowed } from '@/lib/limit';

export const prerender = false;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

export const POST: APIRoute = async ({ request }) => {
  if (!(await allowed('CHECKOUT_LIMIT', request))) return Response.json({ error: 'rate_limited' }, { status: 429 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) return Response.json({ error: 'invalid_email' }, { status: 400 });
  const s = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 120) : null);
  await db()
    // Someone already on the list who joins another one (e.g. the Windows waitlist) gets the newer source.
    .prepare(
      'INSERT INTO leads (ts, email, source, utm_source, utm_campaign) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET source = COALESCE(excluded.source, leads.source)',
    )
    .bind(Date.now(), email, s(body?.source), s(body?.utm_source), s(body?.utm_campaign))
    .run();
  return Response.json({ ok: true });
};
