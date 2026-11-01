import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { SETUP, setupPrice } from '@/config/site';
import { db } from '@/lib/db';
import { allowed } from '@/lib/limit';

export const prerender = false;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const SIZES = ['1', '2-5', '6-20', '21+'];

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const POST: APIRoute = async ({ request }) => {
  if (!(await allowed('CHECKOUT_LIMIT', request))) return Response.json({ error: 'rate_limited' }, { status: 429 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const s = (v: unknown, n = 160) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  // Honeypot: people never see the field, form-filling bots do.
  if (s(body?.website)) return Response.json({ ok: true });

  const email = (s(body?.email, 254) ?? '').toLowerCase();
  const name = s(body?.name, 120);
  if (!name) return Response.json({ error: 'missing_name' }, { status: 400 });
  if (!EMAIL.test(email)) return Response.json({ error: 'invalid_email' }, { status: 400 });
  const company = s(body?.company);
  const phone = s(body?.phone, 40);
  const teamSize = SIZES.includes(String(body?.team_size)) ? String(body?.team_size) : null;
  const message = s(body?.message, 4000);
  const locale = body?.locale === 'de' ? 'de' : 'en';
  const now = Date.now();

  const row = await db()
    .prepare(
      `INSERT INTO setup_requests (ts, name, email, company, phone, team_size, message, locale, utm_source, utm_campaign)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(now, name, email, company, phone, teamSize, message, locale, s(body?.utm_source), s(body?.utm_campaign))
    .first<{ id: number }>();
  if (!row) return Response.json({ error: 'unavailable' }, { status: 503 });

  if (env.EMAIL) {
    const lines = [
      `New setup request (${setupPrice('de')}) #${row.id}`,
      '',
      `Name: ${name}`,
      `Company: ${company ?? '-'}`,
      `Email: ${email}`,
      `Phone: ${phone ?? '-'}`,
      `Team size: ${teamSize ?? '-'}`,
      `Language: ${locale}`,
      `Source: ${s(body?.utm_source) ?? '-'} / ${s(body?.utm_campaign) ?? '-'}`,
      '',
      'What should Godmode take over:',
      message ?? '-',
      '',
      'Reply to this email to answer them directly.',
    ];
    try {
      await env.EMAIL.send({
        from: { name: 'Godmode Website', email: env.MAIL_FROM ?? 'daniel@usegodmode.com' },
        replyTo: email,
        to: SETUP.notify,
        subject: `Setup request: ${company ?? name}`,
        text: lines.join('\n'),
        html: `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(lines.join('\n'))}</pre>`,
      });
      await db().prepare('UPDATE setup_requests SET notified_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
    } catch (e) {
      console.error('setup request email failed', row.id, e);
    }
  } else {
    console.log('setup request stored, no EMAIL binding', row.id);
  }
  return Response.json({ ok: true });
};
