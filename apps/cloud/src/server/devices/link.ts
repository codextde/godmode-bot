/**
 * Linking a computer to an account, device-code style: the computer asks (startLink) and polls (pollLink) with a
 * secret only it knows; a signed-in person approves the short code in the browser (approveLink).
 */
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { CloudLinkPollResponse, CloudLinkStartResponse } from "@godmode/shared";
import { actorOf, audit } from "../audit";
import type { SessionContext } from "../auth/sessions";
import { deviceAllowance } from "../billing/entitlements";
import { config } from "../config";
import { newId, newUserCode, safeEqual, sha256 } from "../crypto";
import { db, devices, linkRequests, users, type Device, type LinkRequest } from "../db";
import { AppError, badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from "../errors";
import { sendMail } from "../mail";
import { deviceLinkedEmail } from "../mail/templates";
import { rateLimit } from "../ratelimit";
import { can } from "../rbac";
import { relayHub } from "../relay-bridge";
import { getSettings } from "../settings";

const LINK_MS = 10 * 60_000;
const POLL_SECONDS = 3;

const startSchema = z.object({
  instanceId: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  platform: z.string().trim().max(100).default(""),
  version: z.string().trim().max(100).default(""),
  secretHash: z.string().regex(/^[0-9a-f]{64}$/i),
});

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export async function startLink(body: unknown, ip: string): Promise<CloudLinkStartResponse> {
  if (!rateLimit(`link-start:${ip}`, 10, LINK_MS).ok) {
    throw tooMany("Too many link requests from this address. Try again in a few minutes.");
  }
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) throw badRequest("The link request is incomplete. Update Godmode and try again.");
  const input = parsed.data;
  const expiresAt = new Date(Date.now() + LINK_MS);
  // The code is unique over every row; a collision of two random 8-letter codes is rare but possible.
  for (let attempt = 0; ; attempt++) {
    const row = {
      id: newId("lnk"),
      userCode: newUserCode(),
      secretHash: input.secretHash.toLowerCase(),
      instanceId: input.instanceId,
      name: input.name.replace(/\s+/g, " ").slice(0, 80),
      platform: input.platform.slice(0, 40),
      appVersion: input.version.slice(0, 40),
      ip,
      expiresAt,
    };
    try {
      await db.insert(linkRequests).values(row);
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 5) continue;
      throw err;
    }
    return {
      requestId: row.id,
      userCode: row.userCode,
      verifyUrl: `${config().publicUrl}/link?code=${row.userCode}`,
      expiresAt: expiresAt.toISOString(),
      interval: POLL_SECONDS,
    };
  }
}

export async function pollLink(requestId: string, secret: string): Promise<CloudLinkPollResponse> {
  const [request] =
    typeof requestId === "string" && requestId.length <= 64
      ? await db.select().from(linkRequests).where(eq(linkRequests.id, requestId)).limit(1)
      : [];
  if (!request || !secret || !safeEqual(sha256(secret), request.secretHash)) {
    throw unauthorized("This link request is not known to the cloud. Start linking again.");
  }
  if (request.status === "denied") return { status: "denied" };
  if (request.status === "approved" && request.deviceId && request.userId) {
    const [user] = await db.select().from(users).where(eq(users.id, request.userId)).limit(1);
    if (user) return { status: "approved", deviceId: request.deviceId, account: { email: user.email, name: user.name } };
    return { status: "expired" };
  }
  if (request.expiresAt.getTime() <= Date.now()) return { status: "expired" };
  return { status: "pending" };
}

/** "kqzm 7hpd", "KQZM7HPD" and "KQZM-7HPD" are the same code. */
function normalizeUserCode(value: string): string | null {
  const plain = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : null;
}

export async function getPendingLink(userCode: string): Promise<LinkRequest | null> {
  const code = normalizeUserCode(userCode);
  if (!code) return null;
  const [request] = await db
    .select()
    .from(linkRequests)
    .where(and(eq(linkRequests.userCode, code), eq(linkRequests.status, "pending"), gt(linkRequests.expiresAt, new Date())))
    .limit(1);
  return request ?? null;
}

const gone = () => notFound("This code has expired or was already used. Start linking again on the computer.", "link_not_found");

export async function approveLink(userCode: string, ctx: SessionContext): Promise<{ device: Device }> {
  if (!can(ctx, "devices.link")) throw forbidden("Your role can't link computers. Ask an administrator.");
  const request = await getPendingLink(userCode);
  if (!request) throw gone();
  const [existing] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.userId, ctx.user.id), eq(devices.instanceId, request.instanceId)))
    .limit(1);
  // The instance id is not secret: replacing a live link would hand its address, shares and paired phones to
  // whichever machine asked. The real computer has to let go first.
  if (existing && relayHub().isOnline(existing.id)) {
    throw conflict(`${existing.name} is connected right now. Unlink it on the computer first.`, "device_online");
  }
  if (!existing) {
    const allowance = await deviceAllowance(ctx.user.id);
    if (allowance.limit !== null && allowance.used >= allowance.limit) {
      const n = allowance.limit;
      throw new AppError(
        `Your plan includes ${n} computer${n === 1 ? "" : "s"}, and ${n === 1 ? "it is" : "all are"} linked. Remove one or choose a bigger plan to link this computer.`,
        "plan_limit",
        402,
      );
    }
  }

  let device: Device;
  try {
    device = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(linkRequests)
        .set({ status: "approved", userId: ctx.user.id })
        .where(and(eq(linkRequests.id, request.id), eq(linkRequests.status, "pending"), gt(linkRequests.expiresAt, new Date())))
        .returning();
      if (!claimed) throw gone();
      const fields = { name: request.name, platform: request.platform, appVersion: request.appVersion, secretHash: request.secretHash };
      const [row] = existing
        ? await tx.update(devices).set(fields).where(eq(devices.id, existing.id)).returning()
        : await tx
            .insert(devices)
            .values({ id: newId("dvc"), userId: ctx.user.id, instanceId: request.instanceId, ...fields })
            .returning();
      if (!row) throw gone();
      await tx.update(linkRequests).set({ deviceId: row.id }).where(eq(linkRequests.id, request.id));
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("This computer was just linked by another request. Reload the page.", "conflict");
    throw err;
  }

  await audit(actorOf(ctx), "device.link", { type: "device", id: device.id }, { name: device.name, replaced: Boolean(existing), requestIp: request.ip });
  void notifyLinked(ctx.user.email, device.name);
  return { device };
}

async function notifyLinked(to: string, deviceName: string): Promise<void> {
  try {
    const { appName } = await getSettings("general");
    await sendMail({ to, kind: "notice", ...deviceLinkedEmail({ appName, deviceName, url: `${config().publicUrl}/devices` }) });
  } catch (err) {
    console.error("[link] could not send the linked e-mail:", err instanceof Error ? err.message : err);
  }
}

export async function denyLink(userCode: string, ctx: SessionContext): Promise<void> {
  const request = await getPendingLink(userCode);
  if (!request) throw gone();
  await db
    .update(linkRequests)
    .set({ status: "denied", userId: ctx.user.id })
    .where(and(eq(linkRequests.id, request.id), eq(linkRequests.status, "pending")));
  await audit(actorOf(ctx), "device.link_denied", { type: "link", id: request.id }, { name: request.name, requestIp: request.ip });
}
