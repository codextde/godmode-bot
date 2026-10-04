"use server";

import { ZodError } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { checkPermission } from "@/lib/session";
import { archivePlan, createPlan, getPlan, updatePlan, setPlanPrice, type PlanWithPrices } from "@/server/billing/plans";
import { syncPlanToStripe } from "@/server/billing/stripe";
import { AppError, notFound } from "@/server/errors";
import { getSettings } from "@/server/settings";
import { parseMoney } from "./_lib/money";

/*
 * Plans are edited by people with `billing.manage`; every service function checks that again. Prices are entered as
 * decimals ("9.90") and stored in minor units; a changed amount makes a new Stripe price, so unchanged amounts are
 * left alone and new ones use the default currency from Settings → Billing.
 */

export interface PlanFormInput {
  /** Create only: the key of the Stripe lookup keys. */
  key?: string;
  name: string;
  description: string;
  features: string[];
  limits: { maxDevices: number | null; relayGbPerMonth: number | null; browserAccess: boolean; phoneGateway: boolean; sharing: boolean };
  isPublic: boolean;
  highlighted: boolean;
  /** Create only. */
  isFree?: boolean;
  sort: number;
  /** Decimal text; "" means no price for that interval. */
  priceMonth: string;
  priceYear: string;
}

/** What happened in Stripe after a plan was saved. "skipped": nothing to do (no Stripe, or the free plan). */
export type SyncOutcome = { status: "synced" } | { status: "skipped" } | { status: "failed"; error: string };

function fieldError(field: string, message: string): ZodError {
  return new ZodError([{ code: "custom", path: [field], message, input: undefined }]);
}

type PriceChange = { interval: "month" | "year"; amount: number; currency: string };

/**
 * Works out which prices to write, before anything is stored. An emptied field for an existing price is refused:
 * Stripe prices cannot be removed, only archived with their plan.
 */
function pricePlan(input: PlanFormInput, existing: PlanWithPrices | null, defaultCurrency: string): PriceChange[] {
  const changes: PriceChange[] = [];
  for (const [field, interval] of [
    ["priceMonth", "month"],
    ["priceYear", "year"],
  ] as const) {
    const text = typeof input[field] === "string" ? input[field].trim() : "";
    const current = existing?.prices.find((p) => p.interval === interval && p.active) ?? null;
    if (text === "") {
      if (current) throw fieldError(field, "A price can be changed, not removed. Archive the plan to stop selling it.");
      continue;
    }
    if (current) {
      const same = parseMoney(text, current.currency);
      if (same.ok && same.minor === current.amount) continue;
    }
    const parsed = parseMoney(text, defaultCurrency);
    if (!parsed.ok) throw fieldError(field, parsed.error);
    changes.push({ interval, amount: parsed.minor, currency: defaultCurrency });
  }
  return changes;
}

function planFields(input: PlanFormInput) {
  const limits = input.limits ?? ({} as PlanFormInput["limits"]);
  return {
    name: input.name,
    description: input.description,
    features: Array.isArray(input.features) ? input.features.map((f) => String(f).trim()).filter(Boolean) : [],
    limits: {
      maxDevices: limits.maxDevices === null ? null : limits.maxDevices,
      relayGbPerMonth: limits.relayGbPerMonth === null ? null : limits.relayGbPerMonth,
      browserAccess: limits.browserAccess,
      phoneGateway: limits.phoneGateway,
      sharing: limits.sharing,
    },
    isPublic: input.isPublic,
    highlighted: input.highlighted,
    sort: input.sort,
  };
}

async function syncIfConnected(planId: string, isFree: boolean, ctx: Awaited<ReturnType<typeof checkPermission>>): Promise<SyncOutcome> {
  if (isFree) return { status: "skipped" };
  const { stripeSecretKeySet } = await getSettings("billing");
  if (!stripeSecretKeySet) return { status: "skipped" };
  try {
    await syncPlanToStripe(planId, ctx);
    return { status: "synced" };
  } catch (err) {
    if (err instanceof AppError) return { status: "failed", error: err.message };
    console.error("[billing] plan sync failed:", err);
    return { status: "failed", error: "Could not update Stripe. Try “Sync to Stripe” in a minute." };
  }
}

export async function createPlanAction(input: PlanFormInput): Promise<ActionResult<{ planId: string; sync: SyncOutcome }>> {
  return runAction(async () => {
    const ctx = await checkPermission("billing.manage");
    const isFree = input.isFree === true;
    const { currency } = await getSettings("billing");
    const prices = isFree ? [] : pricePlan(input, null, currency);
    const plan = await createPlan({ ...planFields(input), key: typeof input.key === "string" ? input.key : "", isFree }, ctx);
    for (const price of prices) await setPlanPrice(plan.id, price, ctx);
    return { planId: plan.id, sync: await syncIfConnected(plan.id, plan.isFree, ctx) };
  });
}

export async function updatePlanAction(planId: string, input: PlanFormInput): Promise<ActionResult<{ sync: SyncOutcome }>> {
  return runAction(async () => {
    const ctx = await checkPermission("billing.manage");
    const existing = await getPlan(planId);
    if (!existing) throw notFound("This plan does not exist.");
    const { currency } = await getSettings("billing");
    // Archived plans keep their prices; the free plan has none.
    const prices = existing.isFree || existing.archived ? [] : pricePlan(input, existing, currency);
    await updatePlan(planId, planFields(input), ctx);
    for (const price of prices) await setPlanPrice(planId, price, ctx);
    return { sync: await syncIfConnected(planId, existing.isFree, ctx) };
  });
}

export async function archivePlanAction(planId: string): Promise<ActionResult<{ sync: SyncOutcome }>> {
  return runAction(async () => {
    const ctx = await checkPermission("billing.manage");
    const plan = await archivePlan(planId, ctx);
    return { sync: await syncIfConnected(planId, plan.isFree, ctx) };
  });
}

export async function syncPlanAction(planId: string): Promise<ActionResult<void>> {
  return runAction(async () => {
    const ctx = await checkPermission("billing.manage");
    await syncPlanToStripe(planId, ctx);
  });
}
