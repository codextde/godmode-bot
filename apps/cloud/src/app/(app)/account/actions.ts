"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { actor, checkUser, clearSessionCookie } from "@/lib/session";
import { revokeAllSessions, revokeSession } from "@/server/auth/sessions";
import { badRequest } from "@/server/errors";
import { deleteOwnAccount, updateProfile } from "@/server/users";

export async function updateNameAction(name: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkUser();
    const clean = z.string("Enter your name.").trim().max(80, "Keep your name under 80 characters.").parse(name);
    await updateProfile(ctx.user.id, { name: clean }, await actor());
    revalidatePath("/", "layout");
  });
}

/** Signs out one other browser of the signed-in person. The current one signs out through the menu instead. */
export async function revokeSessionAction(sessionId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkUser();
    const id = z.string().min(1).max(64).parse(sessionId);
    if (id === ctx.session.id) throw badRequest("This is the browser you are using. Use “Sign out” to end it.");
    // Scoped to the own account: someone else's session id matches nothing.
    await revokeSession(id, ctx.user.id, await actor());
    revalidatePath("/account");
  });
}

export async function revokeOtherSessionsAction(): Promise<ActionResult<{ count: number }>> {
  return runAction(async () => {
    const ctx = await checkUser();
    const count = await revokeAllSessions(ctx.user.id, ctx.session.id, await actor());
    revalidatePath("/account");
    return { count };
  });
}

/** Deletes the own account after the e-mail address was typed; refused for the last active owner. */
export async function deleteOwnAccountAction(confirmEmail: string): Promise<ActionResult> {
  const result = await runAction(async () => {
    const ctx = await checkUser();
    await deleteOwnAccount(ctx, z.string("Type your e-mail address to confirm.").max(320).parse(confirmEmail));
    await clearSessionCookie();
  });
  if (result.ok) redirect("/login?deleted=1");
  return result;
}
