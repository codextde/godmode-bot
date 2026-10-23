import type { APIRoute } from 'astro';
import { assetRedirect, assetText, releaseFor } from '@/lib/releases';
import { allowed } from '@/lib/limit';

export const prerender = false;

// The headless server binaries and their checksums, as fetched by /install.sh.
const SERVER_FILE = /^godmode-(darwin|linux|windows)-(x64|arm64|x64-baseline)(\.exe)?(\.sha256)?$/;

/** /download/file/godmode-linux-x64[?version=v0.2.0]: only these release files, no key needed. */
export const GET: APIRoute = async ({ params, url, request }) => {
  const name = params.name ?? '';
  if (!SERVER_FILE.test(name)) return new Response('Not found', { status: 404 });
  if (!(await allowed('CHECKOUT_LIMIT', request))) return new Response('Too many requests', { status: 429 });
  try {
    const release = await releaseFor(url.searchParams.get('version'));
    const asset = release.assets.find((a) => a.name === name);
    if (asset) return await assetRedirect(asset);
    // Newer releases keep the checksums in one SHA256SUMS file instead of one .sha256 file per binary.
    const sums = name.endsWith('.sha256') && release.assets.find((a) => a.name === 'SHA256SUMS');
    const line = sums && (await assetText(sums)).split('\n').find((l) => l.split(/\s+/)[1] === name.slice(0, -7));
    if (line) return new Response(`${line.trim()}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    return new Response(`${name} is not part of ${release.tag_name}`, { status: 404 });
  } catch (e) {
    console.error('file download failed', e);
    return new Response('Download temporarily unavailable', { status: 502 });
  }
};
