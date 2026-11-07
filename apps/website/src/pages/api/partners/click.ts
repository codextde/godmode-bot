import type { APIRoute } from 'astro';
import { allowed } from '@/lib/limit';
import { safePath, sameOrigin, setRefCookie } from '@/lib/partner-auth';
import { activePartnerByCode } from '@/lib/partners';
import { serverEvent } from '@/lib/serverEvent';

export const prerender = false;

/** ?ref=CODE on any page (static pages can't set cookies): the page script reports it here and drops it from the URL. */
export const POST: APIRoute = async ({ request, url, cookies }) => {
  if (!sameOrigin(request, url)) return new Response(null, { status: 403 });
  if (!(await allowed('TRACK_LIMIT', request))) return new Response(null, { status: 204 });
  const body = (await request.json().catch(() => ({}))) as { code?: unknown; path?: unknown };
  const partner = await activePartnerByCode(String(body.code ?? '')).catch(() => null);
  if (partner) {
    await setRefCookie(cookies, partner.code, url.protocol === 'https:');
    await serverEvent(request, 'ref_click', partner.code, { ref: partner.code, path: safePath(String(body.path ?? '')) });
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};
