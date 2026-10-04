/**
 * Plans (what a person gets) and their prices (what Stripe charges). Stripe prices are immutable, so a changed amount
 * becomes a new `plan_prices` row and the old row is deactivated; subscriptions on the old price keep it until they
 * change plan. Prices reach Stripe through `syncPlanToStripe` (stripe.ts).
 */
import type { CloudPlanLimits, CloudPlanSummary } from "@godmode/shared";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { actorOf, audit } from "../audit";
import type { SessionContext } from "../auth/sessions";
import { newId } from "../crypto";
import { db, planPrices, plans, type Plan, type PlanPrice } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { can } from "../rbac/permissions";
import { getSettings } from "../settings";

/** Metadata tag on every Stripe object of this product; the Stripe account may be shared with other products. */
export const PRODUCT_TAG = "godmode_cloud";

export type PlanWithPrices = Plan & { prices: PlanPrice[] };

export const UNLIMITED_PLAN: CloudPlanSummary = {
  id: "unlimited",
  name: "Unlimited",
  limits: { maxDevices: null, relayGbPerMonth: null, browserAccess: true, phoneGateway: true, sharing: true },
};

const FREE_LIMITS: CloudPlanLimits = { maxDevices: 1, relayGbPerMonth: 1, browserAccess: true, phoneGateway: true, sharing: false };

/** Used only when no free plan row exists (before the first boot seeded one). */
const FREE_FALLBACK: CloudPlanSummary = { id: "free", name: "Free", limits: FREE_LIMITS };

/** Plans, prices, Stripe setup and plan grants are edited by people with `billing.manage`. */
export function assertCanManageBilling(ctx: SessionContext): void {
  if (!can(ctx, "billing.manage")) throw forbidden("You need the permission to manage billing for that.");
}

const limitsSchema = z.object({
  maxDevices: z.number().int().min(0).max(100_000).nullable(),
  relayGbPerMonth: z.number().min(0).max(1_000_000).nullable(),
  browserAccess: z.boolean(),
  phoneGateway: z.boolean(),
  sharing: z.boolean(),
});

const fields = {
  name: z.string().trim().min(1, "Give the plan a name.").max(60, "Keep the name under 60 characters."),
  description: z.string().trim().max(500, "Keep the description under 500 characters."),
  features: z.array(z.string().trim().min(1).max(120)).max(20, "A plan lists at most 20 features."),
  limits: limitsSchema,
  isPublic: z.boolean(),
  highlighted: z.boolean(),
  sort: z.number().int().min(0).max(10_000),
};

const createSchema = z.object({
  ...fields,
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_]{0,39}$/, "Use lower-case letters, digits and underscores for the key."),
  description: fields.description.default(""),
  features: fields.features.default([]),
  isFree: z.boolean().default(false),
  isPublic: fields.isPublic.default(true),
  highlighted: fields.highlighted.default(false),
  sort: fields.sort.default(0),
});

// The key names the Stripe lookup keys and the free flag decides who gets what, so neither changes after creation.
const patchSchema = z.object(fields).partial();

const priceSchema = z.object({
  interval: z.enum(["month", "year"]),
  amount: z.number().int("Enter the amount in cents.").min(1, "A price must be more than zero.").max(100_000_000),
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{3}$/, "Use a three-letter currency code such as usd or eur."),
});

export type PlanInput = z.input<typeof createSchema>;
export type PlanPatch = z.input<typeof patchSchema>;
export type PriceInput = z.input<typeof priceSchema>;

export function planSummary(plan: Plan): CloudPlanSummary {
  return { id: plan.id, name: plan.name, limits: { ...FREE_LIMITS, ...plan.limits } };
}

async function withPrices(rows: Plan[]): Promise<PlanWithPrices[]> {
  if (rows.length === 0) return [];
  const prices = await db
    .select()
    .from(planPrices)
    .where(and(inArray(planPrices.planId, rows.map((p) => p.id)), eq(planPrices.active, true)))
    .orderBy(asc(planPrices.interval), asc(planPrices.createdAt));
  return rows.map((plan) => ({ ...plan, prices: prices.filter((p) => p.planId === plan.id) }));
}

/** Plans in display order, each with its active prices. */
export async function listPlans(opts: { includeArchived?: boolean; publicOnly?: boolean } = {}): Promise<PlanWithPrices[]> {
  const rows = await db
    .select()
    .from(plans)
    .where(and(opts.includeArchived ? undefined : eq(plans.archived, false), opts.publicOnly ? eq(plans.isPublic, true) : undefined))
    .orderBy(asc(plans.sort), asc(plans.createdAt));
  return withPrices(rows);
}

export async function getPlan(id: string): Promise<PlanWithPrices | null> {
  const rows = await db.select().from(plans).where(eq(plans.id, id));
  return (await withPrices(rows))[0] ?? null;
}

/** The plan of everyone without a subscription or grant. */
export async function getFreePlan(): Promise<CloudPlanSummary> {
  const [row] = await db.select().from(plans).where(eq(plans.isFree, true)).orderBy(asc(plans.createdAt)).limit(1);
  return row ? planSummary(row) : FREE_FALLBACK;
}

export async function createPlan(input: PlanInput, ctx: SessionContext): Promise<Plan> {
  assertCanManageBilling(ctx);
  const value = createSchema.parse(input);
  const [sameKey] = await db.select({ id: plans.id }).from(plans).where(eq(plans.key, value.key));
  if (sameKey) throw conflict("A plan with this key already exists. Choose another key.");
  if (value.isFree) {
    const [free] = await db.select({ name: plans.name }).from(plans).where(eq(plans.isFree, true));
    if (free) throw conflict(`"${free.name}" is already the free plan. There can only be one.`);
  }
  const [plan] = await db
    .insert(plans)
    .values({ id: newId("plan"), ...value })
    .returning();
  await audit(actorOf(ctx), "plan.create", { type: "plan", id: plan!.id }, { key: plan!.key, name: plan!.name });
  return plan!;
}

export async function updatePlan(id: string, patch: PlanPatch, ctx: SessionContext): Promise<Plan> {
  assertCanManageBilling(ctx);
  const value = patchSchema.parse(patch);
  const [plan] = await db
    .update(plans)
    .set({ ...value, updatedAt: new Date() })
    .where(eq(plans.id, id))
    .returning();
  if (!plan) throw notFound("This plan does not exist.");
  await audit(actorOf(ctx), "plan.update", { type: "plan", id }, { fields: Object.keys(value) });
  return plan;
}

/**
 * Hides a plan from new subscriptions. People who already pay for it keep it. Stripe is updated on the next
 * `syncPlanToStripe` (the admin page runs it right after).
 */
export async function archivePlan(id: string, ctx: SessionContext): Promise<Plan> {
  assertCanManageBilling(ctx);
  const existing = await getPlan(id);
  if (!existing) throw notFound("This plan does not exist.");
  if (existing.isFree) throw badRequest("The free plan can't be archived: everyone without a subscription uses it.");
  const [plan] = await db.update(plans).set({ archived: true, updatedAt: new Date() }).where(eq(plans.id, id)).returning();
  await audit(actorOf(ctx), "plan.archive", { type: "plan", id }, { name: existing.name });
  return plan!;
}

/**
 * Sets the price of a plan for one interval. The same amount and currency is a no-op; anything else adds a new row
 * (without a Stripe price until the plan is synced) and deactivates the previous one.
 */
export async function setPlanPrice(planId: string, input: PriceInput, ctx: SessionContext): Promise<PlanPrice> {
  assertCanManageBilling(ctx);
  const value = priceSchema.parse(input);
  const result = await db.transaction(async (tx) => {
    const [plan] = await tx.select().from(plans).where(eq(plans.id, planId)).for("update");
    if (!plan) throw notFound("This plan does not exist.");
    if (plan.isFree) throw badRequest("The free plan has no price.");
    if (plan.archived) throw badRequest("This plan is archived. Prices of archived plans can't change.");
    const [current] = await tx
      .select()
      .from(planPrices)
      .where(and(eq(planPrices.planId, planId), eq(planPrices.interval, value.interval), eq(planPrices.active, true)));
    if (current && current.amount === value.amount && current.currency === value.currency) return { price: current, changed: false };
    if (current) await tx.update(planPrices).set({ active: false }).where(eq(planPrices.id, current.id));
    const [price] = await tx
      .insert(planPrices)
      .values({ id: newId("price"), planId, interval: value.interval, amount: value.amount, currency: value.currency })
      .returning();
    return { price: price!, changed: true };
  });
  if (result.changed) {
    await audit(actorOf(ctx), "plan.update", { type: "plan", id: planId }, { price: { interval: value.interval, amount: value.amount, currency: value.currency } });
  }
  return result.price;
}

/**
 * Seeds the two starting plans when the table is empty. Called by `bootstrapData()` at every start; the advisory lock
 * keeps two starting processes from both seeding.
 */
export async function ensureDefaultPlans(): Promise<void> {
  const { currency } = await getSettings("billing");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('godmode_cloud.default_plans'))`);
    const [row] = await tx.select({ n: count() }).from(plans);
    if (row && row.n > 0) return;
    const cloudId = newId("plan");
    await tx.insert(plans).values([
      {
        id: newId("plan"),
        key: "free",
        name: "Free",
        description: "Try Godmode Cloud with one computer.",
        features: ["1 computer", "1 GB relay traffic per month", "Browser and phone access"],
        limits: FREE_LIMITS,
        isFree: true,
        sort: 0,
      },
      {
        id: cloudId,
        key: "cloud",
        name: "Godmode Cloud",
        description: "Reach all your computers from any browser and your phone.",
        features: ["Up to 5 computers", "100 GB relay traffic per month", "Browser and phone access", "Share computers with other accounts"],
        limits: { maxDevices: 5, relayGbPerMonth: 100, browserAccess: true, phoneGateway: true, sharing: true },
        highlighted: true,
        sort: 1,
      },
    ]);
    await tx.insert(planPrices).values([
      { id: newId("price"), planId: cloudId, interval: "month", amount: 1000, currency },
      { id: newId("price"), planId: cloudId, interval: "year", amount: 10000, currency },
    ]);
  });
}
