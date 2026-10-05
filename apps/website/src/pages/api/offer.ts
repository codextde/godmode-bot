import type { APIRoute } from 'astro';
import { FOUNDING, foundingOpen } from '@/config/site';
import { foundingTaken } from '@/lib/db';
import { minLivemode } from '@/lib/entitlement';

export const prerender = false;

/** GET /api/offer → founding seats left, for the counters on the page. */
export const GET: APIRoute = async () => {
  const taken = await foundingTaken(minLivemode(), FOUNDING.start);
  return Response.json(
    { seats: FOUNDING.seats, left: Math.max(0, FOUNDING.seats - taken), open: foundingOpen(taken) },
    { headers: { 'cache-control': 'no-store' } },
  );
};
