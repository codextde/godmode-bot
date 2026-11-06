import type { AstroCookies } from 'astro';
import { PARTNERS } from '@/config/partners';
import { db } from './db';
import { sign, verify } from './signed';

const DAY = 86_400;

// The partner a visitor came through (last click wins). Signed, so only codes this site handed out count.
export const REF_COOKIE = 'gm_ref';
const REF_TTL = PARTNERS.cookieDays * DAY;

export const CODE = /^[A-Z0-9]{3,20}$/;
export const normalizeCode = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : '');

export async function setRefCookie(cookies: AstroCookies, code: string, secure: boolean) {
  cookies.set(REF_COOKIE, await sign(code, REF_TTL), { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: REF_TTL });
}

const refFrom = async (value: string | undefined) => {
  const code = await verify(value).catch(() => null);
  return code && CODE.test(code) ? code : null;
};

export const refFromCookies = (cookies: AstroCookies) => refFrom(cookies.get(REF_COOKIE)?.value);

/** The same, for handlers that only have the request (server-side events). */
export function refFromRequest(request: Request) {
  const raw = request.headers.get('cookie') ?? '';
  const hit = raw.split(/;\s*/).find((c) => c.startsWith(`${REF_COOKIE}=`));
  return refFrom(hit ? decodeURIComponent(hit.slice(REF_COOKIE.length + 1)) : undefined);
}

// Partner sessions: a signed partner id in an HttpOnly cookie for 30 days.
export const PARTNER_COOKIE = 'gm_partner';
const SESSION_TTL = 30 * DAY;

export async function setPartnerSession(cookies: AstroCookies, partnerId: number, secure: boolean) {
  cookies.set(PARTNER_COOKIE, await sign(`ps${partnerId}`, SESSION_TTL), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL,
  });
}

export const clearPartnerSession = (cookies: AstroCookies) => cookies.delete(PARTNER_COOKIE, { path: '/' });

export async function partnerIdFromCookies(cookies: AstroCookies): Promise<number | null> {
  const payload = await verify(cookies.get(PARTNER_COOKIE)?.value).catch(() => null);
  return payload && /^ps\d+$/.test(payload) ? Number(payload.slice(2)) : null;
}

// Sign-in links: stateless, 30 minutes, and good once: the token carries the partner's last_login_at, which a
// successful sign-in moves on.
const LOGIN_TTL = 30 * 60;

export async function loginToken(partner: { id: number; last_login_at: number | null }) {
  return sign(`pl${partner.id}-${partner.last_login_at ?? 0}`, LOGIN_TTL);
}

/** Checks a sign-in link and uses it up. The email counts as verified from here on. */
export async function consumeLoginToken(token: string | null | undefined, now = Date.now()): Promise<number | null> {
  const payload = await verify(token ?? undefined).catch(() => null);
  const m = payload ? /^pl(\d+)-(\d+)$/.exec(payload) : null;
  if (!m) return null;
  const id = Number(m[1]);
  const nonce = Number(m[2]);
  const res = await db()
    .prepare(
      `UPDATE partners SET last_login_at = ?, email_verified_at = COALESCE(email_verified_at, ?)
       WHERE id = ? AND COALESCE(last_login_at, 0) = ? AND status <> 'banned'`,
    )
    .bind(Math.max(now, nonce + 1), now, id, nonce)
    .run();
  return res.meta.changes ? id : null;
}

/**
 * Form posts must come from this site. Browsers send Origin on POSTs; without it (some in-app browsers) the
 * Referer has to match instead.
 */
export function sameOrigin(request: Request, url: URL) {
  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') return origin === url.origin;
  const referer = request.headers.get('referer');
  try {
    return Boolean(referer) && new URL(referer!).origin === url.origin;
  } catch {
    return false;
  }
}

/** Runs work after the response (emails, Stripe) so a slow mail or API call never holds up a sign-up or sign-in. */
export async function afterResponse(locals: App.Locals, task: () => Promise<unknown>) {
  const ctx = (locals as Partial<App.Locals>).cfContext;
  if (ctx) ctx.waitUntil(task());
  else await task();
}

/** A same-site path to send a visitor on to; anything else falls back to the home page. */
export function safePath(to: string | null | undefined, fallback = '/') {
  if (!to || !to.startsWith('/') || to.startsWith('//') || to.includes('\\') || /[\u0000-\u001f]/.test(to)) return fallback;
  try {
    const u = new URL(to, 'https://usegodmode.com');
    // "/.//evil.com" parses to the path "//evil.com", which a browser reads as another host.
    if (u.origin !== 'https://usegodmode.com' || u.pathname.startsWith('//')) return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
