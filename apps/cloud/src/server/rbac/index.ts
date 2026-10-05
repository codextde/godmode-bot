/**
 * Roles. Every rule is enforced here, not only in the UI: the granting rule, who may edit which role, and that one
 * active owner always remains.
 */
import { and, asc, count, eq, getTableColumns, gt, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { actorOf, audit } from "../audit";
import type { SessionContext } from "../auth/sessions";
import { newId } from "../crypto";
import { db, invites, roles, users, type Role, type Tx } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { getSettings } from "../settings";
import {
  can,
  canGrantRole,
  isOwner,
  isPermission,
  OWNER_ROLE_ID,
  OWNER_ROLE_KEY,
  PERMISSION_KEYS,
  PERSONAL_PERMISSIONS,
  SYSTEM_ROLES,
  type Permission,
} from "./permissions";

export * from "./permissions";

/** Seeds the four built-in roles. Idempotent; never overwrites edits made to them. */
export async function ensureSystemRoles(): Promise<void> {
  for (const role of SYSTEM_ROLES) {
    await db
      .insert(roles)
      .values({ id: role.id, key: role.key, name: role.name, description: role.description, permissions: role.permissions, system: true })
      .onConflictDoNothing();
  }
}

const ROLE_ORDER = sql`case ${roles.key} when 'owner' then 0 when 'admin' then 1 when 'billing' then 2 when 'member' then 3 else 4 end`;

export async function listRoles(): Promise<(Role & { userCount: number })[]> {
  return db
    .select({ ...getTableColumns(roles), userCount: count(users.id) })
    .from(roles)
    .leftJoin(users, eq(users.roleId, roles.id))
    .groupBy(roles.id)
    .orderBy(ROLE_ORDER, asc(roles.name));
}

export async function getRole(id: string): Promise<Role | null> {
  const [role] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  return role ?? null;
}

export async function getRoleByKey(key: string): Promise<Role | null> {
  const [role] = await db.select().from(roles).where(eq(roles.key, key)).limit(1);
  return role ?? null;
}

/** Throws unless `ctx` may give `role` to someone (the granting rule). */
export function assertCanGrant(ctx: SessionContext, role: Pick<Role, "key" | "permissions">): void {
  if (role.key === OWNER_ROLE_KEY && !isOwner(ctx)) throw forbidden("Only an owner can make someone an owner.");
  if (!canGrantRole(ctx, role)) throw forbidden("You can only give a role whose permissions you have yourself.");
}

function cleanPermissions(values: readonly string[]): Permission[] {
  for (const value of values) if (!isPermission(value)) throw badRequest(`"${value}" is not a permission.`);
  return PERMISSION_KEYS.filter((p) => values.includes(p));
}

function cleanName(value: string): string {
  const name = String(value ?? "").trim();
  if (!name) throw badRequest("Enter a name for the role.");
  if (name.length > 40) throw badRequest("Keep the role name under 40 characters.");
  return name;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

function requireRoleManager(ctx: SessionContext): void {
  if (!can(ctx, "roles.manage")) throw forbidden("You don't have permission to manage roles.");
}

export async function createRole(
  input: { name: string; key?: string; description?: string; permissions: string[] },
  ctx: SessionContext,
): Promise<Role> {
  requireRoleManager(ctx);
  const name = cleanName(input.name);
  const key = input.key?.trim() || slug(name);
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(key)) throw badRequest("Use 2 to 40 lower-case letters, digits and dashes for the key, starting with a letter.");
  const description = String(input.description ?? "").trim().slice(0, 200);
  const permissions = cleanPermissions(input.permissions);
  if (!isOwner(ctx) && permissions.some((p) => !ctx.role.permissions.includes(p))) {
    throw forbidden("You can only give a role permissions you have yourself.");
  }
  if (await getRoleByKey(key)) throw conflict("A role with this key already exists. Choose another name.");
  try {
    const [role] = await db.insert(roles).values({ id: newId("role"), key, name, description, permissions, system: false }).returning();
    await audit(actorOf(ctx), "role.create", { type: "role", id: role!.id }, { key, permissions });
    return role!;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A role with this key already exists. Choose another name.");
    throw err;
  }
}

export async function updateRole(
  id: string,
  patch: { name?: string; description?: string; permissions?: string[] },
  ctx: SessionContext,
): Promise<Role> {
  requireRoleManager(ctx);
  const role = await getRole(id);
  if (!role) throw notFound("That role no longer exists.");
  if (!isOwner(ctx) && ctx.role.id === role.id) throw forbidden("You can't edit the role you have yourself.");
  const set: Partial<Role> = {};
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (role.system && name !== role.name) throw badRequest("Built-in roles keep their name.");
    set.name = name;
  }
  if (patch.description !== undefined) set.description = String(patch.description).trim().slice(0, 200);
  let added: Permission[] = [];
  let removed: string[] = [];
  if (patch.permissions !== undefined) {
    if (role.key === OWNER_ROLE_KEY) throw badRequest("The owner role always has every permission.");
    const next = cleanPermissions(patch.permissions);
    added = next.filter((p) => !role.permissions.includes(p));
    removed = role.permissions.filter((p) => !(next as string[]).includes(p));
    if (!isOwner(ctx) && added.some((p) => !ctx.role.permissions.includes(p))) {
      throw forbidden("You can only add permissions you have yourself.");
    }
    if (added.some((p) => !PERSONAL_PERMISSIONS.includes(p))) {
      const { defaultRoleKey } = await getSettings("auth");
      if (defaultRoleKey === role.key) {
        throw badRequest("People who sign up on their own get this role, so it can only have the Personal permissions. Choose another default role first.");
      }
    }
    set.permissions = next;
  }
  const [updated] = await db
    .update(roles)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(roles.id, id))
    .returning();
  await audit(actorOf(ctx), "role.update", { type: "role", id }, { key: role.key, added, removed, renamed: set.name !== undefined && set.name !== role.name });
  return updated!;
}

/** Refuses while people or pending invitations have the role; old (used, revoked, expired) invitations go with it. */
export async function deleteRole(id: string, ctx: SessionContext): Promise<void> {
  requireRoleManager(ctx);
  const role = await getRole(id);
  if (!role) throw notFound("That role no longer exists.");
  if (role.system) throw badRequest("Built-in roles can't be deleted.");
  const { defaultRoleKey } = await getSettings("auth");
  if (defaultRoleKey === role.key) throw badRequest("This role is given to people who sign up on their own. Choose another default role first.");
  await db.transaction(async (tx) => {
    await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, id)).for("update");
    const [people] = await tx.select({ n: count() }).from(users).where(eq(users.roleId, id));
    if (people && people.n > 0) {
      throw badRequest(`${people.n === 1 ? "1 person has" : `${people.n} people have`} this role. Give them another role first.`);
    }
    const [pending] = await tx
      .select({ n: count() })
      .from(invites)
      .where(and(eq(invites.roleId, id), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`)));
    if (pending && pending.n > 0) throw badRequest("This role has pending invitations. Revoke them first.");
    await tx
      .delete(invites)
      .where(and(eq(invites.roleId, id), or(isNotNull(invites.acceptedAt), isNotNull(invites.revokedAt), lte(invites.expiresAt, sql`now()`))));
    await tx.delete(roles).where(eq(roles.id, id));
  });
  await audit(actorOf(ctx), "role.delete", { type: "role", id }, { key: role.key });
}

/**
 * Locks every owner row (`SELECT … FOR UPDATE`, in id order so two changes cannot deadlock). The first statement of
 * every transaction that changes someone's role or status or deletes an account, so owner counts cannot race.
 */
export async function lockOwners(tx: Tx): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.roleId, OWNER_ROLE_ID)).orderBy(asc(users.id)).for("update");
}

/** After `lockOwners`: refuses unless an active owner other than `userId` remains. */
export async function assertAnotherActiveOwner(tx: Tx, userId: string): Promise<void> {
  const [row] = await tx
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.roleId, OWNER_ROLE_ID), eq(users.status, "active"), ne(users.id, userId)));
  if (!row || row.n < 1) throw badRequest("There must always be at least one active owner. Make someone else an owner first.");
}
