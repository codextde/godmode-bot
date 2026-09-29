import { env } from 'cloudflare:workers';

// Small HMAC-signed tokens for cookies: `<payload>.<expiry>.<signature>` (base64url).
const enc = new TextEncoder();
let keyPromise: Promise<CryptoKey> | undefined;

function key() {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not configured');
  keyPromise ??= crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
  return keyPromise;
}

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function sign(payload: string, ttlSeconds: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await crypto.subtle.sign('HMAC', await key(), enc.encode(`${payload}.${exp}`));
  return `${payload}.${exp}.${b64url(sig)}`;
}

export async function verify(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [payload, exp, sig] = parts;
  if (Number(exp) < Date.now() / 1000) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify('HMAC', await key(), raw, enc.encode(`${payload}.${exp}`));
  return ok ? payload : null;
}

/** A stable, non-reversible ID for sharing with third parties (e.g. the X conversion_id). */
export async function publicId(value: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await key(), enc.encode(`public:${value}`));
  return b64url(mac).slice(0, 22);
}

/** Daily-rotating salt for anonymous visitor hashes — secret, so IPs can't be brute-forced back out. */
export async function dailyHash(day: string, value: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await key(), enc.encode(`visitor:${day}:${value}`));
  return [...new Uint8Array(mac)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const ORDER_COOKIE = 'gm_order';
