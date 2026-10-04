/** Computers linked to accounts: lookup, authentication of their link secret, and what their owners may change. */
import { and, asc, count, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { CloudClose, parseCloudBearer, type CloudAccessRole } from "@godmode/shared";
import { actorOf, audit, type Actor } from "../audit";
import type { SessionContext } from "../auth/sessions";
import { safeEqual, sha256 } from "../crypto";
import { db, deviceAccess, devices, users, type Device, type User } from "../db";
import { badRequest, forbidden, notFound, unauthorized } from "../errors";
import { can } from "../rbac";
import { relayHub } from "../relay-bridge";

/** `Authorization: Bearer <deviceId>.<secret>` (the "Bearer " prefix is optional). Null for anything but a match. */
export async function authenticateDevice(bearer: string): Promise<Device | null> {
  const parsed = parseCloudBearer(bearer.replace(/^bearer\s+/i, "").trim());
  if (!parsed) return null;
  const [device] = await db.select().from(devices).where(eq(devices.id, parsed.deviceId)).limit(1);
  if (!device) return null;
  return safeEqual(sha256(parsed.secret), device.secretHash) ? device : null;
}

/**
 * The device API's guard: the computer behind the Authorization header and its owner, or a 401/403 AppError. A
 * computer turned off in the cloud may only unlink itself (`allowDisabled`).
 */
export async function requireDevice(authorization: string | null, opts: { allowDisabled?: boolean } = {}): Promise<{ device: Device; owner: User }> {
  const device = authorization ? await authenticateDevice(authorization) : null;
  if (!device) throw unauthorized("This computer is not linked to this cloud. Link it again.");
  const [owner] = await db.select().from(users).where(eq(users.id, device.userId)).limit(1);
  if (!owner) throw unauthorized("This computer is not linked to this cloud. Link it again.");
  if (owner.status !== "active") throw forbidden("The account this computer is linked to is suspended.", "account_suspended");
  if (device.status !== "active" && !opts.allowDisabled) throw forbidden("This computer is turned off in Godmode Cloud.", "device_disabled");
  return { device, owner };
}

export async function getDeviceWithOwner(deviceId: string): Promise<{ device: Device; owner: User } | null> {
  const [row] = await db
    .select({ device: devices, owner: users })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(eq(devices.id, deviceId))
    .limit(1);
  return row ?? null;
}

/** Status of each computer and of its owner, for the relay's periodic re-check of open links. */
export async function deviceStates(deviceIds: string[]): Promise<Map<string, { status: Device["status"]; ownerStatus: User["status"] }>> {
  const out = new Map<string, { status: Device["status"]; ownerStatus: User["status"] }>();
  if (deviceIds.length === 0) return out;
  const rows = await db
    .select({ id: devices.id, status: devices.status, ownerStatus: users.status })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(inArray(devices.id, deviceIds));
  for (const row of rows) out.set(row.id, { status: row.status, ownerStatus: row.ownerStatus });
  return out;
}

export async function listDevicesFor(
  userId: string,
): Promise<{ device: Device; role: CloudAccessRole; owner: { email: string; name: string | null } }[]> {
  const [own, sharedWithMe] = await Promise.all([
    db
      .select({ device: devices, email: users.email, name: users.name })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(eq(devices.userId, userId))
      .orderBy(asc(devices.createdAt)),
    db
      .select({ device: devices, role: deviceAccess.role, email: users.email, name: users.name })
      .from(deviceAccess)
      .innerJoin(devices, eq(devices.id, deviceAccess.deviceId))
      .innerJoin(users, eq(users.id, devices.userId))
      .where(eq(deviceAccess.userId, userId))
      .orderBy(asc(devices.createdAt)),
  ]);
  return [
    ...own.map((r) => ({ device: r.device, role: "owner" as const, owner: { email: r.email, name: r.name } })),
    ...sharedWithMe.map((r) => ({ device: r.device, role: r.role, owner: { email: r.email, name: r.name } })),
  ];
}

/** The computer and what this person may do on it; null when it does not exist or they have no access. */
export async function getDeviceForUser(deviceId: string, userId: string): Promise<{ device: Device; role: CloudAccessRole } | null> {
  const [row] = await db
    .select({ device: devices, role: deviceAccess.role })
    .from(devices)
    .leftJoin(deviceAccess, and(eq(deviceAccess.deviceId, devices.id), eq(deviceAccess.userId, userId)))
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!row) return null;
  if (row.device.userId === userId) return { device: row.device, role: "owner" };
  return row.role ? { device: row.device, role: row.role } : null;
}

async function loadDevice(deviceId: string): Promise<Device> {
  const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) throw notFound("This computer does not exist any more.", "device_not_found");
  return device;
}

/** Owners manage their own computers; `devices.manage` lets admins turn off or remove anyone's. */
async function manageableDevice(deviceId: string, ctx: SessionContext): Promise<Device> {
  const device = await loadDevice(deviceId);
  if (device.userId !== ctx.user.id && !can(ctx, "devices.manage")) {
    throw notFound("This computer does not exist any more.", "device_not_found");
  }
  return device;
}

export async function renameDevice(deviceId: string, name: string, ctx: SessionContext): Promise<Device> {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!clean) throw badRequest("Give the computer a name.");
  const device = await loadDevice(deviceId);
  if (device.userId !== ctx.user.id) throw notFound("This computer does not exist any more.", "device_not_found");
  const [updated] = await db.update(devices).set({ name: clean }).where(eq(devices.id, deviceId)).returning();
  await audit(actorOf(ctx), "device.rename", { type: "device", id: deviceId }, { from: device.name, to: clean });
  return updated ?? { ...device, name: clean };
}

export async function removeDevice(deviceId: string, ctx: SessionContext): Promise<void> {
  const device = await manageableDevice(deviceId, ctx);
  await db.delete(devices).where(eq(devices.id, deviceId));
  relayHub().disconnect(deviceId, CloudClose.BadCredential, "Removed");
  await audit(actorOf(ctx), "device.remove", { type: "device", id: deviceId }, { name: device.name, ownerId: device.userId });
}

/** The computer unlinks itself (device API). Its link, if still open, ends; it will not be let in again. */
export async function unlinkDevice(device: Device, actor: Actor): Promise<void> {
  await db.delete(devices).where(eq(devices.id, device.id));
  relayHub().disconnect(device.id, CloudClose.BadCredential, "Unlinked");
  await audit(actor, "device.unlink", { type: "device", id: device.id }, { name: device.name, ownerId: device.userId });
}

export async function setDeviceStatus(deviceId: string, status: Device["status"], ctx: SessionContext): Promise<Device> {
  const device = await manageableDevice(deviceId, ctx);
  const [updated] = await db.update(devices).set({ status }).where(eq(devices.id, deviceId)).returning();
  if (status === "disabled") relayHub().disconnect(deviceId, CloudClose.Disabled, "Turned off in the cloud");
  if (status !== device.status) {
    await audit(actorOf(ctx), status === "disabled" ? "device.disable" : "device.enable", { type: "device", id: deviceId }, { name: device.name });
  }
  return updated ?? { ...device, status };
}

export async function touchDevice(
  deviceId: string,
  patch: Partial<Pick<Device, "name" | "platform" | "appVersion" | "browserAccess" | "phoneAccess" | "lastIp">>,
): Promise<void> {
  await db
    .update(devices)
    .set({ ...patch, lastSeenAt: new Date() })
    .where(eq(devices.id, deviceId));
}

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function adminListDevices(q: {
  search?: string;
  status?: Device["status"];
  userId?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ rows: (Device & { owner: User })[]; total: number }> {
  const pageSize = Math.min(Math.max(q.pageSize ?? 25, 1), 200);
  const page = Math.max(q.page ?? 1, 1);
  const search = q.search?.trim();
  const filters: SQL[] = [];
  if (search) filters.push(or(ilike(devices.name, likePattern(search)), ilike(users.email, likePattern(search)))!);
  if (q.status) filters.push(eq(devices.status, q.status));
  if (q.userId) filters.push(eq(devices.userId, q.userId));
  const where = filters.length ? and(...filters) : undefined;
  const [rows, totals] = await Promise.all([
    db
      .select({ device: devices, owner: users })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(where)
      .orderBy(desc(devices.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(devices).innerJoin(users, eq(users.id, devices.userId)).where(where),
  ]);
  return { rows: rows.map((r) => ({ ...r.device, owner: r.owner })), total: totals[0]?.n ?? 0 };
}
