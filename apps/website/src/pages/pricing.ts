import type { APIRoute } from 'astro';

export const prerender = false;

// People type usegodmode.com/pricing; the plans are a section of the home page.
export const ALL: APIRoute = () =>
  new Response(null, { status: 301, headers: { location: '/#pricing', 'cache-control': 'public, max-age=86400' } });
