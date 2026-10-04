/** Who may sign in, how e-mail addresses are compared, and where a sign-in may send the browser afterwards. */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { config } from "../config";
import { db, invites, roles, users, type Invite, type Role, type User } from "../db";
import { badRequest } from "../errors";
import { OWNER_ROLE_KEY } from "../rbac/permissions";
import { getSettings } from "../settings";

const LOCAL_PART = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Trimmed and lower-cased. Exactly one "@", ASCII only, a domain with a dot: anything else is refused, so the part
 * after "@" means the same here, in the domain check and at the mail server.
 */
export function normalizeEmail(email: string): string {
  const value = String(email ?? "").trim().toLowerCase();
  const at = value.indexOf("@");
  if (value.length > 254 || at <= 0 || at !== value.lastIndexOf("@")) throw badRequest("Enter a valid e-mail address.", "invalid_email");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!LOCAL_PART.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !DOMAIN.test(domain)) {
    throw badRequest("Enter a valid e-mail address.", "invalid_email");
  }
  return value;
}

export function isValidEmail(email: string): boolean {
  try {
    normalizeEmail(email);
    return true;
  } catch {
    return false;
  }
}

/** The part after "@" of a normalised address. */
export function emailDomain(email: string): string {
  return normalizeEmail(email).split("@")[1]!;
}

/** Exact comparison with each listed domain; subdomains must be listed themselves. An empty list allows any. */
export function domainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  if (!allowedDomains.length) return true;
  return allowedDomains.includes(emailDomain(email));
}

/**
 * The only reader of a `next` value. Returns a path on this site (path + query + hash) or null. A backslash or a
 * control character is refused outright: browsers read "\" as "/" and drop tabs and newlines, so "/\evil.com" would
 * otherwise leave the site.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value) return null;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return null;
  }
  const origin = config().publicUrl;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return url.pathname + url.search + url.hash;
}

export type LoginDecision =
  | { allowed: true; user: (User & { role: Role }) | null; invite: Invite | null }
  | { allowed: false; reason: "domain" | "not_invited" | "suspended" };

/** The pending invitation of an address, if any (not accepted, not revoked, not expired). */
export async function pendingInvite(email: string): Promise<Invite | null> {
  const [invite] = await db
    .select()
    .from(invites)
    .where(and(eq(invites.email, email), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`)))
    .orderBy(sql`${invites.createdAt} desc`)
    .limit(1);
  return invite ?? null;
}

/**
 * Who may get a sign-in e-mail. Existing accounts: active, and a listed domain unless they are an owner (owners are
 * never locked out by the domain list). New people: a listed domain, and an invitation unless sign-up is open.
 */
export async function loginPolicy(email: string): Promise<LoginDecision> {
  const address = normalizeEmail(email);
  const auth = await getSettings("auth");
  const [row] = await db
    .select({ user: users, role: roles })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.email, address))
    .limit(1);
  if (row) {
    if (row.user.status !== "active") return { allowed: false, reason: "suspended" };
    if (row.role.key !== OWNER_ROLE_KEY && !domainAllowed(address, auth.allowedDomains)) return { allowed: false, reason: "domain" };
    return { allowed: true, user: { ...row.user, role: row.role }, invite: null };
  }
  if (!domainAllowed(address, auth.allowedDomains)) return { allowed: false, reason: "domain" };
  const invite = await pendingInvite(address);
  if (invite) return { allowed: true, user: null, invite };
  if (auth.inviteOnly) return { allowed: false, reason: "not_invited" };
  return { allowed: true, user: null, invite: null };
}
