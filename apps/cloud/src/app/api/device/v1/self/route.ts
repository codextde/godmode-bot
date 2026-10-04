import { requireDevice, unlinkDevice } from "@/server/devices";
import { errorBody } from "@/server/errors";
import { clientIp, PEER_HEADER } from "@/server/ratelimit";

/** The computer unlinks itself: its record is deleted. */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const { device } = await requireDevice(request.headers.get("authorization"), { allowDisabled: true });
    await unlinkDevice(device, { id: null, label: `device:${device.id}`, ip: clientIp(request.headers, request.headers.get(PEER_HEADER)) });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const { status, body } = errorBody(err);
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
  }
}
