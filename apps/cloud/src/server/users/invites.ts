/**
 * Invitations. The link is `<publicUrl>/invite/<token>`; only the token's hash is stored, so the link can be shown
 * once (right after creating or resending) and is otherwise only in the e-mail.
 */
import { and, count, desc, eq, gt, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { actorOf, audit } from "../audit";
import { domainAllowed, normalizeEmail } from "../auth/policy";
import { createSession, type SessionContext } from "../auth/sessions";
import { config } from "../config";
import { newId, randomToken, sha256 } from "../crypto";
import { db, invites, roles, users, type Invite, type Role, type Tx, type User } from "../db";
import { AppError, badRequest, conflict, forbidden, notFound } from "../errors";
import { mailFooter, sendMail } from "../mail";
import { inviteEmail } from "../mail/templates";
import { assertCanGrant, can, canGrantRole, getRole, OWNER_ROLE_KEY } from "../rbac";
import { getSettings } from "../settings";

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export interface InviteResult {
  invite: Invite;
  /** The invitation link. Show it to copy: when `emailed` is false nobody else has it. */
  url: string;
  /** True only when an e-mail actually went out over SMTP. */
  emailed: boolean;
}

const DAY_MS = 86_400_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function inviteStatus(invite: Pick<Invite, "acceptedAt" | "revokedAt" | "expiresAt">, now = Date.now()): InviteStatus {
  if (invite.acceptedAt) return "accepted";
  if (invite.revokedAt) return "revoked";
  return invite.expiresAt.getTime() <= now ? "expired" : "pending";
}

function inviteUrl(token: string): string {
  return `${config().publicUrl}/invite/${token}`;
}

function invalidInvite(): AppError {
  return new AppError("This invitation is no longer valid. Ask the person who invited you for a new one.", "invite_invalid", 410);
}

function requireInviter(ctx: SessionContext): void {
  if (!can(ctx, "invites.manage")) throw forbidden("You don't have permission to invite people.");
}

async function domainError(email: string): Promise<AppError | null> {
  const { allowedDomains } = await getSettings("auth");
  if (domainAllowed(email, allowedDomains)) return null;
  return badRequest(`Only addresses at ${allowedDomains.join(", ")} can join this cloud.`, "domain");
}

async function mailInvite(invite: Invite, token: string, role: Role, ctx: SessionContext): Promise<{ url: string; emailed: boolean }> {
  const url = inviteUrl(token);
  const [{ appName }, { inviteDays }, footer] = await Promise.all([getSettings("general"), getSettings("auth"), mailFooter()]);
  const content = inviteEmail({ appName, url, inviter: ctx.user.name || ctx.user.email, role: role.name, days: inviteDays, footer });
  const result = await sendMail({ to: invite.email, ...content, kind: "invite" });
  if (result.ok) await db.update(invites).set({ lastSentAt: new Date() }).where(eq(invites.id, invite.id));
  return { url, emailed: result.ok && result.transport === "smtp" };
}

async function issueInvite(emailInput: string, role: Role, ctx: SessionContext): Promise<InviteResult> {
  const email = normalizeEmail(emailInput);
  const refused = await domainError(email);
  if (refused) throw refused;
  const { inviteDays } = await getSettings("auth");
  const token = randomToken(32);
  const invite = await db.transaction(async (tx) => {
    // One invitation per address at a time, also when two admins invite the same person at once.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('godmode-cloud:invite'), hashtext(${email}))`);
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) throw conflict(`${email} already has an account.`, "exists");
    const [pending] = await tx
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.email, email), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`)))
      .limit(1);
    if (pending) throw conflict(`${email} already has a pending invitation. Resend it instead.`, "duplicate");
    const [row] = await tx
      .insert(invites)
      .values({ id: newId("inv"), email, roleId: role.id, invitedBy: ctx.user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + inviteDays * DAY_MS) })
      .returning();
    return row!;
  });
  const sent = await mailInvite(invite, token, role, ctx);
  await audit(actorOf(ctx), "invite.create", { type: "invite", id: invite.id }, { email, role: role.key, emailed: sent.emailed });
  return { invite, ...sent };
}

async function grantableRole(roleId: string, ctx: SessionContext): Promise<Role> {
  const role = await getRole(roleId);
  if (!role) throw notFound("That role no longer exists.");
  assertCanGrant(ctx, role);
  return role;
}

/** Checks the address's domain, that it has no account and no pending invitation, then sends the invitation. */
export async function createInvite(input: { email: string; roleId: string }, ctx: SessionContext): Promise<InviteResult> {
  requireInviter(ctx);
  const role = await grantableRole(input.roleId, ctx);
  return issueInvite(input.email, role, ctx);
}

/** Invites many addresses (separated by commas, spaces or new lines inside the entries too). */
export async function createInvites(
  emails: string[],
  roleId: string,
  ctx: SessionContext,
): Promise<{ created: InviteResult[]; skipped: { email: string; reason: string }[] }> {
  requireInviter(ctx);
  const role = await grantableRole(roleId, ctx);
  const entries = emails.flatMap((e) => String(e).split(/[\s,;]+/)).filter(Boolean);
  if (entries.length > 100) throw badRequest("Invite at most 100 people at once.");
  const created: InviteResult[] = [];
  const skipped: { email: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    let email: string;
    try {
      email = normalizeEmail(entry);
    } catch {
      skipped.push({ email: entry, reason: "This is not a valid e-mail address." });
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    try {
      created.push(await issueInvite(email, role, ctx));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      skipped.push({ email, reason: err.message });
    }
  }
  return { created, skipped };
}

const inviter = alias(users, "inviter");

export async function listInvites(q: {
  status?: InviteStatus;
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ rows: (Invite & { role: Role; inviter: string | null; status: InviteStatus })[]; total: number }> {
  const pageSize = Math.min(Math.max(Math.floor(q.pageSize ?? 25), 1), 100);
  const page = Math.max(Math.floor(q.page ?? 1), 1);
  const filters: SQL[] = [];
  if (q.status === "pending") filters.push(isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`));
  if (q.status === "accepted") filters.push(isNotNull(invites.acceptedAt));
  if (q.status === "revoked") filters.push(isNull(invites.acceptedAt), isNotNull(invites.revokedAt));
  if (q.status === "expired") filters.push(isNull(invites.acceptedAt), isNull(invites.revokedAt), lte(invites.expiresAt, sql`now()`));
  const search = q.search?.trim().toLowerCase();
  if (search) filters.push(sql`${invites.email} like ${`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`);
  const where = filters.length ? and(...filters) : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select({ invite: invites, role: roles, inviterName: inviter.name, inviterEmail: inviter.email })
      .from(invites)
      .innerJoin(roles, eq(roles.id, invites.roleId))
      .leftJoin(inviter, eq(inviter.id, invites.invitedBy))
      .where(where)
      .orderBy(desc(invites.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(invites).where(where),
  ]);
  const now = Date.now();
  return {
    rows: rows.map((r) => ({ ...r.invite, role: r.role, inviter: r.inviterName || r.inviterEmail || null, status: inviteStatus(r.invite, now) })),
    total: total?.n ?? 0,
  };
}

/** A new link (the old one stops working) and a fresh expiry. */
export async function resendInvite(id: string, ctx: SessionContext): Promise<{ url: string; emailed: boolean }> {
  requireInviter(ctx);
  const [current] = await db.select().from(invites).where(eq(invites.id, id)).limit(1);
  if (!current) throw notFound("That invitation no longer exists.");
  if (current.acceptedAt) throw badRequest("This invitation was already accepted.");
  if (current.revokedAt) throw badRequest("This invitation was revoked. Create a new one.");
  const role = await grantableRole(current.roleId, ctx);
  const refused = await domainError(current.email);
  if (refused) throw refused;
  const [account] = await db.select({ id: users.id }).from(users).where(eq(users.email, current.email)).limit(1);
  if (account) throw conflict(`${current.email} already has an account.`, "exists");
  const { inviteDays } = await getSettings("auth");
  const token = randomToken(32);
  const [invite] = await db
    .update(invites)
    .set({ tokenHash: sha256(token), expiresAt: new Date(Date.now() + inviteDays * DAY_MS) })
    .where(and(eq(invites.id, id), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
    .returning();
  if (!invite) throw badRequest("This invitation is no longer pending.");
  const sent = await mailInvite(invite, token, role, ctx);
  await audit(actorOf(ctx), "invite.resend", { type: "invite", id }, { email: invite.email, emailed: sent.emailed });
  return sent;
}

export async function revokeInvite(id: string, ctx: SessionContext): Promise<void> {
  requireInviter(ctx);
  const [invite] = await db
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, id), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
    .returning();
  if (!invite) {
    const [exists] = await db.select({ id: invites.id }).from(invites).where(eq(invites.id, id)).limit(1);
    throw exists ? badRequest("This invitation is no longer pending.") : notFound("That invitation no longer exists.");
  }
  await audit(actorOf(ctx), "invite.revoke", { type: "invite", id }, { email: invite.email });
}

/** A pending, unexpired invitation by its link token, with its role and who sent it. */
export async function getInviteByToken(token: string): Promise<(Invite & { role: Role; inviter: string | null }) | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [row] = await db
    .select({ invite: invites, role: roles, inviterName: inviter.name, inviterEmail: inviter.email })
    .from(invites)
    .innerJoin(roles, eq(roles.id, invites.roleId))
    .leftJoin(inviter, eq(inviter.id, invites.invitedBy))
    .where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`)))
    .limit(1);
  if (!row) return null;
  return { ...row.invite, role: row.role, inviter: row.inviterName || row.inviterEmail || null };
}

/**
 * The granting rule, checked again when the account is created: the inviter must still be able to give the role.
 * When the inviter is gone or suspended, the invitation still stands for roles without admin access.
 */
async function inviterMayStillGrant(tx: Tx, invite: Invite, role: Role): Promise<boolean> {
  if (invite.invitedBy) {
    const [row] = await tx
      .select({ status: users.status, role: roles })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(eq(users.id, invite.invitedBy))
      .limit(1);
    if (row && row.status === "active") return canGrantRole({ role: row.role }, role);
  }
  return role.key !== OWNER_ROLE_KEY && !role.permissions.includes("admin.access");
}

/**
 * Creates the account of an invitation that the caller has just marked accepted inside `tx`. Used by `acceptInvite`
 * and by the first sign-in of an invited address. Throws an AppError (and so rolls back) when it may not happen.
 */
export async function createAccountFromInvite(tx: Tx, invite: Invite, name: string | null): Promise<User> {
  const { allowedDomains } = await getSettings("auth");
  if (!domainAllowed(invite.email, allowedDomains)) throw badRequest("This address is no longer allowed to join this cloud.", "domain");
  const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, invite.email)).limit(1);
  if (existing) throw conflict("This address already has an account. Sign in instead.", "exists");
  const [role] = await tx.select().from(roles).where(eq(roles.id, invite.roleId)).limit(1);
  if (!role || !(await inviterMayStillGrant(tx, invite, role))) throw invalidInvite();
  const [user] = await tx
    .insert(users)
    .values({ id: newId("usr"), email: invite.email, name, roleId: role.id, invitedBy: invite.invitedBy, lastLoginAt: new Date() })
    .returning();
  return user!;
}

/** Marks a pending invitation accepted (one statement, so it can be used once) and returns it, or null. */
export async function claimInvite(tx: Tx, where: SQL): Promise<Invite | null> {
  const [invite] = await tx
    .update(invites)
    .set({ acceptedAt: new Date() })
    .where(and(where, isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`)))
    .returning();
  return invite ?? null;
}

/** "Join" on the invitation page: creates the account and signs it in. */
export async function acceptInvite(
  token: string,
  input: { name: string },
  meta: { ip: string | null; userAgent: string | null },
): Promise<{ user: User; sessionToken: string; expires: Date }> {
  const name = String(input.name ?? "").trim();
  if (name.length > 80) throw badRequest("Keep your name under 80 characters.");
  if (!TOKEN_SHAPE.test(token)) throw invalidInvite();
  const { user, invite } = await db.transaction(async (tx) => {
    const claimed = await claimInvite(tx, eq(invites.tokenHash, sha256(token)));
    if (!claimed) throw invalidInvite();
    return { user: await createAccountFromInvite(tx, claimed, name || null), invite: claimed };
  });
  const { token: sessionToken, session } = await createSession(user.id, meta);
  await audit({ id: user.id, label: user.email, ip: meta.ip }, "invite.accept", { type: "invite", id: invite.id }, { roleId: user.roleId });
  return { user, sessionToken, expires: session.expiresAt };
}
