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
import { serveStatic } from "./static";
import { handleWebhook } from "../automations/webhooks";

const log = logger("http");

export function createApp() {
  const app = new Hono();

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
    if (err instanceof HttpError) {
      return c.json({ error: err.message, code: err.code, details: err.details }, err.status as 400);
    }
    log.error(`${c.req.method} ${c.req.path} failed`, err);
    return c.json({ error: err instanceof Error ? err.message : "Internal error", code: "internal" }, 500);
  });

  // Public
  app.get("/api/health", (c) => c.json({ ok: true, name: "godmode-bot" }));
  registerAuthRoutes(app); // handles its own auth for protected auth endpoints

  // MCP gateway for agent runs (authenticated by per-run tokens, not user auth)
  registerMcpRoutes(app);

  // Automation webhooks (the secret token in the path is the credential)
  app.post("/hooks/:token", handleWebhook);

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
  registerBrowserRoutes(app);
  registerComputerRoutes(app);
  registerVmRoutes(app);
  registerBackupRoutes(app);
  registerVoiceRoutes(app);
  registerFolderRoutes(app);

  app.all("/api/*", (c) => c.json({ error: "Not found", code: "not_found" }, 404));

  // Web dashboard (server mode) — SPA
  app.get("*", serveStatic);

  return app;
}
