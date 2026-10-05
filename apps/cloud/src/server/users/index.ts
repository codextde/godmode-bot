/**
 * Accounts. Role, status and deletion changes run in one transaction that first locks every owner row, so at least
 * one active owner always remains, and only owners may change owner accounts.
 */
import { CloudClose } from "@godmode/shared";
import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { actorOf, audit, type Actor } from "../audit";
import { normalizeEmail } from "../auth/policy";
import { revokeAllSessions, type SessionContext } from "../auth/sessions";
import { cancelNow } from "../billing/subscriptions";
import { db, devices, roles, users, type Role, type User } from "../db";
import { badRequest, forbidden, notFound } from "../errors";
import { assertAnotherActiveOwner, assertCanGrant, can, getRole, isOwner, lockOwners, OWNER_ROLE_ID } from "../rbac";
import { relayHub } from "../relay-bridge";

function requireManager(ctx: SessionContext): void {
  if (!can(ctx, "users.manage")) throw forbidden("You don't have permission to manage people.");
}

function protectOwnerAccount(ctx: SessionContext, target: Pick<User, "roleId">): void {
  if (target.roleId === OWNER_ROLE_ID && !isOwner(ctx)) throw forbidden("Only an owner can change an owner's account.");
}

export async function listUsers(q: {
  search?: string;
  roleId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ rows: (User & { role: Role; deviceCount: number })[]; total: number }> {
  const pageSize = Math.min(Math.max(Math.floor(q.pageSize ?? 25), 1), 100);
  const page = Math.max(Math.floor(q.page ?? 1), 1);
  const filters: SQL[] = [];
  const search = q.search?.trim();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    filters.push(or(ilike(users.email, like), ilike(users.name, like))!);
  }
  if (q.roleId) filters.push(eq(users.roleId, q.roleId));
  if (q.status === "active" || q.status === "suspended") filters.push(eq(users.status, q.status));
  const where = filters.length ? and(...filters) : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select({
        user: users,
        role: roles,
        deviceCount: sql<number>`(select count(*) from ${devices} where ${devices.userId} = ${users.id})`.mapWith(Number),
      })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(users).where(where),
  ]);
  return { rows: rows.map((r) => ({ ...r.user, role: r.role, deviceCount: r.deviceCount })), total: total?.n ?? 0 };
}

export async function getUser(id: string): Promise<(User & { role: Role }) | null> {
  const [row] = await db.select({ user: users, role: roles }).from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(eq(users.id, id)).limit(1);
  return row ? { ...row.user, role: row.role } : null;
}

/** The person's own name (Account page). Audited as `actor`, by default the person themselves. */
export async function updateProfile(userId: string, patch: { name: string }, actor?: Actor): Promise<User> {
  const name = String(patch.name ?? "").trim();
  if (name.length > 80) throw badRequest("Keep your name under 80 characters.");
  const [user] = await db
    .update(users)
    .set({ name: name || null, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  if (!user) throw notFound("That account no longer exists.");
  await audit(actor ?? { id: user.id, label: user.email }, "user.profile", { type: "user", id: user.id }, { fields: ["name"] });
  return user;
}

export async function setUserRole(userId: string, roleId: string, ctx: SessionContext): Promise<User> {
  requireManager(ctx);
  if (userId === ctx.user.id) throw forbidden("You can't change your own role.");
  const role = await getRole(roleId);
  if (!role) throw notFound("That role no longer exists.");
  assertCanGrant(ctx, role);
  let previous: string | null = null;
  const user = await db.transaction(async (tx) => {
    await lockOwners(tx);
    const [target] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!target) throw notFound("That person no longer has an account.");
    protectOwnerAccount(ctx, target);
    previous = target.roleId;
    if (target.roleId === role.id) return target;
    if (target.roleId === OWNER_ROLE_ID && target.status === "active") await assertAnotherActiveOwner(tx, userId);
    const [updated] = await tx.update(users).set({ roleId: role.id, updatedAt: new Date() }).where(eq(users.id, userId)).returning();
    return updated!;
  });
  if (previous !== role.id) await audit(actorOf(ctx), "user.role", { type: "user", id: userId }, { email: user.email, from: previous, to: role.id });
  return user;
}

function disconnectComputers(deviceIds: string[], code: number, reason: string): void {
  for (const id of deviceIds) {
    try {
      relayHub().disconnect(id, code, reason);
    } catch (err) {
      console.error(`[users] could not disconnect ${id}:`, err instanceof Error ? err.message : err);
    }
  }
}

async function ownedDeviceIds(userId: string): Promise<string[]> {
  const rows = await db.select({ id: devices.id }).from(devices).where(eq(devices.userId, userId));
  return rows.map((r) => r.id);
}

/** Suspending signs the person out everywhere and disconnects their computers; reactivating lets them sign in again. */
export async function setUserStatus(userId: string, status: "active" | "suspended", ctx: SessionContext): Promise<User> {
  requireManager(ctx);
  if (status !== "active" && status !== "suspended") throw badRequest("Choose active or suspended.");
  if (userId === ctx.user.id) throw forbidden("You can't change the status of your own account.");
  let changed = false;
  const user = await db.transaction(async (tx) => {
    await lockOwners(tx);
    const [target] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!target) throw notFound("That person no longer has an account.");
    protectOwnerAccount(ctx, target);
    if (target.status === status) return target;
    if (status === "suspended" && target.roleId === OWNER_ROLE_ID) await assertAnotherActiveOwner(tx, userId);
    changed = true;
    const [updated] = await tx.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId)).returning();
    return updated!;
  });
  if (!changed) return user;
  if (status === "suspended") {
    const sessionsRevoked = await revokeAllSessions(userId);
    disconnectComputers(await ownedDeviceIds(userId), CloudClose.Disabled, "Account suspended");
    await audit(actorOf(ctx), "user.suspend", { type: "user", id: userId }, { email: user.email, sessionsRevoked });
  } else {
    await audit(actorOf(ctx), "user.activate", { type: "user", id: userId }, { email: user.email });
  }
  return user;
}

/** "Sign out everywhere" for someone else (admin). */
export async function signOutUser(userId: string, ctx: SessionContext): Promise<number> {
  requireManager(ctx);
  const target = await getUser(userId);
  if (!target) throw notFound("That person no longer has an account.");
  protectOwnerAccount(ctx, target);
  return revokeAllSessions(userId, userId === ctx.user.id ? ctx.session.id : undefined, actorOf(ctx));
}

async function removeAccount(userId: string, ctx: SessionContext): Promise<void> {
  const target = await getUser(userId);
  if (!target) throw notFound("That person no longer has an account.");
  protectOwnerAccount(ctx, target);
  const actor = actorOf(ctx);
  // Refuse early, before anything is cancelled in Stripe; the transaction below checks again under the lock.
  if (target.roleId === OWNER_ROLE_ID && target.status === "active") {
    await db.transaction(async (tx) => {
      await lockOwners(tx);
      await assertAnotherActiveOwner(tx, userId);
    });
  }
  // Stripe first: if it refuses, nothing is deleted and the person sees why.
  await cancelNow(userId, actor);
  const deviceIds = await db.transaction(async (tx) => {
    await lockOwners(tx);
    const [current] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!current) throw notFound("That person no longer has an account.");
    if (current.roleId === OWNER_ROLE_ID && current.status === "active") await assertAnotherActiveOwner(tx, userId);
    const owned = await tx.select({ id: devices.id }).from(devices).where(eq(devices.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
    return owned.map((d) => d.id);
  });
  disconnectComputers(deviceIds, CloudClose.BadCredential, "Removed");
  await audit(actor, "user.delete", { type: "user", id: userId }, { email: target.email, computers: deviceIds.length, self: userId === ctx.user.id });
}

/**
 * Deletes someone's account from the admin area: ends their subscription in Stripe immediately, deletes the account
 * (sessions, computers and shares go with it) and disconnects their computers. Nobody deletes themselves here.
 */
export async function deleteAccount(userId: string, ctx: SessionContext): Promise<void> {
  requireManager(ctx);
  if (userId === ctx.user.id) throw forbidden("You can't delete your own account here. Use the Account page.");
  await removeAccount(userId, ctx);
}

/** The Account page's "Delete account", confirmed by typing the own address. Refused for the last active owner. */
export async function deleteOwnAccount(ctx: SessionContext, confirmEmail: string): Promise<void> {
  let typed: string;
  try {
    typed = normalizeEmail(confirmEmail);
  } catch {
    typed = "";
  }
  if (typed !== ctx.user.email) throw badRequest("Type your e-mail address exactly as shown to confirm.");
  await removeAccount(ctx.user.id, ctx);
}

export async function countUsers(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users);
  return row?.n ?? 0;
}

/** New accounts per day (UTC) for the last `days` days, oldest first, days without sign-ups included. */
export async function signupSeries(days: number): Promise<{ day: string; count: number }[]> {
  const n = Math.min(Math.max(Math.floor(days) || 1, 1), 366);
  const result = await db.execute<{ day: string; count: number }>(sql`
    select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(c.count, 0)::int as count
    from generate_series(
      (now() at time zone 'utc')::date - ${n - 1}::int,
      (now() at time zone 'utc')::date,
      interval '1 day'
    ) as d(day)
    left join (
      select (created_at at time zone 'utc')::date as day, count(*) as count
      from ${users}
      where created_at >= ((now() at time zone 'utc')::date - ${n - 1}::int)::timestamp at time zone 'utc'
      group by 1
    ) c on c.day = d.day::date
    order by d.day
  `);
  return result.rows.map((r) => ({ day: r.day, count: Number(r.count) }));
}
