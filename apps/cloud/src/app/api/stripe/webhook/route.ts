import { handleStripeWebhook } from "@/server/billing/webhook";

/** Stripe events. The signature covers the exact bytes Stripe sent, so the body is read as text and never parsed first. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const result = await handleStripeWebhook(body, request.headers.get("stripe-signature"));
  return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
}
