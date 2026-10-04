import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  deleteUserAction,
  grantPlanAction,
  revokeUserSessionAction,
  setUserRoleAction,
  setUserStatusAction,
  signOutUserAction,
} from "@/app/(app)/admin/users/actions";
import { GET as exportUsers } from "@/app/(app)/admin/users/export/route";
import { createSession, listSessions } from "@/server/auth/sessions";
import { ensureDefaultPlans } from "@/server/billing/plans";
import { db, plans, users } from "@/server/db";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { META, person, seed } from "./helpers";

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
  test("signed out: every action answers with a session message", async () => {
    const target = await person();
    const result = await setUserStatusAction(target.ctx.user.id, "suspended");
    expect(result).toEqual({ ok: false, error: "Your session has ended. Sign in again." });
  });

  test("a member cannot manage people", async () => {
    const me = await person();
    const target = await person();
    actAs(me.token);
    for (const result of [
      await setUserRoleAction(target.ctx.user.id, "role_admin"),
      await setUserStatusAction(target.ctx.user.id, "suspended"),
      await signOutUserAction(target.ctx.user.id),
      await revokeUserSessionAction(target.ctx.user.id, target.ctx.session.id),
      await deleteUserAction(target.ctx.user.id, target.ctx.user.email),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/permission/);
    }
  });

  test("the billing role sees people but cannot manage them", async () => {
    const me = await person({ role: "billing" });
    const target = await person();
    actAs(me.token);
    const result = await setUserStatusAction(target.ctx.user.id, "suspended");
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/permission/) });
  });
});

describe("escalation attempts", () => {
  test("an admin cannot make someone an owner, nor give a role with permissions they lack", async () => {
    const admin = await person({ role: "admin" });
    const target = await person();
    actAs(admin.token);
    expect(await setUserRoleAction(target.ctx.user.id, "role_owner")).toMatchObject({ ok: false, error: "Only an owner can make someone an owner." });
    // The billing role holds billing.manage, which admins do not.
    expect(await setUserRoleAction(target.ctx.user.id, "role_billing")).toMatchObject({
      ok: false,
      error: "You can only give a role whose permissions you have yourself.",
    });
    expect(await setUserRoleAction(target.ctx.user.id, "role_admin")).toEqual({ ok: true, data: undefined });
  });

  test("an admin cannot touch an owner's account", async () => {
    const admin = await person({ role: "admin" });
    const owner = await person({ role: "owner" });
    actAs(admin.token);
    const refused = "Only an owner can change an owner's account.";
    expect(await setUserStatusAction(owner.ctx.user.id, "suspended")).toMatchObject({ ok: false, error: refused });
    expect(await setUserRoleAction(owner.ctx.user.id, "role_member")).toMatchObject({ ok: false, error: refused });
    expect(await signOutUserAction(owner.ctx.user.id)).toMatchObject({ ok: false, error: refused });
    expect(await revokeUserSessionAction(owner.ctx.user.id, owner.ctx.session.id)).toMatchObject({ ok: false, error: refused });
    expect(await deleteUserAction(owner.ctx.user.id, owner.ctx.user.email)).toMatchObject({ ok: false, error: refused });
    expect(await listSessions(owner.ctx.user.id)).toHaveLength(1);
  });

  test("nobody changes or deletes themselves here", async () => {
    const owner = await person({ role: "owner" });
    actAs(owner.token);
    expect(await setUserRoleAction(owner.ctx.user.id, "role_admin")).toMatchObject({ ok: false, error: "You can't change your own role." });
    expect(await setUserStatusAction(owner.ctx.user.id, "suspended")).toMatchObject({ ok: false, error: /own account/ });
    expect(await deleteUserAction(owner.ctx.user.id, owner.ctx.user.email)).toMatchObject({ ok: false, error: /Account page/ });
    expect(await revokeUserSessionAction(owner.ctx.user.id, owner.ctx.session.id)).toMatchObject({ ok: false, error: /browser you are using/ });
  });
});

describe("what managers can do", () => {
  test("suspend, reactivate, sign out everywhere, revoke one browser", async () => {
    const admin = await person({ role: "admin" });
    const target = await person();
    await createSession(target.ctx.user.id, META);
    actAs(admin.token);

    expect(await signOutUserAction(target.ctx.user.id)).toEqual({ ok: true, data: { count: 2 } });
    expect(await listSessions(target.ctx.user.id)).toHaveLength(0);

    const { session } = await createSession(target.ctx.user.id, META);
    expect(await revokeUserSessionAction(target.ctx.user.id, session.id)).toEqual({ ok: true, data: undefined });
    expect(await listSessions(target.ctx.user.id)).toHaveLength(0);

    expect(await setUserStatusAction(target.ctx.user.id, "suspended")).toEqual({ ok: true, data: undefined });
    expect((await db.select().from(users).where(eq(users.id, target.ctx.user.id)))[0]?.status).toBe("suspended");
    expect(await setUserStatusAction(target.ctx.user.id, "active")).toEqual({ ok: true, data: undefined });
    expect((await db.select().from(users).where(eq(users.id, target.ctx.user.id)))[0]?.status).toBe("active");
  });

  test("delete needs the typed address and removes the account", async () => {
    const admin = await person({ role: "admin" });
    const target = await person({ email: "gone@example.com" });
    actAs(admin.token);
    expect(await deleteUserAction(target.ctx.user.id, "someone@example.com")).toMatchObject({ ok: false, error: /exactly as shown/ });
    expect(await deleteUserAction(target.ctx.user.id, " GONE@example.com ")).toEqual({ ok: true, data: undefined });
    expect(await db.select().from(users).where(eq(users.id, target.ctx.user.id))).toHaveLength(0);
  });

  test("bad ids are refused, not crashed on", async () => {
    const admin = await person({ role: "admin" });
    actAs(admin.token);
    expect(await setUserStatusAction("", "suspended")).toMatchObject({ ok: false });
    expect(await setUserStatusAction("usr_missing", "suspended")).toMatchObject({ ok: false, error: /no longer has an account/ });
    // @ts-expect-error a status outside the union
    expect(await setUserStatusAction("usr_missing", "banned")).toMatchObject({ ok: false });
  });
});

describe("giving plans", () => {
  test("needs billing.manage; admins are refused, the billing role is not", async () => {
    await ensureDefaultPlans();
    const [paid] = await db.select().from(plans).where(eq(plans.isFree, false));
    const admin = await person({ role: "admin" });
    const billing = await person({ role: "billing" });
    const target = await person();

    actAs(admin.token);
    expect(await grantPlanAction({ userId: target.ctx.user.id, planId: paid!.id, until: null })).toMatchObject({ ok: false, error: /permission/ });

    actAs(billing.token);
    expect(await grantPlanAction({ userId: target.ctx.user.id, planId: paid!.id, until: "2027-01-31" })).toEqual({ ok: true, data: undefined });
    const [row] = await db.select().from(users).where(eq(users.id, target.ctx.user.id));
    expect(row?.planOverrideId).toBe(paid!.id);
    expect(row?.planOverrideUntil?.toISOString()).toBe("2027-01-31T23:59:59.999Z");

    expect(await grantPlanAction({ userId: target.ctx.user.id, planId: paid!.id, until: "2020-01-01" })).toMatchObject({ ok: false, error: /future/ });
    expect(await grantPlanAction({ userId: target.ctx.user.id, planId: paid!.id, until: "soon" })).toMatchObject({ ok: false, fields: { until: "Pick a valid date." } });

    expect(await grantPlanAction({ userId: target.ctx.user.id, planId: null, until: null })).toEqual({ ok: true, data: undefined });
    expect((await db.select().from(users).where(eq(users.id, target.ctx.user.id)))[0]?.planOverrideId).toBeNull();
  });
});

describe("CSV export", () => {
  const request = (query = "") => new Request(`http://localhost:3210/admin/users/export${query}`);

  test("signed out and members get JSON errors, never the file", async () => {
    const member = await person();
    let res = await exportUsers(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
    actAs(member.token);
    res = await exportUsers(request());
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("the billing role (users.read) downloads escaped rows that follow the filters", async () => {
    const billing = await person({ role: "billing", email: "bill@example.com" });
    await person({ email: "formula@example.com", name: '=HYPERLINK("http://evil.example")' });
    await person({ email: "comma@example.com", name: "Doe, Jane", role: "admin", status: "suspended" });
    actAs(billing.token);

    const res = await exportUsers(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="people-/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const lines = text.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,email,name,role,status,computers,last_sign_in,created");
    expect(lines).toHaveLength(4);
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(text).toContain('"Doe, Jane",Admin,suspended,0');

    const filtered = await (await exportUsers(request("?status=suspended&q=comma"))).text();
    expect(filtered.trimEnd().split("\r\n")).toHaveLength(2);
    expect(filtered).toContain("comma@example.com");
    expect(filtered).not.toContain("formula@example.com");
  });
});
