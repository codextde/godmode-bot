import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { dailyHash } from '@/lib/signed';
import { allowed, BOTS } from '@/lib/limit';

export const prerender = false;

const TYPES = new Set([
  'pageview',
  'click',
  'view',
  'checkout_start',
  'video_play',
  'faq',
  'usecase',
  'roi_calc',
  'lead',
  'consent',
  'purchase_view',
]);
const str = (v: unknown, n = 120) => (typeof v === 'string' && v ? v.slice(0, n) : null);

/**
 * Cookieless analytics. A visitor is a keyed hash of (day, IP, user agent) with a secret key — it changes
 * every day, the IP itself is never stored, and without the key the hash can't be reversed.
 */
export const POST: APIRoute = async ({ request }) => {
  const ua = request.headers.get('user-agent') ?? '';
  if (!ua || BOTS.test(ua)) return new Response(null, { status: 204 });
  if (!(await allowed('TRACK_LIMIT', request))) return new Response(null, { status: 204 });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return new Response(null, { status: 400 });
  }
  const type = String(body.type ?? '');
  if (!TYPES.has(type)) return new Response(null, { status: 400 });

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const visitor = await dailyHash(day, `${ip}|${ua}`);
  let referrer: string | null = null;
  try {
    if (typeof body.referrer === 'string' && body.referrer) referrer = new URL(body.referrer).hostname;
  } catch {
    /* ignore malformed referrers */
  }
  const cf = (request as Request & { cf?: { country?: string } }).cf;

  await db()
    .prepare(
      `INSERT INTO events (ts, day, visitor, type, path, label, referrer, utm_source, utm_medium, utm_campaign,
         utm_content, has_click_id, country, device)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      now.getTime(),
      day,
      visitor,
      type,
      str(body.path, 200),
      str(body.label),
      referrer,
      str(body.utm_source),
      str(body.utm_medium),
      str(body.utm_campaign),
      str(body.utm_content),
      body.click ? 1 : 0,
      cf?.country ?? null,
      str(body.device, 12),
    )
    .run();
  return new Response(null, { status: 204 });
};
