import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config, isLoopbackHost } from "../config";
import { get, getMeta, insert, run, setMeta } from "../db";
import { getSettings } from "../services/settings";
import { hashPassword, safeEqual, sha256, verifyPassword } from "../vault/crypto";
import { HttpError, newId, now, randomToken } from "../util";

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
  // Invalidate all existing sessions when the password changes.
  run("DELETE FROM sessions");
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
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    expires,
  });
  return token;
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

export type AuthKind = "token" | "session" | null;

export function authenticate(c: Context): AuthKind {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    if (safeEqual(header.slice(7).trim(), getAccessToken())) return "token";
  }
  const q = c.req.query("token");
  if (q && safeEqual(q, getAccessToken())) return "token";
  if (validSession(getCookie(c, SESSION_COOKIE))) return "session";
  return null;
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

/** Protect against DNS rebinding: when not in remote mode, only accept loopback Host headers. */
export const hostGuard: MiddlewareHandler = async (c, next) => {
  const settings = getSettings();
  const cfg = config();
  if (!settings.server.remoteAccess && isLoopbackHost(cfg.host)) {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "").toLowerCase();
    if (host && !LOCAL_HOSTS.has(host)) {
      return c.json({ error: "Host not allowed", code: "host_forbidden" }, 403);
    }
  }
  await next();
};

/** Require auth for /api/* (except public endpoints). Enforce same-origin for cookie auth on unsafe methods. */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const kind = authenticate(c);
  if (!kind) return c.json({ error: "Unauthorized", code: "unauthorized" }, 401);
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
  await next();
};

/* Simple in-memory login rate limiter */
const attempts = new Map<string, { count: number; first: number }>();

export function rateLimitLogin(ip: string): void {
  const windowMs = 15 * 60_000;
  const entry = attempts.get(ip);
  const t = Date.now();
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
