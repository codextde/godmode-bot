import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SYSTEM } from "@/server/audit";
import type { SessionContext } from "@/server/auth/sessions";
import { listSessions } from "@/server/auth/sessions";
import { newId, sha256 } from "@/server/crypto";
import { db, invites, pool, roles, users } from "@/server/db";
import {
  can,
  canGrantRole,
  canOpenPage,
  createRole,
  deleteRole,
  editableSettingsGroups,
  ensureSystemRoles,
  listRoles,
  pagePermission,
  PERMISSION_KEYS,
  updateRole,
} from "@/server/rbac";
import { writeSettings } from "@/server/settings";
import { deleteAccount, setUserRole, setUserStatus, signOutUser } from "@/server/users";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { auditRows, makeUser, seed } from "./fixtures";

vi.mock("@/server/billing/subscriptions", () => ({ cancelNow: vi.fn(async () => {}) }));

beforeAll(resetDatabase);
beforeEach(async () => {
  await truncateAll();
  await seed();
});
afterAll(closeDatabase);

const role = (key: string, permissions: string[]) => ({ role: { key, permissions } });

describe("permissions (pure)", () => {
  test("owners can do everything, others what their role lists", () => {
    const owner = role("owner", []);
    const admin = role("admin", PERMISSION_KEYS.filter((p) => p !== "roles.manage" && p !== "billing.manage"));
    expect(PERMISSION_KEYS.every((p) => can(owner, p))).toBe(true);
    expect(can(owner, "owner")).toBe(true);
    expect(can(admin, "settings.manage")).toBe(true);
    expect(can(admin, "roles.manage")).toBe(false);
    expect(can(admin, "billing.manage")).toBe(false);
    expect(can(admin, "owner")).toBe(false);
  });

  test("page permissions, including sub-pages", () => {
    expect(pagePermission("/admin")).toBe("admin.access");
    expect(pagePermission("/admin/users/usr_123?tab=sessions")).toBe("users.read");
    expect(pagePermission("/admin/settings/email")).toBe("owner");
    expect(pagePermission("/admin/settings/relay")).toBe("settings.manage");
    expect(pagePermission("/admin/settings/billing")).toBe("billing.manage");
    expect(pagePermission("/devices")).toBeNull();
    const admin = role("admin", ["admin.access", "users.read", "settings.manage"]);
    expect(canOpenPage(admin, "/admin/users/x")).toBe(true);
    expect(canOpenPage(admin, "/admin/settings/auth")).toBe(false);
    expect(editableSettingsGroups(admin)).toEqual(["general", "relay"]);
    expect(editableSettingsGroups(role("owner", []))).toEqual(["general", "auth", "email", "billing", "relay", "security"]);
  });

  test("the granting rule", () => {
    const admin = role("admin", ["admin.access", "users.manage", "invites.manage"]);
    expect(canGrantRole(admin, { key: "owner", permissions: [] })).toBe(false);
    expect(canGrantRole(admin, { key: "x", permissions: ["admin.access", "users.manage"] })).toBe(true);
    expect(canGrantRole(admin, { key: "x", permissions: ["billing.manage"] })).toBe(false);
    expect(canGrantRole(role("owner", []), { key: "owner", permissions: [] })).toBe(true);
  });
});

describe("system roles", () => {
  test("are seeded once and edits survive a reseed", async () => {
    await db.update(roles).set({ permissions: ["devices.link"] }).where(eq(roles.key, "member"));
    await ensureSystemRoles();
    const list = await listRoles();
    expect(list.map((r) => r.key)).toEqual(["owner", "admin", "billing", "member"]);
    expect(list.find((r) => r.key === "member")!.permissions).toEqual(["devices.link"]);
    const admin = list.find((r) => r.key === "admin")!;
    expect(admin.permissions).not.toContain("roles.manage");
    expect(admin.permissions).not.toContain("billing.manage");
  });
});

/** A custom role that may manage roles and people but not billing. */
async function manager(): Promise<SessionContext> {
  const owner = await makeUser({ role: "owner" });
  await createRole({ name: "Manager", permissions: ["admin.access", "roles.manage", "users.read", "users.manage", "devices.link"] }, owner);
  return makeUser({ role: "manager" });
}

describe("roles", () => {
  test("nobody can give a role permissions they lack", async () => {
    const mgr = await manager();
    await expect(createRole({ name: "Cashier", permissions: ["billing.manage"] }, mgr)).rejects.toMatchObject({ status: 403 });
    await expect(createRole({ name: "Bad", permissions: ["nope"] }, mgr)).rejects.toMatchObject({ status: 400 });
    const helper = await createRole({ name: "Helper", permissions: ["users.read", "devices.link"] }, mgr);
    expect(helper.key).toBe("helper");
    await expect(updateRole(helper.id, { permissions: ["users.read", "billing.read"] }, mgr)).rejects.toMatchObject({ status: 403 });
    await expect(updateRole(helper.id, { permissions: ["users.read"] }, mgr)).resolves.toMatchObject({ permissions: ["users.read"] });
    await expect(createRole({ name: "Helper", permissions: [] }, mgr)).rejects.toMatchObject({ status: 409 });
  });

  test("nobody but an owner edits the role they hold", async () => {
    const mgr = await manager();
    await expect(updateRole(mgr.role.id, { permissions: [...mgr.role.permissions, "audit.read"] }, mgr)).rejects.toMatchObject({ status: 403 });
    await expect(updateRole(mgr.role.id, { name: "Boss" }, mgr)).rejects.toMatchObject({ status: 403 });
  });

  test("built-in roles keep key and name; only the owner role's permissions are fixed", async () => {
    const owner = await makeUser({ role: "owner" });
    await expect(updateRole("role_admin", { name: "Admins" }, owner)).rejects.toMatchObject({ status: 400 });
    await expect(updateRole("role_owner", { permissions: [] }, owner)).rejects.toMatchObject({ status: 400 });
    await expect(updateRole("role_member", { permissions: ["devices.link"] }, owner)).resolves.toMatchObject({ permissions: ["devices.link"] });
    await expect(deleteRole("role_member", owner)).rejects.toMatchObject({ status: 400 });
  });

  test("the default sign-up role cannot gain admin access", async () => {
    const owner = await makeUser({ role: "owner" });
    await expect(updateRole("role_member", { permissions: ["admin.access", "devices.link"] }, owner)).rejects.toMatchObject({ status: 400 });
  });

  test("a role in use cannot be deleted; old invitations go with it", async () => {
    const owner = await makeUser({ role: "owner" });
    const custom = await createRole({ name: "Temp", permissions: ["devices.link"] }, owner);
    const person = await makeUser({ role: "temp" });
    await expect(deleteRole(custom.id, owner)).rejects.toThrow("1 person has this role. Give them another role first.");
    await db.update(users).set({ roleId: "role_member" }).where(eq(users.id, person.user.id));
    const base = { roleId: custom.id, tokenHash: "", expiresAt: new Date(Date.now() + 86_400_000) };
    await db.insert(invites).values({ ...base, id: newId("inv"), email: "p@example.com", tokenHash: sha256("p") });
    await expect(deleteRole(custom.id, owner)).rejects.toThrow("This role has pending invitations. Revoke them first.");
    await db.update(invites).set({ revokedAt: new Date() });
    await db.insert(invites).values({ ...base, id: newId("inv"), email: "a@example.com", tokenHash: sha256("a"), acceptedAt: new Date() });
    await db.insert(invites).values({ ...base, id: newId("inv"), email: "e@example.com", tokenHash: sha256("e"), expiresAt: new Date(Date.now() - 1000) });
    await deleteRole(custom.id, owner);
    expect(await db.select().from(invites)).toHaveLength(0);
    expect(await db.select().from(roles).where(eq(roles.id, custom.id))).toHaveLength(0);
    expect(await auditRows("role.delete")).toHaveLength(1);
  });

  test("members cannot manage roles", async () => {
    const member = await makeUser();
    await expect(createRole({ name: "X", permissions: [] }, member)).rejects.toMatchObject({ status: 403 });
  });
});

describe("giving roles", () => {
  test("the granting rule applies to role changes", async () => {
    const admin = await makeUser({ role: "admin" });
    const person = await makeUser();
    await expect(setUserRole(person.user.id, "role_owner", admin)).rejects.toMatchObject({ status: 403 });
    await expect(setUserRole(person.user.id, "role_billing", admin)).rejects.toMatchObject({ status: 403 });
    await expect(setUserRole(person.user.id, "role_admin", admin)).resolves.toMatchObject({ roleId: "role_admin" });
    await expect(setUserRole(admin.user.id, "role_member", admin)).rejects.toMatchObject({ status: 403 });
    const [entry] = await auditRows("user.role");
    expect(entry!.meta).toMatchObject({ from: "role_member", to: "role_admin" });
  });

  test("only owners make owners", async () => {
    const owner = await makeUser({ role: "owner" });
    const person = await makeUser();
    await expect(setUserRole(person.user.id, "role_owner", owner)).resolves.toMatchObject({ roleId: "role_owner" });
  });
});

describe("owner accounts", () => {
  test("only an owner may change, suspend, sign out or delete an owner", async () => {
    const owner = await makeUser({ role: "owner" });
    const admin = await makeUser({ role: "admin" });
    await expect(setUserRole(owner.user.id, "role_member", admin)).rejects.toMatchObject({ status: 403 });
    await expect(setUserStatus(owner.user.id, "suspended", admin)).rejects.toMatchObject({ status: 403 });
    await expect(signOutUser(owner.user.id, admin)).rejects.toMatchObject({ status: 403 });
    await expect(deleteAccount(owner.user.id, admin)).rejects.toMatchObject({ status: 403 });
    expect(await listSessions(owner.user.id)).toHaveLength(1);
  });

  test("two owners demoting each other at once leave exactly one", async () => {
    const a = await makeUser({ role: "owner" });
    const b = await makeUser({ role: "owner" });
    // Hold both owner rows from another connection so the two changes are certain to run at the same time.
    const blocker = await pool().connect();
    await blocker.query("begin");
    await blocker.query("select id from users where role_id = 'role_owner' for update");
    const pending = Promise.allSettled([setUserRole(b.user.id, "role_member", a), setUserRole(a.user.id, "role_member", b)]);
    await new Promise((r) => setTimeout(r, 150));
    await blocker.query("commit");
    blocker.release();
    const results = await pending;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toBe("There must always be at least one active owner. Make someone else an owner first.");
    const owners = await db.select().from(users).where(eq(users.roleId, "role_owner"));
    expect(owners).toHaveLength(1);
  });

  test("a stale owner session cannot remove the last active owner", async () => {
    const a = await makeUser({ role: "owner" });
    const b = await makeUser({ role: "owner" });
    await setUserRole(a.user.id, "role_member", b);
    // `a` still holds a context from before the change.
    await expect(setUserStatus(b.user.id, "suspended", a)).rejects.toThrow("at least one active owner");
    await expect(deleteAccount(b.user.id, a)).rejects.toThrow("at least one active owner");
  });

  test("suspending one of two owners works", async () => {
    const a = await makeUser({ role: "owner" });
    const b = await makeUser({ role: "owner" });
    await expect(setUserStatus(b.user.id, "suspended", a)).resolves.toMatchObject({ status: "suspended" });
  });

  test("the default role setting follows the granting rule too", async () => {
    await expect(writeSettings("auth", { defaultRoleKey: "billing" }, SYSTEM)).rejects.toMatchObject({ status: 400 });
  });

  test("the role open sign-ups get holds only personal permissions", async () => {
    const owner = await makeUser({ role: "owner" });
    const signup = await createRole({ name: "Sign-up", permissions: ["devices.link"] }, owner);
    const reader = await createRole({ name: "Reader", permissions: ["devices.link", "users.read"] }, owner);
    // Not the admin area, but still more than a person's own things.
    await expect(writeSettings("auth", { defaultRoleKey: reader.key }, SYSTEM)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("only the Personal permissions"),
    });
    await writeSettings("auth", { defaultRoleKey: signup.key }, SYSTEM);
    for (const extra of ["users.read", "devices.read", "audit.read", "admin.access"]) {
      await expect(updateRole(signup.id, { permissions: ["devices.link", extra] }, owner)).rejects.toMatchObject({ status: 400 });
    }
    await expect(updateRole(signup.id, { permissions: ["devices.link", "devices.share", "billing.self"] }, owner)).resolves.toMatchObject({
      permissions: ["devices.link", "devices.share", "billing.self"],
    });
    // Another role is not affected.
    await expect(updateRole(reader.id, { permissions: ["devices.link", "users.read", "audit.read"] }, owner)).resolves.toBeDefined();
  });
});
