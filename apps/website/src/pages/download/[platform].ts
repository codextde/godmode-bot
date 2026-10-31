import type { APIRoute } from 'astro';
import { assetRedirect, findAsset, PLATFORMS } from '@/lib/releases';
import { allowed } from '@/lib/limit';

export const prerender = false;

/** /download/mac, /download/windows, … — the latest release's file for that platform. No key needed: the app runs free for 7 days. */
export const GET: APIRoute = async ({ params, request }) => {
  const platform = params.platform ?? '';
  if (!Object.hasOwn(PLATFORMS, platform)) return new Response('Unknown platform', { status: 404 });
  const target = PLATFORMS[platform];
  if (!(await allowed('CHECKOUT_LIMIT', request))) return new Response('Too many requests', { status: 429 });
  try {
    const { release, asset } = await findAsset((a) => target.match.test(a.name));
    if (!asset) return new Response(`No ${target.label} build in ${release.tag_name} yet.`, { status: 404 });
    return await assetRedirect(asset);
  } catch (e) {
    console.error('download failed', e);
    return new Response('Download temporarily unavailable — please try again or email us.', { status: 502 });
  }
};
