import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { billingEnabled, deviceAllowance, getEntitlements, previewBillingEnable, setBillingEnabled } from "@/server/billing/entitlements";
import { UNLIMITED_PLAN } from "@/server/billing/plans";
import { setStripeClientForTests } from "@/server/billing/stripe";
import { newId } from "@/server/crypto";
import { db, devices, subscriptions, users } from "@/server/db";
import { getSettings } from "@/server/settings";
import { eq } from "drizzle-orm";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { auditActions, connectStripe, createUser, ctxFor, fakeStripe, freePlan, paidPlan, recordingHub, seedRoles } from "./helpers";

const DAY_MS = 86_400_000;
let notices: ReturnType<typeof recordingHub>["notices"];

beforeAll(resetDatabase);
afterAll(async () => {
  setStripeClientForTests(null);
  await closeDatabase();
});
beforeEach(async () => {
  await truncateAll();
  await seedRoles();
  notices = recordingHub().notices;
  fakeStripe().install();
});

async function addSubscription(userId: string, p: { planId: string | null; status: string; periodStart?: Date; periodEnd?: Date; createdAt?: Date }) {
  await db.insert(subscriptions).values({
    id: newId("sub"),
    userId,
    planId: p.planId,
    stripeSubscriptionId: `sub_${newId("x")}`,
    stripeCustomerId: "cus_x",
    status: p.status,
    currentPeriodStart: p.periodStart ?? new Date(Date.now() - DAY_MS),
    currentPeriodEnd: p.periodEnd ?? new Date(Date.now() + 29 * DAY_MS),
    createdAt: p.createdAt ?? new Date(),
  });
}

async function addDevices(userId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = newId("dvc");
    // Spread creation times so "oldest" is well defined.
    await db.insert(devices).values({ id, userId, name: `Mac ${i}`, instanceId: `gm_${i}`, secretHash: "h", createdAt: new Date(Date.now() - (n - i) * 60_000) });
    ids.push(id);
  }
  return ids;
}

describe("getEntitlements", () => {
  test("billing off (or no key) ⇒ unlimited for everyone", async () => {
    const user = await createUser("a@example.com");
    expect(await billingEnabled()).toBe(false);
    expect(await getEntitlements(user.id)).toMatchObject({ plan: UNLIMITED_PLAN, source: "unlimited" });
    await connectStripe({ enabled: false });
    expect((await getEntitlements(user.id)).source).toBe("unlimited");
  });

  test("owner role ⇒ unlimited even with billing on", async () => {
    await connectStripe();
    await freePlan();
    const owner = await createUser("o@example.com", "owner");
    expect(await billingEnabled()).toBe(true);
    expect(await getEntitlements(owner.id)).toMatchObject({ plan: UNLIMITED_PLAN, source: "unlimited" });
  });

  test("subscription: active and trialing grant; past_due only within the grace days; canceled does not", async () => {
    await connectStripe({ patch: { pastDueGraceDays: 7 } });
    const free = await freePlan();
    const { plan } = await paidPlan();
    const cases: [string, Date, string][] = [
      ["active", new Date(), plan.id],
      ["trialing", new Date(), plan.id],
      ["past_due", new Date(Date.now() - 3 * DAY_MS), plan.id],
      ["past_due", new Date(Date.now() - 8 * DAY_MS), free.id],
      ["canceled", new Date(), free.id],
      ["unpaid", new Date(), free.id],
    ];
    for (const [status, periodStart, expected] of cases) {
      const user = await createUser(`${status}-${periodStart.getTime()}@example.com`);
      await addSubscription(user.id, { planId: plan.id, status, periodStart });
      const ent = await getEntitlements(user.id);
      expect([status, ent.plan.id]).toEqual([status, expected]);
      expect(ent.subscription?.status).toBe(status);
      expect(ent.source).toBe(expected === plan.id ? "subscription" : "free");
    }
  });

  test("override with expiry; subscription wins over override; planId null counts as free", async () => {
    await connectStripe();
    const free = await freePlan();
    const { plan: pro } = await paidPlan({ key: "pro" });
    const { plan: team } = await paidPlan({ key: "team" });

    const granted = await createUser("g@example.com", "member", { planOverrideId: team.id, planOverrideUntil: new Date(Date.now() + DAY_MS) });
    expect(await getEntitlements(granted.id)).toMatchObject({ source: "override", plan: { id: team.id } });

    const expired = await createUser("e@example.com", "member", { planOverrideId: team.id, planOverrideUntil: new Date(Date.now() - DAY_MS) });
    expect(await getEntitlements(expired.id)).toMatchObject({ source: "free", plan: { id: free.id } });

    const forever = await createUser("f@example.com", "member", { planOverrideId: team.id, planOverrideUntil: null });
    expect((await getEntitlements(forever.id)).source).toBe("override");

    const both = await createUser("b@example.com", "member", { planOverrideId: team.id });
    await addSubscription(both.id, { planId: pro.id, status: "active" });
    expect(await getEntitlements(both.id)).toMatchObject({ source: "subscription", plan: { id: pro.id } });

    const unknownPrice = await createUser("u@example.com");
    await addSubscription(unknownPrice.id, { planId: null, status: "active" });
    expect(await getEntitlements(unknownPrice.id)).toMatchObject({ source: "free", plan: { id: free.id } });
  });

  test("the newest running subscription is used, not an older canceled one", async () => {
    await connectStripe();
    await freePlan();
    const { plan } = await paidPlan();
    const user = await createUser("n@example.com");
    await addSubscription(user.id, { planId: plan.id, status: "active", createdAt: new Date(Date.now() - 10 * DAY_MS) });
    await addSubscription(user.id, { planId: plan.id, status: "canceled", createdAt: new Date() });
    await addSubscription(user.id, { planId: plan.id, status: "incomplete_expired", createdAt: new Date() });
    expect((await getEntitlements(user.id)).subscription?.status).toBe("active");
  });
});

describe("deviceAllowance", () => {
  test("unlimited ⇒ every computer; over the limit ⇒ the oldest N stay allowed", async () => {
    const user = await createUser("d@example.com");
    const ids = await addDevices(user.id, 3);
    const open = await deviceAllowance(user.id);
    expect(open).toEqual({ used: 3, limit: null, allowedDeviceIds: new Set(ids) });

    await connectStripe();
    await freePlan(2);
    const limited = await deviceAllowance(user.id);
    expect(limited.used).toBe(3);
    expect(limited.limit).toBe(2);
    expect([...limited.allowedDeviceIds]).toEqual(ids.slice(0, 2));
  });
});

describe("turning billing on", () => {
  test("previewBillingEnable counts people who would be on Free and computers over its limit", async () => {
    await connectStripe({ enabled: false });
    const free = await freePlan(1);
    const { plan } = await paidPlan();
    const owner = await createUser("o@example.com", "owner");
    await addDevices(owner.id, 4);
    const payer = await createUser("p@example.com");
    await addSubscription(payer.id, { planId: plan.id, status: "active" });
    await addDevices(payer.id, 3);
    const granted = await createUser("g@example.com", "member", { planOverrideId: plan.id });
    await addDevices(granted.id, 2);
    const a = await createUser("a@example.com");
    await addDevices(a.id, 3);
    await createUser("b@example.com");
    const suspended = await createUser("s@example.com", "member", { status: "suspended" });
    await addDevices(suspended.id, 5);

    const preview = await previewBillingEnable();
    expect(preview).toEqual({ people: 2, computersOverLimit: 2, freePlan: { id: free.id, name: "Free", limits: free.limits } });
  });

  test("setBillingEnabled needs a key and billing.manage, audits, and re-announces plans", async () => {
    const owner = await createUser("o@example.com", "owner");
    const ctx = await ctxFor(owner);
    await expect(setBillingEnabled(true, ctx)).rejects.toMatchObject({ status: 400 });
    await connectStripe({ enabled: false });
    await freePlan();
    const member = await createUser("m@example.com");
    await addDevices(member.id, 1);
    await expect(setBillingEnabled(true, await ctxFor(member))).rejects.toMatchObject({ status: 403 });

    await setBillingEnabled(true, ctx);
    expect((await getSettings("billing")).enabled).toBe(true);
    expect(await auditActions()).toContain("billing.enable");
    expect(notices.filter((n) => n.userId === member.id).map((n) => n.notice.type)).toEqual(["plan", "billing"]);
    expect(notices.find((n) => n.notice.type === "plan")!.notice).toMatchObject({ plan: { name: "Free" } });

    await setBillingEnabled(false, await ctxFor(await createUser("bm@example.com", "billing")));
    expect(await billingEnabled()).toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, member.id));
    expect((await getEntitlements(row!.id)).source).toBe("unlimited");
  });
});
