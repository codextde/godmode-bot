import type { APIRoute } from 'astro';
import { PRICING } from '@/config/site';
import { lifetimeSold } from '@/lib/db';
import { minLivemode } from '@/lib/entitlement';

export const prerender = false;

/** GET /api/offer → { lifetimeLeft } for the Founder Lifetime counter on the pricing card. */
export const GET: APIRoute = async () => {
  const sold = await lifetimeSold(minLivemode());
  return Response.json(
    { lifetimeLeft: Math.max(0, PRICING.lifetimeCap - sold) },
    { headers: { 'cache-control': 'no-store' } },
  );
};
