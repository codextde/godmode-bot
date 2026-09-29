import type { APIRoute } from 'astro';
import { assetText, latestRelease } from '@/lib/releases';

export const prerender = false;

/**
 * The desktop app's update feed (Tauri updater). Mirrors latest.json from the newest GitHub release and
 * points every bundle at /api/update/asset/… on this site. Bundles are verified by the app with the
 * updater public key, so serving them through here doesn't change their trust.
 */
export const GET: APIRoute = async ({ url }) => {
  try {
    const release = await latestRelease();
    const manifest = release.assets.find((a) => a.name === 'latest.json');
    if (!manifest) return new Response('no update manifest', { status: 404 });
    const data = JSON.parse(await assetText(manifest)) as { platforms?: Record<string, { url: string }> };
    // Bundles are referenced either by download URL (…/<file name>) or by API URL (…/assets/<id>).
    const names = new Map(release.assets.map((a) => [String(a.id), a.name]));
    for (const p of Object.values(data.platforms ?? {})) {
      const last = decodeURIComponent(p.url.split('/').pop() ?? '');
      p.url = `${url.origin}/api/update/asset/${encodeURIComponent(names.get(last) ?? last)}`;
    }
    return Response.json(data, { headers: { 'cache-control': 'public, max-age=300' } });
  } catch (e) {
    console.error('update feed failed', e);
    return new Response('update feed unavailable', { status: 502 });
  }
};
