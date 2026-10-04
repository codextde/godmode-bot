import { cancelSubscription } from "@/server/billing/subscriptions";
import { requireDevice } from "@/server/devices";
import { errorBody } from "@/server/errors";
import { clientIp, PEER_HEADER } from "@/server/ratelimit";
import { getBillingOverview } from "@/server/usage";

/** Cancel at the end of the period (reversible with /resume). Checkout and payment changes stay in the browser. */
export async function POST(request: Request): Promise<Response> {
  try {
    const { device, owner } = await requireDevice(request.headers.get("authorization"));
    await cancelSubscription(owner, { id: null, label: `device:${device.id}`, ip: clientIp(request.headers, request.headers.get(PEER_HEADER)) });
    return Response.json(await getBillingOverview(owner, { forDevice: true }), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const { status, body } = errorBody(err);
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
  }
}
