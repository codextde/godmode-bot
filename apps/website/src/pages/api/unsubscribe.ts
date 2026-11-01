import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { leadFromUnsubscribeToken } from '@/lib/signed';

export const prerender = false;

const page = (title: string, body: string, status = 200, action = '') =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Godmode</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#fafaf9;color:#111;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<main style="max-width:420px;margin:24px;padding:32px;border:1px solid #e7e5e4;border-radius:16px;background:#fff;text-align:center">
<h1 style="margin:0 0 8px;font-size:22px;letter-spacing:-0.02em">${title}</h1><p style="margin:0 0 20px;color:#57534e">${body}</p>${action}
<a href="/" style="color:#0a7f5a">usegodmode.com</a></main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );

/** GET from the link in an email, POST from mail apps (one-click, RFC 8058) and from the app's Settings. */
const unsubscribe: APIRoute = async ({ request, url }) => {
  const json = (request.headers.get('accept') ?? '').includes('application/json');
  const id = await leadFromUnsubscribeToken(url.searchParams.get('e'));
  if (!id) {
    return json
      ? Response.json({ error: 'invalid_link' }, { status: 400 })
      : page('This link doesn’t work', 'It may be cut off. Reply to any of our emails and we take you off the list by hand.', 400);
  }
  await db().prepare('UPDATE leads SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE id = ?').bind(Date.now(), id).run();
  return json ? Response.json({ ok: true }) : page('You’re unsubscribed', 'You won’t get any more emails about your free days. Godmode keeps working as before.');
};

// Link scanners open GET links in mails, so the link itself only asks; the button (and one-click POST) unsubscribes.
export const GET: APIRoute = async ({ url }) => {
  const token = url.searchParams.get('e') ?? '';
  if (!(await leadFromUnsubscribeToken(token))) return page('This link doesn’t work', 'It may be cut off. Reply to any of our emails and we take you off the list by hand.', 400);
  const action = `<form method="post" action="/api/unsubscribe?e=${encodeURIComponent(token)}" style="margin:0 0 20px"><button style="font:inherit;font-weight:600;color:#fff;background:#0a7f5a;border:0;border-radius:999px;padding:10px 22px;cursor:pointer">Unsubscribe</button></form>`;
  return page('Stop these emails?', 'You won’t get any more emails about your free days. Godmode keeps working as before.', 200, action);
};
export const POST = unsubscribe;
