/**
 * Relay traffic per computer and UTC day, the monthly quota check the relay asks before every request, and the
 * billing overview shown on /billing and sent to computers. 1 GB of a plan is 10^9 bytes.
 */
import type { CloudBilling, CloudSubscription, CloudSubscriptionStatus, CloudUsage } from "@godmode/shared";
import { and, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { billingEnabled, deviceAllowance, getEntitlements, getSubscription } from "./billing/entitlements";
import { listInvoices } from "./billing/subscriptions";
import { config } from "./config";
import { db, usageDaily, type Subscription, type User } from "./db";
import { AppError } from "./errors";
import { shared } from "./shared";

const GB = 1_000_000_000;
const ALLOWANCE_TTL_MS = 30_000;

type UsageRow = { deviceId: string; userId: string; bytesIn: number; bytesOut: number; requests: number };
type Allowance = { ok: true } | { ok: false; reason: string };

const allowanceCache = () => shared("usage.relayAllowed", () => new Map<string, { at: number; value: Allowance }>());

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthBounds(now = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/** Adds the counters to today's row of each computer. */
export async function recordUsage(rows: UsageRow[]): Promise<void> {
  // One row per computer: Postgres refuses to update the same row twice in one statement.
  const byDevice = new Map<string, UsageRow>();
  for (const row of rows) {
    if (!row.bytesIn && !row.bytesOut && !row.requests) continue;
    const sum = byDevice.get(row.deviceId);
    if (sum) {
      sum.bytesIn += row.bytesIn;
      sum.bytesOut += row.bytesOut;
      sum.requests += row.requests;
      sum.userId = row.userId;
    } else {
      byDevice.set(row.deviceId, { ...row });
    }
  }
  if (byDevice.size === 0) return;
  const day = utcDay(new Date());
  await db
    .insert(usageDaily)
    .values([...byDevice.values()].map((r) => ({ ...r, day })))
    .onConflictDoUpdate({
      target: [usageDaily.deviceId, usageDaily.day],
      set: {
        userId: sql`excluded.user_id`,
        bytesIn: sql`${usageDaily.bytesIn} + excluded.bytes_in`,
        bytesOut: sql`${usageDaily.bytesOut} + excluded.bytes_out`,
        requests: sql`${usageDaily.requests} + excluded.requests`,
      },
    });
}

async function monthTotals(userId: string, start: Date): Promise<{ bytes: number; requests: number }> {
  const [row] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${usageDaily.bytesIn} + ${usageDaily.bytesOut}), 0)`,
      requests: sql<string>`coalesce(sum(${usageDaily.requests}), 0)`,
    })
    .from(usageDaily)
    .where(and(eq(usageDaily.userId, userId), gte(usageDaily.day, utcDay(start))));
  return { bytes: Number(row?.bytes ?? 0), requests: Number(row?.requests ?? 0) };
}

/** This calendar month (UTC) of the account, with the limits of its plan. */
export async function getUsage(userId: string): Promise<CloudUsage> {
  const { start, end } = monthBounds();
  const [totals, ent, devices] = await Promise.all([monthTotals(userId, start), getEntitlements(userId), deviceAllowance(userId)]);
  const gb = ent.limits.relayGbPerMonth;
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    devices: { used: devices.used, limit: devices.limit },
    relayBytes: { used: totals.bytes, limit: gb === null ? null : Math.round(gb * GB) },
    requests: totals.requests,
  };
}

/** Whether the account may still relay this month. Asked on every relayed request, so cached for 30 s. */
export async function relayAllowed(userId: string): Promise<Allowance> {
  const cache = allowanceCache();
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < ALLOWANCE_TTL_MS) return hit.value;
  const { limits } = await getEntitlements(userId);
  let value: Allowance = { ok: true };
  if (limits.relayGbPerMonth !== null) {
    const { start, end } = monthBounds();
    const { bytes } = await monthTotals(userId, start);
    if (bytes >= limits.relayGbPerMonth * GB) {
      const resets = end.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
      value = {
        ok: false,
        reason: `This account has used its ${limits.relayGbPerMonth} GB of relay traffic for this month. It resets on ${resets}; a bigger plan includes more.`,
      };
    }
  }
  cache.set(userId, { at: Date.now(), value });
  return value;
}

/** One entry per UTC day for the last `days` days (today included), zeros where nothing was relayed. */
export async function usageSeries(q: { userId?: string; deviceId?: string; days: number }): Promise<{ day: string; bytesIn: number; bytesOut: number; requests: number }[]> {
  const days = Math.min(Math.max(Math.trunc(q.days), 1), 366);
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1)));
  const conditions: SQL[] = [gte(usageDaily.day, utcDay(from))];
  if (q.userId) conditions.push(eq(usageDaily.userId, q.userId));
  if (q.deviceId) conditions.push(eq(usageDaily.deviceId, q.deviceId));
  const rows = await db
    .select({
      day: usageDaily.day,
      bytesIn: sql<string>`sum(${usageDaily.bytesIn})`,
      bytesOut: sql<string>`sum(${usageDaily.bytesOut})`,
      requests: sql<string>`sum(${usageDaily.requests})`,
    })
    .from(usageDaily)
    .where(and(...conditions))
    .groupBy(usageDaily.day);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: days }, (_, i) => {
    const day = utcDay(new Date(from.getTime() + i * 86_400_000));
    const row = byDay.get(day);
    return { day, bytesIn: Number(row?.bytesIn ?? 0), bytesOut: Number(row?.bytesOut ?? 0), requests: Number(row?.requests ?? 0) };
  });
}

/** Traffic per computer since `from` (UTC day), with zeros for computers without traffic. */
export async function usageTotals(deviceIds: string[], from: Date): Promise<Record<string, { bytesIn: number; bytesOut: number; requests: number }>> {
  const out: Record<string, { bytesIn: number; bytesOut: number; requests: number }> = {};
  for (const id of deviceIds) out[id] = { bytesIn: 0, bytesOut: 0, requests: 0 };
  if (deviceIds.length === 0) return out;
  const rows = await db
    .select({
      deviceId: usageDaily.deviceId,
      bytesIn: sql<string>`sum(${usageDaily.bytesIn})`,
      bytesOut: sql<string>`sum(${usageDaily.bytesOut})`,
      requests: sql<string>`sum(${usageDaily.requests})`,
    })
    .from(usageDaily)
    .where(and(inArray(usageDaily.deviceId, deviceIds), gte(usageDaily.day, utcDay(from))))
    .groupBy(usageDaily.deviceId);
  for (const r of rows) out[r.deviceId] = { bytesIn: Number(r.bytesIn), bytesOut: Number(r.bytesOut), requests: Number(r.requests) };
  return out;
}

function subscriptionView(sub: Subscription | null): CloudSubscription | null {
  if (!sub) return null;
  return {
    status: sub.status as CloudSubscriptionStatus,
    interval: sub.interval,
    amount: sub.amount,
    currency: sub.currency,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    trialEnd: sub.trialEnd?.toISOString() ?? null,
  };
}

/**
 * Plan, subscription, usage and invoices of an account. For a computer (`forDevice`) invoices carry no Stripe links,
 * only a link to the signed-in /billing page. When Stripe can't be reached the rest still comes back, with a notice.
 */
export async function getBillingOverview(user: User, opts: { forDevice?: boolean } = {}): Promise<CloudBilling & { notice: string | null }> {
  const { publicUrl } = config();
  const [enabled, ent, subscription, usage] = await Promise.all([billingEnabled(), getEntitlements(user.id), getSubscription(user.id), getUsage(user.id)]);
  let invoices: CloudBilling["invoices"] = [];
  let notice: string | null = null;
  try {
    invoices = await listInvoices(user);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    notice = "Invoices could not be loaded from Stripe right now. Try again in a few minutes.";
  }
  if (opts.forDevice) {
    invoices = invoices.map((invoice) => ({ ...invoice, url: `${publicUrl}/billing?invoice=${encodeURIComponent(invoice.id)}`, pdf: null }));
  }
  return {
    billingEnabled: enabled,
    plan: ent.plan,
    subscription: subscriptionView(subscription),
    usage,
    invoices,
    urls: { billing: `${publicUrl}/billing`, devices: `${publicUrl}/devices`, account: `${publicUrl}/account` },
    notice,
  };
}
