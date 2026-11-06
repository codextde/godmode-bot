import type { APIRoute } from 'astro';
import { clearPartnerSession } from '@/lib/partner-auth';

export const prerender = false;

const logout: APIRoute = ({ cookies }) => {
  clearPartnerSession(cookies);
  return new Response(null, { status: 303, headers: { location: '/partners', 'cache-control': 'no-store' } });
};

export const POST = logout;
export const GET = logout;
