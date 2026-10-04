/**
 * The signed-in person for pages, layouts, server actions and route handlers (Next side: next/headers, React cache).
 * Pages and layouts use `requireUser` / `requirePermission` (redirect or the 403 page); server actions and route
 * handlers use `checkUser` / `checkPermission` (they throw AppErrors that `runAction` turns into messages).
 */
import { cookies, headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { cache } from "react";
import { actorOf, audit, type Actor } from "@/server/audit";
import { loginCookieName, loginCookieOptions } from "@/server/auth/login";
import { safeNext } from "@/server/auth/policy";
import {
  createSession,
  revokeSession,
  sessionCookieName,
  sessionCookieOptions,
  validateSessionToken,
  type SessionContext,
} from "@/server/auth/sessions";
import { forbidden as forbiddenError, unauthorized } from "@/server/errors";
import { clientIp, PEER_HEADER } from "@/server/ratelimit";
import { can, type PagePermission } from "@/server/rbac/permissions";

export type { SessionContext };

/** The request's client address (see `clientIp`) and user agent. */
export const requestMeta = cache(async (): Promise<{ ip: string; userAgent: string | null }> => {
  const h = await headers();
  return { ip: clientIp(h, h.get(PEER_HEADER)), userAgent: h.get("user-agent")?.slice(0, 512) ?? null };
});

/** The current session, or null. Validated once per request. */
export const getSession = cache(async (): Promise<SessionContext | null> => {
  const store = await cookies();
  const token = store.get(sessionCookieName())?.value;
  if (!token) return null;
  const result = await validateSessionToken(token);
  if (!result) return null;
  const { renewed, ...ctx } = result;
  if (renewed) {
    try {
      store.set(sessionCookieName(), token, sessionCookieOptions(ctx.session.expiresAt));
    } catch {
      // Server Components cannot set cookies; proxy.ts re-sends the renewed cookie on document requests.
    }
  }
  const { ip } = await requestMeta();
  return { ...ctx, ip };
});

/** The path to come back to after signing in: `next` if given, else the `x-pathname` header proxy.ts sets. */
async function loginUrl(next?: string): Promise<string> {
  const target = safeNext(next ?? (await headers()).get("x-pathname"));
  return target && !target.startsWith("/login") ? `/login?next=${encodeURIComponent(target)}` : "/login";
}

/** For pages and layouts: signed out ⇒ redirect to /login?next=…. */
export async function requireUser(next?: string): Promise<SessionContext> {
  const ctx = await getSession();
  if (!ctx) redirect(await loginUrl(next));
  return ctx;
}

/** For pages and layouts: signed out ⇒ /login; signed in without the permission ⇒ the 403 page. */
export async function requirePermission(permission: PagePermission, next?: string): Promise<SessionContext> {
  const ctx = await requireUser(next);
  if (!can(ctx, permission)) forbidden();
  return ctx;
}

/** For server actions and route handlers: throws a 401 AppError when signed out. */
export async function checkUser(): Promise<SessionContext> {
  const ctx = await getSession();
  if (!ctx) throw unauthorized("Your session has ended. Sign in again.");
  return ctx;
}

/** For server actions and route handlers: throws a 401 or 403 AppError. */
export async function checkPermission(permission: PagePermission): Promise<SessionContext> {
  const ctx = await checkUser();
  if (!can(ctx, permission)) {
    throw forbiddenError(permission === "owner" ? "Only an owner can do this." : "You don't have permission to do that.");
  }
  return ctx;
}

/** Who is acting, for audit entries: the signed-in person, or "anonymous", with the request's address. */
export async function actor(): Promise<Actor> {
  const [ctx, { ip }] = await Promise.all([getSession(), requestMeta()]);
  return ctx ? actorOf(ctx, ip) : { id: null, label: "anonymous", ip };
}

export async function setSessionCookie(token: string, expires: Date): Promise<void> {
  (await cookies()).set(sessionCookieName(), token, sessionCookieOptions(expires));
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(sessionCookieName(), "", sessionCookieOptions(new Date(0)));
}

/** Creates a session for `userId` and sets its cookie (after a link, a code, an invitation or the setup claim). */
export async function startSession(userId: string): Promise<void> {
  const { token, session } = await createSession(userId, await requestMeta());
  await setSessionCookie(token, session.expiresAt);
}

/** Signs out this browser: revokes the session, writes `logout`, clears the cookie. The caller redirects. */
export async function signOut(): Promise<void> {
  const ctx = await getSession();
  if (ctx) {
    await revokeSession(ctx.session.id, ctx.user.id);
    await audit(actorOf(ctx), "logout", { type: "user", id: ctx.user.id });
  }
  await clearSessionCookie();
}

/** Remembers which sign-in this browser asked for, so only it can use the code. */
export async function setLoginCookie(loginId: string): Promise<void> {
  (await cookies()).set(loginCookieName(), loginId, loginCookieOptions());
}

export async function readLoginCookie(): Promise<string | null> {
  return (await cookies()).get(loginCookieName())?.value || null;
}

export async function clearLoginCookie(): Promise<void> {
  (await cookies()).set(loginCookieName(), "", { ...loginCookieOptions(), maxAge: 0 });
}
