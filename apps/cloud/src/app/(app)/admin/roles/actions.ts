"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { checkPermission } from "@/lib/session";
import { createRole, deleteRole, updateRole } from "@/server/rbac";

const id = z.string().min(1).max(64);
const permissions = z.array(z.string().max(64)).max(64);

const createSchema = z.object({
  name: z.string().trim().min(1, "Enter a name for the role.").max(40, "Keep the role name under 40 characters."),
  description: z.string().trim().max(200, "Keep the description under 200 characters.").default(""),
  permissions,
});

const updateSchema = z.object({
  name: z.string().trim().min(1, "Enter a name for the role.").max(40, "Keep the role name under 40 characters.").optional(),
  description: z.string().trim().max(200, "Keep the description under 200 characters.").optional(),
  permissions: permissions.optional(),
});

/**
 * Creates a custom role (also "Duplicate": the client sends the copied permissions). The service refuses unknown
 * permissions and any permission the actor does not hold.
 */
export async function createRoleAction(input: { name: string; description?: string; permissions: string[] }): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await checkPermission("roles.manage");
    const role = await createRole(createSchema.parse(input), ctx);
    revalidatePath("/admin/roles");
    return { id: role.id };
  });
}

/** Saves a role's name, description and permissions. The owner role and the actor's own role are refused by the service. */
export async function updateRoleAction(
  roleId: string,
  patch: { name?: string; description?: string; permissions?: string[] },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("roles.manage");
    await updateRole(id.parse(roleId), updateSchema.parse(patch), ctx);
    revalidatePath("/admin/roles");
  });
}

export async function deleteRoleAction(roleId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("roles.manage");
    await deleteRole(id.parse(roleId), ctx);
    revalidatePath("/admin/roles");
  });
}
