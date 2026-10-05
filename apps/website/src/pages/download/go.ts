import type { APIRoute } from 'astro';
import { PLATFORMS } from '@/lib/releases';
import { setKeyCookie } from '@/lib/signed';

export const prerender = false;

/** Target of the form on /download: keeps the key in a cookie and continues to the clean /download/<platform>. */
const go: APIRoute = async ({ request, url, cookies }) => {
  const input = request.method === 'POST' ? await request.formData().catch(() => null) : url.searchParams;
  const platform = String(input?.get('platform') ?? '');
  const key = String(input?.get('key') ?? '');
  if (key) await setKeyCookie(cookies, key, url.protocol === 'https:');
  const location = PLATFORMS[platform] ? `/download/${platform}` : '/download';
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
};

export const GET = go;
export const POST = go;
