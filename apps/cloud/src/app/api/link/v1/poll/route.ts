import { pollLink } from "@/server/devices/link";
import { errorBody } from "@/server/errors";

/** The computer waits for approval: `Authorization: Bearer <link secret>`, body CloudLinkPollRequest. */
export async function POST(request: Request): Promise<Response> {
  try {
    const secret = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization")?.trim() ?? "")?.[1] ?? "";
    const body = (await request.json().catch(() => null)) as { requestId?: unknown } | null;
    const requestId = typeof body?.requestId === "string" ? body.requestId : "";
    return Response.json(await pollLink(requestId, secret), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const { status, body } = errorBody(err);
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
  }
}
