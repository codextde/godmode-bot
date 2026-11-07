import { db } from '@/lib/db';
import { dailyHash } from '@/lib/signed';
import { BOTS } from '@/lib/limit';

type Extra = { ref?: string | null; path?: string };

/** Cookieless server-side event (same daily visitor hash as /api/track), for requests no page script sees. */
export async function serverEvent(request: Request, type: 'download' | 'app_check' | 'ref_click', label: string, extra: Extra = {}) {
  const ua = request.headers.get('user-agent') ?? '';
  if (type !== 'app_check' && (!ua || BOTS.test(ua))) return;
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const visitor = await dailyHash(day, `${request.headers.get('cf-connecting-ip') ?? ''}|${ua}`);
    let referrer: string | null = null;
    try {
      const r = request.headers.get('referer');
      if (r) referrer = new URL(r).hostname;
    } catch {
      /* ignore */
    }
    const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? null;
    const path = extra.path ?? new URL(request.url).pathname;
    await db()
      .prepare(`INSERT INTO events (ts, day, visitor, type, path, label, referrer, country, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(now.getTime(), day, visitor, type, path.slice(0, 200), label.slice(0, 120), referrer, country, extra.ref ?? null)
      .run();
  } catch (e) {
    console.error('server event failed', e);
  }
}
