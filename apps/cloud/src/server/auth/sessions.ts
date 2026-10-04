/**
 * Database sessions. The browser holds a random token; only its SHA-256 is stored. A person may be signed in on any
 * number of browsers at once. Sessions roll: once less than half of `auth.sessionDays` is left, a request extends it.
 */
import { and, count, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { actorOf, audit, type Actor } from "../audit";
import { isSecureSite } from "../config";
import { newId, randomToken, sha256 } from "../crypto";
import { db, roles, sessions, users, type Role, type Session, type User } from "../db";
import { forbidden } from "../errors";
import { isOwner } from "../rbac/permissions";
import { getSettings } from "../settings";

export interface SessionContext {
  session: Session;
  user: User;
  role: Role;
  /** Address of the current request, when the caller knows it (for audit entries). */
  ip?: string | null;
}

const DAY_MS = 86_400_000;
/** `last_seen_at` is written at most this often. */
const TOUCH_MS = 5 * 60_000;
/** `randomToken(32)`: 43 base64url characters. Anything else is not worth a database lookup. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function sessionCookieName(): string {
  return isSecureSite() ? "__Host-gmc_session" : "gmc_session";
}

export function sessionCookieOptions(expires: Date): { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; expires: Date } {
  return { httpOnly: true, secure: isSecureSite(), sameSite: "lax", path: "/", expires };
}

/** The session token from a raw Cookie header (the custom server has no Next cookie API). */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const name = sessionCookieName();
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function createSession(userId: string, meta: { ip: string | null; userAgent: string | null }): Promise<{ token: string; session: Session }> {
  const { sessionDays } = await getSettings("auth");
  const token = randomToken(32);
  const [session] = await db
    .insert(sessions)
    .values({
      id: newId("ses"),
      userId,
      tokenHash: sha256(token),
      label: describeUserAgent(meta.userAgent),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      expiresAt: new Date(Date.now() + sessionDays * DAY_MS),
    })
    .returning();
  return { token, session: session! };
}

/**
 * The signed-in person behind a token: not revoked, not expired, account active. `renewed` is true when this call
 * extended `expires_at`; the caller then re-sends the cookie with the new expiry.
 */
export async function validateSessionToken(token: string): Promise<(SessionContext & { renewed: boolean }) | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [row] = await db
    .select({ session: sessions, user: users, role: roles })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(sessions.tokenHash, sha256(token)))
    .limit(1);
  if (!row) return null;
  const now = Date.now();
  if (row.session.revokedAt || row.session.expiresAt.getTime() <= now || row.user.status !== "active") return null;
  const { sessionDays } = await getSettings("auth");
  const lifetime = sessionDays * DAY_MS;
  const renew = row.session.expiresAt.getTime() - now < lifetime / 2;
  const touch = now - row.session.lastSeenAt.getTime() > TOUCH_MS;
  if (!renew && !touch) return { ...row, renewed: false };
  const [updated] = await db
    .update(sessions)
    .set(renew ? { lastSeenAt: new Date(now), expiresAt: new Date(now + lifetime) } : { lastSeenAt: new Date(now) })
    .where(and(eq(sessions.id, row.session.id), isNull(sessions.revokedAt)))
    .returning();
  // Revoked between the read and the write.
  if (!updated) return null;
  return { session: updated, user: row.user, role: row.role, renewed: renew };
}

/** The person's signed-in browsers, most recently used first. */
export async function listSessions(userId: string): Promise<Session[]> {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)))
    .orderBy(desc(sessions.lastSeenAt));
}

/** Signs out one browser of `userId`. Audited when `actor` is given. */
export async function revokeSession(sessionId: string, userId: string, actor?: Actor): Promise<void> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  if (rows.length && actor) await audit(actor, "session.revoke", { type: "user", id: userId }, { sessionId });
}

/** Signs out every browser of `userId` except `exceptSessionId`. Audited when `actor` is given. */
export async function revokeAllSessions(userId: string, exceptSessionId?: string, actor?: Actor): Promise<number> {
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (exceptSessionId) conditions.push(ne(sessions.id, exceptSessionId));
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: sessions.id });
  if (actor) await audit(actor, "session.revoke_all", { type: "user", id: userId }, { count: rows.length });
  return rows.length;
}

/** Signed-in browsers across all accounts. */
export async function countActiveSessions(): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(sessions)
    .where(and(isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)));
  return row?.n ?? 0;
}

/** "Sign everyone out" (Settings → Security, owners only). Keeps the caller's own session. */
export async function revokeEverySession(exceptSessionId: string, ctx: SessionContext): Promise<number> {
  if (!isOwner(ctx)) throw forbidden("Only an owner can sign everyone out.");
  const rows = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(isNull(sessions.revokedAt), ne(sessions.id, exceptSessionId)))
    .returning({ id: sessions.id });
  await audit(actorOf(ctx), "session.revoke_all", { type: "sessions", id: "all" }, { scope: "everyone", count: rows.length });
  return rows.length;
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\/|\bChromium\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b|\biPod\b/, "iOS"],
  [/\biPad\b/, "iPadOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMacintosh\b|\bMac OS X\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

/**
 * "Chrome on macOS". Built only from the fixed names above, never from a piece of the header: the result appears in
 * sign-in e-mails, and the header is written by whoever sends the request.
 */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown browser";
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? "Unknown browser";
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return system ? `${browser} on ${system}` : browser;
}
