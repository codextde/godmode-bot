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
import { registerQuestionRoutes } from "./routes/questions";
import { registerIntegrationRoutes } from "./routes/integrations";
import { registerBrowserRoutes } from "./routes/browser";
import { registerBackupRoutes } from "./routes/backup";
import { registerVoiceRoutes } from "./routes/voice";
import { registerFileRoutes } from "./routes/files";
import { registerFolderRoutes } from "./routes/folders";
import { isExpectedSlow, registerMcpRoutes } from "../mcp/http";
import { registerComputerRoutes } from "./routes/computer";
import { registerVmRoutes } from "./routes/vms";
import { registerSshRoutes } from "./routes/ssh";
import { registerLogRoutes } from "./routes/logs";
import { registerTaskRoutes } from "./routes/tasks";
import { serveStatic } from "./static";
import { handleWebhook } from "../automations/webhooks";
import { registerMessagingRoutes } from "./routes/messaging";
import { handleMessagingHook } from "../messaging/service";
import { registerMobileRoutes } from "./routes/mobile";
import { registerRunnerRoutes } from "./routes/runners";
import { registerLinkRoutes } from "./routes/link";
import { remoteRouting } from "../remote/routing";
import { registerCloudRoutes } from "./routes/cloud";

const log = logger("http");
const SLOW_REQUEST_MS = 1000;

/** Expected refusals (signed out, vault locked, passphrase needed) — not worth a log line. */
function isRoutineRefusal(err: HttpError) {
  return err.status === 401 || err.status === 423 || err.code === "grant_required";
}

function isApiPath(path: string) {
  return path.startsWith("/api/") || path.startsWith("/mcp") || path.startsWith("/hooks/");
}

/** Sign-in, phone pairing and webhook endpoints answer anyone: their refusals must not let strangers fill (or write into) the log. */
function isPublicPath(path: string) {
  return path.startsWith("/api/auth/") || path === "/api/mobile/pair" || path.startsWith("/hooks/");
}

const REJECTIONS_PER_MINUTE = 30;

function rejectionLogger() {
  let windowStart = 0;
  let count = 0;
  let suppressed = 0;
  return (level: "info" | "warn", msg: string, details: Record<string, unknown>) => {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      if (suppressed) log.info("more rejected requests not logged", { count: suppressed });
      windowStart = now;
      count = 0;
      suppressed = 0;
    }
    if (++count > REJECTIONS_PER_MINUTE) suppressed++;
    else log[level](msg, details);
  };
}

export function createApp() {
  const app = new Hono();
  const logRejection = rejectionLogger();

  // Route patterns (never raw paths): ids stay groupable and the webhook token in /hooks/:token stays out of the log.
  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    if (!isApiPath(c.req.path)) return;
    const ms = Math.round(performance.now() - started);
    const details = { method: c.req.method, route: c.req.routePath, status: c.res.status, ms };
    // `expected`: the route waits for something by design (see `expectSlow`), so it says nothing about the core.
    if (ms >= SLOW_REQUEST_MS) log.info("slow request", isExpectedSlow(c) ? { ...details, expected: true } : details);
    else if (!c.req.path.startsWith("/api/logs")) log.debug("request", details);
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
      else if (!isRoutineRefusal(err) && !isPublicPath(c.req.path)) {
        logRejection("info", "request rejected", { method: c.req.method, route, status: err.status, code: err.code, error: err.message });
      }
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
    if (path === "/api/health" || path.startsWith("/api/auth/") || path === "/api/mobile/pair") return next();
    return requireAuth(c, next);
  });
  // Requests about a chat that works on a runner (and the runner's screen) are answered by the runner.
  app.use("/api/*", remoteRouting);

  registerSystemRoutes(app);
  registerVaultRoutes(app);
  registerWorkspaceRoutes(app);
  registerAgentRoutes(app);
  registerChatRoutes(app);
  registerMissingLoginRoutes(app);
  registerQuestionRoutes(app);
  registerIntegrationRoutes(app);
  registerMessagingRoutes(app);
  registerBrowserRoutes(app);
  registerComputerRoutes(app);
  registerVmRoutes(app);
  registerTaskRoutes(app);
  registerSshRoutes(app);
  registerBackupRoutes(app);
  registerVoiceRoutes(app);
  registerFolderRoutes(app);
  registerFileRoutes(app);
  registerLogRoutes(app);
  registerMobileRoutes(app);
  registerRunnerRoutes(app);
  registerLinkRoutes(app);
  registerCloudRoutes(app);

  app.all("/api/*", (c) => {
    if (!isPublicPath(c.req.path)) logRejection("warn", "unknown API route", { method: c.req.method, path: c.req.path.slice(0, 200) });
    return c.json({ error: "Not found", code: "not_found" }, 404);
  });

  // Web dashboard (server mode) — SPA
  app.get("*", serveStatic);

  return app;
}
