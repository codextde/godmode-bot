import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SYSTEM } from "@/server/audit";
import { consumeLoginCode, consumeLoginToken, peekLoginToken, requestLogin } from "@/server/auth/login";
import { auditLog, db, invites, loginTokens, users } from "@/server/db";
import { AppError } from "@/server/errors";
import type { MailMessage, MailResult } from "@/server/mail";
import { writeSettings } from "@/server/settings";
import { createInvite } from "@/server/users/invites";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { auditRows, makeUser, META, seed } from "./fixtures";

const mail = vi.hoisted(() => ({ sent: [] as MailMessage[], result: { ok: true, transport: "smtp" } as MailResult }));

vi.mock("@/server/mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/mail")>();
  return {
    ...actual,
    sendMail: async (msg: MailMessage) => {
      mail.sent.push(msg);
      return mail.result;
    },
  };
});

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
  mail.sent.length = 0;
  mail.result = { ok: true, transport: "smtp" };
});
afterAll(closeDatabase);

/** Waits for the sign-in e-mail (sending is not awaited by requestLogin) and reads the link token and code. */
async function received(count = 1): Promise<{ token: string; code: string | null; text: string }> {
  await vi.waitFor(() => expect(mail.sent.length).toBe(count));
  const text = mail.sent[count - 1]!.text;
  const token = /\/auth\/verify\?token=([A-Za-z0-9_-]{43})/.exec(text)?.[1];
  const code = /asked for it: (\d{4}) (\d{4})/.exec(text);
  if (!token) throw new Error("no link in the e-mail");
  return { token, code: code ? code[1]! + code[2]! : null, text };
}

function wrongCode(code: string): string {
  return code === "00000000" ? "11111111" : "00000000";
}

describe("sign-in link", () => {
  test("signs in once, then never again", async () => {
    const member = await makeUser({ email: "member@example.com" });
    const { loginId } = await requestLogin("Member@Example.com", { ...META, next: "/billing?tab=plans" });
    expect(loginId).toMatch(/^lgn_/);
    const { token, code } = await received();
    expect(code).toMatch(/^\d{8}$/);
    expect(mail.sent[0]!.to).toBe("member@example.com");
    expect(mail.sent[0]!.kind).toBe("login");
    expect(await peekLoginToken(token)).toEqual({ email: "member@example.com" });
    const first = await consumeLoginToken(token, META);
    expect(first?.user.id).toBe(member.user.id);
    expect(first?.next).toBe("/billing?tab=plans");
    expect(await consumeLoginToken(token, META)).toBeNull();
    expect(await peekLoginToken(token)).toBeNull();
    // The code of a used sign-in is dead too.
    expect(await consumeLoginCode(loginId, code!, META)).toBe("locked");
    const success = await auditRows("login.success");
    expect(success).toHaveLength(1);
    expect(success[0]!.meta).toEqual({ method: "link" });
  });

  test("an expired link does nothing", async () => {
    await makeUser({ email: "member@example.com" });
    const { loginId } = await requestLogin("member@example.com", META);
    const { token, code } = await received();
    await db.update(loginTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(loginTokens.id, loginId));
    expect(await consumeLoginToken(token, META)).toBeNull();
    expect(await consumeLoginCode(loginId, code!, META)).toBe("locked");
  });

  test("an unsafe next is dropped", async () => {
    await makeUser({ email: "member@example.com" });
    await requestLogin("member@example.com", { ...META, next: "/\\evil.com" });
    const { token } = await received();
    expect((await consumeLoginToken(token, META))?.next).toBeNull();
  });

  test("the policy is checked again when the link is used", async () => {
    const member = await makeUser({ email: "member@example.com" });
    await requestLogin("member@example.com", META);
    const { token } = await received();
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, member.user.id));
    expect(await consumeLoginToken(token, META)).toBeNull();
    const denied = await auditRows("login.denied");
    expect(denied.map((r) => r.meta)).toContainEqual({ reason: "suspended" });
  });
});

describe("sign-in code", () => {
  test("the right code signs in once", async () => {
    const member = await makeUser({ email: "member@example.com" });
    const { loginId } = await requestLogin("member@example.com", { ...META, next: "/devices" });
    const { code } = await received();
    const spaced = `${code!.slice(0, 4)} ${code!.slice(4)}`;
    const result = await consumeLoginCode(loginId, spaced, META);
    expect(typeof result === "object" && result.user.id).toBe(member.user.id);
    expect(typeof result === "object" && result.next).toBe("/devices");
    expect(await consumeLoginCode(loginId, code!, META)).toBe("locked");
    const [row] = await db.select().from(loginTokens).where(eq(loginTokens.id, loginId));
    expect(row!.attempts).toBe(0);
  });

  test("five wrong codes lock the sign-in", async () => {
    await makeUser({ email: "member@example.com" });
    const { loginId } = await requestLogin("member@example.com", META);
    const { code } = await received();
    for (let i = 0; i < 5; i++) expect(await consumeLoginCode(loginId, wrongCode(code!), META)).toBe("invalid");
    expect(await consumeLoginCode(loginId, code!, META)).toBe("locked");
    expect(await auditRows("login.code_locked")).toHaveLength(1);
    const audits = await db.select().from(auditLog);
    expect(JSON.stringify(audits)).not.toContain(code!);
  });

  test("parallel guesses cannot get past five", async () => {
    await makeUser({ email: "member@example.com" });
    const { loginId } = await requestLogin("member@example.com", META);
    const { code } = await received();
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeLoginCode(loginId, wrongCode(code!), META)));
    expect(results.filter((r) => r === "invalid")).toHaveLength(5);
    expect(results.filter((r) => r === "locked")).toHaveLength(15);
    const [row] = await db.select().from(loginTokens).where(eq(loginTokens.id, loginId));
    expect(row!.attempts).toBe(5);
    expect(await consumeLoginCode(loginId, code!, META)).toBe("locked");
  });

  test("ten wrong codes for an address in a day stop codes, but not the link", async () => {
    await makeUser({ email: "member@example.com" });
    const first = await requestLogin("member@example.com", META);
    const a = await received(1);
    const second = await requestLogin("member@example.com", META);
    const b = await received(2);
    for (let i = 0; i < 5; i++) await consumeLoginCode(first.loginId, wrongCode(a.code!), META);
    for (let i = 0; i < 4; i++) await consumeLoginCode(second.loginId, wrongCode(b.code!), META);
    // Nine wrong so far: one more try is allowed, then the address is locked even for a sign-in with tries left.
    expect(await consumeLoginCode(second.loginId, wrongCode(b.code!), META)).toBe("invalid");
    const third = await requestLogin("member@example.com", META);
    const c = await received(3);
    expect(c.code).toBeNull();
    expect(c.text).not.toMatch(/\d{4} \d{4}/);
    expect(await consumeLoginCode(third.loginId, "12345678", META)).toBe("locked");
    expect((await consumeLoginToken(c.token, META))?.user.email).toBe("member@example.com");
  });

  test("a code only works for its own sign-in", async () => {
    await makeUser({ email: "a@example.com" });
    await makeUser({ email: "b@example.com" });
    const a = await requestLogin("a@example.com", META);
    await received(1);
    await requestLogin("b@example.com", META);
    const b = await received(2);
    expect(await consumeLoginCode(a.loginId, b.code!, META)).toBe("invalid");
  });
});

describe("refused addresses", () => {
  test("look the same as real ones from outside", async () => {
    await makeUser({ email: "member@example.com" });
    const real = await requestLogin("member@example.com", META);
    await received(1);
    const refused = await requestLogin("stranger@example.com", META);
    expect(Object.keys(refused)).toEqual(Object.keys(real));
    expect(refused.loginId).toMatch(/^lgn_/);
    // Nothing is sent for the refused address.
    await new Promise((r) => setTimeout(r, 50));
    expect(mail.sent).toHaveLength(1);
    const [row] = await db.select().from(loginTokens).where(eq(loginTokens.id, refused.loginId));
    expect(row).toBeDefined();
    expect(row!.codeHash).toBeNull();
    // Wrong codes answer and lock exactly like a real sign-in.
    for (let i = 0; i < 5; i++) expect(await consumeLoginCode(refused.loginId, "12345678", META)).toBe("invalid");
    expect(await consumeLoginCode(refused.loginId, "12345678", META)).toBe("locked");
    expect((await auditRows("login.denied")).map((r) => r.meta)).toContainEqual({ reason: "not_invited" });
  });

  test("refused for every reason without an e-mail", async () => {
    await writeSettings("auth", { allowedDomains: ["solakon.de"] }, SYSTEM);
    await makeUser({ email: "paused@solakon.de", status: "suspended" });
    await requestLogin("someone@gmail.com", META);
    await requestLogin("paused@solakon.de", META);
    await requestLogin("nobody@solakon.de", META);
    await new Promise((r) => setTimeout(r, 50));
    expect(mail.sent).toHaveLength(0);
    const reasons = (await auditRows("login.denied")).map((r) => (r.meta as { reason: string }).reason).sort();
    expect(reasons).toEqual(["domain", "not_invited", "suspended"]);
  });

  test("an invalid address is a validation error, not a refusal", async () => {
    await expect(requestLogin("not-an-address", META)).rejects.toBeInstanceOf(AppError);
  });
});

describe("new people", () => {
  test("the first sign-in of an invited address creates the account with the invitation's role", async () => {
    const owner = await makeUser({ email: "owner@example.com", role: "owner" });
    const { invite } = await createInvite({ email: "new@example.com", roleId: "role_admin" }, owner);
    mail.sent.length = 0;
    await requestLogin("new@example.com", META);
    const { token } = await received();
    const result = await consumeLoginToken(token, META);
    expect(result?.user.email).toBe("new@example.com");
    expect(result?.user.roleId).toBe("role_admin");
    const [accepted] = await db.select().from(invites).where(eq(invites.id, invite.id));
    expect(accepted!.acceptedAt).not.toBeNull();
    expect(await auditRows("invite.accept")).toHaveLength(1);
  });

  test("open sign-up creates a member", async () => {
    await writeSettings("auth", { inviteOnly: false }, SYSTEM);
    await requestLogin("fresh@example.com", META);
    const { token } = await received();
    const result = await consumeLoginToken(token, META);
    expect(result?.user.roleId).toBe("role_member");
  });
});

describe("limits and fallbacks", () => {
  test("sign-in e-mails per address are limited", async () => {
    await makeUser({ email: "member@example.com" });
    for (let i = 0; i < 5; i++) await requestLogin("member@example.com", META);
    await expect(requestLogin("member@example.com", META)).rejects.toMatchObject({ status: 429 });
    // The same limit applies to an address without an account.
    for (let i = 0; i < 5; i++) await requestLogin("stranger@example.com", { ...META, ip: "198.51.100.1" });
    await expect(requestLogin("stranger@example.com", { ...META, ip: "198.51.100.1" })).rejects.toMatchObject({ status: 429 });
  });

  test("an owner's link goes to the server log when sending fails", async () => {
    await makeUser({ email: "owner@example.com", role: "owner" });
    await makeUser({ email: "member@example.com" });
    mail.result = { ok: false, error: "Connection refused" };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await requestLogin("member@example.com", META);
      await received(1);
      await requestLogin("owner@example.com", META);
      const { token } = await received(2);
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining(`/auth/verify?token=${token}`)));
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});
