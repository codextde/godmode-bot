/**
 * Database schema (PostgreSQL, Drizzle). Migrations are generated from this file with `pnpm db:generate` into
 * apps/cloud/drizzle and applied at startup (server/migrate.ts).
 *
 * Conventions: ids are `<prefix>_<16 base62 chars>` strings; e-mail addresses are stored lower-cased; every token
 * (session, sign-in link, invite, computer secret) is stored as its SHA-256 hash, never in clear text.
 */
import type { CloudPlanLimits } from "@godmode/shared";
import { bigint, bigserial, boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

/* ------------------------------------------------------------------ */
/* People                                                               */
/* ------------------------------------------------------------------ */

export const roles = pgTable("roles", {
  id: text("id").primaryKey(),
  /** Stable slug: "owner", "admin", "billing", "member", or a custom one. */
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** Permission keys (src/server/rbac/permissions.ts). The owner role ignores this list and may do everything. */
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  /** Built in: can't be deleted or renamed. */
  system: boolean("system").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id),
    status: text("status").$type<"active" | "suspended">().notNull().default("active"),
    stripeCustomerId: text("stripe_customer_id"),
    /** A plan given by an admin without payment. Wins over the free plan, loses to a paid subscription. */
    planOverrideId: text("plan_override_id"),
    planOverrideUntil: ts("plan_override_until"),
    invitedBy: text("invited_by"),
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email), uniqueIndex("users_stripe_customer_key").on(t.stripeCustomerId)],
);

export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    revokedAt: ts("revoked_at"),
    lastSentAt: ts("last_sent_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invites_token_key").on(t.tokenHash), index("invites_email_idx").on(t.email)],
);

/** One sign-in e-mail: a link (token) and a 6-digit code for the browser that asked. Single use. */
export const loginTokens = pgTable(
  "login_tokens",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** SHA-256 of `<id>:<code>`. */
    codeHash: text("code_hash"),
    /** Where to go after signing in (a path on this site). */
    next: text("next"),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    /** Wrong codes entered. */
    attempts: integer("attempts").notNull().default(0),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("login_tokens_token_key").on(t.tokenHash), index("login_tokens_email_idx").on(t.email)],
);

/** One signed-in browser. A person can have many at once. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** "Chrome on macOS" */
    label: text("label").notNull().default(""),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("sessions_token_key").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

/* ------------------------------------------------------------------ */
/* Configuration and audit                                              */
/* ------------------------------------------------------------------ */

/** One row per settings group (src/server/settings). Secret fields inside `value` are stored encrypted. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: updatedAt(),
  updatedBy: text("updated_by"),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: text("actor_id"),
    /** E-mail of the person, "system", "stripe" or "device:<id>". Kept when the account is deleted. */
    actor: text("actor").notNull(),
    /** e.g. "user.invite", "settings.update", "device.link" */
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
  },
  (t) => [index("audit_at_idx").on(t.at), index("audit_action_idx").on(t.action), index("audit_actor_idx").on(t.actorId)],
);

/* ------------------------------------------------------------------ */
/* Computers                                                            */
/* ------------------------------------------------------------------ */

/** A Godmode linked to an account. */
export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The computer's own stable id (`gm_…`). Linking the same computer again reuses its row. */
    instanceId: text("instance_id").notNull(),
    platform: text("platform").notNull().default(""),
    appVersion: text("app_version").notNull().default(""),
    secretHash: text("secret_hash").notNull(),
    /** "disabled": the cloud refuses its link (set by the owner or an admin). */
    status: text("status").$type<"active" | "disabled">().notNull().default("active"),
    /** As the computer reported them when it last connected. */
    browserAccess: boolean("browser_access").notNull().default(true),
    phoneAccess: boolean("phone_access").notNull().default(true),
    lastSeenAt: ts("last_seen_at"),
    lastIp: text("last_ip"),
    createdAt: createdAt(),
  },
  (t) => [index("devices_user_idx").on(t.userId), uniqueIndex("devices_user_instance_key").on(t.userId, t.instanceId)],
);

/** A computer shared with another account. */
export const deviceAccess = pgTable(
  "device_access",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<"operator" | "viewer">().notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.userId] }), index("device_access_user_idx").on(t.userId)],
);

/** A computer asking to be linked, until someone signed in approves it. */
export const linkRequests = pgTable(
  "link_requests",
  {
    id: text("id").primaryKey(),
    userCode: text("user_code").notNull(),
    secretHash: text("secret_hash").notNull(),
    instanceId: text("instance_id").notNull(),
    name: text("name").notNull(),
    platform: text("platform").notNull().default(""),
    appVersion: text("app_version").notNull().default(""),
    ip: text("ip"),
    status: text("status").$type<"pending" | "approved" | "denied">().notNull().default("pending"),
    deviceId: text("device_id"),
    userId: text("user_id"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("link_requests_code_key").on(t.userCode)],
);

/** Relay traffic per computer and day (UTC). `user_id` is the owner at that time. */
export const usageDaily = pgTable(
  "usage_daily",
  {
    deviceId: text("device_id").notNull(),
    userId: text("user_id").notNull(),
    day: date("day").notNull(),
    /** Bytes towards the computer. */
    bytesIn: bigint("bytes_in", { mode: "number" }).notNull().default(0),
    /** Bytes from the computer. */
    bytesOut: bigint("bytes_out", { mode: "number" }).notNull().default(0),
    requests: integer("requests").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.day] }), index("usage_user_day_idx").on(t.userId, t.day)],
);

/* ------------------------------------------------------------------ */
/* Plans and subscriptions                                              */
/* ------------------------------------------------------------------ */

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** Bullet points on the plan card. */
  features: jsonb("features").$type<string[]>().notNull().default([]),
  limits: jsonb("limits").$type<CloudPlanLimits>().notNull(),
  /** The plan of everyone without a subscription. Exactly one plan has this. */
  isFree: boolean("is_free").notNull().default(false),
  /** Offered on the billing page. */
  isPublic: boolean("is_public").notNull().default(true),
  highlighted: boolean("highlighted").notNull().default(false),
  sort: integer("sort").notNull().default(0),
  stripeProductId: text("stripe_product_id"),
  archived: boolean("archived").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const planPrices = pgTable(
  "plan_prices",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    interval: text("interval").$type<"month" | "year">().notNull(),
    /** Minor units (cents). */
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    stripePriceId: text("stripe_price_id"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("plan_prices_plan_idx").on(t.planId), uniqueIndex("plan_prices_stripe_key").on(t.stripePriceId)],
);

/** Mirror of a Stripe subscription, kept current by the webhook. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: text("plan_id"),
    priceId: text("price_id"),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    status: text("status").notNull(),
    interval: text("interval").$type<"month" | "year">(),
    amount: integer("amount"),
    currency: text("currency"),
    currentPeriodStart: ts("current_period_start"),
    currentPeriodEnd: ts("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: ts("canceled_at"),
    trialEnd: ts("trial_end"),
    livemode: boolean("livemode").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("subscriptions_stripe_key").on(t.stripeSubscriptionId), index("subscriptions_user_idx").on(t.userId)],
);

/** Stripe events already handled, so a redelivery does nothing. */
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Role = typeof roles.$inferSelect;
export type User = typeof users.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type LoginToken = typeof loginTokens.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type DeviceAccess = typeof deviceAccess.$inferSelect;
export type LinkRequest = typeof linkRequests.$inferSelect;
export type UsageDay = typeof usageDaily.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type PlanPrice = typeof planPrices.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
