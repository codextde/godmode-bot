import { checkPermission } from "@/lib/session";
import { listSubscriptions } from "@/server/billing/subscriptions";
import { errorBody } from "@/server/errors";
import { csvResponse, toCsv } from "../../_lib/csv";

const HEADER = [
  "E-mail",
  "Name",
  "Plan",
  "Status",
  "Interval",
  "Amount (minor units)",
  "Currency",
  "Period start",
  "Period end",
  "Cancels at period end",
  "Canceled at",
  "Trial end",
  "Mode",
  "Stripe subscription",
  "Stripe customer",
  "Created",
];

/** GET /admin/billing/export?q=&status= — every matching subscription as CSV (billing.read). */
export async function GET(request: Request): Promise<Response> {
  try {
    await checkPermission("billing.read");
  } catch (err) {
    const { status, body } = errorBody(err);
    return Response.json(body, { status });
  }
  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() || undefined;
  const status = url.searchParams.get("status")?.trim() || undefined;
  const rows: unknown[][] = [];
  for (let page = 1; ; page += 1) {
    const result = await listSubscriptions({ search, status, page, pageSize: 200 });
    for (const s of result.rows) {
      rows.push([
        s.user.email,
        s.user.name,
        s.plan?.name ?? "",
        s.status,
        s.interval,
        s.amount,
        s.currency?.toUpperCase(),
        s.currentPeriodStart,
        s.currentPeriodEnd,
        s.cancelAtPeriodEnd,
        s.canceledAt,
        s.trialEnd,
        s.livemode ? "live" : "test",
        s.stripeSubscriptionId,
        s.stripeCustomerId,
        s.createdAt,
      ]);
    }
    if (result.rows.length < 200 || rows.length >= result.total) break;
  }
  return csvResponse("subscriptions", toCsv(HEADER, rows));
}
