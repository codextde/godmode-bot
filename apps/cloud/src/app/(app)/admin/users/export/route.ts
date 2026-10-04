import { checkPermission } from "@/lib/session";
import { errorBody } from "@/server/errors";
import { listUsers } from "@/server/users";
import { csvResponse, toCsv } from "../../_lib/csv";

/** Rows per query, and the most rows one file holds. */
const BATCH = 100;
const MAX_ROWS = 50_000;

/** People as CSV, with the list's search and filters (`?q`, `?role`, `?status`). Needs `users.read`. */
export async function GET(request: Request): Promise<Response> {
  try {
    await checkPermission("users.read");
    const params = new URL(request.url).searchParams;
    const query = {
      search: params.get("q")?.slice(0, 200) || undefined,
      roleId: params.get("role") || undefined,
      status: params.get("status") || undefined,
    };
    const rows: unknown[][] = [];
    for (let page = 1; rows.length < MAX_ROWS; page += 1) {
      const batch = await listUsers({ ...query, page, pageSize: BATCH });
      for (const u of batch.rows) {
        rows.push([u.id, u.email, u.name ?? "", u.role.name, u.status, u.deviceCount, u.lastLoginAt, u.createdAt]);
      }
      if (batch.rows.length < BATCH) break;
    }
    return csvResponse("people", toCsv(["id", "email", "name", "role", "status", "computers", "last_sign_in", "created"], rows));
  } catch (err) {
    const { status, body } = errorBody(err);
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
  }
}
