import { getEntitlements } from "@/server/billing/entitlements";
import { config } from "@/server/config";
import { requireDevice } from "@/server/devices";
import { errorBody } from "@/server/errors";

/** The linked computer's own record: `Authorization: Bearer <deviceId>.<secret>`. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { device, owner } = await requireDevice(request.headers.get("authorization"));
    const { plan } = await getEntitlements(owner.id);
    return Response.json(
      { deviceId: device.id, name: device.name, account: { email: owner.email, name: owner.name }, plan, publicUrl: config().publicUrl },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const { status, body } = errorBody(err);
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
  }
}
