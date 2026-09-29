import type { APIRoute } from 'astro';
import { assetRedirect, releaseFor } from '@/lib/releases';
import { entitled } from '@/lib/entitlement';
import { allowed } from '@/lib/limit';

export const prerender = false;

// The headless server binaries and their checksums, as fetched by /install.sh.
const SERVER_FILE = /^godmode-(darwin|linux|windows)-(x64|arm64|x64-baseline)(\.exe)?(\.sha256)?$/;

/** /download/file/godmode-linux-x64?key=GM-…[&version=v0.2.0] — licensed customers only. */
export const GET: APIRoute = async ({ params, url, cookies, request }) => {
  const name = params.name ?? '';
  if (!SERVER_FILE.test(name)) return new Response('Not found', { status: 404 });
  if (!(await allowed('CHECKOUT_LIMIT', request))) return new Response('Too many requests', { status: 429 });
  if (!(await entitled(cookies, url.searchParams.get('key')))) {
    return new Response('A valid license key is required (GODMODE_LICENSE).', { status: 403 });
  }
  try {
    const release = await releaseFor(url.searchParams.get('version'));
    const asset = release.assets.find((a) => a.name === name);
    if (!asset) return new Response(`${name} is not part of ${release.tag_name}`, { status: 404 });
    return await assetRedirect(asset);
  } catch (e) {
    console.error('file download failed', e);
    return new Response('Download temporarily unavailable', { status: 502 });
  }
};
