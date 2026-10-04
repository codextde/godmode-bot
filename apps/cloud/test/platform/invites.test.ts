import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SYSTEM } from "@/server/audit";
import { validateSessionToken } from "@/server/auth/sessions";
import { db, invites, users } from "@/server/db";
import type { MailMessage, MailResult } from "@/server/mail";
import { writeSettings } from "@/server/settings";
import { setUserRole } from "@/server/users";
import { acceptInvite, createInvite, createInvites, getInviteByToken, listInvites, resendInvite, revokeInvite } from "@/server/users/invites";
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
vi.mock("@/server/billing/subscriptions", () => ({ cancelNow: vi.fn(async () => {}) }));

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
  mail.sent.length = 0;
  mail.result = { ok: true, transport: "smtp" };
});
afterAll(closeDatabase);

const tokenOf = (url: string) => url.split("/invite/")[1]!;

describe("creating", () => {
  test("sends the invitation and returns the link", async () => {
    const owner = await makeUser({ role: "owner", name: "Dana" });
    const result = await createInvite({ email: "New@Example.com", roleId: "role_member" }, owner);
    expect(result.invite.email).toBe("new@example.com");
    expect(result.url).toMatch(/^http:\/\/localhost:3210\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(result.emailed).toBe(true);
    expect(result.invite.tokenHash).not.toBe(tokenOf(result.url));
    expect(result.invite.expiresAt.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    expect(mail.sent[0]).toMatchObject({ to: "new@example.com", kind: "invite", subject: "Dana invited you to Godmode Cloud" });
    expect(mail.sent[0]!.text).toContain(result.url);
    expect(await auditRows("invite.create")).toHaveLength(1);
  });

  test("emailed is false when nothing went out over SMTP", async () => {
    const owner = await makeUser({ role: "owner" });
    mail.result = { ok: true, transport: "log" };
    expect((await createInvite({ email: "a@example.com", roleId: "role_member" }, owner)).emailed).toBe(false);
    mail.result = { ok: false, error: "Connection refused" };
    expect((await createInvite({ email: "b@example.com", roleId: "role_member" }, owner)).emailed).toBe(false);
  });

  test("lifetime follows auth.inviteDays", async () => {
    await writeSettings("auth", { inviteDays: 2 }, SYSTEM);
    const owner = await makeUser({ role: "owner" });
    const { invite } = await createInvite({ email: "a@example.com", roleId: "role_member" }, owner);
    expect(invite.expiresAt.getTime()).toBeLessThan(Date.now() + 2 * 86_400_000 + 5000);
  });

  test("checks the domain, existing accounts and pending invitations", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@solakon.de" });
    await writeSettings("auth", { allowedDomains: ["solakon.de"] }, SYSTEM);
    await expect(createInvite({ email: "x@gmail.com", roleId: "role_member" }, owner)).rejects.toMatchObject({ code: "domain" });
    await expect(createInvite({ email: "x@sub.solakon.de", roleId: "role_member" }, owner)).rejects.toMatchObject({ code: "domain" });
    await expect(createInvite({ email: "owner@solakon.de", roleId: "role_member" }, owner)).rejects.toMatchObject({ code: "exists" });
    await createInvite({ email: "x@solakon.de", roleId: "role_member" }, owner);
    await expect(createInvite({ email: "X@solakon.de", roleId: "role_member" }, owner)).rejects.toMatchObject({ code: "duplicate" });
  });

  test("two invitations of one address at once create one", async () => {
    const owner = await makeUser({ role: "owner" });
    const results = await Promise.allSettled([1, 2, 3].map(() => createInvite({ email: "same@example.com", roleId: "role_member" }, owner)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(invites)).toHaveLength(1);
  });

  test("the granting rule decides which roles someone may invite as", async () => {
    const admin = await makeUser({ role: "admin" });
    const member = await makeUser();
    await expect(createInvite({ email: "a@example.com", roleId: "role_owner" }, admin)).rejects.toMatchObject({ status: 403 });
    await expect(createInvite({ email: "a@example.com", roleId: "role_billing" }, admin)).rejects.toMatchObject({ status: 403 });
    await expect(createInvite({ email: "a@example.com", roleId: "role_admin" }, admin)).resolves.toBeDefined();
    await expect(createInvite({ email: "b@example.com", roleId: "role_member" }, member)).rejects.toMatchObject({ status: 403 });
    await expect(createInvite({ email: "c@example.com", roleId: "role_missing" }, admin)).rejects.toMatchObject({ status: 404 });
  });

  test("many at once, with reasons for the ones skipped", async () => {
    const owner = await makeUser({ role: "owner", email: "owner@example.com" });
    await createInvite({ email: "pending@example.com", roleId: "role_member" }, owner);
    const { created, skipped } = await createInvites(["a@example.com, b@example.com", "A@example.com", "nope", "owner@example.com", "pending@example.com"], "role_member", owner);
    expect(created.map((c) => c.invite.email)).toEqual(["a@example.com", "b@example.com"]);
    expect(skipped).toEqual([
      { email: "nope", reason: "This is not a valid e-mail address." },
      { email: "owner@example.com", reason: "owner@example.com already has an account." },
      { email: "pending@example.com", reason: "pending@example.com already has a pending invitation. Resend it instead." },
    ]);
  });
});

describe("accepting", () => {
  test("creates the account with the role and signs it in", async () => {
    const owner = await makeUser({ role: "owner" });
    const { url, invite } = await createInvite({ email: "new@example.com", roleId: "role_admin" }, owner);
    const found = await getInviteByToken(tokenOf(url));
    expect(found?.role.key).toBe("admin");
    expect(found?.inviter).toBe(owner.user.email);
    const result = await acceptInvite(tokenOf(url), { name: " New Person " }, META);
    expect(result.user).toMatchObject({ email: "new@example.com", name: "New Person", roleId: "role_admin", invitedBy: owner.user.id });
    expect((await validateSessionToken(result.sessionToken))?.user.id).toBe(result.user.id);
    expect(result.expires.getTime()).toBeGreaterThan(Date.now() + 364 * 86_400_000);
    const [row] = await db.select().from(invites).where(eq(invites.id, invite.id));
    expect(row!.acceptedAt).not.toBeNull();
    await expect(acceptInvite(tokenOf(url), { name: "" }, META)).rejects.toMatchObject({ code: "invite_invalid" });
    expect(await getInviteByToken(tokenOf(url))).toBeNull();
  });

  test("expired invitations cannot be used", async () => {
    const owner = await makeUser({ role: "owner" });
    const { url, invite } = await createInvite({ email: "late@example.com", roleId: "role_member" }, owner);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, invite.id));
    expect(await getInviteByToken(tokenOf(url))).toBeNull();
    await expect(acceptInvite(tokenOf(url), { name: "" }, META)).rejects.toMatchObject({ code: "invite_invalid" });
    expect(await db.select().from(users).where(eq(users.email, "late@example.com"))).toHaveLength(0);
  });

  test("a removed domain blocks acceptance", async () => {
    const owner = await makeUser({ role: "owner" });
    const { url } = await createInvite({ email: "x@gmail.com", roleId: "role_member" }, owner);
    await writeSettings("auth", { allowedDomains: ["solakon.de"] }, SYSTEM);
    await expect(acceptInvite(tokenOf(url), { name: "" }, META)).rejects.toMatchObject({ code: "domain" });
    // Rolled back: the invitation is still pending.
    expect((await listInvites({ status: "pending" })).total).toBe(1);
  });

  test("the inviter must still be allowed to give the role", async () => {
    const owner = await makeUser({ role: "owner" });
    const admin = await makeUser({ role: "admin" });
    const { url } = await createInvite({ email: "x@example.com", roleId: "role_admin" }, admin);
    await setUserRole(admin.user.id, "role_member", owner);
    await expect(acceptInvite(tokenOf(url), { name: "" }, META)).rejects.toMatchObject({ code: "invite_invalid" });
  });
});

describe("managing", () => {
  test("revoking ends the link", async () => {
    const owner = await makeUser({ role: "owner" });
    const { url, invite } = await createInvite({ email: "x@example.com", roleId: "role_member" }, owner);
    await revokeInvite(invite.id, owner);
    expect(await getInviteByToken(tokenOf(url))).toBeNull();
    await expect(acceptInvite(tokenOf(url), { name: "" }, META)).rejects.toMatchObject({ code: "invite_invalid" });
    await expect(revokeInvite(invite.id, owner)).rejects.toThrow("This invitation is no longer pending.");
    await expect(resendInvite(invite.id, owner)).rejects.toThrow("This invitation was revoked. Create a new one.");
    expect(await auditRows("invite.revoke")).toHaveLength(1);
  });

  test("resending makes a new link and a new expiry", async () => {
    const owner = await makeUser({ role: "owner" });
    const first = await createInvite({ email: "x@example.com", roleId: "role_member" }, owner);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, first.invite.id));
    const again = await resendInvite(first.invite.id, owner);
    expect(again.url).not.toBe(first.url);
    expect(again.emailed).toBe(true);
    expect(await getInviteByToken(tokenOf(first.url))).toBeNull();
    expect((await getInviteByToken(tokenOf(again.url)))?.id).toBe(first.invite.id);
    expect(await auditRows("invite.resend")).toHaveLength(1);
  });

  test("resending follows the granting rule", async () => {
    const owner = await makeUser({ role: "owner" });
    const admin = await makeUser({ role: "admin" });
    const { invite } = await createInvite({ email: "x@example.com", roleId: "role_owner" }, owner);
    await expect(resendInvite(invite.id, admin)).rejects.toMatchObject({ status: 403 });
  });

  test("lists by status with role and inviter", async () => {
    const owner = await makeUser({ role: "owner", name: "Dana" });
    const a = await createInvite({ email: "a@example.com", roleId: "role_member" }, owner);
    const b = await createInvite({ email: "b@example.com", roleId: "role_member" }, owner);
    await createInvite({ email: "c@example.com", roleId: "role_admin" }, owner);
    await revokeInvite(a.invite.id, owner);
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, b.invite.id));
    const all = await listInvites({});
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.status).sort()).toEqual(["expired", "pending", "revoked"]);
    expect(all.rows[0]!.inviter).toBe("Dana");
    const pending = await listInvites({ status: "pending" });
    expect(pending.rows.map((r) => [r.email, r.role.key])).toEqual([["c@example.com", "admin"]]);
    expect((await listInvites({ status: "expired" })).rows.map((r) => r.email)).toEqual(["b@example.com"]);
    expect((await listInvites({ status: "revoked" })).rows.map((r) => r.email)).toEqual(["a@example.com"]);
    expect((await listInvites({ search: "C@EX" })).total).toBe(1);
  });
});
