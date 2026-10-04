/**
 * Billing test helpers: a fake Stripe client that records every call (the real API is never contacted), people with
 * system roles, a relay hub that records notices, and Stripe-shaped subscription objects.
 */
import type { CloudNotice } from "@godmode/shared";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { SYSTEM } from "@/server/audit";
import type { SessionContext } from "@/server/auth/sessions";
import { setStripeClientForTests } from "@/server/billing/stripe";
import { newId } from "@/server/crypto";
import { auditLog, db, planPrices, plans, roles, users, type Role, type User } from "@/server/db";
import { SYSTEM_ROLES } from "@/server/rbac/permissions";
import { registerRelayHub, type RelayHubApi } from "@/server/relay-bridge";
import { writeSettings } from "@/server/settings";

export const WEBHOOK_SECRET = "whsec_test_godmode_cloud_billing";

export type Call = { method: string; args: unknown[] };

const DAY = 86_400;

export function missing(what: string): Error {
  return new Stripe.errors.StripeInvalidRequestError({ message: `No such ${what}`, code: "resource_missing" });
}

/** A subscription the way Stripe 2026-09-30 returns it: the period lives on the item, not the subscription. */
export function stripeSubscription(p: {
  id?: string;
  customer: string;
  price: string;
  amount?: number;
  currency?: string;
  interval?: "month" | "year";
  status?: Stripe.Subscription.Status;
  metadata?: Record<string, string>;
  periodStart?: number;
  periodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  livemode?: boolean;
}): Stripe.Subscription {
  const now = Math.floor(Date.now() / 1000);
  const id = p.id ?? `sub_${newId("x").slice(2)}`;
  const start = p.periodStart ?? now - DAY;
  const end = p.periodEnd ?? start + 30 * DAY;
  return {
    id,
    object: "subscription",
    customer: p.customer,
    status: p.status ?? "active",
    metadata: p.metadata ?? {},
    cancel_at_period_end: p.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    canceled_at: null,
    trial_end: null,
    currency: p.currency ?? "usd",
    livemode: p.livemode ?? false,
    items: {
      object: "list",
      has_more: false,
      url: `/v1/subscription_items?subscription=${id}`,
      data: [
        {
          id: `si_${id}`,
          object: "subscription_item",
          current_period_start: start,
          current_period_end: end,
          subscription: id,
          price: {
            id: p.price,
            object: "price",
            unit_amount: p.amount ?? 1000,
            currency: p.currency ?? "usd",
            recurring: { interval: p.interval ?? "month", interval_count: 1 },
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

/** A Stripe stand-in with just the calls billing makes. While `fail` has an error for a method, every call of it throws that error. */
export function fakeStripe() {
  const calls: Call[] = [];
  const fail = new Map<string, unknown>();
  const subscriptions = new Map<string, Stripe.Subscription>();
  const invoices: Record<string, unknown>[] = [];
  const endpoints = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const next = (prefix: string) => `${prefix}_fake${++seq}`;
  const call = (method: string, args: unknown[]) => {
    calls.push({ method, args });
    const error = fail.get(method);
    if (error) throw error;
  };
  const subscription = (id: string) => {
    const sub = subscriptions.get(id);
    if (!sub) throw missing(`subscription: ${id}`);
    return sub;
  };

  const client = {
    accounts: {
      retrieveCurrent: async (...args: unknown[]) => {
        call("accounts.retrieveCurrent", args);
        return { id: "acct_fake", email: "owner@example.com", default_currency: "eur", settings: { dashboard: { display_name: "Codext GmbH" } } };
      },
    },
    customers: {
      create: async (...args: unknown[]) => {
        call("customers.create", args);
        return { id: next("cus"), ...(args[0] as object) };
      },
    },
    checkout: {
      sessions: {
        create: async (...args: unknown[]) => {
          call("checkout.sessions.create", args);
          const id = next("cs");
          return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (...args: unknown[]) => {
          call("billingPortal.sessions.create", args);
          return { id: next("bps"), url: "https://billing.stripe.com/p/session/test" };
        },
      },
      configurations: {
        create: async (...args: unknown[]) => {
          call("billingPortal.configurations.create", args);
          return { id: next("bpc") };
        },
        update: async (...args: unknown[]) => {
          call("billingPortal.configurations.update", args);
          return { id: args[0] };
        },
      },
    },
    products: {
      create: async (...args: unknown[]) => {
        call("products.create", args);
        return { id: next("prod"), ...(args[0] as object) };
      },
      update: async (...args: unknown[]) => {
        call("products.update", args);
        return { id: args[0], ...(args[1] as object) };
      },
      list: async (...args: unknown[]) => {
        call("products.list", args);
        return { data: [] };
      },
    },
    prices: {
      create: async (...args: unknown[]) => {
        call("prices.create", args);
        return { id: next("price"), ...(args[0] as object) };
      },
      update: async (...args: unknown[]) => {
        call("prices.update", args);
        return { id: args[0], ...(args[1] as object) };
      },
    },
    subscriptions: {
      retrieve: async (...args: unknown[]) => {
        call("subscriptions.retrieve", args);
        return subscription(args[0] as string);
      },
      update: async (...args: unknown[]) => {
        call("subscriptions.update", args);
        const id = args[0] as string;
        const params = args[1] as Stripe.SubscriptionUpdateParams;
        const sub = structuredClone(subscription(id));
        if (params.cancel_at_period_end !== undefined) sub.cancel_at_period_end = params.cancel_at_period_end;
        const item = params.items?.[0];
        if (item?.price) (sub.items.data[0]!.price as { id: string }).id = item.price;
        subscriptions.set(id, sub);
        return sub;
      },
      cancel: async (...args: unknown[]) => {
        call("subscriptions.cancel", args);
        const id = args[0] as string;
        const sub = structuredClone(subscription(id));
        sub.status = "canceled";
        sub.canceled_at = Math.floor(Date.now() / 1000);
        subscriptions.set(id, sub);
        return sub;
      },
      list: async (...args: unknown[]) => {
        call("subscriptions.list", args);
        const { customer } = args[0] as { customer: string };
        return { data: [...subscriptions.values()].filter((s) => s.customer === customer) };
      },
    },
    invoices: {
      list: async (...args: unknown[]) => {
        call("invoices.list", args);
        return { data: invoices };
      },
    },
    webhookEndpoints: {
      retrieve: async (...args: unknown[]) => {
        call("webhookEndpoints.retrieve", args);
        const endpoint = endpoints.get(args[0] as string);
        if (!endpoint) throw missing("webhook endpoint");
        return endpoint;
      },
      update: async (...args: unknown[]) => {
        call("webhookEndpoints.update", args);
        return { id: args[0], ...(args[1] as object) };
      },
      list: async (...args: unknown[]) => {
        call("webhookEndpoints.list", args);
        return { data: [...endpoints.values()] };
      },
      del: async (...args: unknown[]) => {
        call("webhookEndpoints.del", args);
        endpoints.delete(args[0] as string);
        return { id: args[0], deleted: true };
      },
      create: async (...args: unknown[]) => {
        call("webhookEndpoints.create", args);
        const params = args[0] as Record<string, unknown>;
        const endpoint = { id: next("we"), secret: WEBHOOK_SECRET, api_version: params.api_version ?? null, ...params };
        endpoints.set(endpoint.id, endpoint);
        return endpoint;
      },
    },
  };

  const fake = {
    client: client as unknown as Stripe,
    calls,
    fail,
    subscriptions,
    invoices,
    endpoints,
    /** Every recorded call of one method. */
    callsOf: (method: string) => calls.filter((c) => c.method === method),
    /** First argument of the last call of `method`. */
    lastParams: <T = Record<string, unknown>>(method: string): T => {
      const list = calls.filter((c) => c.method === method);
      return list[list.length - 1]?.args[0] as T;
    },
    install: () => setStripeClientForTests(fake.client),
  };
  return fake;
}

export type FakeStripe = ReturnType<typeof fakeStripe>;

/** Records what the relay hub was told. Register after `truncateAll`, which clears shared state. */
export function recordingHub(): { notices: { userId: string; notice: CloudNotice }[] } {
  const notices: { userId: string; notice: CloudNotice }[] = [];
  const hub: RelayHubApi = {
    isOnline: () => false,
    info: () => null,
    online: () => [],
    disconnect: () => {},
    notify: () => {},
    notifyUser: (userId, notice) => notices.push({ userId, notice }),
    stats: () => ({ links: 0, streams: 0, sockets: 0, bytesIn: 0, bytesOut: 0, startedAt: new Date().toISOString() }),
  };
  registerRelayHub(hub);
  return { notices };
}

export async function seedRoles(): Promise<void> {
  await db.insert(roles).values(SYSTEM_ROLES.map((r) => ({ ...r, system: true }))).onConflictDoNothing();
}

export async function createUser(email: string, roleKey = "member", patch: Partial<User> = {}): Promise<User> {
  const role = SYSTEM_ROLES.find((r) => r.key === roleKey)!;
  const [user] = await db
    .insert(users)
    .values({ id: newId("usr"), email, roleId: role.id, ...patch })
    .returning();
  return user!;
}

export async function ctxFor(user: User): Promise<SessionContext> {
  const [role] = await db.select().from(roles).where(eq(roles.id, user.roleId));
  const now = new Date();
  return {
    user,
    role: role as Role,
    session: { id: newId("ses"), userId: user.id, tokenHash: "x", label: "", ip: null, userAgent: null, createdAt: now, lastSeenAt: now, expiresAt: now, revokedAt: null },
  };
}

export async function reloadUser(id: string): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user!;
}

/** Stores a secret key (and webhook secret) and turns billing on or off. */
export async function connectStripe(opts: { enabled?: boolean; webhook?: boolean; patch?: Record<string, unknown> } = {}): Promise<void> {
  await writeSettings(
    "billing",
    {
      stripeSecretKey: "sk_test_fake",
      webhookSecret: opts.webhook === false ? null : WEBHOOK_SECRET,
      enabled: opts.enabled ?? true,
      ...opts.patch,
    },
    SYSTEM,
  );
}

/** A paid plan with an active, synced monthly price. */
export async function paidPlan(p: { key?: string; amount?: number; maxDevices?: number | null; gb?: number | null; stripePriceId?: string } = {}) {
  const planId = newId("plan");
  const [plan] = await db
    .insert(plans)
    .values({
      id: planId,
      key: p.key ?? `pro_${planId.slice(-6).toLowerCase()}`,
      name: "Pro",
      limits: { maxDevices: p.maxDevices === undefined ? 5 : p.maxDevices, relayGbPerMonth: p.gb === undefined ? 100 : p.gb, browserAccess: true, phoneGateway: true, sharing: true },
      stripeProductId: "prod_pro",
    })
    .returning();
  const [price] = await db
    .insert(planPrices)
    .values({ id: newId("price"), planId, interval: "month", amount: p.amount ?? 1000, currency: "usd", stripePriceId: p.stripePriceId ?? `price_${planId}` })
    .returning();
  return { plan: plan!, price: price! };
}

export async function freePlan(maxDevices: number | null = 1, gb: number | null = 1) {
  const [plan] = await db
    .insert(plans)
    .values({ id: newId("plan"), key: "free", name: "Free", isFree: true, limits: { maxDevices, relayGbPerMonth: gb, browserAccess: true, phoneGateway: true, sharing: false } })
    .returning();
  return plan!;
}

export async function auditActions(): Promise<string[]> {
  const rows = await db.select({ action: auditLog.action }).from(auditLog).orderBy(auditLog.id);
  return rows.map((r) => r.action);
}

export function signed(payload: unknown, secret = WEBHOOK_SECRET): { body: string; signature: string } {
  const body = JSON.stringify(payload);
  return { body, signature: Stripe.webhooks.generateTestHeaderString({ payload: body, secret }) };
}

export function event(type: string, object: Record<string, unknown>, id = `evt_${newId("x").slice(2)}`) {
  return { id, object: "event", type, api_version: "2026-09-30.endive", created: Math.floor(Date.now() / 1000), data: { object }, livemode: false };
}
