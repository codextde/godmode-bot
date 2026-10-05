import { requireDevice } from "@/server/devices";
import { errorBody } from "@/server/errors";
import { getBillingOverview } from "@/server/usage";

/** The owner's billing overview as the computer may see it (invoices link to the cloud, not to Stripe). */
export async function GET(request: Request): Promise<Response> {
  try {
    const { owner } = await requireDevice(request.headers.get("authorization"));
    return Response.json(await getBillingOverview(owner, { forDevice: true }), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const { status, body } = errorBody(err);
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
  }
}
