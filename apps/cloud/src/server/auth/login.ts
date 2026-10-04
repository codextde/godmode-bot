/**
 * Magic-link sign-in. One e-mail carries a single-use link and, for the browser that asked, an 8-digit code.
 *
 * Every address gets the same answer: refused addresses also get a real row (with a random token nobody receives and
 * no code), so wrong codes lock it exactly like a real one, and the e-mail is sent without the request waiting for it.
 */
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { audit, type Actor } from "../audit";
import { config, isSecureSite } from "../config";
import { keyedHash, newId, newLoginCode, randomToken, safeEqual, sha256 } from "../crypto";
import { db, invites, loginTokens, users, type LoginToken, type User } from "../db";
import { AppError, tooMany } from "../errors";
import { mailFooter, sendMail } from "../mail";
import { loginEmail } from "../mail/templates";
import { rateLimit } from "../ratelimit";
import { getRoleByKey, OWNER_ROLE_KEY } from "../rbac";
import { getSettings } from "../settings";
import { claimInvite, createAccountFromInvite } from "../users/invites";
import { loginPolicy, normalizeEmail, safeNext } from "./policy";
import { describeUserAgent } from "./sessions";

export interface LoginMeta {
  ip: string;
  userAgent: string | null;
}

const WINDOW_MS = 15 * 60_000;
/** Wrong codes per sign-in e-mail. */
const MAX_CODE_ATTEMPTS = 5;
/** Wrong codes per address within 24 hours; after that e-mails carry no code (the link keeps working). */
const MAX_ADDRESS_ATTEMPTS = 10;
/** Link and code checks per IP and 15 minutes. */
const CHECKS_PER_IP = 30;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Holds the login id so that only the browser that asked can use the code. */
export function loginCookieName(): string {
  return isSecureSite() ? "__Host-gmc_login" : "gmc_login";
}

export function loginCookieOptions(): { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; maxAge: number } {
  return { httpOnly: true, secure: isSecureSite(), sameSite: "lax", path: "/", maxAge: 15 * 60 };
}

function codeHash(loginId: string, code: string): string {
  return keyedHash("login-code", `${loginId}:${code}`);
}

/** Wrong codes of an address in the last 24 hours. */
async function addressAttempts(email: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${loginTokens.attempts}), 0)`.mapWith(Number) })
    .from(loginTokens)
    .where(and(eq(loginTokens.email, email), gt(loginTokens.createdAt, sql`now() - interval '24 hours'`)));
  return row?.n ?? 0;
}

async function deliverLoginEmail(p: { email: string; token: string; code: string | null; minutes: number; meta: LoginMeta; owner: boolean }): Promise<void> {
  const url = `${config().publicUrl}/auth/verify?token=${p.token}`;
  const [{ appName }, footer] = await Promise.all([getSettings("general"), mailFooter()]);
  const content = loginEmail({ appName, url, code: p.code, minutes: p.minutes, ip: p.meta.ip, device: describeUserAgent(p.meta.userAgent), footer });
  const result = await sendMail({ to: p.email, ...content, kind: "login" });
  // An owner must never be locked out by a broken mail server: the server log is their way back in.
  if (!result.ok && p.owner) console.log(`[mail] The sign-in e-mail to ${p.email} (owner) could not be sent. Sign-in link: ${url}`);
}

/**
 * Starts a sign-in. Resolves the same way for every address (no account enumeration) and sends an e-mail only when
 * the address may sign in. Throws only for an invalid address or when a rate limit is reached.
 */
export async function requestLogin(email: string, meta: LoginMeta & { next?: string | null }): Promise<{ loginId: string }> {
  const address = normalizeEmail(email);
  const security = await getSettings("security");
  // Limits apply to every address alike, so hitting one reveals nothing about accounts. The e-mail address is only
  // counted for requests its sender's IP may make: a flood from one IP must not lock someone out of their account.
  if (!rateLimit(`login:ip:${meta.ip}`, security.loginPerIp, WINDOW_MS).ok || !rateLimit(`login:email:${address}`, security.loginPerEmail, WINDOW_MS).ok) {
    throw tooMany("Too many sign-in requests. Wait a few minutes and try again.");
  }
  const [auth, decision, attempts] = await Promise.all([getSettings("auth"), loginPolicy(address), addressAttempts(address)]);
  const id = newId("lgn");
  const token = randomToken(32);
  const code = decision.allowed && auth.codeLogin && attempts < MAX_ADDRESS_ATTEMPTS ? newLoginCode() : null;
  await db.insert(loginTokens).values({
    id,
    email: address,
    tokenHash: sha256(token),
    codeHash: code ? codeHash(id, code) : null,
    next: safeNext(meta.next),
    expiresAt: new Date(Date.now() + auth.magicLinkMinutes * 60_000),
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
  });
  if (decision.allowed) {
    const owner = decision.user?.role.key === OWNER_ROLE_KEY;
    void deliverLoginEmail({ email: address, token, code, minutes: auth.magicLinkMinutes, meta, owner }).catch((err) =>
      console.error("[login] could not send the sign-in e-mail:", err instanceof Error ? err.message : err),
    );
  } else {
    void audit({ id: null, label: address, ip: meta.ip }, "login.denied", null, { reason: decision.reason });
  }
  return { loginId: id };
}

/** The address of a usable sign-in link, for "Sign in as …" on the confirm page. Does not use the link. */
export async function peekLoginToken(token: string): Promise<{ email: string } | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [row] = await db
    .select({ email: loginTokens.email })
    .from(loginTokens)
    .where(and(eq(loginTokens.tokenHash, sha256(token)), isNull(loginTokens.usedAt), gt(loginTokens.expiresAt, sql`now()`)))
    .limit(1);
  return row ?? null;
}

function checkLimit(kind: string, ip: string): void {
  if (!rateLimit(`${kind}:ip:${ip}`, CHECKS_PER_IP, WINDOW_MS).ok) throw tooMany("Too many attempts. Wait a few minutes and try again.");
}

/**
 * Runs once a link or code was accepted: checks the policy again (the person may have been suspended or the invitation
 * revoked since the e-mail went out) and creates the account of a new person.
 */
async function completeSignIn(row: LoginToken, method: "link" | "code", meta: LoginMeta): Promise<{ user: User; next: string | null } | null> {
  const anonymous: Actor = { id: null, label: row.email, ip: meta.ip };
  const decision = await loginPolicy(row.email);
  if (!decision.allowed) {
    await audit(anonymous, "login.denied", null, { reason: decision.reason });
    return null;
  }
  let user: User;
  if (decision.user) {
    const [updated] = await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, decision.user.id)).returning();
    if (!updated) return null;
    user = updated;
  } else if (decision.invite) {
    try {
      user = await db.transaction(async (tx) => {
        const invite = await claimInvite(tx, eq(invites.id, decision.invite!.id));
        if (!invite) throw new AppError("The invitation was used or revoked in the meantime.", "invite_invalid");
        return createAccountFromInvite(tx, invite, null);
      });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      await audit(anonymous, "login.denied", null, { reason: err.code });
      return null;
    }
    await audit({ id: user.id, label: user.email, ip: meta.ip }, "invite.accept", { type: "invite", id: decision.invite.id }, { roleId: user.roleId });
  } else {
    // Open sign-up. The default role is re-checked here: it must never open the admin area.
    const { defaultRoleKey } = await getSettings("auth");
    const role = await getRoleByKey(defaultRoleKey);
    if (!role || role.key === OWNER_ROLE_KEY || role.permissions.includes("admin.access")) {
      console.error(`[login] the default role "${defaultRoleKey}" may not be given on sign-up; refused ${row.email}.`);
      await audit(anonymous, "login.denied", null, { reason: "default_role" });
      return null;
    }
    const [created] = await db
      .insert(users)
      .values({ id: newId("usr"), email: row.email, roleId: role.id, lastLoginAt: new Date() })
      .onConflictDoNothing()
      .returning();
    if (created) {
      user = created;
    } else {
      // Two first sign-ins of the same address at once: the other one created the account.
      const [existing] = await db.select().from(users).where(eq(users.email, row.email)).limit(1);
      if (!existing) return null;
      user = existing;
    }
  }
  await audit({ id: user.id, label: user.email, ip: meta.ip }, "login.success", { type: "user", id: user.id }, { method });
  return { user, next: safeNext(row.next) };
}

/** The link from the e-mail (POST from the confirm page). Single use; null when used, expired or unknown. */
export async function consumeLoginToken(token: string, meta: LoginMeta): Promise<{ user: User; next: string | null } | null> {
  checkLimit("login-link", meta.ip);
  if (!TOKEN_SHAPE.test(token)) return null;
  const [row] = await db
    .update(loginTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(loginTokens.tokenHash, sha256(token)), isNull(loginTokens.usedAt), gt(loginTokens.expiresAt, sql`now()`)))
    .returning();
  if (!row) {
    await audit({ id: null, label: "unknown", ip: meta.ip }, "login.denied", null, { reason: "invalid_link" });
    return null;
  }
  return completeSignIn(row, "link", meta);
}

/**
 * The code typed in the browser that asked. "locked": this sign-in can no longer take codes (5 wrong ones, 10 for
 * the address in 24 hours, used or expired); "invalid": wrong code.
 */
export async function consumeLoginCode(loginId: string, code: string, meta: LoginMeta): Promise<{ user: User; next: string | null } | "invalid" | "locked"> {
  checkLimit("login-code", meta.ip);
  // Counting the attempt and checking the limits is one statement, so parallel guesses cannot get past the cap.
  const [attempt] = await db
    .update(loginTokens)
    .set({ attempts: sql`${loginTokens.attempts} + 1` })
    .where(
      and(
        eq(loginTokens.id, String(loginId)),
        isNull(loginTokens.usedAt),
        gt(loginTokens.expiresAt, sql`now()`),
        lt(loginTokens.attempts, MAX_CODE_ATTEMPTS),
        sql`(select coalesce(sum(o.attempts), 0) from login_tokens o where o.email = login_tokens.email and o.created_at > now() - interval '24 hours') < ${MAX_ADDRESS_ATTEMPTS}`,
      ),
    )
    .returning({ codeHash: loginTokens.codeHash, email: loginTokens.email, attempts: loginTokens.attempts });
  if (!attempt) return "locked";
  const digits = String(code ?? "").replace(/[\s-]/g, "");
  const matches = attempt.codeHash !== null && /^\d{8}$/.test(digits) && safeEqual(attempt.codeHash, codeHash(loginId, digits));
  const actor: Actor = { id: null, label: attempt.email, ip: meta.ip };
  if (!matches) {
    if (attempt.attempts >= MAX_CODE_ATTEMPTS) await audit(actor, "login.code_locked", { type: "login", id: loginId });
    else await audit(actor, "login.denied", { type: "login", id: loginId }, { reason: "wrong_code" });
    return "invalid";
  }
  // The right code does not count as a wrong one.
  const [row] = await db
    .update(loginTokens)
    .set({ usedAt: new Date(), attempts: sql`${loginTokens.attempts} - 1` })
    .where(and(eq(loginTokens.id, loginId), isNull(loginTokens.usedAt)))
    .returning();
  if (!row) return "invalid";
  return (await completeSignIn(row, "code", meta)) ?? "invalid";
}
