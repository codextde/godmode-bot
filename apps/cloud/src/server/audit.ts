/** The audit log: who did what, when, from where. Writing never fails the action it records. */
import { and, count, desc, eq, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import type { SessionContext } from "./auth/sessions";
import { auditLog, db, type AuditEntry } from "./db";
import { getSettings } from "./settings";

export interface Actor {
  id: string | null;
  /** E-mail of the person, "system", "stripe" or "device:<id>". */
  label: string;
  ip?: string | null;
}

export const SYSTEM: Actor = { id: null, label: "system" };

/** The person behind a page or server action, for audit entries written by services. */
export function actorOf(ctx: SessionContext, ip?: string | null): Actor {
  return { id: ctx.user.id, label: ctx.user.email, ip: ip ?? ctx.ip ?? null };
}

const ACTIONS = [
  { action: "login.success", label: "Signed in" },
  { action: "login.denied", label: "Sign-in refused" },
  { action: "login.code_locked", label: "Sign-in code locked" },
  { action: "logout", label: "Signed out" },
  { action: "session.revoke", label: "Signed out a browser" },
  { action: "session.revoke_all", label: "Signed out everywhere" },
  { action: "invite.create", label: "Invited someone" },
  { action: "invite.resend", label: "Resent an invitation" },
  { action: "invite.revoke", label: "Revoked an invitation" },
  { action: "invite.accept", label: "Accepted an invitation" },
  { action: "user.role", label: "Changed a role" },
  { action: "user.suspend", label: "Suspended someone" },
  { action: "user.activate", label: "Reactivated someone" },
  { action: "user.delete", label: "Deleted an account" },
  { action: "user.profile", label: "Updated a profile" },
  { action: "role.create", label: "Created a role" },
  { action: "role.update", label: "Changed a role's permissions" },
  { action: "role.delete", label: "Deleted a role" },
  { action: "settings.update", label: "Changed settings" },
  { action: "setup.claim", label: "Claimed this cloud" },
  { action: "setup.finish", label: "Finished setup" },
  { action: "device.link", label: "Linked a computer" },
  { action: "device.link_denied", label: "Denied a link request" },
  { action: "device.unlink", label: "Unlinked a computer" },
  { action: "device.rename", label: "Renamed a computer" },
  { action: "device.disable", label: "Turned off a computer" },
  { action: "device.enable", label: "Turned on a computer" },
  { action: "device.remove", label: "Removed a computer" },
  { action: "device.share", label: "Shared a computer" },
  { action: "device.unshare", label: "Stopped sharing a computer" },
  { action: "plan.create", label: "Created a plan" },
  { action: "plan.update", label: "Changed a plan" },
  { action: "plan.archive", label: "Archived a plan" },
  { action: "plan.sync", label: "Synced a plan to Stripe" },
  { action: "plan.grant", label: "Gave a plan" },
  { action: "subscription.checkout", label: "Started a checkout" },
  { action: "subscription.change", label: "Changed a subscription" },
  { action: "subscription.cancel", label: "Cancelled a subscription" },
  { action: "subscription.resume", label: "Resumed a subscription" },
  { action: "subscription.cancel_now", label: "Ended a subscription immediately" },
  { action: "billing.enable", label: "Turned billing on or off" },
  { action: "billing.webhook", label: "Received a Stripe event" },
  { action: "mail.failed", label: "E-mail could not be sent" },
] as const;

export type AuditAction = (typeof ACTIONS)[number]["action"];

/** The only action names anyone writes, with labels for the audit page's filter. */
export const AUDIT_ACTIONS: { action: AuditAction; label: string }[] = ACTIONS.map((a) => ({ ...a }));

const KNOWN = new Set<string>(ACTIONS.map((a) => a.action));

export async function audit(
  actor: Actor,
  action: AuditAction | (string & {}),
  target?: { type: string; id: string } | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  if (!KNOWN.has(action)) console.warn(`[audit] unknown action "${action}"; add it to AUDIT_ACTIONS.`);
  try {
    await db.insert(auditLog).values({
      actorId: actor.id,
      actor: actor.label,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      ip: actor.ip ?? null,
      meta: meta ?? null,
    });
  } catch (err) {
    console.error(`[audit] could not record ${action}:`, err instanceof Error ? err.message : err);
  }
}

export async function listAudit(q: {
  search?: string;
  action?: string;
  actorId?: string;
  targetId?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ rows: AuditEntry[]; total: number }> {
  const pageSize = Math.min(Math.max(Math.floor(q.pageSize ?? 25), 1), 200);
  const page = Math.max(Math.floor(q.page ?? 1), 1);
  const filters: SQL[] = [];
  if (q.action) filters.push(eq(auditLog.action, q.action));
  if (q.actorId) filters.push(eq(auditLog.actorId, q.actorId));
  if (q.targetId) filters.push(eq(auditLog.targetId, q.targetId));
  const search = q.search?.trim();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    filters.push(or(ilike(auditLog.actor, like), ilike(auditLog.action, like), ilike(auditLog.targetId, like), ilike(auditLog.ip, like))!);
  }
  const where = filters.length ? and(...filters) : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(auditLog).where(where),
  ]);
  return { rows, total: total?.n ?? 0 };
}

/** Deletes entries older than `security.auditRetentionDays` (0 keeps everything). */
export async function pruneAudit(): Promise<number> {
  const { auditRetentionDays } = await getSettings("security");
  if (auditRetentionDays <= 0) return 0;
  const deleted = await db
    .delete(auditLog)
    .where(lt(auditLog.at, sql`now() - make_interval(days => ${auditRetentionDays})`))
    .returning({ id: auditLog.id });
  return deleted.length;
}
