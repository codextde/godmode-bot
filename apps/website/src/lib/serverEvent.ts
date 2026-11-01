import { db } from '@/lib/db';
import { dailyHash } from '@/lib/signed';
import { BOTS } from '@/lib/limit';

/** Cookieless server-side event (same daily visitor hash as /api/track), for requests no page script sees. */
export async function serverEvent(request: Request, type: 'download' | 'app_check', label: string) {
  const ua = request.headers.get('user-agent') ?? '';
  if (type === 'download' && (!ua || BOTS.test(ua))) return;
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
    await db()
      .prepare(`INSERT INTO events (ts, day, visitor, type, path, label, referrer, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(now.getTime(), day, visitor, type, new URL(request.url).pathname.slice(0, 200), label.slice(0, 120), referrer, country)
      .run();
  } catch (e) {
    console.error('server event failed', e);
  }
}
