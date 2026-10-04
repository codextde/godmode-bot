import "./next-mocks";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { confirmLinkAction, joinInviteAction, logoutAction, requestLoginAction, verifyCodeAction } from "@/app/(auth)/actions";
import { loginCookieName, peekLoginToken } from "@/server/auth/login";
import { sessionCookieName, validateSessionToken } from "@/server/auth/sessions";
import { db, loginTokens, sessions, users } from "@/server/db";
import { OWNER_ROLE_ID } from "@/server/rbac/permissions";
import { updateSettings } from "@/server/settings";
import { bootstrapData, finishSetup } from "@/server/setup";
import { createInvite } from "@/server/users/invites";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { auditRows, makeUser } from "../platform/fixtures";
import { captureMail, redirectOf, request } from "./next-mocks";

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await bootstrapData();
  request.reset();
});
afterAll(closeDatabase);

const CODE = /enter this code[^:]*: (\d{4} \d{4})/;
const LINK = /\/auth\/verify\?token=([A-Za-z0-9_-]{43})/;

describe("requestLoginAction", () => {
  test("answers the same for an account, a stranger and a refused domain", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@solakon.de" });
    await updateSettings("auth", { inviteOnly: true, allowedDomains: ["solakon.de"] }, owner);
    const outcomes = [];
    for (const email of ["owner@solakon.de", "nobody@solakon.de", "x@elsewhere.org"]) {
      request.cookies.clear();
      const result = await requestLoginAction({ email, next: "/billing" });
      outcomes.push({ result, cookie: request.cookies.has(loginCookieName()) });
    }
    expect(outcomes.every((o) => o.result.ok && o.cookie)).toBe(true);
    // Every address gets a row, so wrong codes lock the same way; refused ones get no code.
    const rows = await db.select().from(loginTokens);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.email === "owner@solakon.de")?.codeHash).not.toBeNull();
    expect(rows.find((r) => r.email === "x@elsewhere.org")?.codeHash).toBeNull();
    expect(rows.every((r) => r.next === "/billing")).toBe(true);
  });

  test("refuses only what cannot be an address", async () => {
    const result = await requestLoginAction({ email: "not an address" });
    expect(result).toMatchObject({ ok: false, error: "Enter a valid e-mail address." });
    expect(await requestLoginAction({ email: "" })).toMatchObject({ ok: false, error: "Enter your e-mail address." });
    expect(request.cookies.has(loginCookieName())).toBe(false);
  });

  test("drops a foreign next", async () => {
    await makeUser({ role: "owner", email: "owner@example.com" });
    await requestLoginAction({ email: "owner@example.com", next: "https://evil.example/x" });
    const [row] = await db.select().from(loginTokens);
    expect(row?.next).toBeNull();
  });
});

describe("verifyCodeAction", () => {
  test("signs in the browser that asked with the right code, refuses wrong ones", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@example.com" });
    await finishSetup(owner);
    const mail = captureMail();
    try {
      await requestLoginAction({ email: "owner@example.com", next: "/devices?page=2" });
      const digits = (await mail.wait(CODE)).replace(/\D/g, "");
      expect(digits).toMatch(/^\d{8}$/);
      expect(await verifyCodeAction("00000000")).toMatchObject({ ok: false, error: "That code is not right. Check the e-mail and try again." });
      expect(request.cookies.has(sessionCookieName())).toBe(false);
      const target = await redirectOf(() => verifyCodeAction(`${digits.slice(0, 4)} ${digits.slice(4)}`));
      expect(target).toBe("/devices?page=2");
      const token = request.cookies.get(sessionCookieName());
      expect(token).toBeTruthy();
      expect((await validateSessionToken(token!))?.user.email).toBe("owner@example.com");
      expect(request.cookies.has(loginCookieName())).toBe(false);
    } finally {
      mail.stop();
    }
  });

  test("without the login cookie the code is useless", async () => {
    expect(await verifyCodeAction("12345678")).toMatchObject({ ok: false, error: "This sign-in has expired. Request a new e-mail." });
  });

  test("locks after five wrong codes", async () => {
    await makeUser({ role: "owner", email: "owner@example.com" });
    await requestLoginAction({ email: "owner@example.com" });
    for (let i = 0; i < 5; i++) expect((await verifyCodeAction("00000000")).ok).toBe(false);
    const locked = await verifyCodeAction("00000000");
    expect(locked).toMatchObject({ ok: false });
    expect((locked as { error: string }).error).toContain("can no longer be used");
  });

  test("replaces another account's session in this browser", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@example.com" });
    await finishSetup(owner);
    const other = await makeUser({ email: "other@example.com" });
    const { token } = await import("@/server/auth/sessions").then((m) => m.createSession(other.user.id, { ip: "1.2.3.4", userAgent: null }));
    request.cookies.set(sessionCookieName(), token);
    const mail = captureMail();
    try {
      await requestLoginAction({ email: "owner@example.com" });
      const digits = (await mail.wait(CODE)).replace(/\D/g, "");
      await redirectOf(() => verifyCodeAction(digits));
    } finally {
      mail.stop();
    }
    expect(await validateSessionToken(token)).toBeNull();
    expect((await validateSessionToken(request.cookies.get(sessionCookieName())!))?.user.email).toBe("owner@example.com");
    expect(await auditRows("logout")).toHaveLength(1);
  });
});

describe("confirmLinkAction", () => {
  test("peeking never uses the link; the action uses it once", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@example.com" });
    await finishSetup(owner);
    const mail = captureMail();
    let token: string;
    try {
      await requestLoginAction({ email: "owner@example.com", next: "/setup" });
      token = await mail.wait(LINK);
    } finally {
      mail.stop();
    }
    expect(await peekLoginToken(token)).toEqual({ email: "owner@example.com" });
    expect(await peekLoginToken(token)).toEqual({ email: "owner@example.com" });
    request.cookies.clear();
    expect(await redirectOf(() => confirmLinkAction(token))).toBe("/setup");
    expect((await validateSessionToken(request.cookies.get(sessionCookieName())!))?.user.email).toBe("owner@example.com");
    expect(await peekLoginToken(token)).toBeNull();
    expect(await confirmLinkAction(token)).toMatchObject({ ok: false, error: "This link has expired or was already used." });
    expect(await confirmLinkAction("garbage")).toMatchObject({ ok: false });
  });
});

describe("joinInviteAction", () => {
  test("creates the account, signs it in and opens the start page", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@example.com" });
    await finishSetup(owner);
    const { url } = await createInvite({ email: "new@example.com", roleId: "role_member" }, owner);
    const token = url.split("/invite/")[1]!;
    expect(await joinInviteAction({ token, name: "" })).toMatchObject({ ok: false, fields: { name: "Enter your name." } });
    expect(await redirectOf(() => joinInviteAction({ token, name: "  New Person " }))).toBe("/");
    const ctx = await validateSessionToken(request.cookies.get(sessionCookieName())!);
    expect(ctx?.user).toMatchObject({ email: "new@example.com", name: "New Person", roleId: "role_member" });
    expect(await joinInviteAction({ token, name: "Again" })).toMatchObject({ ok: false });
    expect(await auditRows("invite.accept")).toHaveLength(1);
  });

  test("waits while the cloud is still being set up", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@example.com" });
    const { url } = await createInvite({ email: "new@example.com", roleId: "role_member" }, owner);
    const result = await joinInviteAction({ token: url.split("/invite/")[1]!, name: "New" });
    expect(result).toMatchObject({ ok: false, error: "This cloud is still being set up. Try again a little later." });
    expect(await db.select().from(users).where(eq(users.email, "new@example.com"))).toHaveLength(0);
  });
});

describe("logoutAction", () => {
  test("revokes this session, clears the cookie and goes to /login", async () => {
    const owner = await makeUser({ role: "owner" });
    const { token } = await import("@/server/auth/sessions").then((m) => m.createSession(owner.user.id, { ip: "1.2.3.4", userAgent: null }));
    request.cookies.set(sessionCookieName(), token);
    expect(await redirectOf(() => logoutAction())).toBe("/login");
    expect(request.cookies.has(sessionCookieName())).toBe(false);
    expect(await validateSessionToken(token)).toBeNull();
    expect((await db.select().from(sessions)).filter((s) => s.revokedAt !== null)).toHaveLength(1);
    expect(await auditRows("logout")).toHaveLength(1);
    // Signed out already: still lands on /login.
    expect(await redirectOf(() => logoutAction())).toBe("/login");
    expect(owner.user.roleId).toBe(OWNER_ROLE_ID);
  });
});
