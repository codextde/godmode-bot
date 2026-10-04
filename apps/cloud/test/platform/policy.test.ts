import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { SYSTEM } from "@/server/audit";
import { domainAllowed, emailDomain, loginPolicy, normalizeEmail, safeNext } from "@/server/auth/policy";
import { newId, sha256 } from "@/server/crypto";
import { db, invites } from "@/server/db";
import { AppError } from "@/server/errors";
import { writeSettings } from "@/server/settings";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { makeUser, seed } from "./fixtures";

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
});
afterAll(closeDatabase);

describe("normalizeEmail", () => {
  test("trims and lower-cases", () => {
    expect(normalizeEmail("  Daniel@Solakon.DE ")).toBe("daniel@solakon.de");
  });

  test.each([
    "a@evil.com@solakon.de",
    "no-at.example.com",
    "@solakon.de",
    "x@",
    "x@localhost",
    "dänisch@solakon.de",
    "x@s\u043elakon.de",
    "x y@solakon.de",
    "x@solakon.de​",
    ".x@solakon.de",
    "x..y@solakon.de",
    "x@solakon.de.",
  ])("refuses %j", (value) => {
    expect(() => normalizeEmail(value)).toThrow(AppError);
  });
});

describe("domain check", () => {
  test("compares the part after @ exactly", () => {
    expect(emailDomain("A@Solakon.DE")).toBe("solakon.de");
    expect(domainAllowed("a@solakon.de", ["solakon.de"])).toBe(true);
    expect(domainAllowed("a@sub.solakon.de", ["solakon.de"])).toBe(false);
    expect(domainAllowed("a@evilsolakon.de", ["solakon.de"])).toBe(false);
    expect(domainAllowed("a@solakon.de.evil.com", ["solakon.de"])).toBe(false);
    expect(domainAllowed("a@sub.solakon.de", ["solakon.de", "sub.solakon.de"])).toBe(true);
    expect(domainAllowed("a@anything.org", [])).toBe(true);
  });
});

describe("safeNext", () => {
  test.each([
    ["/devices", "/devices"],
    ["/d/dvc_x/?tab=chat#top", "/d/dvc_x/?tab=chat#top"],
    ["http://localhost:3210/billing?x=1", "/billing?x=1"],
    ["/a/../admin", "/admin"],
  ])("keeps %j", (value, expected) => {
    expect(safeNext(value)).toBe(expected);
  });

  test.each([
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r/evil.com",
    "//evil.com",
    "///evil.com/x",
    "https://evil.com/",
    "http://localhost:3211/",
    "https://localhost:3210/",
    "javascript:alert(1)",
    "data:text/html,hi",
    "",
    null,
    undefined,
  ])("refuses %j", (value) => {
    expect(safeNext(value as string | null | undefined)).toBeNull();
  });
});

async function invite(email: string, opts: { expired?: boolean; revoked?: boolean } = {}) {
  await db.insert(invites).values({
    id: newId("inv"),
    email,
    roleId: "role_member",
    tokenHash: sha256(newId("t")),
    expiresAt: new Date(Date.now() + (opts.expired ? -1 : 1) * 86_400_000),
    revokedAt: opts.revoked ? new Date() : null,
  });
}

describe("loginPolicy", () => {
  test("invite-only refuses unknown addresses and accepts invited ones and accounts", async () => {
    expect(await loginPolicy("stranger@example.com")).toEqual({ allowed: false, reason: "not_invited" });
    await invite("guest@example.com");
    const invited = await loginPolicy("Guest@Example.com");
    expect(invited.allowed && invited.invite?.email).toBe("guest@example.com");
    const member = await makeUser({ email: "member@example.com" });
    const known = await loginPolicy("member@example.com");
    expect(known.allowed && known.user?.id).toBe(member.user.id);
  });

  test("expired and revoked invitations do not count", async () => {
    await invite("late@example.com", { expired: true });
    await invite("gone@example.com", { revoked: true });
    expect(await loginPolicy("late@example.com")).toEqual({ allowed: false, reason: "not_invited" });
    expect(await loginPolicy("gone@example.com")).toEqual({ allowed: false, reason: "not_invited" });
  });

  test("open sign-up lets new addresses in", async () => {
    await writeSettings("auth", { inviteOnly: false }, SYSTEM);
    expect(await loginPolicy("new@example.com")).toEqual({ allowed: true, user: null, invite: null });
  });

  test("the domain list is matched exactly and never locks out owners", async () => {
    await writeSettings("auth", { inviteOnly: false, allowedDomains: ["solakon.de"] }, SYSTEM);
    await makeUser({ email: "member@gmail.com" });
    await makeUser({ email: "boss@gmail.com", role: "owner" });
    expect(await loginPolicy("new@gmail.com")).toEqual({ allowed: false, reason: "domain" });
    expect(await loginPolicy("new@sub.solakon.de")).toEqual({ allowed: false, reason: "domain" });
    expect(await loginPolicy("member@gmail.com")).toEqual({ allowed: false, reason: "domain" });
    expect((await loginPolicy("boss@gmail.com")).allowed).toBe(true);
    expect((await loginPolicy("new@solakon.de")).allowed).toBe(true);
  });

  test("an invitation does not bypass the domain list", async () => {
    await writeSettings("auth", { allowedDomains: ["solakon.de"] }, SYSTEM);
    await invite("guest@gmail.com");
    expect(await loginPolicy("guest@gmail.com")).toEqual({ allowed: false, reason: "domain" });
  });

  test("suspended accounts are refused", async () => {
    await makeUser({ email: "paused@example.com", status: "suspended" });
    await makeUser({ email: "paused-owner@example.com", role: "owner", status: "suspended" });
    expect(await loginPolicy("paused@example.com")).toEqual({ allowed: false, reason: "suspended" });
    expect(await loginPolicy("paused-owner@example.com")).toEqual({ allowed: false, reason: "suspended" });
  });
});
