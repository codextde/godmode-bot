/**
 * What an account may use. Order: billing off ⇒ unlimited; owner role ⇒ unlimited; a subscription that is active,
 * trialing, or past_due within the grace period ⇒ its plan; a plan granted by an admin (until its date) ⇒ that plan;
 * otherwise the free plan. A computer shared with someone counts against its owner's plan.
 */
import type { CloudPlanLimits, CloudPlanSummary } from "@godmode/shared";
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { actorOf, audit } from "../audit";
import type { SessionContext } from "../auth/sessions";
import { db, devices, plans, roles, subscriptions, users, type Subscription } from "../db";
import { badRequest } from "../errors";
import { OWNER_ROLE_KEY } from "../rbac/permissions";
import { relayHub } from "../relay-bridge";
import { getSettingsWithSecrets, updateSettings } from "../settings";
import { getFreePlan, planSummary, UNLIMITED_PLAN } from "./plans";

export interface Entitlements {
  plan: CloudPlanSummary;
  limits: CloudPlanLimits;
  source: "unlimited" | "subscription" | "override" | "free";
  subscription: Subscription | null;
}

/** Statuses in which a subscription is still running (and blocks a second checkout). */
export const LIVE_STATUSES = ["active", "trialing", "past_due"] as const;

const DAY_MS = 86_400_000;

/** The person's current subscription: a running one first, otherwise the newest that is not incomplete_expired. */
export async function getSubscription(userId: string): Promise<Subscription | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), ne(subscriptions.status, "incomplete_expired")))
    .orderBy(
      sql`case when ${subscriptions.status} in ('active', 'trialing', 'past_due') then 0 else 1 end`,
      desc(subscriptions.createdAt),
    )
    .limit(1);
  return row ?? null;
}

/** `billing.enabled` and a stored secret key. Without both, every account has everything. */
export async function billingEnabled(): Promise<boolean> {
  const settings = await getSettingsWithSecrets("billing");
  return settings.enabled && settings.stripeSecretKey !== "";
}

/**
 * Whether a subscription still grants its plan. Stripe moves `current_period_end` forward at renewal even when the
 * payment fails, so the grace period of a past_due subscription counts from the start of the unpaid period.
 */
function subscriptionGrants(sub: Pick<Subscription, "status" | "currentPeriodStart" | "currentPeriodEnd">, graceDays: number, now: number): boolean {
  if (sub.status === "active" || sub.status === "trialing") return true;
  if (sub.status !== "past_due") return false;
  const due = sub.currentPeriodStart ?? sub.currentPeriodEnd;
  return due !== null && now <= due.getTime() + graceDays * DAY_MS;
}

function overrideValid(user: { planOverrideId: string | null; planOverrideUntil: Date | null }, now: number): boolean {
  return user.planOverrideId !== null && (user.planOverrideUntil === null || user.planOverrideUntil.getTime() > now);
}

function result(plan: CloudPlanSummary, source: Entitlements["source"], subscription: Subscription | null): Entitlements {
  return { plan, limits: plan.limits, source, subscription };
}

async function planById(id: string): Promise<CloudPlanSummary | null> {
  const [row] = await db.select().from(plans).where(eq(plans.id, id));
  return row ? planSummary(row) : null;
}

export async function getEntitlements(userId: string): Promise<Entitlements> {
  const settings = await getSettingsWithSecrets("billing");
  if (!settings.enabled || !settings.stripeSecretKey) return result(UNLIMITED_PLAN, "unlimited", null);

  const [user] = await db
    .select({ roleKey: roles.key, planOverrideId: users.planOverrideId, planOverrideUntil: users.planOverrideUntil })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId));
  const subscription = await getSubscription(userId);
  if (user?.roleKey === OWNER_ROLE_KEY) return result(UNLIMITED_PLAN, "unlimited", subscription);

  const now = Date.now();
  // A subscription to a price we do not know (planId null) grants nothing beyond the free plan.
  if (subscription?.planId && subscriptionGrants(subscription, settings.pastDueGraceDays, now)) {
    const plan = await planById(subscription.planId);
    if (plan) return result(plan, "subscription", subscription);
  }
  if (user && overrideValid(user, now)) {
    const plan = await planById(user.planOverrideId!);
    if (plan) return result(plan, "override", subscription);
  }
  return result(await getFreePlan(), "free", subscription);
}

/** Computers the plan allows. Over the limit, the oldest `limit` computers stay allowed. */
export async function deviceAllowance(userId: string): Promise<{ used: number; limit: number | null; allowedDeviceIds: Set<string> }> {
  const [{ limits }, owned] = await Promise.all([
    getEntitlements(userId),
    db.select({ id: devices.id }).from(devices).where(eq(devices.userId, userId)).orderBy(asc(devices.createdAt), asc(devices.id)),
  ]);
  const limit = limits.maxDevices;
  const allowed = limit === null ? owned : owned.slice(0, limit);
  return { used: owned.length, limit, allowedDeviceIds: new Set(allowed.map((d) => d.id)) };
}

/**
 * Tells the person's linked computers about their (possibly) new plan; the relay hub re-checks the computer limit on
 * the "plan" notice. Never throws: a missed notice is repaired by the next Hello.
 */
export async function announceEntitlements(userId: string): Promise<void> {
  try {
    const { plan } = await getEntitlements(userId);
    relayHub().notifyUser(userId, { type: "plan", plan });
    relayHub().notifyUser(userId, { type: "billing" });
  } catch (err) {
    console.error("[billing] could not announce the plan:", err instanceof Error ? err.message : err);
  }
}

/** What turning billing on would do: how many people end up on the free plan, and how many computers lose access. */
export async function previewBillingEnable(): Promise<{ people: number; computersOverLimit: number; freePlan: CloudPlanSummary }> {
  const [freePlan, settings, people, live, deviceCounts, planRows] = await Promise.all([
    getFreePlan(),
    getSettingsWithSecrets("billing"),
    db
      .select({ id: users.id, roleKey: roles.key, planOverrideId: users.planOverrideId, planOverrideUntil: users.planOverrideUntil })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(eq(users.status, "active")),
    db.select().from(subscriptions).where(inArray(subscriptions.status, [...LIVE_STATUSES])),
    db.select({ userId: devices.userId, n: count() }).from(devices).groupBy(devices.userId),
    db.select({ id: plans.id }).from(plans),
  ]);
  const known = new Set(planRows.map((p) => p.id));
  const devicesOf = new Map(deviceCounts.map((d) => [d.userId, d.n]));
  const now = Date.now();
  let moved = 0;
  let computersOverLimit = 0;
  for (const person of people) {
    if (person.roleKey === OWNER_ROLE_KEY) continue;
    const paying = live.some(
      (s) => s.userId === person.id && s.planId !== null && known.has(s.planId) && subscriptionGrants(s, settings.pastDueGraceDays, now),
    );
    const granted = overrideValid(person, now) && known.has(person.planOverrideId!);
    if (paying || granted) continue;
    moved += 1;
    const limit = freePlan.limits.maxDevices;
    if (limit !== null) computersOverLimit += Math.max(0, (devicesOf.get(person.id) ?? 0) - limit);
  }
  return { people: moved, computersOverLimit, freePlan };
}

/** Turns charging on or off. Every account with a computer is told, so links over the new limits close. */
export async function setBillingEnabled(enabled: boolean, ctx: SessionContext): Promise<void> {
  if (enabled) {
    const settings = await getSettingsWithSecrets("billing");
    if (!settings.stripeSecretKey) throw badRequest("Connect Stripe before turning billing on.");
  }
  // updateSettings checks billing.manage itself.
  await updateSettings("billing", { enabled }, ctx);
  await audit(actorOf(ctx), "billing.enable", null, { enabled });
  const owners = await db.selectDistinct({ userId: devices.userId }).from(devices);
  for (const { userId } of owners) await announceEntitlements(userId);
}
