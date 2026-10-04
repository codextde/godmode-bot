"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { actor, checkPermission } from "@/lib/session";
import { cancelSubscription, changePlan, createCheckout, createPortal, resumeSubscription } from "@/server/billing/subscriptions";

// Every action is for the signed-in person's own account and needs `billing.self`. The price is a `plan_prices.id`;
// the billing service refuses anything that is not an active price of a public, paid plan.
const priceId = z.string("Choose a plan.").regex(/^price_[0-9A-Za-z]{1,40}$/, "Choose a plan.");

/** Starts Stripe Checkout and returns its address; the browser goes there. */
export async function checkoutAction(price: string): Promise<ActionResult<{ url: string }>> {
  return runAction(async () => {
    const ctx = await checkPermission("billing.self");
    return createCheckout(ctx.user, priceId.parse(price));
  });
}

/** The Stripe billing portal: payment method, invoices, tax details. */
export async function portalAction(): Promise<ActionResult<{ url: string }>> {
  return runAction(async () => {
    const ctx = await checkPermission("billing.self");
    return createPortal(ctx.user);
  });
}

export async function changePlanAction(price: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("billing.self");
    await changePlan(ctx.user, priceId.parse(price));
    revalidatePath("/billing");
  });
}

export async function cancelSubscriptionAction(): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("billing.self");
    await cancelSubscription(ctx.user, await actor());
    revalidatePath("/billing");
  });
}

export async function resumeSubscriptionAction(): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("billing.self");
    await resumeSubscription(ctx.user, await actor());
    revalidatePath("/billing");
  });
}
