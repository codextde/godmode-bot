import { env } from 'cloudflare:workers';

/** HTTP Basic auth for /admin (any username, password = ADMIN_PASSWORD). */
export function checkAdmin(request: Request): Response | null {
  const unauthorized = new Response('Authentication required', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="Godmode admin", charset="UTF-8"', 'cache-control': 'no-store' },
  });
  const expected = env.ADMIN_PASSWORD;
  if (!expected) return new Response('ADMIN_PASSWORD is not configured', { status: 503 });
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return unauthorized;
  let password = '';
  try {
    password = atob(header.slice(6)).split(':').slice(1).join(':');
  } catch {
    return unauthorized;
  }
  return timingSafeEqual(password, expected) ? null : unauthorized;
}

function timingSafeEqual(a: string, b: string) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
