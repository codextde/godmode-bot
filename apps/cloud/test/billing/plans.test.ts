import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  archivePlan,
  createPlan,
  ensureDefaultPlans,
  getFreePlan,
  listPlans,
  planSummary,
  setPlanPrice,
  UNLIMITED_PLAN,
  updatePlan,
} from "@/server/billing/plans";
import { checkStripeKey, ensurePortalConfiguration, ensureWebhook, setStripeClientForTests, syncPlanToStripe } from "@/server/billing/stripe";
import { resetConfig } from "@/server/config";
import { db, planPrices, plans, users } from "@/server/db";
import { getSettings, getSettingsWithSecrets, writeSettings } from "@/server/settings";
import { SYSTEM } from "@/server/audit";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { auditActions, connectStripe, createUser, ctxFor, fakeStripe, recordingHub, seedRoles, WEBHOOK_SECRET, type FakeStripe } from "./helpers";

let stripe: FakeStripe;

beforeAll(resetDatabase);
afterAll(async () => {
  setStripeClientForTests(null);
  await closeDatabase();
});
beforeEach(async () => {
  await truncateAll();
  await seedRoles();
  recordingHub();
  stripe = fakeStripe();
  stripe.install();
});

async function billingManager() {
  return ctxFor(await createUser("billing@example.com", "billing"));
}

describe("default plans", () => {
  test("ensureDefaultPlans seeds Free and Godmode Cloud once, in billing.currency", async () => {
    await writeSettings("billing", { currency: "eur" }, SYSTEM);
    await ensureDefaultPlans();
    await ensureDefaultPlans();
    await Promise.all([ensureDefaultPlans(), ensureDefaultPlans()]);
    const rows = await db.select().from(plans).orderBy(asc(plans.sort));
    expect(rows.map((p) => [p.key, p.isFree, p.highlighted])).toEqual([
      ["free", true, false],
      ["cloud", false, true],
    ]);
    expect(rows[0]!.limits).toEqual({ maxDevices: 1, relayGbPerMonth: 1, browserAccess: true, phoneGateway: true, sharing: false });
    expect(rows[1]!.limits).toEqual({ maxDevices: 5, relayGbPerMonth: 100, browserAccess: true, phoneGateway: true, sharing: true });
    const prices = await db.select().from(planPrices).orderBy(asc(planPrices.amount));
    expect(prices.map((p) => [p.interval, p.amount, p.currency, p.planId])).toEqual([
      ["month", 1000, "eur", rows[1]!.id],
      ["year", 10000, "eur", rows[1]!.id],
    ]);
  });

  test("seeds nothing when any plan exists", async () => {
    const ctx = await billingManager();
    await createPlan({ key: "solo", name: "Solo", limits: { maxDevices: 2, relayGbPerMonth: 10, browserAccess: true, phoneGateway: true, sharing: false } }, ctx);
    await ensureDefaultPlans();
    expect((await db.select().from(plans)).map((p) => p.key)).toEqual(["solo"]);
  });

  test("planSummary, UNLIMITED_PLAN and the free plan fallback", async () => {
    expect(UNLIMITED_PLAN.limits).toEqual({ maxDevices: null, relayGbPerMonth: null, browserAccess: true, phoneGateway: true, sharing: true });
    expect((await getFreePlan()).limits.maxDevices).toBe(1);
    await ensureDefaultPlans();
    const [free] = await db.select().from(plans).where(eq(plans.isFree, true));
    expect(await getFreePlan()).toEqual(planSummary(free!));
    expect(planSummary(free!)).toEqual({ id: free!.id, name: "Free", limits: free!.limits });
  });
});

describe("plan editing", () => {
  test("needs billing.manage", async () => {
    const member = await ctxFor(await createUser("m@example.com", "member"));
    const admin = await ctxFor(await createUser("a@example.com", "admin"));
    const input = { key: "x", name: "X", limits: { maxDevices: 1, relayGbPerMonth: 1, browserAccess: true, phoneGateway: true, sharing: false } };
    await expect(createPlan(input, member)).rejects.toMatchObject({ status: 403 });
    await expect(createPlan(input, admin)).rejects.toMatchObject({ status: 403 });
    const owner = await ctxFor(await createUser("o@example.com", "owner"));
    await expect(createPlan(input, owner)).resolves.toMatchObject({ key: "x" });
  });

  test("createPlan validates, refuses duplicate keys and a second free plan; updates and archives are audited", async () => {
    const ctx = await billingManager();
    const limits = { maxDevices: 3, relayGbPerMonth: 20, browserAccess: true, phoneGateway: false, sharing: true };
    await expect(createPlan({ key: "Bad Key", name: "X", limits }, ctx)).rejects.toThrow();
    const plan = await createPlan({ key: "team", name: "Team", limits, features: ["Three computers"] }, ctx);
    await expect(createPlan({ key: "team", name: "Again", limits }, ctx)).rejects.toMatchObject({ status: 409 });
    await createPlan({ key: "gratis", name: "Gratis", limits, isFree: true }, ctx);
    await expect(createPlan({ key: "gratis2", name: "Gratis 2", limits, isFree: true }, ctx)).rejects.toMatchObject({ status: 409 });

    const updated = await updatePlan(plan.id, { name: "Team plus", highlighted: true }, ctx);
    expect(updated).toMatchObject({ name: "Team plus", highlighted: true, key: "team" });
    await archivePlan(plan.id, ctx);
    expect((await listPlans()).map((p) => p.key)).not.toContain("team");
    expect((await listPlans({ includeArchived: true })).map((p) => p.key)).toContain("team");
    expect(await auditActions()).toEqual(expect.arrayContaining(["plan.create", "plan.update", "plan.archive"]));
  });

  test("the free plan can't be archived or priced", async () => {
    const ctx = await billingManager();
    await ensureDefaultPlans();
    const [free] = await db.select().from(plans).where(eq(plans.isFree, true));
    await expect(archivePlan(free!.id, ctx)).rejects.toMatchObject({ status: 400 });
    await expect(setPlanPrice(free!.id, { interval: "month", amount: 500, currency: "usd" }, ctx)).rejects.toMatchObject({ status: 400 });
  });

  test("listPlans: publicOnly hides private plans; prices are the active ones", async () => {
    const ctx = await billingManager();
    const limits = { maxDevices: 1, relayGbPerMonth: 1, browserAccess: true, phoneGateway: true, sharing: false };
    await ensureDefaultPlans();
    await createPlan({ key: "hidden", name: "Hidden", limits, isPublic: false }, ctx);
    expect((await listPlans({ publicOnly: true })).map((p) => p.key).sort()).toEqual(["cloud", "free"]);
    const cloud = (await listPlans()).find((p) => p.key === "cloud")!;
    await setPlanPrice(cloud.id, { interval: "month", amount: 1200, currency: "usd" }, ctx);
    const again = (await listPlans()).find((p) => p.key === "cloud")!;
    expect(again.prices.map((p) => [p.interval, p.amount])).toEqual([
      ["month", 1200],
      ["year", 10000],
    ]);
  });
});

describe("setPlanPrice", () => {
  test("a changed amount makes a new price and deactivates the old one; the same amount is a no-op", async () => {
    const ctx = await billingManager();
    await ensureDefaultPlans();
    const [cloud] = await db.select().from(plans).where(eq(plans.key, "cloud"));
    const [oldMonth] = await db.select().from(planPrices).where(eq(planPrices.interval, "month"));
    await db.update(planPrices).set({ stripePriceId: "price_old_month" }).where(eq(planPrices.id, oldMonth!.id));

    const same = await setPlanPrice(cloud!.id, { interval: "month", amount: 1000, currency: "usd" }, ctx);
    expect(same.id).toBe(oldMonth!.id);

    const changed = await setPlanPrice(cloud!.id, { interval: "month", amount: 1500, currency: "USD" }, ctx);
    expect(changed.id).not.toBe(oldMonth!.id);
    expect(changed).toMatchObject({ amount: 1500, currency: "usd", active: true, stripePriceId: null });
    const rows = await db.select().from(planPrices).where(eq(planPrices.interval, "month"));
    expect(rows.map((r) => [r.amount, r.active]).sort()).toEqual([
      [1000, false],
      [1500, true],
    ]);
    await expect(setPlanPrice(cloud!.id, { interval: "month", amount: 0, currency: "usd" }, ctx)).rejects.toThrow();
    await expect(setPlanPrice(cloud!.id, { interval: "month", amount: 10, currency: "dollars" }, ctx)).rejects.toThrow();
    expect((await auditActions()).filter((a) => a === "plan.update")).toHaveLength(1);
  });
});

describe("Stripe setup", () => {
  test("syncPlanToStripe creates a tagged product and prices with lookup keys and tax behaviour, then the portal", async () => {
    const ctx = await billingManager();
    await connectStripe({ patch: { taxBehavior: "exclusive" } });
    await ensureDefaultPlans();
    const [cloud] = await db.select().from(plans).where(eq(plans.key, "cloud"));
    await syncPlanToStripe(cloud!.id, ctx);

    const product = stripe.lastParams("products.create");
    expect(product).toMatchObject({ name: "Godmode Cloud", active: true, metadata: { product: "godmode_cloud", plan_id: cloud!.id, plan_key: "cloud" } });
    const created = stripe.callsOf("prices.create").map((c) => c.args[0] as Record<string, unknown>);
    expect(created).toHaveLength(2);
    expect(created).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unit_amount: 1000,
          currency: "usd",
          recurring: { interval: "month" },
          tax_behavior: "exclusive",
          lookup_key: "godmode_cloud_cloud_month_usd",
          transfer_lookup_key: true,
          metadata: expect.objectContaining({ product: "godmode_cloud" }),
        }),
        expect.objectContaining({ unit_amount: 10000, lookup_key: "godmode_cloud_cloud_year_usd" }),
      ]),
    );
    const rows = await db.select().from(planPrices);
    expect(rows.every((r) => r.stripePriceId?.startsWith("price_fake"))).toBe(true);
    const [synced] = await db.select().from(plans).where(eq(plans.id, cloud!.id));
    expect(synced!.stripeProductId).toMatch(/^prod_fake/);

    const portal = stripe.lastParams<Record<string, any>>("billingPortal.configurations.create");
    expect(portal.features.subscription_cancel).toEqual({ enabled: true, mode: "at_period_end" });
    expect(portal.features.subscription_update.products).toEqual([{ product: synced!.stripeProductId, prices: expect.arrayContaining(rows.map((r) => r.stripePriceId)) }]);
    expect((await getSettings("billing")).portalConfigurationId).toMatch(/^bpc_fake/);

    // A new amount: a new Stripe price, the old one deactivated; the product is updated, not recreated.
    await setPlanPrice(cloud!.id, { interval: "month", amount: 1200, currency: "usd" }, ctx);
    await syncPlanToStripe(cloud!.id, ctx);
    expect(stripe.callsOf("products.create")).toHaveLength(1);
    expect(stripe.callsOf("products.update")).toHaveLength(1);
    expect(stripe.callsOf("prices.create")).toHaveLength(3);
    const oldMonth = rows.find((r) => r.interval === "month")!;
    expect(stripe.callsOf("prices.update").map((c) => c.args)).toEqual([[oldMonth.stripePriceId, { active: false }]]);
    expect(stripe.callsOf("billingPortal.configurations.update")).toHaveLength(1);
    expect(await auditActions()).toContain("plan.sync");
  });

  test("syncPlanToStripe refuses without Stripe, for the free plan, and without billing.manage", async () => {
    const ctx = await billingManager();
    await ensureDefaultPlans();
    const [free] = await db.select().from(plans).where(eq(plans.isFree, true));
    const [cloud] = await db.select().from(plans).where(eq(plans.key, "cloud"));
    await expect(syncPlanToStripe(cloud!.id, ctx)).rejects.toMatchObject({ code: "stripe_not_connected" });
    await connectStripe();
    await expect(syncPlanToStripe(free!.id, ctx)).rejects.toMatchObject({ status: 400 });
    const member = await ctxFor(await createUser("m@example.com"));
    await expect(syncPlanToStripe(cloud!.id, member)).rejects.toMatchObject({ status: 403 });
    expect(stripe.calls).toHaveLength(0);
  });

  test("checkStripeKey checks the shape, asks Stripe, and stores the account name and mode", async () => {
    expect(await checkStripeKey("pk_test_123")).toMatchObject({ ok: false });
    expect(await checkStripeKey(" sk_test_abc ")).toEqual({ ok: true, livemode: false, accountName: "Codext GmbH", defaultCurrency: "eur" });
    const settings = await getSettings("billing");
    expect(settings).toMatchObject({ stripeAccountName: "Codext GmbH", livemode: false });
    const { default: Stripe } = await import("stripe");
    stripe.fail.set("accounts.retrieveCurrent", new Stripe.errors.StripeAuthenticationError({ message: "Invalid API Key provided" }));
    expect(await checkStripeKey("sk_live_wrong")).toEqual({ ok: false, error: "Stripe did not accept the secret key. Check it under Settings → Billing." });
    // A restricted key without the account permission still passes when it can read products.
    stripe.fail.set("accounts.retrieveCurrent", new Stripe.errors.StripePermissionError({ message: "no access" }));
    expect(await checkStripeKey("rk_live_restricted")).toMatchObject({ ok: true, livemode: true, accountName: "" });
  });

  test("switching the key between test and live forgets every Stripe customer; the same mode keeps them", async () => {
    const buyer = await createUser("buyer@example.com", "member", { stripeCustomerId: "cus_test_1" });
    await checkStripeKey("sk_test_first");
    await checkStripeKey("sk_test_second");
    expect((await db.select().from(users).where(eq(users.id, buyer.id)))[0]!.stripeCustomerId).toBe("cus_test_1");
    await checkStripeKey("sk_live_real");
    expect((await db.select().from(users).where(eq(users.id, buyer.id)))[0]!.stripeCustomerId).toBeNull();
  });

  test("ensureWebhook needs https, creates a tagged endpoint and stores its secret", async () => {
    const ctx = await billingManager();
    await connectStripe({ webhook: false });
    expect(await ensureWebhook(ctx)).toMatchObject({ ok: false, manual: true });
    expect(stripe.callsOf("webhookEndpoints.create")).toHaveLength(0);

    const before = process.env.DOMAIN;
    process.env.DOMAIN = "cloud.example.com";
    resetConfig();
    try {
      const result = await ensureWebhook(ctx);
      expect(result).toMatchObject({ ok: true, endpointId: expect.stringMatching(/^we_fake/) });
      const params = stripe.lastParams("webhookEndpoints.create");
      expect(params).toMatchObject({
        url: "https://cloud.example.com/api/stripe/webhook",
        api_version: "2026-09-30.endive",
        metadata: { product: "godmode_cloud" },
        enabled_events: expect.arrayContaining(["checkout.session.completed", "customer.subscription.updated", "invoice.paid", "invoice.payment_failed"]),
      });
      const stored = await getSettingsWithSecrets("billing");
      expect(stored.webhookSecret).toBe(WEBHOOK_SECRET);
      expect(stored.webhookEndpointId).toBe((result as { endpointId: string }).endpointId);

      // Running it again repairs the same endpoint instead of making a second one.
      await ensureWebhook(ctx);
      expect(stripe.callsOf("webhookEndpoints.create")).toHaveLength(1);
      expect(stripe.callsOf("webhookEndpoints.update")).toHaveLength(1);
      expect(await auditActions()).toContain("billing.webhook");
    } finally {
      process.env.DOMAIN = before;
      resetConfig();
    }
  });

  test("ensureWebhook retries without api_version when the account refuses it", async () => {
    const ctx = await billingManager();
    await connectStripe({ webhook: false });
    const before = process.env.DOMAIN;
    process.env.DOMAIN = "cloud.example.com";
    resetConfig();
    try {
      const { default: Stripe } = await import("stripe");
      const create = stripe.client.webhookEndpoints.create.bind(stripe.client.webhookEndpoints);
      let first = true;
      stripe.client.webhookEndpoints.create = (async (params: Parameters<typeof create>[0]) => {
        if (first) {
          first = false;
          throw new Stripe.errors.StripeInvalidRequestError({ message: "You can only use 3 API versions.", param: "api_version" });
        }
        return create(params);
      }) as typeof create;
      expect(await ensureWebhook(ctx)).toMatchObject({ ok: true });
      expect(stripe.lastParams("webhookEndpoints.create")).not.toHaveProperty("api_version");
    } finally {
      process.env.DOMAIN = before;
      resetConfig();
    }
  });

  test("ensurePortalConfiguration recreates a configuration Stripe no longer has", async () => {
    await connectStripe({ patch: { portalConfigurationId: "bpc_gone" } });
    const { missing } = await import("./helpers");
    stripe.fail.set("billingPortal.configurations.update", missing("configuration"));
    const id = await ensurePortalConfiguration();
    expect(id).toMatch(/^bpc_fake/);
    expect(stripe.lastParams<Record<string, any>>("billingPortal.configurations.create").features.subscription_update).toEqual({ enabled: false });
    expect((await getSettings("billing")).portalConfigurationId).toBe(id);
  });
});
