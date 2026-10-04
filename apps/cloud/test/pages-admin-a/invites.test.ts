import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createInvitesAction, resendInviteAction, revokeInviteAction } from "@/app/(app)/admin/invites/actions";
import { db, invites } from "@/server/db";
import { writeSettings } from "@/server/settings";
import { SYSTEM } from "@/server/audit";
import { listInvites } from "@/server/users/invites";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { person, seed } from "./helpers";

const state = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("next/headers", async () => (await import("./helpers")).nextHeadersMock(state));
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

const actAs = (token: string | null) => {
  state.token = token;
};

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
  actAs(null);
});
afterAll(closeDatabase);

describe("permission checks", () => {
  test("signed out, members and the billing role cannot invite", async () => {
    expect(await createInvitesAction({ emails: "a@example.com", roleId: "role_member" })).toMatchObject({ ok: false, error: /session has ended/ });
    const member = await person();
    actAs(member.token);
    expect(await createInvitesAction({ emails: "a@example.com", roleId: "role_member" })).toMatchObject({ ok: false, error: /permission/ });
    const billing = await person({ role: "billing" });
    actAs(billing.token);
    expect(await createInvitesAction({ emails: "a@example.com", roleId: "role_member" })).toMatchObject({ ok: false, error: /permission/ });
    expect(await resendInviteAction("inv_x")).toMatchObject({ ok: false, error: /permission/ });
    expect(await revokeInviteAction("inv_x")).toMatchObject({ ok: false, error: /permission/ });
  });

  test("an admin cannot invite owners or roles with permissions they lack", async () => {
    const admin = await person({ role: "admin" });
    actAs(admin.token);
    expect(await createInvitesAction({ emails: "boss@example.com", roleId: "role_owner" })).toMatchObject({ ok: false, error: "Only an owner can make someone an owner." });
    expect(await createInvitesAction({ emails: "money@example.com", roleId: "role_billing" })).toMatchObject({
      ok: false,
      error: "You can only give a role whose permissions you have yourself.",
    });
    expect((await listInvites({})).total).toBe(0);
  });
});

describe("inviting", () => {
  test("many addresses at once, with links to copy and the skipped ones explained", async () => {
    const admin = await person({ role: "admin", email: "admin@example.com" });
    await person({ email: "taken@example.com" });
    actAs(admin.token);
    const result = await createInvitesAction({ emails: "anna@example.com, ben@example.com\nnot-an-address taken@example.com anna@example.com", roleId: "role_member" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created.map((c) => c.email)).toEqual(["anna@example.com", "ben@example.com"]);
    for (const c of result.data.created) {
      expect(c.url).toMatch(/^http:\/\/localhost:3210\/invite\/[A-Za-z0-9_-]{43}$/);
      expect(c.emailed).toBe(false); // the log transport never counts as e-mailed
    }
    expect(result.data.skipped).toEqual([
      { email: "not-an-address", reason: "This is not a valid e-mail address." },
      { email: "taken@example.com", reason: "taken@example.com already has an account." },
    ]);
    expect((await listInvites({ status: "pending" })).total).toBe(2);
  });

  test("empty input is a field error", async () => {
    const admin = await person({ role: "admin" });
    actAs(admin.token);
    expect(await createInvitesAction({ emails: "   ", roleId: "role_member" })).toMatchObject({ ok: false, fields: { emails: "Enter at least one e-mail address." } });
    expect(await createInvitesAction({ emails: "a@example.com", roleId: "" })).toMatchObject({ ok: false, fields: { roleId: "Choose a role." } });
  });

  test("the domain list applies to invitations", async () => {
    await writeSettings("auth", { allowedDomains: ["solakon.de"] }, SYSTEM);
    const admin = await person({ role: "admin", email: "admin@solakon.de" });
    actAs(admin.token);
    const result = await createInvitesAction({ emails: "x@example.com y@solakon.de", roleId: "role_member" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created.map((c) => c.email)).toEqual(["y@solakon.de"]);
    expect(result.data.skipped[0]).toMatchObject({ email: "x@example.com", reason: /solakon\.de/ });
  });

  test("resend gives a new link; revoke ends it; both refuse what is no longer pending", async () => {
    const admin = await person({ role: "admin" });
    actAs(admin.token);
    const created = await createInvitesAction({ emails: "anna@example.com", roleId: "role_member" });
    if (!created.ok) throw new Error(created.error);
    const first = created.data.created[0]!;
    const [before] = await db.select().from(invites).where(eq(invites.email, "anna@example.com"));

    const resent = await resendInviteAction(before!.id);
    expect(resent.ok).toBe(true);
    if (!resent.ok) return;
    expect(resent.data.url).not.toBe(first.url);
    const [after] = await db.select().from(invites).where(eq(invites.id, before!.id));
    expect(after?.tokenHash).not.toBe(before?.tokenHash);

    expect(await revokeInviteAction(before!.id)).toEqual({ ok: true, data: undefined });
    expect((await listInvites({ status: "revoked" })).rows.map((r) => r.id)).toEqual([before!.id]);
    expect(await revokeInviteAction(before!.id)).toMatchObject({ ok: false, error: "This invitation is no longer pending." });
    expect(await resendInviteAction(before!.id)).toMatchObject({ ok: false, error: /revoked/ });
    expect(await resendInviteAction("inv_missing")).toMatchObject({ ok: false, error: /no longer exists/ });
  });

  test("resending an invitation for a role the actor can no longer grant is refused", async () => {
    const owner = await person({ role: "owner" });
    const admin = await person({ role: "admin" });
    actAs(owner.token);
    const created = await createInvitesAction({ emails: "money@example.com", roleId: "role_billing" });
    if (!created.ok) throw new Error(created.error);
    const [invite] = await db.select().from(invites).where(eq(invites.email, "money@example.com"));
    actAs(admin.token);
    expect(await resendInviteAction(invite!.id)).toMatchObject({ ok: false, error: "You can only give a role whose permissions you have yourself." });
  });
});
