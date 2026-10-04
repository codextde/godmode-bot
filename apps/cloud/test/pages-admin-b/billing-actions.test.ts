import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { archivePlanAction, createPlanAction, syncPlanAction, updatePlanAction, type PlanFormInput } from "@/app/(app)/admin/billing/actions";
import { minorUnits, moneyText, parseMoney } from "@/app/(app)/admin/billing/_lib/money";
import { getPlan, listPlans } from "@/server/billing/plans";
import { setStripeClientForTests } from "@/server/billing/stripe";
import { SYSTEM } from "@/server/audit";
import { db, planPrices } from "@/server/db";
import { writeSettings } from "@/server/settings";
import { fakeStripe, freePlan } from "../billing/helpers";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { makeUser, seed } from "../platform/fixtures";
import type { SessionState } from "./helpers";

const session = vi.hoisted((): SessionState => ({ ctx: null }));
vi.mock("@/lib/session", async () => (await import("./helpers")).sessionModule(session));
const signIn = (ctx: SessionState["ctx"]) => {
  session.ctx = ctx;
};

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
});
afterEach(() => {
  signIn(null);
  setStripeClientForTests(null);
});
afterAll(closeDatabase);

const pro = (patch: Partial<PlanFormInput> = {}): PlanFormInput => ({
  key: "pro",
  name: "Pro",
  description: "For teams.",
  features: ["5 computers", " ", "Sharing"],
  limits: { maxDevices: 5, relayGbPerMonth: 100, browserAccess: true, phoneGateway: true, sharing: true },
  isPublic: true,
  highlighted: false,
  isFree: false,
  sort: 1,
  priceMonth: "9.90",
  priceYear: "99",
  ...patch,
});

describe("money", () => {
  test("decimal text to minor units and back", () => {
    expect(parseMoney("9.90", "eur")).toEqual({ ok: true, minor: 990 });
    expect(parseMoney("9,9", "eur")).toEqual({ ok: true, minor: 990 });
    expect(parseMoney("100", "usd")).toEqual({ ok: true, minor: 10000 });
    expect(parseMoney("1200", "jpy")).toEqual({ ok: true, minor: 1200 });
    expect(parseMoney("9.999", "eur")).toMatchObject({ ok: false, error: "Use at most 2 decimals." });
    expect(parseMoney("12.5", "jpy")).toMatchObject({ ok: false, error: "JPY has no decimals." });
    expect(parseMoney("0", "eur")).toMatchObject({ ok: false, error: "A price must be more than zero." });
    expect(parseMoney("abc", "eur")).toMatchObject({ ok: false });
    expect(parseMoney("-5", "eur")).toMatchObject({ ok: false });
    expect(moneyText(990, "eur")).toBe("9.90");
    expect(moneyText(1200, "jpy")).toBe("1200");
    expect(minorUnits("xyz")).toBe(2);
  });
});

describe("plan editor", () => {
  test("billing.read alone cannot edit: the admin role is refused, a member too", async () => {
    signIn(await makeUser({ role: "admin" }));
    expect(await createPlanAction(pro())).toEqual({ ok: false, error: "You don't have permission to do that." });
    signIn(await makeUser({ role: "member" }));
    expect((await createPlanAction(pro())).ok).toBe(false);
    expect(await listPlans({ includeArchived: true })).toEqual([]);
  });

  test("creates a plan with prices in minor units of the default currency; Stripe is skipped while not connected", async () => {
    signIn(await makeUser({ role: "billing" }));
    await writeSettings("billing", { currency: "eur" }, SYSTEM);
    const result = await createPlanAction(pro());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sync).toEqual({ status: "skipped" });
    const plan = await getPlan(result.data.planId);
    expect(plan).toMatchObject({ key: "pro", name: "Pro", features: ["5 computers", "Sharing"], isFree: false, limits: { maxDevices: 5, relayGbPerMonth: 100 } });
    expect(plan!.prices.map((p) => [p.interval, p.amount, p.currency])).toEqual([
      ["month", 990, "eur"],
      ["year", 9900, "eur"],
    ]);
  });

  test("validation: price text, name, key and limits come back per field and nothing is written", async () => {
    signIn(await makeUser({ role: "billing" }));
    const price = await createPlanAction(pro({ priceMonth: "nine" }));
    expect(!price.ok && price.fields).toEqual({ priceMonth: "Enter an amount like 9.90." });
    const name = await createPlanAction(pro({ name: "" }));
    expect(!name.ok && name.fields).toMatchObject({ name: "Give the plan a name." });
    const key = await createPlanAction(pro({ key: "Pro Plan" }));
    expect(!key.ok && key.fields).toMatchObject({ key: expect.stringContaining("lower-case") });
    const limit = await createPlanAction(pro({ limits: { ...pro().limits, maxDevices: Number.NaN } }));
    expect(!limit.ok && Object.keys(limit.fields ?? {})).toEqual(["limits.maxDevices"]);
    expect(await listPlans({ includeArchived: true })).toEqual([]);
  });

  test("the free flag is create-only and there is only one free plan", async () => {
    signIn(await makeUser({ role: "billing" }));
    await freePlan();
    const second = await createPlanAction(pro({ key: "free2", isFree: true }));
    expect(!second.ok && second.error).toMatch(/already the free plan/);
    const dup = await createPlanAction(pro({ key: "free" }));
    expect(!dup.ok && dup.error).toMatch(/already exists/);
  });

  test("an unchanged amount keeps its price row; a changed one makes a new row and retires the old", async () => {
    signIn(await makeUser({ role: "billing" }));
    const created = await createPlanAction(pro());
    if (!created.ok) throw new Error(created.error);
    const id = created.data.planId;
    const before = await getPlan(id);

    const same = await updatePlanAction(id, pro({ name: "Pro Team", priceMonth: "9.9", priceYear: "99.00" }));
    expect(same.ok).toBe(true);
    const after = await getPlan(id);
    expect(after!.name).toBe("Pro Team");
    expect(after!.prices.map((p) => p.id).sort()).toEqual(before!.prices.map((p) => p.id).sort());

    const changed = await updatePlanAction(id, pro({ priceMonth: "12", priceYear: "99" }));
    expect(changed.ok).toBe(true);
    const rows = await db.select().from(planPrices).where(eq(planPrices.planId, id));
    expect(rows.filter((r) => r.interval === "month").sort((a, b) => a.amount - b.amount).map((r) => [r.amount, r.active])).toEqual([
      [990, false],
      [1200, true],
    ]);

    const removed = await updatePlanAction(id, pro({ priceMonth: "", priceYear: "99" }));
    expect(!removed.ok && removed.fields).toEqual({ priceMonth: "A price can be changed, not removed. Archive the plan to stop selling it." });
  });

  test("archive: refused for the free plan, hides a paid one", async () => {
    signIn(await makeUser({ role: "billing" }));
    const free = await freePlan();
    expect(!(await archivePlanAction(free.id)).ok).toBe(true);
    const created = await createPlanAction(pro());
    if (!created.ok) throw new Error(created.error);
    const archived = await archivePlanAction(created.data.planId);
    expect(archived).toEqual({ ok: true, data: { sync: { status: "skipped" } } });
    expect((await listPlans()).map((p) => p.key)).toEqual(["free"]);
    expect((await getPlan(created.data.planId))!.archived).toBe(true);
  });

  test("with Stripe connected a save syncs the product and prices; sync alone fails calmly without Stripe", async () => {
    signIn(await makeUser({ role: "billing" }));
    const created = await createPlanAction(pro());
    if (!created.ok) throw new Error(created.error);
    const without = await syncPlanAction(created.data.planId);
    expect(without).toEqual({ ok: false, error: "Stripe is not connected. Add the secret key under Settings → Billing." });

    const stripe = fakeStripe();
    stripe.install();
    await writeSettings("billing", { stripeSecretKey: "sk_test_fake" }, SYSTEM);
    const saved = await updatePlanAction(created.data.planId, pro({ description: "Teams." }));
    expect(saved).toEqual({ ok: true, data: { sync: { status: "synced" } } });
    const plan = await getPlan(created.data.planId);
    expect(plan!.stripeProductId).toMatch(/^prod_/);
    expect(plan!.prices.every((p) => p.stripePriceId?.startsWith("price_"))).toBe(true);
    expect(stripe.callsOf("prices.create")).toHaveLength(2);
  });
});
