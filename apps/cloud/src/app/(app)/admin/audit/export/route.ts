import { checkPermission } from "@/lib/session";
import { AUDIT_ACTIONS, listAudit } from "@/server/audit";
import { errorBody } from "@/server/errors";
import { csvResponse, toCsv } from "../../_lib/csv";

/** Rows per query, and the most (newest) rows one file holds. */
const BATCH = 200;
const MAX_ROWS = 20_000;

const KNOWN = new Set<string>(AUDIT_ACTIONS.map((a) => a.action));

/** The audit log as CSV, with the page's search and action filter (`?q`, `?action`). Needs `audit.read`. */
export async function GET(request: Request): Promise<Response> {
  try {
    await checkPermission("audit.read");
    const params = new URL(request.url).searchParams;
    const action = params.get("action") ?? "";
    const query = { search: params.get("q")?.slice(0, 200) || undefined, action: KNOWN.has(action) ? action : undefined };
    const rows: unknown[][] = [];
    for (let page = 1; rows.length < MAX_ROWS; page += 1) {
      const batch = await listAudit({ ...query, page, pageSize: BATCH });
      for (const e of batch.rows) {
        rows.push([e.id, e.at, e.actor, e.actorId ?? "", e.action, e.targetType ?? "", e.targetId ?? "", e.ip ?? "", e.meta ? JSON.stringify(e.meta) : ""]);
      }
      if (batch.rows.length < BATCH) break;
    }
    return csvResponse("audit-log", toCsv(["id", "at", "actor", "actor_id", "action", "target_type", "target_id", "ip", "meta"], rows));
  } catch (err) {
    const { status, body } = errorBody(err);
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
  }
}
