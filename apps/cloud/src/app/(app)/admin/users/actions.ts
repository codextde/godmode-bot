"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { checkPermission } from "@/lib/session";
import { actorOf } from "@/server/audit";
import { revokeSession } from "@/server/auth/sessions";
import { grantPlan } from "@/server/billing/subscriptions";
import { badRequest, forbidden, notFound } from "@/server/errors";
import { isOwner } from "@/server/rbac/permissions";
import { deleteAccount, getUser, setUserRole, setUserStatus, signOutUser } from "@/server/users";

const id = z.string().min(1).max(64);

function refresh(userId: string): void {
  revalidatePath("/admin/users");
  revalidatePath(`/admin/users/${userId}`);
}

/** The service applies the granting rule (only roles whose permissions the actor holds; owner only by an owner). */
export async function setUserRoleAction(userId: string, roleId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("users.manage");
    await setUserRole(id.parse(userId), id.parse(roleId), ctx);
    refresh(userId);
  });
}

export async function setUserStatusAction(userId: string, status: "active" | "suspended"): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("users.manage");
    await setUserStatus(id.parse(userId), z.enum(["active", "suspended"]).parse(status), ctx);
    refresh(userId);
  });
}

/** Signs the person out of every browser (the actor's own current browser stays signed in). */
export async function signOutUserAction(userId: string): Promise<ActionResult<{ count: number }>> {
  return runAction(async () => {
    const ctx = await checkPermission("users.manage");
    const count = await signOutUser(id.parse(userId), ctx);
    refresh(userId);
    return { count };
  });
}

/** Signs out one browser of someone. `revokeSession` has no guard of its own, so the owner rule is applied here. */
export async function revokeUserSessionAction(userId: string, sessionId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("users.manage");
    const target = await getUser(id.parse(userId));
    if (!target) throw notFound("That person no longer has an account.");
    if (isOwner(target) && !isOwner(ctx)) throw forbidden("Only an owner can change an owner's account.");
    if (sessionId === ctx.session.id) throw badRequest("This is the browser you are using. Sign out from the menu instead.");
    await revokeSession(id.parse(sessionId), target.id, actorOf(ctx));
    refresh(userId);
  });
}

const grantSchema = z.object({
  userId: id,
  planId: id.nullable(),
  /** A calendar day ("2027-01-31"); the plan is kept until the end of that day (UTC). */
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a valid date.")
    .nullable(),
});

/** Gives a plan without payment, optionally until a date; `planId: null` takes it away again. */
export async function grantPlanAction(input: { userId: string; planId: string | null; until: string | null }): Promise<ActionResult> {
  return runAction(async () => {
    await checkPermission("users.read");
    const ctx = await checkPermission("billing.manage");
    const { userId, planId, until } = grantSchema.parse(input);
    let end: Date | null = null;
    if (planId && until) {
      end = new Date(`${until}T23:59:59.999Z`);
      if (Number.isNaN(end.getTime())) throw badRequest("Pick a valid date.");
    }
    await grantPlan(userId, planId, end, ctx);
    refresh(userId);
  });
}

/** The typed confirmation is checked again here: the address must be the one of the account being deleted. */
export async function deleteUserAction(userId: string, confirmEmail: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("users.manage");
    const target = await getUser(id.parse(userId));
    if (!target) throw notFound("That person no longer has an account.");
    if (String(confirmEmail).trim().toLowerCase() !== target.email) throw badRequest("Type the person's e-mail address exactly as shown to confirm.");
    await deleteAccount(target.id, ctx);
    refresh(userId);
  });
}
