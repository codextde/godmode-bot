import type { APIRoute } from 'astro';
import { assetRedirect, latestRelease, PLATFORMS } from '@/lib/releases';
import { entitled } from '@/lib/entitlement';
import { allowed } from '@/lib/limit';
import { keyFromCookie, setKeyCookie } from '@/lib/signed';

export const prerender = false;

/** /download/mac, /download/windows — licensed customers only (order cookie, key cookie, or a legacy ?key=). */
export const GET: APIRoute = async ({ params, url, cookies, request }) => {
  const platform = params.platform ?? '';
  const target = PLATFORMS[platform];
  if (!target) return new Response('Unknown platform', { status: 404 });
  if (!(await allowed('CHECKOUT_LIMIT', request))) return new Response('Too many requests', { status: 429 });

  const queryKey = url.searchParams.get('key');
  if (queryKey) await setKeyCookie(cookies, queryKey, url.protocol === 'https:');
  const key = queryKey ?? (await keyFromCookie(cookies));
  if (!(await entitled(cookies, key))) {
    const back = new URLSearchParams({ platform });
    if (key) back.set('invalid', '1');
    return new Response(null, { status: 303, headers: { location: `/download?${back}`, 'cache-control': 'no-store' } });
  }
  try {
    const release = await latestRelease();
    const asset = release.assets.find((a) => target.match.test(a.name));
    if (!asset) return new Response(`No ${target.label} build in ${release.tag_name} yet.`, { status: 404 });
    return await assetRedirect(asset);
  } catch (e) {
    console.error('download failed', e);
    return new Response('Download temporarily unavailable — please try again or email us.', { status: 502 });
  }
};
