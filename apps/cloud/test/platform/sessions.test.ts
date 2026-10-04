import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  countActiveSessions,
  createSession,
  describeUserAgent,
  listSessions,
  readSessionCookie,
  revokeAllSessions,
  revokeEverySession,
  revokeSession,
  sessionCookieName,
  sessionCookieOptions,
  validateSessionToken,
} from "@/server/auth/sessions";
import { resetConfig } from "@/server/config";
import { db, sessions, users } from "@/server/db";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { auditRows, makeUser, META, seed } from "./fixtures";

const DAY = 86_400_000;

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
});
afterAll(closeDatabase);

describe("sessions", () => {
  test("a new session validates and is labelled from the user agent", async () => {
    const { user } = await makeUser();
    const { token, session } = await createSession(user.id, META);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.label).toBe("Chrome on macOS");
    expect(session.tokenHash).not.toBe(token);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 364 * DAY);
    const ctx = await validateSessionToken(token);
    expect(ctx?.user.id).toBe(user.id);
    expect(ctx?.role.key).toBe("member");
    expect(ctx?.renewed).toBe(false);
  });

  test("one person can be signed in on many browsers", async () => {
    const { user } = await makeUser();
    const tokens = await Promise.all([1, 2, 3].map(() => createSession(user.id, META)));
    for (const { token } of tokens) expect((await validateSessionToken(token))?.user.id).toBe(user.id);
    expect(await listSessions(user.id)).toHaveLength(4);
    expect(await countActiveSessions()).toBe(4);
  });

  test("rolls: with less than half the lifetime left, a request extends it and says so", async () => {
    const { user } = await makeUser();
    const { token, session } = await createSession(user.id, META);
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 10 * DAY) })
      .where(eq(sessions.id, session.id));
    const renewed = await validateSessionToken(token);
    expect(renewed?.renewed).toBe(true);
    expect(renewed!.session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 364 * DAY);
    const again = await validateSessionToken(token);
    expect(again?.renewed).toBe(false);
  });

  test("last seen is written at most every five minutes", async () => {
    const { user } = await makeUser();
    const { token, session } = await createSession(user.id, META);
    const old = new Date(Date.now() - 10 * 60_000);
    await db.update(sessions).set({ lastSeenAt: old }).where(eq(sessions.id, session.id));
    const ctx = await validateSessionToken(token);
    expect(ctx!.session.lastSeenAt.getTime()).toBeGreaterThan(old.getTime() + 5 * 60_000);
    expect(ctx!.renewed).toBe(false);
  });

  test("revoked, expired, suspended and unknown are refused", async () => {
    const { user } = await makeUser();
    const a = await createSession(user.id, META);
    const b = await createSession(user.id, META);
    await revokeSession(a.session.id, user.id);
    expect(await validateSessionToken(a.token)).toBeNull();
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.id, b.session.id));
    expect(await validateSessionToken(b.token)).toBeNull();
    const c = await createSession(user.id, META);
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
    expect(await validateSessionToken(c.token)).toBeNull();
    expect(await validateSessionToken("x".repeat(43))).toBeNull();
    expect(await validateSessionToken("short")).toBeNull();
  });

  test("revoking needs the session's own user", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    await revokeSession(owner.session.id, other.user.id, { id: other.user.id, label: other.user.email });
    expect(await listSessions(owner.user.id)).toHaveLength(1);
    expect(await auditRows("session.revoke")).toHaveLength(0);
  });

  test("sign out everywhere else keeps the current browser", async () => {
    const ctx = await makeUser();
    await createSession(ctx.user.id, META);
    await createSession(ctx.user.id, META);
    const count = await revokeAllSessions(ctx.user.id, ctx.session.id, { id: ctx.user.id, label: ctx.user.email });
    expect(count).toBe(2);
    expect((await listSessions(ctx.user.id)).map((s) => s.id)).toEqual([ctx.session.id]);
    expect(await auditRows("session.revoke_all")).toHaveLength(1);
  });

  test("sign everyone out is for owners and keeps their session", async () => {
    const owner = await makeUser({ role: "owner" });
    const admin = await makeUser({ role: "admin" });
    await makeUser();
    await expect(revokeEverySession(admin.session.id, admin)).rejects.toMatchObject({ status: 403 });
    expect(await revokeEverySession(owner.session.id, owner)).toBe(2);
    expect(await countActiveSessions()).toBe(1);
    expect((await listSessions(owner.user.id)).map((s) => s.id)).toEqual([owner.session.id]);
  });
});

describe("cookies", () => {
  afterEach(() => {
    process.env.DOMAIN = "http://localhost:3210";
    resetConfig();
  });

  test("names and options follow http or https", () => {
    expect(sessionCookieName()).toBe("gmc_session");
    expect(sessionCookieOptions(new Date(0))).toMatchObject({ httpOnly: true, secure: false, sameSite: "lax", path: "/" });
    process.env.DOMAIN = "cloud.example.com";
    resetConfig();
    expect(sessionCookieName()).toBe("__Host-gmc_session");
    expect(sessionCookieOptions(new Date(0)).secure).toBe(true);
  });

  test("reads the token from a Cookie header", () => {
    expect(readSessionCookie("a=1; gmc_session=abc_DEF-123; b=2")).toBe("abc_DEF-123");
    expect(readSessionCookie("gmc_sessionx=1; other=2")).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie("gmc_session=%E0%A4%A")).toBeNull();
  });
});

describe("describeUserAgent", () => {
  test.each([
    [META.userAgent, "Chrome on macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari on iOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0", "Edge on Windows"],
    ["Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36", "Chrome on Android"],
    ["curl/8.5.0", "Unknown browser"],
    [null, "Unknown browser"],
  ])("%s → %s", (ua, expected) => {
    expect(describeUserAgent(ua)).toBe(expected);
  });

  test("never repeats any part of the header", () => {
    const evil = "<a href=https://evil.example>Click</a> Chrome/1 Windows";
    const out = describeUserAgent(evil);
    expect(out).toBe("Chrome on Windows");
    expect(out).not.toMatch(/[<>]|evil|Click/);
  });
});
