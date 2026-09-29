import type { APIRoute } from 'astro';
import { assetRedirect, latestRelease } from '@/lib/releases';

export const prerender = false;

// Only the signed updater bundles referenced by latest.json.
const UPDATER_BUNDLE = /(\.app\.tar\.gz|\.AppImage|\.msi|-setup\.exe|\.deb|\.rpm)$/;

export const GET: APIRoute = async ({ params }) => {
  const name = params.name ?? '';
  if (!UPDATER_BUNDLE.test(name)) return new Response('Not found', { status: 404 });
  try {
    const release = await latestRelease();
    const asset = release.assets.find((a) => a.name === name);
    if (!asset) return new Response('Not found', { status: 404 });
    return await assetRedirect(asset);
  } catch (e) {
    console.error('update asset failed', e);
    return new Response('update unavailable', { status: 502 });
  }
};
