import type { APIRoute } from 'astro';
import { allowed } from '@/lib/limit';
import { safePath, setRefCookie } from '@/lib/partner-auth';
import { activePartnerByCode } from '@/lib/partners';
import { serverEvent } from '@/lib/serverEvent';

export const prerender = false;

/** A partner's link: usegodmode.com/r/CODE[?to=/download]. Remembers the partner for 60 days (last click wins). */
export const GET: APIRoute = async ({ params, url, request, cookies }) => {
  const to = safePath(url.searchParams.get('to'));
  const partner = await activePartnerByCode(params.code ?? '').catch(() => null);
  if (partner) {
    await setRefCookie(cookies, partner.code, url.protocol === 'https:');
    if (await allowed('TRACK_LIMIT', request)) await serverEvent(request, 'ref_click', partner.code, { ref: partner.code, path: to });
  }
  return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
};
