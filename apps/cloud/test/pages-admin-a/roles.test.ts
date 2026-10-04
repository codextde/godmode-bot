import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createRoleAction, deleteRoleAction, updateRoleAction } from "@/app/(app)/admin/roles/actions";
import { db, roles } from "@/server/db";
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
  test("only roles.manage may create, edit or delete roles (admins do not have it)", async () => {
    expect(await createRoleAction({ name: "Support", permissions: [] })).toMatchObject({ ok: false, error: /session has ended/ });
    const admin = await person({ role: "admin" });
    actAs(admin.token);
    expect(await createRoleAction({ name: "Support", permissions: [] })).toMatchObject({ ok: false, error: /permission/ });
    expect(await updateRoleAction("role_member", { permissions: [] })).toMatchObject({ ok: false, error: /permission/ });
    expect(await deleteRoleAction("role_member")).toMatchObject({ ok: false, error: /permission/ });
  });
});

describe("owners", () => {
  test("create, rename, change permissions, delete a custom role", async () => {
    const owner = await person({ role: "owner" });
    actAs(owner.token);
    const created = await createRoleAction({ name: "Support", description: "Helps people", permissions: ["admin.access", "users.read", "devices.link"] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    let [role] = await db.select().from(roles).where(eq(roles.id, id));
    expect(role).toMatchObject({ key: "support", name: "Support", description: "Helps people", system: false });
    expect(role?.permissions).toEqual(["admin.access", "users.read", "devices.link"]);

    expect(await updateRoleAction(id, { name: "Helpdesk", permissions: ["users.read", "audit.read"] })).toEqual({ ok: true, data: undefined });
    [role] = await db.select().from(roles).where(eq(roles.id, id));
    expect(role?.name).toBe("Helpdesk");
    expect(role?.permissions).toEqual(["users.read", "audit.read"]);

    // The key comes from the first name and stays ("support"); a new role with that name collides.
    expect(await createRoleAction({ name: "Support", permissions: [] })).toMatchObject({ ok: false, error: /already exists/ });
    expect(await createRoleAction({ name: " ", permissions: [] })).toMatchObject({ ok: false, fields: { name: "Enter a name for the role." } });
    expect(await createRoleAction({ name: "Odd", permissions: ["fly.away"] })).toMatchObject({ ok: false, error: '"fly.away" is not a permission.' });

    expect(await deleteRoleAction(id)).toEqual({ ok: true, data: undefined });
    expect(await db.select().from(roles).where(eq(roles.id, id))).toHaveLength(0);
  });

  test("the service's sentences on refusal reach the page", async () => {
    const owner = await person({ role: "owner" });
    actAs(owner.token);
    expect(await updateRoleAction("role_owner", { permissions: ["admin.access"] })).toMatchObject({ ok: false, error: "The owner role always has every permission." });
    expect(await updateRoleAction("role_admin", { name: "Boss" })).toMatchObject({ ok: false, error: "Built-in roles keep their name." });
    expect(await deleteRoleAction("role_admin")).toMatchObject({ ok: false, error: "Built-in roles can't be deleted." });
    expect(await deleteRoleAction("role_missing")).toMatchObject({ ok: false, error: "That role no longer exists." });

    const created = await createRoleAction({ name: "Taken", permissions: [] });
    if (!created.ok) throw new Error(created.error);
    await person({ roleId: created.data.id });
    expect(await deleteRoleAction(created.data.id)).toMatchObject({ ok: false, error: "1 person has this role. Give them another role first." });
  });
});

describe("a custom role manager who is not an owner", () => {
  test("cannot add permissions they lack, cannot edit their own role, can edit others within their permissions", async () => {
    const owner = await person({ role: "owner" });
    actAs(owner.token);
    const managerRole = await createRoleAction({ name: "Role manager", permissions: ["admin.access", "roles.manage", "users.read"] });
    if (!managerRole.ok) throw new Error(managerRole.error);
    const manager = await person({ roleId: managerRole.data.id });
    actAs(manager.token);

    expect(await createRoleAction({ name: "Sneaky", permissions: ["billing.manage"] })).toMatchObject({
      ok: false,
      error: "You can only give a role permissions you have yourself.",
    });
    expect(await updateRoleAction(managerRole.data.id, { permissions: ["admin.access", "roles.manage", "users.read", "users.manage"] })).toMatchObject({
      ok: false,
      error: "You can't edit the role you have yourself.",
    });
    expect(await updateRoleAction("role_member", { permissions: ["devices.link", "users.manage"] })).toMatchObject({
      ok: false,
      error: "You can only add permissions you have yourself.",
    });
    expect(await updateRoleAction("role_member", { permissions: ["devices.link", "users.read"] })).toEqual({ ok: true, data: undefined });
    const [member] = await db.select().from(roles).where(eq(roles.id, "role_member"));
    expect(member?.permissions).toEqual(["users.read", "devices.link"]);
  });
});
