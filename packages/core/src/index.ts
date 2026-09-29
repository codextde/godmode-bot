#!/usr/bin/env bun
/**
 * Godmode Bot core daemon.
 *
 *   godmode serve [--host 127.0.0.1] [--port 7777] [--data-dir ~/.godmode] [--ui ./dist] [--token-stdin]
 *   godmode token            print the access token for the web dashboard
 *   godmode password <pw>    set the web dashboard password
 *   godmode doctor           check dependencies (claude, uv, chrome)
 *   godmode version
 */
import { parseArgs } from "node:util";
import { loadConfig, config, VERSION, isLoopbackHost } from "./config";
import { logger, setLogDir } from "./log";
import { openDb, closeDb } from "./db";
import { createApp } from "./server/app";
import { websocketHandler, type WsData } from "./server/ws";
import { authenticate, getAccessToken, isAllowedOrigin, setDashboardPassword } from "./server/auth";
import { getSettings, updateSettings } from "./services/settings";
import { applyRuntimeSettings } from "./services/runtime";
import * as vault from "./vault/vault";
import { ensureDefaultAgent } from "./agents/service";
import { recoverInterruptedRuns, shutdownRunner } from "./runner/runner";
import { startScheduler, stopScheduler } from "./scheduler/scheduler";
import { startDreaming, stopDreaming } from "./memory/dreaming";
import { startAutomationEvents, stopAutomationEvents } from "./automations/events";
import { startAppTriggers, stopAppTriggers } from "./integrations/composioTriggers";
import { shutdownBrowsers, ensureDefaultProfile } from "./browser/manager";
import { shutdownComputer } from "./computer/service";
import { shutdownVms, startVms } from "./vm/service";
import { closeGuestTunnels } from "./vm/guest";
import { runDoctor } from "./services/doctor";
import { getModelCatalog } from "./runner/models";
import { newId } from "./util";

const log = logger("core");

function parseCli() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "data-dir": { type: "string" },
      ui: { type: "string" },
      mode: { type: "string" },
      "token-stdin": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });
  return { values, positionals };
}

const TOKEN_STDIN_TIMEOUT_MS = 10_000;

/**
 * Read the access token from the first line of stdin (`--token-stdin`, used by the desktop shell). Unlike an
 * environment variable, it can't be read later from `ps eww` / /proc/<pid>/environ by other processes of the user.
 * stdin stays open afterwards: in desktop mode its EOF is the shutdown signal.
 */
function readTokenFromStdin(timeoutMs = TOKEN_STDIN_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const finish = (err: Error | null, token?: string) => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      if (err) reject(err);
      else resolve(token!);
    };
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const nl = buffered.indexOf("\n");
      if (nl === -1) {
        if (buffered.length > 4096) finish(new Error("--token-stdin: the token line is too long"));
        return;
      }
      const token = buffered.slice(0, nl).trim();
      if (token) finish(null, token);
      else finish(new Error("--token-stdin: received an empty token"));
    };
    const onEnd = () => finish(new Error("--token-stdin: stdin closed before the token was received"));
    const timer = setTimeout(() => finish(new Error(`--token-stdin: no token received within ${timeoutMs / 1000}s`)), timeoutMs);
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
  });
}

async function serve(values: Record<string, unknown>) {
  const stdinToken = values["token-stdin"] ? await readTokenFromStdin() : null;
  const cfg = loadConfig({
    ...(values["data-dir"] ? { dataDir: String(values["data-dir"]) } : {}),
    ...(values.ui ? { uiDir: String(values.ui) } : {}),
    ...(values.mode ? { mode: values.mode as "desktop" | "server" } : {}),
    ...(stdinToken ? { token: stdinToken } : {}),
  });
  // The token now lives in the config; don't let any child process (agents, MCP servers, installers) inherit it.
  delete process.env.GODMODE_TOKEN;
  setLogDir(cfg.logsDir);
  openDb(cfg.dbPath);

  const settings = getSettings();
  // CLI flags > env > settings
  cfg.host = (values.host as string) || process.env.GODMODE_HOST || settings.server.host || cfg.host;
  cfg.port = Number(values.port || process.env.GODMODE_PORT || settings.server.port || cfg.port);
  if (!isLoopbackHost(cfg.host) && !settings.server.remoteAccess) {
    log.warn(`binding to ${cfg.host} enables remote dashboard access`);
    updateSettings({ server: { remoteAccess: true } });
  }

  applyRuntimeSettings(getSettings());
  await vault.tryAutoUnlock();
  ensureDefaultProfile();
  await ensureDefaultAgent();
  recoverInterruptedRuns();
  startScheduler();
  startDreaming();
  startAutomationEvents();
  startAppTriggers();
  // Adopt VMs that kept running while Godmode was closed.
  startVms().catch((err) => log.warn("could not check VMs", err));

  const app = createApp();
  const token = getAccessToken();

  const serveOpts = {
    hostname: cfg.host,
    idleTimeout: 120,
    // Backups can be large (agent repos + browser profiles); the import route enforces its own 2 GB limit.
    maxRequestBodySize: 2 * 1024 ** 3 + 1024 ** 2,
    fetch(req: Request, server: import("bun").Server<WsData>) {
      const url = new URL(req.url);
      if (url.pathname === "/api/ws") {
        // Reuse Hono-compatible auth on a minimal context shim
        const shim = {
          req: {
            header: (n: string) => req.headers.get(n) ?? undefined,
            query: (n: string) => url.searchParams.get(n) ?? undefined,
            raw: req,
            url: req.url,
          },
        };
        // Block cross-site WebSocket hijacking: browsers always send Origin on WS handshakes.
        const origin = req.headers.get("origin");
        if (origin && !isAllowedOrigin(origin, req.headers.get("host") ?? undefined)) {
          return new Response("Origin not allowed", { status: 403 });
        }
        const auth = authenticate(shim as never);
        if (!auth) return new Response("Unauthorized", { status: 401 });
        const ok = server.upgrade(req, { data: { id: newId("ws"), subscriptions: new Set<string>(), auth } });
        return ok ? undefined : new Response("Upgrade failed", { status: 400 });
      }
      return app.fetch(req, { server });
    },
    websocket: websocketHandler,
  };

  let server: import("bun").Server<WsData>;
  try {
    server = Bun.serve<WsData>({ ...serveOpts, port: cfg.port } as never);
  } catch (err) {
    if (cfg.mode === "desktop") {
      log.warn(`port ${cfg.port} unavailable, picking a random port`);
      server = Bun.serve<WsData>({ ...serveOpts, port: 0 } as never);
    } else {
      throw err;
    }
  }
  cfg.port = server.port ?? cfg.port;

  const displayHost = isLoopbackHost(cfg.host) ? "127.0.0.1" : cfg.host;
  const url = `http://${displayHost}:${cfg.port}`;
  // Machine-readable ready line for the desktop shell.
  console.log(`GODMODE_READY ${JSON.stringify({ url, port: cfg.port, version: VERSION })}`);
  log.info(`Godmode core ${VERSION} listening on ${url} (mode=${cfg.mode}, data=${cfg.dataDir})`);
  if (cfg.mode === "server") {
    log.info(`Dashboard: ${url}  — access token: ${token.slice(0, 6)}… (run \`godmode token\` to print it)`);
  }

  // Background doctor check so the UI has fresh dependency info.
  runDoctor(true).catch((err) => log.warn("doctor failed", err));
  getModelCatalog().catch((err) => log.warn("model catalog failed", err));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`received ${signal}, shutting down`);
    stopScheduler();
    stopDreaming();
    stopAppTriggers();
    stopAutomationEvents();
    await shutdownRunner();
    await shutdownBrowsers();
    await shutdownComputer();
    await shutdownVms().catch((err) => log.warn("could not stop VMs", err));
    closeGuestTunnels();
    server.stop(true);
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Desktop shell closes our stdin when it exits — treat as shutdown signal.
  if (cfg.mode === "desktop") {
    process.stdin.on("end", () => void shutdown("stdin-closed"));
    process.stdin.resume();
  }
}

async function main() {
  const { values, positionals } = parseCli();
  const cmd = positionals[0] ?? "serve";
  if (values.help || cmd === "help") {
    console.log(`Godmode Bot ${VERSION}

Usage:
  godmode serve [--host 127.0.0.1] [--port 7777] [--data-dir ~/.godmode] [--ui <dir>] [--token-stdin]
  godmode token              Print the dashboard access token
  godmode password <new>     Set the web dashboard password
  godmode doctor             Check dependencies
  godmode version`);
    return;
  }
  switch (cmd) {
    case "serve":
      await serve(values);
      return;
    case "version":
      console.log(VERSION);
      return;
    case "token": {
      const cfg = loadConfig(values["data-dir"] ? { dataDir: String(values["data-dir"]) } : {});
      openDb(cfg.dbPath);
      console.log(getAccessToken());
      return;
    }
    case "password": {
      const pw = positionals[1];
      if (!pw) throw new Error("usage: godmode password <new-password>");
      const cfg = loadConfig(values["data-dir"] ? { dataDir: String(values["data-dir"]) } : {});
      openDb(cfg.dbPath);
      setDashboardPassword(pw);
      updateSettings({ server: { hasDashboardPassword: true } });
      console.log("Dashboard password updated.");
      return;
    }
    case "doctor": {
      const cfg = loadConfig(values["data-dir"] ? { dataDir: String(values["data-dir"]) } : {});
      openDb(cfg.dbPath);
      const report = await runDoctor(true);
      for (const d of report.dependencies) {
        console.log(`${d.ok ? "✅" : d.required ? "❌" : "⚠️ "} ${d.name.padEnd(22)} ${d.version ?? ""} ${d.ok ? "" : "— " + d.installHint}`);
      }
      process.exit(report.ok ? 0 : 1);
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  try {
    config();
  } catch {
    /* config not loaded */
  }
  process.exit(1);
});
