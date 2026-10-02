import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { getConnInfo } from "hono/bun";
import { MOBILE_TOKEN_PREFIX, type MobileDevice } from "@godmode/shared";
import { config, isLoopbackHost } from "../config";
import { get, getMeta, insert, run, setMeta } from "../db";
import { getSettings } from "../services/settings";
import { authenticateDevice } from "../mobile/devices";
import { deviceBodyKeys, deviceMayCall, deviceMayUseView } from "../mobile/scope";
import { hashPassword, safeEqual, sha256, verifyPassword } from "../vault/crypto";
import { HttpError, newId, now, randomToken } from "../util";
import { closeSessionSockets } from "./ws";

export const SESSION_COOKIE = "gm_session";
const SESSION_DAYS = 30;

let accessToken: string | null = null;

/** The master access token: provided by the desktop shell, or generated and persisted (0600) for server mode. */
export function getAccessToken(): string {
  if (accessToken) return accessToken;
  const cfg = config();
  if (cfg.token) {
    accessToken = cfg.token;
    return accessToken;
  }
  const file = join(cfg.dataDir, "access-token");
  if (existsSync(file)) {
    accessToken = readFileSync(file, "utf8").trim();
  } else {
    accessToken = randomToken(32);
    writeFileSync(file, accessToken, { mode: 0o600 });
    try {
      if (process.platform !== "win32") chmodSync(file, 0o600);
    } catch {
      /* ignore */
    }
  }
  return accessToken;
}

export function hasDashboardPassword(): boolean {
  return getMeta("auth.dashboard_password") !== null;
}

export function setDashboardPassword(password: string) {
  if (password.length < 8) throw new HttpError(400, "Dashboard password must be at least 8 characters");
  setMeta("auth.dashboard_password", hashPassword(password));
  // Invalidate all existing sessions when the password changes, including their open WebSockets.
  run("DELETE FROM sessions");
  closeSessionSockets();
}

export function checkDashboardPassword(password: string): boolean {
  const stored = getMeta("auth.dashboard_password");
  if (!stored) return false;
  return verifyPassword(password, stored);
}

export function createSession(c: Context): string {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  insert("sessions", {
    id: newId("ses"),
    token_hash: sha256(token),
    user_agent: (c.req.header("user-agent") ?? "").slice(0, 200),
    created_at: now(),
    expires_at: expires.toISOString(),
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: isHttpsRequest(c),
    path: "/",
    expires,
  });
  return token;
}

/**
 * Did the browser reach us over HTTPS? Directly, or — with remote access on — through a TLS-terminating reverse
 * proxy that says so in X-Forwarded-Proto (only trusted then: locally nobody sits in front of us).
 */
function isHttpsRequest(c: Context): boolean {
  if (new URL(c.req.url).protocol === "https:") return true;
  if (!getSettings().server.remoteAccess) return false;
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return proto === "https";
}

export function destroySession(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

function validSession(token: string | undefined): boolean {
  if (!token) return false;
  const row = get<{ expires_at: string }>("SELECT expires_at FROM sessions WHERE token_hash = ?", sha256(token));
  if (!row) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
    return false;
  }
  return true;
}

export type AuthKind = "token" | "session" | "device" | null;

export interface AuthResult {
  kind: Exclude<AuthKind, null>;
  /** The paired phone behind a device token. */
  device?: MobileDevice;
}

export function authenticateRequest(c: Context): AuthResult | null {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    const value = header.slice(7).trim();
    if (value.startsWith(MOBILE_TOKEN_PREFIX)) {
      // Phones only come in over the Tailscale listener, and only while phone access is on.
      if (!isMobileChannel(c) || !getSettings().mobile.enabled) return null;
      const ip = clientIp(c);
      const device = authenticateDevice(value, ip === "unknown" ? undefined : ip);
      return device ? { kind: "device", device } : null;
    }
    if (safeEqual(value, getAccessToken())) return { kind: "token" };
  }
  // Browsers can't set headers on WebSocket handshakes, so only /api/ws accepts the token as a query parameter
  // (elsewhere it would leak into logs, history and Referer headers).
  const q = c.req.query("token");
  if (q && new URL(c.req.url).pathname === "/api/ws" && safeEqual(q, getAccessToken())) return { kind: "token" };
  if (validSession(getCookie(c, SESSION_COOKIE))) return { kind: "session" };
  return null;
}

export function authenticate(c: Context): AuthKind {
  return authenticateRequest(c)?.kind ?? null;
}

/** The request came in on the phones' listener (Tailscale address), see mobile/access.ts. */
export function isMobileChannel(c: Context): boolean {
  return (c.env as { channel?: string } | undefined)?.channel === "mobile";
}

/** The paired phone that made this request (null for the desktop app and the dashboard). */
export function requestDevice(c: Context): MobileDevice | null {
  return (c.get("device" as never) as MobileDevice | undefined) ?? null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "tauri.localhost"]);

/** Origins of the Tauri webview on macOS/Linux (tauri://localhost) and Windows (http(s)://tauri.localhost). */
const DESKTOP_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

/**
 * May a browser page from `origin` call the API? Same-origin (dashboard served by the core), the desktop webview,
 * the Vite dev server (dev mode only) and explicitly configured origins.
 */
export function isAllowedOrigin(origin: string, host: string | undefined): boolean {
  if (DESKTOP_ORIGINS.has(origin)) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (host && parsed.host === host) return true;
  if (config().dev && ["127.0.0.1:1420", "localhost:1420"].includes(parsed.host)) return true;
  return getSettings().server.allowedOrigins.includes(origin);
}

/**
 * Protect against DNS rebinding: when not in remote mode, only accept loopback Host headers. Automation webhooks
 * (`/hooks/<token>`) are exempt so a tunnel can forward them: the secret token authenticates the call, no cookie or
 * bearer token is involved and the answer reveals nothing.
 */
export const hostGuard: MiddlewareHandler = async (c, next) => {
  // The phones' listener checks the Host header against this computer's Tailscale names itself; here the decoded path
  // is checked too (`/api/%61uth/…` is `/api/auth/…` to the router).
  if (isMobileChannel(c)) {
    const path = c.req.path;
    if (!path.startsWith("/api/") || path.startsWith("/api/auth/")) return c.json({ error: "Not found", code: "not_found" }, 404);
    return next();
  }
  const settings = getSettings();
  const cfg = config();
  if (!settings.server.remoteAccess && isLoopbackHost(cfg.host) && !(c.req.method === "POST" && c.req.path.startsWith("/hooks/"))) {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "").toLowerCase();
    if (host && !LOCAL_HOSTS.has(host)) {
      return c.json({ error: "Host not allowed", code: "host_forbidden" }, 403);
    }
  }
  await next();
};

/** Require auth for /api/* (except public endpoints). Enforce same-origin for cookie auth on unsafe methods. */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const auth = authenticateRequest(c);
  const kind = auth?.kind;
  if (!kind || (isMobileChannel(c) && kind !== "device")) return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
  if (kind === "device") {
    const refusal = await deviceRefusal(c);
    if (refusal) return c.json({ error: refusal, code: "device_forbidden" }, 403);
  }
  if (kind === "session" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin) {
      const reqHost = c.req.header("host");
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        /* ignore */
      }
      const allowed = getSettings().server.allowedOrigins;
      if (originHost !== reqHost && !allowed.includes(origin)) {
        return c.json({ error: "Cross-origin request blocked", code: "csrf" }, 403);
      }
    }
  }
  c.set("authKind" as never, kind as never);
  if (auth?.device) c.set("device" as never, auth.device as never);
  await next();
};

/** Why a phone may not make this request (null = it may). */
async function deviceRefusal(c: Context): Promise<string | null> {
  const denied = "The phone app can't do this. Use Godmode on your computer.";
  if (!deviceMayCall(c.req.method, c.req.path)) return denied;
  const keys = deviceBodyKeys(c.req.method, c.req.path);
  if (!keys) return null;
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  if (Object.keys(payload).some((k) => !keys.includes(k))) return denied;
  const view = (payload as { view?: unknown }).view;
  if (c.req.path === "/api/computer/input" && (typeof view !== "string" || !deviceMayUseView(view))) {
    return "Only screens shared in a chat can be controlled from the phone.";
  }
  return null;
}

/** Client address from the TCP connection (not spoofable headers). */
export function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address || "unknown";
  } catch {
    return "unknown";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The app or browser asking runs on this computer — not behind a proxy or a tunnel that only ends here. */
export function isLocalRequest(c: Context): boolean {
  return !isMobileChannel(c) && LOOPBACK.has(clientIp(c)) && !c.req.header("x-forwarded-for") && !c.req.header("forwarded");
}

/* Simple in-memory login rate limiter */
const attempts = new Map<string, { count: number; first: number }>();
const RATE_WINDOW_MS = 15 * 60_000;

export function rateLimitLogin(ip: string): void {
  const windowMs = RATE_WINDOW_MS;
  const entry = attempts.get(ip);
  const t = Date.now();
  if (attempts.size > 1000) {
    for (const [key, value] of attempts) if (t - value.first > windowMs) attempts.delete(key);
  }
  if (!entry || t - entry.first > windowMs) {
    attempts.set(ip, { count: 1, first: t });
    return;
  }
  entry.count++;
  if (entry.count > 10) throw new HttpError(429, "Too many login attempts. Try again in a few minutes.", "rate_limited");
}

export function resetLoginAttempts(ip: string) {
  attempts.delete(ip);
}
