import type { APIRoute } from 'astro';
import { FOUNDING, foundingOpen } from '@/config/site';
import { foundingTaken } from '@/lib/db';
import { minLivemode } from '@/lib/entitlement';

export const prerender = false;

/** GET /api/offer → offer state for the counters on the page; seats left only once enough seats are taken. */
export const GET: APIRoute = async () => {
  const taken = await foundingTaken(minLivemode(), FOUNDING.start);
  const showCount = taken >= FOUNDING.showCountFrom;
  return Response.json(
    {
      seats: FOUNDING.seats,
      open: foundingOpen(taken),
      end: FOUNDING.end,
      ...(showCount ? { left: Math.max(0, FOUNDING.seats - taken) } : {}),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
};
