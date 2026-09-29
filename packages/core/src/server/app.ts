import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { HttpError } from "../util";
import { logger } from "../log";
import { hostGuard, isAllowedOrigin, requireAuth } from "./auth";
import { registerAuthRoutes } from "./routes/auth";
import { registerSystemRoutes } from "./routes/system";
import { registerVaultRoutes } from "./routes/vault";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerAgentRoutes } from "./routes/agents";
import { registerChatRoutes } from "./routes/chat";
import { registerMissingLoginRoutes } from "./routes/missingLogins";
import { registerIntegrationRoutes } from "./routes/integrations";
import { registerBrowserRoutes } from "./routes/browser";
import { registerBackupRoutes } from "./routes/backup";
import { registerVoiceRoutes } from "./routes/voice";
import { registerFolderRoutes } from "./routes/folders";
import { registerMcpRoutes } from "../mcp/http";
import { registerComputerRoutes } from "./routes/computer";
import { registerVmRoutes } from "./routes/vms";
import { registerLogRoutes } from "./routes/logs";
import { serveStatic } from "./static";
import { handleWebhook } from "../automations/webhooks";
import { registerMessagingRoutes } from "./routes/messaging";
import { handleMessagingHook } from "../messaging/service";

const log = logger("http");
const SLOW_REQUEST_MS = 1000;

/** Expected refusals (signed out, vault locked, passphrase needed) — not worth a log line. */
function isRoutineRefusal(err: HttpError) {
  return err.status === 401 || err.status === 423 || err.code === "grant_required";
}

function isApiPath(path: string) {
  return path.startsWith("/api/") || path.startsWith("/mcp") || path.startsWith("/hooks/");
}

export function createApp() {
  const app = new Hono();

  // Route patterns (never raw paths): ids stay groupable and the webhook token in /hooks/:token stays out of the log.
  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    if (!isApiPath(c.req.path)) return;
    const ms = Math.round(performance.now() - started);
    const details = { method: c.req.method, route: c.req.routePath, status: c.res.status, ms };
    if (ms >= SLOW_REQUEST_MS) log.info("slow request", details);
    else log.debug("request", details);
  });

  app.use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      referrerPolicy: "no-referrer",
      // The desktop webview (tauri://localhost) is cross-origin to the core; CORS below governs access.
      crossOriginResourcePolicy: false,
      crossOriginOpenerPolicy: "same-origin",
    }),
  );
  app.use("*", hostGuard);
  // Strict CORS allowlist: desktop webview origins, the dev UI and user-configured dashboard origins.
  app.use(
    "/api/*",
    cors({
      origin: (origin, c) => (origin && isAllowedOrigin(origin, c.req.header("host")) ? origin : null),
      allowHeaders: ["Authorization", "Content-Type", "X-Godmode-Grant"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["Content-Disposition"],
      maxAge: 600,
    }),
  );

  app.onError((err, c) => {
    const route = c.req.routePath;
    if (err instanceof HttpError) {
      if (err.status >= 500) log.error(`${c.req.method} ${route} failed`, { err, status: err.status, code: err.code });
      else if (!isRoutineRefusal(err)) log.info("request rejected", { method: c.req.method, route, status: err.status, code: err.code, error: err.message });
      return c.json({ error: err.message, code: err.code, details: err.details }, err.status as 400);
    }
    log.error(`${c.req.method} ${route} failed`, err);
    return c.json({ error: err instanceof Error ? err.message : "Internal error", code: "internal" }, 500);
  });

  // Public
  app.get("/api/health", (c) => c.json({ ok: true, name: "godmode-bot" }));
  registerAuthRoutes(app); // handles its own auth for protected auth endpoints

  // MCP gateway for agent runs (authenticated by per-run tokens, not user auth)
  registerMcpRoutes(app);

  // Automation webhooks (the secret token in the path is the credential)
  app.post("/hooks/:token", handleWebhook);
  // Microsoft Teams deliveries (secret path + Bot Framework signature)
  app.post("/hooks/messaging/:token", handleMessagingHook);

  // Protected API
  app.use("/api/*", async (c, next) => {
    const path = c.req.path;
    if (path === "/api/health" || path.startsWith("/api/auth/")) return next();
    return requireAuth(c, next);
  });

  registerSystemRoutes(app);
  registerVaultRoutes(app);
  registerWorkspaceRoutes(app);
  registerAgentRoutes(app);
  registerChatRoutes(app);
  registerMissingLoginRoutes(app);
  registerIntegrationRoutes(app);
  registerMessagingRoutes(app);
  registerBrowserRoutes(app);
  registerComputerRoutes(app);
  registerVmRoutes(app);
  registerBackupRoutes(app);
  registerVoiceRoutes(app);
  registerFolderRoutes(app);
  registerLogRoutes(app);

  app.all("/api/*", (c) => {
    log.warn("unknown API route", { method: c.req.method, path: c.req.path });
    return c.json({ error: "Not found", code: "not_found" }, 404);
  });

  // Web dashboard (server mode) — SPA
  app.get("*", serveStatic);

  return app;
}
