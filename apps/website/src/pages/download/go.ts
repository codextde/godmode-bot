import type { APIRoute } from 'astro';
import { PLATFORMS } from '@/lib/releases';

export const prerender = false;

/** Target of the form on /download: turns ?platform=…&key=… into /download/<platform>?key=… */
export const GET: APIRoute = ({ url }) => {
  const platform = url.searchParams.get('platform') ?? '';
  const key = (url.searchParams.get('key') ?? '').trim();
  if (!PLATFORMS[platform]) return new Response(null, { status: 303, headers: { location: '/download' } });
  return new Response(null, { status: 303, headers: { location: `/download/${platform}?key=${encodeURIComponent(key)}` } });
};
