import { startLink } from "@/server/devices/link";
import { errorBody } from "@/server/errors";
import { clientIp, PEER_HEADER } from "@/server/ratelimit";

/** A computer asks to be linked (CloudLinkStartRequest → CloudLinkStartResponse). No auth; rate limited per IP. */
export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    return Response.json(await startLink(body, clientIp(request.headers, request.headers.get(PEER_HEADER))), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const { status, body } = errorBody(err);
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
  }
}
