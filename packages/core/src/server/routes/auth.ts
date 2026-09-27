import type { Hono } from "hono";
import { config } from "../../config";
import { safeEqual } from "../../vault/crypto";
import * as vault from "../../vault/vault";
import { audit } from "../../services/audit";
import { updateSettings } from "../../services/settings";
import {
  authenticate,
  checkDashboardPassword,
  createSession,
  destroySession,
  getAccessToken,
  hasDashboardPassword,
  rateLimitLogin,
  requireAuth,
  resetLoginAttempts,
  setDashboardPassword,
} from "../auth";
import { body, z } from "../validate";
import { HttpError } from "../../util";

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
}

export function registerAuthRoutes(app: Hono) {
  app.get("/api/auth/status", (c) => {
    return c.json({
      authenticated: authenticate(c) !== null,
      mode: config().mode,
      hasDashboardPassword: hasDashboardPassword(),
      vaultInitialized: vault.isInitialized(),
    });
  });

  /** Dashboard password login → HttpOnly session cookie. */
  app.post("/api/auth/login", async (c) => {
    const ip = clientIp(c);
    rateLimitLogin(ip);
    const { password } = await body(c, z.object({ password: z.string().min(1).max(512) }));
    if (!hasDashboardPassword()) throw new HttpError(400, "No dashboard password set. Log in with the access token instead.", "no_password");
    if (!checkDashboardPassword(password)) {
      audit("user", "auth.login_failed", null, { ip });
      throw new HttpError(401, "Wrong password", "wrong_password");
    }
    resetLoginAttempts(ip);
    createSession(c);
    audit("user", "auth.login", null, { ip, method: "password" });
    return c.json({ ok: true });
  });

  /** Exchange the access token (printed by `godmode serve`) for a session cookie. */
  app.post("/api/auth/token", async (c) => {
    const ip = clientIp(c);
    rateLimitLogin(ip);
    const { token } = await body(c, z.object({ token: z.string().min(1).max(512) }));
    if (!safeEqual(token.trim(), getAccessToken())) {
      audit("user", "auth.login_failed", null, { ip, method: "token" });
      throw new HttpError(401, "Invalid access token", "wrong_token");
    }
    resetLoginAttempts(ip);
    createSession(c);
    audit("user", "auth.login", null, { ip, method: "token" });
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    destroySession(c);
    return c.json({ ok: true });
  });

  app.post("/api/auth/password", requireAuth, async (c) => {
    const { password } = await body(c, z.object({ password: z.string().min(8).max(512) }));
    setDashboardPassword(password);
    updateSettings({ server: { hasDashboardPassword: true } });
    audit("user", "auth.password_changed");
    return c.json({ ok: true });
  });
}
