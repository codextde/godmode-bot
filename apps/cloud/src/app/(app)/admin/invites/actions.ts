"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/action";
import { checkPermission } from "@/lib/session";
import { createInvites, resendInvite, revokeInvite } from "@/server/users/invites";

const id = z.string().min(1).max(64);

const createSchema = z.object({
  /** Addresses separated by commas, spaces or new lines. */
  emails: z.string().trim().min(1, "Enter at least one e-mail address.").max(10_000, "That is too much text. Invite at most 100 people at once."),
  roleId: z.string().min(1, "Choose a role.").max(64),
});

export interface InviteLink {
  email: string;
  /** Shown once, to copy: only the hash is stored. */
  url: string;
  emailed: boolean;
}

export interface CreateInvitesResult {
  created: InviteLink[];
  skipped: { email: string; reason: string }[];
}

/** Invites one or many people. The service applies the granting rule to the role and the domain rule to each address. */
export async function createInvitesAction(input: { emails: string; roleId: string }): Promise<ActionResult<CreateInvitesResult>> {
  return runAction(async () => {
    const ctx = await checkPermission("invites.manage");
    const { emails, roleId } = createSchema.parse(input);
    const result = await createInvites([emails], roleId, ctx);
    revalidatePath("/admin/invites");
    return {
      created: result.created.map((c) => ({ email: c.invite.email, url: c.url, emailed: c.emailed })),
      skipped: result.skipped,
    };
  });
}

/** A new link (the old one stops working) and a fresh expiry. */
export async function resendInviteAction(inviteId: string): Promise<ActionResult<{ url: string; emailed: boolean }>> {
  return runAction(async () => {
    const ctx = await checkPermission("invites.manage");
    // No revalidation here: the list refreshes when the dialog with the new link closes, so a row that changes tabs
    // (expired → pending) does not take its dialog away with it.
    return resendInvite(id.parse(inviteId), ctx);
  });
}

export async function revokeInviteAction(inviteId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await checkPermission("invites.manage");
    await revokeInvite(id.parse(inviteId), ctx);
    revalidatePath("/admin/invites");
  });
}
