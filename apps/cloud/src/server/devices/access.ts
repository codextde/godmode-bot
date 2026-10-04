/** Sharing a computer with other accounts of this cloud. */
import { and, asc, eq } from "drizzle-orm";
import { actorOf, audit } from "../audit";
import type { SessionContext } from "../auth/sessions";
import { getEntitlements } from "../billing/entitlements";
import { db, deviceAccess, devices, users, type User } from "../db";
import { badRequest, forbidden, notFound } from "../errors";
import { can } from "../rbac";
import { getSettings } from "../settings";

const notYours = () => notFound("This computer does not exist any more.", "device_not_found");

export async function shareDevice(deviceId: string, email: string, role: "operator" | "viewer", ctx: SessionContext): Promise<void> {
  if (role !== "operator" && role !== "viewer") throw badRequest("Choose what they may do on this computer.");
  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device || device.userId !== ctx.user.id) throw notYours();
  if (!can(ctx, "devices.share")) throw forbidden("Your role can't share computers. Ask an administrator.");
  if (!(await getSettings("relay")).sharing) throw forbidden("Sharing computers is turned off on this cloud.");
  if (!(await getEntitlements(ctx.user.id)).limits.sharing) {
    throw forbidden("Your plan doesn't include sharing computers. Choose a plan with sharing under Billing.", "plan_limit");
  }
  const address = email.trim().toLowerCase();
  const [other] = address ? await db.select().from(users).where(eq(users.email, address)).limit(1) : [];
  if (!other) throw badRequest("There is no account with that address on this cloud. Invite them first.");
  if (other.id === ctx.user.id) throw badRequest("This is your own computer already.");
  if (other.status !== "active") throw badRequest("That account is suspended.");
  await db
    .insert(deviceAccess)
    .values({ deviceId, userId: other.id, role, createdBy: ctx.user.id })
    .onConflictDoUpdate({ target: [deviceAccess.deviceId, deviceAccess.userId], set: { role } });
  await audit(actorOf(ctx), "device.share", { type: "device", id: deviceId }, { userId: other.id, email: other.email, role });
}

/** The owner removes someone, or a person removes a computer that was shared with them. */
export async function unshareDevice(deviceId: string, userId: string, ctx: SessionContext): Promise<void> {
  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device || (device.userId !== ctx.user.id && userId !== ctx.user.id)) throw notYours();
  const removed = await db
    .delete(deviceAccess)
    .where(and(eq(deviceAccess.deviceId, deviceId), eq(deviceAccess.userId, userId)))
    .returning();
  // Open sockets and responses of that person end within a minute (the relay re-checks access).
  if (removed.length) await audit(actorOf(ctx), "device.unshare", { type: "device", id: deviceId }, { userId });
}

export async function listDeviceAccess(
  deviceId: string,
): Promise<{ user: Pick<User, "id" | "email" | "name">; role: "operator" | "viewer" }[]> {
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name, role: deviceAccess.role })
    .from(deviceAccess)
    .innerJoin(users, eq(users.id, deviceAccess.userId))
    .where(eq(deviceAccess.deviceId, deviceId))
    .orderBy(asc(users.email));
  return rows.map((r) => ({ user: { id: r.id, email: r.email, name: r.name }, role: r.role }));
}
