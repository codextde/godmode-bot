import Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { setStripeClientForTests } from "@/server/billing/stripe";
import { syncSubscription } from "@/server/billing/subscriptions";
import { newId } from "@/server/crypto";
import { db, devices, usageDaily } from "@/server/db";
import { getBillingOverview, getUsage, recordUsage, relayAllowed, usageSeries, usageTotals } from "@/server/usage";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { connectStripe, createUser, fakeStripe, freePlan, paidPlan, recordingHub, reloadUser, seedRoles, stripeSubscription, type FakeStripe } from "./helpers";

const GB = 1_000_000_000;
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
afterEach(() => {
  vi.useRealTimers();
});

function utcDay(offsetDays = 0, from = new Date()): string {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + offsetDays)).toISOString().slice(0, 10);
}

async function device(userId: string, name = "Mac"): Promise<string> {
  const id = newId("dvc");
  await db.insert(devices).values({ id, userId, name, instanceId: `gm_${id}`, secretHash: "h" });
  return id;
}

describe("recordUsage", () => {
  test("adds to today's row, merges rows of one computer, skips empty ones", async () => {
    const user = await createUser("u@example.com");
    const a = await device(user.id);
    const b = await device(user.id);
    await recordUsage([
      { deviceId: a, userId: user.id, bytesIn: 100, bytesOut: 1000, requests: 2 },
      { deviceId: a, userId: user.id, bytesIn: 1, bytesOut: 2, requests: 1 },
      { deviceId: b, userId: user.id, bytesIn: 0, bytesOut: 0, requests: 0 },
    ]);
    await recordUsage([{ deviceId: a, userId: user.id, bytesIn: 10, bytesOut: 20, requests: 3 }]);
    await recordUsage([]);
    const rows = await db.select().from(usageDaily);
    expect(rows).toEqual([{ deviceId: a, userId: user.id, day: utcDay(), bytesIn: 111, bytesOut: 1022, requests: 6 }]);
  });
});

describe("getUsage and quota", () => {
  test("counts the calendar month only, with the plan's limits", async () => {
    await connectStripe();
    await freePlan(2, 1.5);
    const user = await createUser("u@example.com");
    const a = await device(user.id);
    await device(user.id);
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
    const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    await db.insert(usageDaily).values([
      { deviceId: a, userId: user.id, day: lastMonth, bytesIn: 5 * GB, bytesOut: 5 * GB, requests: 99 },
      { deviceId: a, userId: user.id, day: firstOfMonth, bytesIn: 100, bytesOut: 200, requests: 3 },
      { deviceId: "dvc_gone", userId: user.id, day: utcDay(), bytesIn: 1, bytesOut: 2, requests: 1 },
    ]);
    const usage = await getUsage(user.id);
    expect(usage).toEqual({
      periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
      devices: { used: 2, limit: 2 },
      relayBytes: { used: 303, limit: 1.5 * GB },
      requests: 4,
    });
  });

  test("relayAllowed refuses over the monthly quota and caches the answer for 30 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 14, 12)));
    await connectStripe();
    await freePlan(1, 1);
    const user = await createUser("u@example.com");
    const a = await device(user.id);
    expect(await relayAllowed(user.id)).toEqual({ ok: true });

    await recordUsage([{ deviceId: a, userId: user.id, bytesIn: GB / 2, bytesOut: GB / 2, requests: 1 }]);
    expect(await relayAllowed(user.id)).toEqual({ ok: true });

    vi.setSystemTime(new Date(Date.UTC(2026, 9, 14, 12, 0, 31)));
    const refused = await relayAllowed(user.id);
    expect(refused).toEqual({
      ok: false,
      reason: "This account has used its 1 GB of relay traffic for this month. It resets on November 1; a bigger plan includes more.",
    });

    // The owner role is never limited.
    const owner = await createUser("o@example.com", "owner");
    const b = await device(owner.id);
    await recordUsage([{ deviceId: b, userId: owner.id, bytesIn: 5 * GB, bytesOut: 0, requests: 1 }]);
    expect(await relayAllowed(owner.id)).toEqual({ ok: true });
  });

  test("billing off ⇒ no quota", async () => {
    await freePlan(1, 1);
    const user = await createUser("u@example.com");
    const a = await device(user.id);
    await recordUsage([{ deviceId: a, userId: user.id, bytesIn: 10 * GB, bytesOut: 0, requests: 1 }]);
    expect(await relayAllowed(user.id)).toEqual({ ok: true });
    expect((await getUsage(user.id)).relayBytes.limit).toBeNull();
  });
});

describe("series and totals", () => {
  test("usageSeries is zero-filled per day; usageTotals per computer since a date", async () => {
    const user = await createUser("u@example.com");
    const other = await createUser("o@example.com");
    const a = await device(user.id);
    const b = await device(user.id);
    const c = await device(other.id);
    await db.insert(usageDaily).values([
      { deviceId: a, userId: user.id, day: utcDay(-2), bytesIn: 10, bytesOut: 20, requests: 1 },
      { deviceId: b, userId: user.id, day: utcDay(-2), bytesIn: 1, bytesOut: 2, requests: 1 },
      { deviceId: a, userId: user.id, day: utcDay(), bytesIn: 5, bytesOut: 5, requests: 2 },
      { deviceId: c, userId: other.id, day: utcDay(), bytesIn: 1000, bytesOut: 1000, requests: 9 },
      { deviceId: a, userId: user.id, day: utcDay(-10), bytesIn: 7, bytesOut: 7, requests: 7 },
    ]);
    expect(await usageSeries({ userId: user.id, days: 3 })).toEqual([
      { day: utcDay(-2), bytesIn: 11, bytesOut: 22, requests: 2 },
      { day: utcDay(-1), bytesIn: 0, bytesOut: 0, requests: 0 },
      { day: utcDay(), bytesIn: 5, bytesOut: 5, requests: 2 },
    ]);
    expect((await usageSeries({ deviceId: b, days: 3 })).map((d) => d.bytesIn)).toEqual([1, 0, 0]);
    expect((await usageSeries({ days: 1 }))[0]).toEqual({ day: utcDay(), bytesIn: 1005, bytesOut: 1005, requests: 11 });

    const from = new Date(Date.parse(`${utcDay(-3)}T00:00:00Z`));
    expect(await usageTotals([a, b, "dvc_none"], from)).toEqual({
      [a]: { bytesIn: 15, bytesOut: 25, requests: 3 },
      [b]: { bytesIn: 1, bytesOut: 2, requests: 1 },
      dvc_none: { bytesIn: 0, bytesOut: 0, requests: 0 },
    });
    expect(await usageTotals([], from)).toEqual({});
  });
});

describe("getBillingOverview", () => {
  async function payer() {
    await connectStripe();
    await freePlan();
    const { plan, price } = await paidPlan({ gb: 50 });
    const user = await createUser("p@example.com", "member", { stripeCustomerId: "cus_p" });
    const sub = stripeSubscription({ customer: "cus_p", price: price.stripePriceId!, metadata: { product: "godmode_cloud", user_id: user.id }, interval: "month", amount: 1000 });
    stripe.subscriptions.set(sub.id, sub);
    await syncSubscription(sub.id);
    stripe.invoices.push({
      id: "in_1",
      number: "GC-1",
      created: 1_760_000_000,
      total: 1000,
      currency: "usd",
      status: "paid",
      hosted_invoice_url: "https://invoice.stripe.com/i/acct/in_1",
      invoice_pdf: "https://pay.stripe.com/invoice/in_1/pdf",
    });
    return { user: await reloadUser(user.id), plan, sub };
  }

  test("for the signed-in page: Stripe links, plan, subscription and usage", async () => {
    const { user, plan, sub } = await payer();
    const overview = await getBillingOverview(user);
    expect(overview).toMatchObject({
      billingEnabled: true,
      plan: { id: plan.id, name: "Pro" },
      subscription: {
        status: "active",
        interval: "month",
        amount: 1000,
        currency: "usd",
        cancelAtPeriodEnd: false,
        trialEnd: null,
        currentPeriodEnd: new Date(sub.items.data[0]!.current_period_end * 1000).toISOString(),
      },
      usage: { devices: { used: 0, limit: 5 }, relayBytes: { used: 0, limit: 50 * GB }, requests: 0 },
      invoices: [{ id: "in_1", url: "https://invoice.stripe.com/i/acct/in_1", pdf: "https://pay.stripe.com/invoice/in_1/pdf" }],
      urls: { billing: "http://localhost:3210/billing", devices: "http://localhost:3210/devices", account: "http://localhost:3210/account" },
      notice: null,
    });
  });

  test("for a computer: invoices link to the cloud's billing page, never to Stripe", async () => {
    const { user } = await payer();
    const overview = await getBillingOverview(user, { forDevice: true });
    expect(overview.invoices).toEqual([
      { id: "in_1", number: "GC-1", date: new Date(1_760_000_000_000).toISOString(), total: 1000, currency: "usd", status: "paid", url: "http://localhost:3210/billing?invoice=in_1", pdf: null },
    ]);
    expect(JSON.stringify(overview)).not.toContain("stripe.com");
  });

  test("still answers, with a notice, when Stripe can't be reached", async () => {
    const { user, plan } = await payer();
    stripe.fail.set("invoices.list", new Stripe.errors.StripeConnectionError({ message: "ECONNRESET" }));
    const overview = await getBillingOverview(user);
    expect(overview).toMatchObject({ billingEnabled: true, plan: { id: plan.id }, subscription: { status: "active" }, invoices: [] });
    expect(overview.notice).toBe("Invoices could not be loaded from Stripe right now. Try again in a few minutes.");
  });

  test("billing off: unlimited plan, no Stripe calls without a customer", async () => {
    const user = await createUser("free@example.com");
    const overview = await getBillingOverview(user);
    expect(overview).toMatchObject({ billingEnabled: false, plan: { id: "unlimited" }, subscription: null, invoices: [], notice: null });
    expect(stripe.calls).toHaveLength(0);
  });
});
