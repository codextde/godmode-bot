import type { APIRoute } from 'astro';
import { assetRedirect, latestRelease, PLATFORMS } from '@/lib/releases';
import { entitled } from '@/lib/entitlement';
import { allowed } from '@/lib/limit';

export const prerender = false;

/** /download/mac, /download/windows?key=GM-… — licensed customers only. */
export const GET: APIRoute = async ({ params, url, cookies, request }) => {
  const platform = params.platform ?? '';
  const target = PLATFORMS[platform];
  if (!target) return new Response('Unknown platform', { status: 404 });
  if (!(await allowed('CHECKOUT_LIMIT', request))) return new Response('Too many requests', { status: 429 });

  if (!(await entitled(cookies, url.searchParams.get('key')))) {
    const back = new URLSearchParams({ platform });
    if (url.searchParams.has('key')) {
      back.set('invalid', '1');
      back.set('key', (url.searchParams.get('key') ?? '').slice(0, 40));
    }
    return new Response(null, { status: 303, headers: { location: `/download?${back}` } });
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
