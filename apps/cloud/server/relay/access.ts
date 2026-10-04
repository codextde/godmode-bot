/**
 * Who may reach a computer through the relay, decided before the computer is contacted.
 *
 * `/d/<id>/…` (channel "cloud"): a signed-in cloud user with access to the computer. `/gw/<id>/…` (channel
 * "mobile"): a paired phone, which brings its own device token that only the computer can check; the cloud is a blind
 * gateway there and never answers 401 itself (the phone app forgets its pairing on a 401).
 */
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { CloudChannel, CloudRelayUser } from "@godmode/shared";
import { readSessionCookie, validateSessionToken } from "@/server/auth/sessions";
import { getEntitlements } from "@/server/billing/entitlements";
import { config } from "@/server/config";
import type { Device } from "@/server/db";
import { getDeviceForUser, getDeviceWithOwner } from "@/server/devices";
import { rateLimit } from "@/server/ratelimit";
import { getSettings } from "@/server/settings";
import { relayAllowed } from "@/server/usage";
import type { StreamSession } from "./link";
import type { Strikes } from "./limits";
import { denial, type Denial } from "./respond";

const MiB = 1024 * 1024;
/** Unauthenticated phone requests (pairing) carry a small JSON body at most. */
const PAIR_BODY_MAX = 16 * 1024;

export interface Grant {
  channel: CloudChannel;
  device: Device;
  ownerId: string;
  user: CloudRelayUser | null;
  session: StreamSession | null;
  maxBodyBytes: number;
  ip: string;
}

export type AccessResult = { ok: true; grant: Grant } | { ok: false; denial: Denial };

export function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The signed-in person behind a request's session cookie, or null. */
export async function sessionFromHeaders(headers: IncomingHttpHeaders) {
  const token = readSessionCookie(header(headers, "cookie") ?? null);
  if (!token) return null;
  const ctx = await validateSessionToken(token);
  return ctx ? { token, ctx } : null;
}

const deny = (status: number, code: string, error: string, retryAfterMs?: number): AccessResult => ({
  ok: false,
  denial: denial(status, code, error, retryAfterMs),
});

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Viewers read: GET/HEAD, plus resolving a chat's files, which is a POST that changes nothing. */
function viewerMay(method: string, path: string): boolean {
  if (SAFE_METHODS.has(method)) return true;
  const pathname = path.split("?")[0]!;
  return method === "POST" && /^\/api\/conversations\/[^/]+\/files$/.test(pathname);
}

/**
 * Fetch metadata: the dashboard only ever calls the relay with fetch() and its WebSocket. Anything else (a link, an
 * <img>, a <script>, a page of another site) is refused without contacting the computer, so what a computer serves
 * can't be loaded as a document, script or style on the cloud's origin.
 */
function fetchDestOk(headers: IncomingHttpHeaders, kind: "http" | "ws"): boolean {
  const dest = header(headers, "sec-fetch-dest");
  return dest === undefined || dest === (kind === "ws" ? "websocket" : "empty");
}

export async function browserAccess(req: IncomingMessage, ip: string, deviceId: string, path: string, kind: "http" | "ws"): Promise<AccessResult> {
  const headers = req.headers;
  const method = (req.method ?? "GET").toUpperCase();
  const publicUrl = config().publicUrl;
  const origin = header(headers, "origin");
  const site = header(headers, "sec-fetch-site");
  if (!fetchDestOk(headers, kind) || (site !== undefined && site !== "same-origin")) {
    return deny(403, "cloud_forbidden", "This address only answers the Godmode dashboard.");
  }
  // Cross-site WebSocket hijacking: browsers send Origin on every WebSocket handshake.
  if (kind === "ws" && origin !== publicUrl) return deny(403, "cloud_forbidden", "This connection must come from the dashboard on this cloud.");

  const session = await sessionFromHeaders(headers);
  if (!session) return deny(401, "cloud_unauthorized", "Sign in to Godmode Cloud to open this computer.");
  const { ctx } = session;
  const access = await getDeviceForUser(deviceId, ctx.user.id);
  if (!access) return deny(404, "device_not_found", "This computer does not exist or is not shared with you.");
  const { device, role } = access;

  if (kind === "http" && !SAFE_METHODS.has(method) && origin !== publicUrl && site !== "same-origin") {
    return deny(403, "cloud_forbidden", "This request must come from the dashboard on this cloud.");
  }

  const relay = await getSettings("relay");
  if (!relay.enabled || !relay.browserAccess) return deny(403, "cloud_forbidden", "Opening computers in the browser is turned off on this cloud.");
  if (device.status !== "active") return deny(403, "cloud_forbidden", "This computer is turned off in Godmode Cloud.");
  if (!device.browserAccess) {
    return deny(403, "cloud_forbidden", "Browser access is turned off on this computer. Turn it on under Settings → Cloud.");
  }

  let ownerId = ctx.user.id;
  if (role !== "owner") {
    const found = await getDeviceWithOwner(deviceId);
    if (!found) return deny(404, "device_not_found", "This computer does not exist or is not shared with you.");
    if (found.owner.status !== "active") return deny(403, "cloud_forbidden", "The account this computer belongs to is suspended.");
    ownerId = found.owner.id;
  }
  const entitlements = await getEntitlements(ownerId);
  if (role !== "owner" && (!relay.sharing || !entitlements.limits.sharing)) {
    return deny(403, "cloud_forbidden", "Sharing is not available for this computer right now. Ask its owner.");
  }
  if (!entitlements.limits.browserAccess) {
    return deny(
      402,
      "plan_limit",
      role === "owner"
        ? "Your plan doesn't include opening computers in the browser. Choose a plan that does under Billing."
        : "The plan of this computer's owner doesn't include opening it in the browser.",
    );
  }
  const quota = await relayAllowed(ownerId);
  if (!quota.ok) return deny(402, "plan_limit", quota.reason);

  if (role === "viewer" && kind === "http" && !viewerMay(method, path)) {
    return deny(403, "cloud_forbidden", "You can look, but not change anything on this computer.");
  }
  if (relay.requestsPerMinute > 0) {
    const limit = rateLimit(`relay:device:${deviceId}`, relay.requestsPerMinute, 60_000);
    if (!limit.ok) return deny(429, "rate_limited", "Too many requests to this computer. Try again in a moment.", limit.retryAfterMs);
  }

  return {
    ok: true,
    grant: {
      channel: "cloud",
      device,
      ownerId,
      user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, role },
      session: { token: session.token, userId: ctx.user.id, deviceId, role },
      maxBodyBytes: relay.maxBodyMb * MiB,
      ip,
    },
  };
}

export async function phoneAccess(
  unauthorizedStrikes: Strikes,
  req: IncomingMessage,
  ip: string,
  deviceId: string,
  path: string,
  kind: "http" | "ws",
): Promise<AccessResult> {
  const headers = req.headers;
  const method = (req.method ?? "GET").toUpperCase();
  const pathname = path.split("?")[0]!;
  if (!fetchDestOk(headers, kind)) return deny(403, "cloud_forbidden", "This address only answers the Godmode app.");
  if (!pathname.startsWith("/api/") || pathname.startsWith("/api/auth/")) return deny(404, "not_found", "Not found.");

  const locked = unauthorizedStrikes.lockedFor(ip);
  if (locked) return deny(429, "rate_limited", "Too many failed attempts from this address. Try again later.", locked);

  // Strangers who only know a device id must not be able to stream bodies through the link or use up the owner's
  // allowance: without a phone token only the health check and pairing pass.
  const hasToken = /^Bearer\s+gmd_\S+$/i.test(header(headers, "authorization") ?? "");
  const pairing = kind === "http" && method === "POST" && pathname === "/api/mobile/pair";
  const health = kind === "http" && method === "GET" && pathname === "/api/health";
  if (!hasToken && !pairing && !health) return deny(404, "not_found", "Not found.");

  const perIp = rateLimit(`relay:gw:${ip}`, 300, 60_000);
  if (!perIp.ok) return deny(429, "rate_limited", "Too many requests. Try again in a moment.", perIp.retryAfterMs);
  if (pairing) {
    const pair = rateLimit(`relay:gw-pair:${ip}`, 10, 15 * 60_000);
    if (!pair.ok) return deny(429, "rate_limited", "Too many pairing attempts. Try again later.", pair.retryAfterMs);
  }

  const found = await getDeviceWithOwner(deviceId);
  if (!found) return deny(404, "device_not_found", "This computer is not known to this cloud.");
  const { device, owner } = found;
  const offline = "This computer can't be reached through the cloud right now.";
  if (device.status !== "active" || owner.status !== "active") return deny(503, "device_offline", offline);
  const relay = await getSettings("relay");
  if (!relay.enabled || !relay.phoneGateway) return deny(503, "device_offline", "The phone gateway is turned off on this cloud.");
  const entitlements = await getEntitlements(owner.id);
  if (!entitlements.limits.phoneGateway) return deny(402, "plan_limit", "The plan of this computer's account doesn't include the phone gateway.");
  const quota = await relayAllowed(owner.id);
  if (!quota.ok) return deny(402, "plan_limit", quota.reason);
  if (!device.phoneAccess) return deny(503, "device_offline", "Phone access through the cloud is turned off on this computer.");

  return {
    ok: true,
    grant: {
      channel: "mobile",
      device,
      ownerId: owner.id,
      user: null,
      session: null,
      maxBodyBytes: hasToken ? relay.maxBodyMb * MiB : PAIR_BODY_MAX,
      ip,
    },
  };
}
