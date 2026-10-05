#!/usr/bin/env bun
/**
 * Godmode Bot core daemon.
 *
 *   godmode serve [--host 127.0.0.1] [--port 7777] [--data-dir ~/.godmode] [--ui ./dist] [--token-stdin]
 *   godmode token            print the access token for the web dashboard
 *   godmode password <pw>    set the web dashboard password
 *   godmode doctor           check dependencies (claude, uv, chrome) and permissions; --fix repairs what it can
 *   godmode update           update the installed tools
 *   godmode cleanup          show what takes up space; --fix removes what is safe to remove
 *   godmode license [<key>]  show the licence, or add (replace) the licence key
 *   godmode runner <install|pair|serve|status|uninstall>   work for a Godmode on another computer (see remote/cli.ts)
 *   godmode mcp | tools | call   the running Godmode for Claude Code and other apps outside it (see connect/cli.ts)
 *   godmode version
 */
import { rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { CleanupRun } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { loadConfig, config, BUILD, VERSION, isLoopbackHost, type CoreConfig } from "./config";
import { logger, setLogDir, setLogLevel } from "./log";
import { openDb, closeDb, setMeta, getDb } from "./db";
import { createApp } from "./server/app";
import { websocketHandler, type WsData } from "./server/ws";
import { authenticateRequest, getAccessToken, isAllowedOrigin, setDashboardPassword } from "./server/auth";
import { getSettings, updateSettings } from "./services/settings";
import { applyRuntimeSettings, onSettingsApplied } from "./services/runtime";
import * as vault from "./vault/vault";
import { ensureDefaultAgent } from "./agents/service";
import { recoverInterruptedRuns, shutdownRunner } from "./runner/runner";
import { clearRunMods } from "./mods/service";
import { startScheduler, stopScheduler } from "./scheduler/scheduler";
import { startDreaming, stopDreaming } from "./memory/dreaming";
import { startFollowups, stopFollowups } from "./services/followups";
import { startPauses, stopPauses } from "./services/pauses";
import { startBudgets, stopBudgets } from "./services/budgets";
import { startRunNotices, stopRunNotices } from "./services/runNotices";
import { startAutomationEvents, stopAutomationEvents } from "./automations/events";
import { startAppTriggers, stopAppTriggers } from "./integrations/composioTriggers";
import { startMessaging, stopMessaging } from "./messaging/service";
import { shutdownBrowsers, ensureDefaultProfile } from "./browser/manager";
import { shutdownComputer } from "./computer/service";
import { shutdownVms, startVms } from "./vm/service";
import { closeAllConnections } from "./ssh/client";
import { closeGuestTunnels } from "./vm/guest";
import { startTasks, stopTasks } from "./tasks/service";
import { runDoctor } from "./services/doctor";
import { checkPermissions } from "./services/permissions";
import { cleanUp, fixAll, installUpdates, startMaintenance, stopMaintenance } from "./services/maintenance";
import { RECOMMENDED, scanCleanup } from "./services/cleanup";
import { checkUpdates } from "./services/updates";
import { resourceSnapshot, startDiagnostics, stopDiagnostics } from "./diagnostics/monitor";
import { getModelCatalog } from "./runner/models";
import { refreshMobileAccess, startMobileAccess, stopMobileAccess } from "./mobile/access";
import { answerHealth, HEALTH_PATH, runnerFile, runningRunner, runRunnerCli, servingRunner, USAGE as RUNNER_USAGE, type RunnerProcess } from "./remote/cli";
import { startLinkServer, stopLinkServer } from "./remote/linkServer";
import { startRunners, stopRunners } from "./remote/runners";
import { bootstrapDependencies } from "./remote/health";
import { startKeepAwake, stopKeepAwake } from "./remote/keepAwake";
import { startCloudLink, stopCloudLink } from "./cloud/link";
import { licenseState, setLicenseKey, startLicense, stopLicense } from "./license/license";
import { removeCoreFile, runConnectCli, USAGE as CONNECT_USAGE, writeCoreFile } from "./connect/cli";
import { newId } from "./util";
import { SPEND_BACKFILL_SQL } from "./db/migrations";

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
      fix: { type: "boolean" },
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

/**
 * `role`: given by `godmode runner serve`; `godmode serve` takes it from GODMODE_ROLE. A runner is the same core without
 * what only the human's own Godmode does (schedules, dreaming, automations, messaging, the task board, phones): it
 * works on what a controller sends over the link, stays on loopback and keeps its computer awake.
 */
async function serve(values: Record<string, unknown>, role?: CoreConfig["role"]) {
  const stdinToken = values["token-stdin"] ? await readTokenFromStdin() : null;
  const cfg = loadConfig({
    ...(role ? { role } : {}),
    ...(values["data-dir"] ? { dataDir: String(values["data-dir"]) } : {}),
    ...(values.ui ? { uiDir: String(values.ui) } : {}),
    ...(values.mode ? { mode: values.mode as "desktop" | "server" } : {}),
    ...(stdinToken ? { token: stdinToken } : {}),
  });
  const runner = cfg.role === "runner";
  if (runner) {
    cfg.mode = "server";
    // Before the database is opened: a second runner on the same data dir would take the first one's runs for
    // interrupted ones and mark them as failed, and nothing else stops it (the API port is a random one).
    const other = await servingRunner(cfg.dataDir);
    if (other) throw new Error(`A runner is already serving from ${cfg.dataDir} (pid ${other.pid}).`);
  }
  // The token now lives in the config; don't let any child process (agents, MCP servers, installers) inherit it.
  delete process.env.GODMODE_TOKEN;
  setLogDir(cfg.logsDir);
  startDiagnostics();
  openDb(cfg.dbPath);

  const settings = getSettings();
  // CLI flags > env > settings
  cfg.host = (values.host as string) || process.env.GODMODE_HOST || settings.server.host || cfg.host;
  cfg.port = Number(values.port || process.env.GODMODE_PORT || settings.server.port || cfg.port);
  if (runner) {
    // The link is the only way in from outside. The API is for the runner's own runs (the MCP gateway): loopback, and
    // a random port unless one is asked for, so a Godmode app on the same computer keeps its 7777.
    cfg.host = "127.0.0.1";
    cfg.port = Number(values.port ?? 0);
  }
  if (!isLoopbackHost(cfg.host) && !settings.server.remoteAccess) {
    log.warn(`binding to ${cfg.host} enables remote dashboard access`);
    updateSettings({ server: { remoteAccess: true } });
  }

  applyRuntimeSettings(getSettings());
  // Before anything can start a run (and before child processes could inherit GODMODE_LICENSE).
  if (!runner) startLicense();
  await vault.tryAutoUnlock();
  ensureDefaultProfile();
  await ensureDefaultAgent();
  recoverInterruptedRuns();
  clearRunMods();
  // Runs that were cut off by a crash are booked now (once): what their earlier stretches cost counts.
  getDb().run(SPEND_BACKFILL_SQL);
  // Before anything can start a run: the runner keeps the display on while runs work, and counts them from the start.
  if (runner) startKeepAwake();
  else startScheduler();
  startFollowups();
  startPauses();
  startBudgets();
  if (!runner) {
    // A runner's runs are told by the computer it works for (they arrive there as its own runs).
    startRunNotices();
    startDreaming();
    startAutomationEvents();
    startAppTriggers();
    startMessaging();
    startTasks();
  }
  // Adopt VMs that kept running while Godmode was closed.
  startVms().catch((err) => log.warn("could not check VMs", err));

  const app = createApp();
  getAccessToken(); // creates the access token on first start

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
        const auth = authenticateRequest(shim as never);
        if (!auth) return new Response("Unauthorized", { status: 401 });
        const ok = server.upgrade(req, { data: { id: newId("ws"), subscriptions: new Set<string>(), auth: auth.kind, deviceId: auth.device?.id } });
        return ok ? undefined : new Response("Upgrade failed", { status: 400 });
      }
      // `godmode runner status` asks the runner itself: permissions and the session are this process's, not the asking terminal's.
      if (runner && req.method === "GET" && url.pathname === HEALTH_PATH) return answerHealth(req);
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
  if (runner) {
    // The way in for the computers it works for: encrypted, on every interface, at the port they were paired with.
    if (typeof values["link-port"] === "number") setMeta("link.port", String(values["link-port"]));
    const linkPort = startLinkServer({ app, websocket: websocketHandler });
    // Tells `godmode runner install` and `status` that this runner is up; gone again when it stops.
    const info: RunnerProcess = {
      pid: process.pid,
      apiPort: cfg.port,
      linkPort,
      startedAt: new Date().toISOString(),
      version: VERSION,
    };
    writeFileSync(runnerFile(cfg.dataDir), JSON.stringify(info, null, 2) + "\n", { mode: 0o600 });
  } else {
    startMobileAccess({ app, websocket: websocketHandler });
    onSettingsApplied(() => void refreshMobileAccess());
    // Connect to the runners this Godmode works with.
    startRunners();
    // Only a linked computer dials its cloud; it follows settings changes by itself. A runner never does: it works
    // for another computer, which is the one people reach.
    startCloudLink({ app, websocket: websocketHandler });
    // Where `godmode mcp` and `godmode call` find this core.
    writeCoreFile(cfg);
  }

  const displayHost = isLoopbackHost(cfg.host) ? "127.0.0.1" : cfg.host;
  const url = `http://${displayHost}:${cfg.port}`;
  // Machine-readable ready line for the desktop shell.
  console.log(`GODMODE_READY ${JSON.stringify({ url, port: cfg.port, version: VERSION })}`);
  log.info(`Godmode core ${VERSION} listening on ${url} (mode=${cfg.mode}, data=${cfg.dataDir})`, {
    build: BUILD,
    platform: `${cfg.platform} ${cfg.arch}`,
    bun: Bun.version,
    startupMs: Math.round(performance.now()),
  });
  if (cfg.mode === "server" && !runner) {
    log.info(`Dashboard: ${url}  — run \`godmode token\` to print the access token`);
  }

  // Background doctor check so the UI has fresh dependency info.
  runDoctor(true).catch((err) => log.warn("doctor failed", err));
  getModelCatalog().catch((err) => log.warn("model catalog failed", err));
  startMaintenance();
  // Nobody sits in front of a runner to click "Install": it fetches what it needs by itself. GODMODE_RUNNER_BOOTSTRAP=0
  // leaves the machine's software alone (tests, machines that are managed otherwise).
  if (runner && process.env.GODMODE_RUNNER_BOOTSTRAP !== "0") void bootstrapDependencies();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`received ${signal}, shutting down`, resourceSnapshot());
    stopDiagnostics();
    stopMaintenance();
    if (!runner) stopScheduler();
    stopFollowups();
    stopPauses();
    stopBudgets();
    if (runner) {
      stopLinkServer();
      stopKeepAwake();
      // Only its own: a runner.json that names another process is that runner's way of saying it serves.
      if (runningRunner(cfg.dataDir)?.pid === process.pid) rmSync(runnerFile(cfg.dataDir), { force: true });
    } else {
      stopRunNotices();
      stopDreaming();
      stopAppTriggers();
      stopAutomationEvents();
      stopMobileAccess();
      stopRunners();
      stopCloudLink();
      stopLicense();
      removeCoreFile(cfg.dataDir);
      await stopMessaging();
      stopTasks();
    }
    await shutdownRunner();
    await shutdownBrowsers();
    await shutdownComputer();
    await shutdownVms().catch((err) => log.warn("could not stop VMs", err));
    closeGuestTunnels();
    closeAllConnections();
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

/**
 * `godmode cleanup --fix`: a core that is running cleans itself — only it knows which browsers are open and holds
 * the locks its agents and tasks take. Without one, this process does.
 */
async function cleanUpFromCli(): Promise<CleanupRun> {
  const url = `http://127.0.0.1:${Number(process.env.GODMODE_PORT || getSettings().server.port)}`;
  const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) })
    .then((res) => res.json() as Promise<{ name?: string }>)
    .catch(() => null);
  if (health?.name !== "godmode-bot") return cleanUp(RECOMMENDED);
  const res = await fetch(`${url}/api/cleanup`, {
    method: "POST",
    headers: { authorization: `Bearer ${getAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ ids: RECOMMENDED }),
  });
  if (!res.ok) throw new Error("Godmode is running — clean up from Settings → Cleanup, or quit Godmode first.");
  return (await res.json()) as CleanupRun;
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
  godmode doctor [--fix]     Check dependencies and permissions (--fix repairs what it can)
  godmode update             Update the installed tools
  godmode cleanup [--fix]    Show what takes up space (--fix removes what is safe to remove)
  godmode license [<key>]    Show the licence, or add the licence key (GM-XXXXX-XXXXX-XXXXX-XXXXX)
  godmode version

Claude Code and other AI tools (they set up agents, automations and tasks in the running Godmode):
${CONNECT_USAGE}

Runner (this computer works for a Godmode on another one):
${RUNNER_USAGE.replace(/^Usage:\n/, "")}`);
    return;
  }
  switch (cmd) {
    case "serve":
      await serve(values);
      return;
    case "version":
      console.log(VERSION);
      return;
    case "runner": {
      const serving = positionals[1] === "serve";
      // Keep the answer readable: no database and probe chatter between the lines of a one-shot command.
      if (!serving && !process.env.GODMODE_LOG_LEVEL) setLogLevel("warn");
      const code = await runRunnerCli(Bun.argv.slice(Bun.argv.indexOf("runner", 2) + 1), { serve: (v) => serve(v, "runner") });
      // `runner serve` returned because it listens now and keeps running; every other command is done.
      if (code !== 0 || !serving) process.exit(code);
      return;
    }
    case "mcp":
    case "tools":
    case "call":
      // Nothing but the answer on stdout: an MCP client reads every line of it.
      setLogLevel("error");
      process.exit(await runConnectCli(cmd, positionals.slice(1), typeof values["data-dir"] === "string" ? values["data-dir"] : undefined));
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
      if (values.fix) {
        for (const r of (await fixAll()).results) console.log(`${r.outcome === "fixed" ? "🔧" : "✋"} ${r.name}: ${r.outcome === "fixed" ? "fixed" : r.output}`);
      }
      const report = await runDoctor(true);
      for (const d of report.dependencies) {
        console.log(`${d.ok ? "✅" : d.required ? "❌" : "⚠️ "} ${d.name.padEnd(22)} ${d.version ?? ""} ${d.ok ? "" : "— " + d.installHint}`);
      }
      const permissions = await checkPermissions({ privacy: false });
      for (const p of permissions.permissions) {
        console.log(`${p.ok ? "✅" : p.required ? "❌" : "⚠️ "} ${p.name.padEnd(22)} ${p.detail}${p.ok || !p.fixHint ? "" : ` — ${p.fixHint}`}`);
      }
      process.exit(report.ok && permissions.ok ? 0 : 1);
    }
    case "update": {
      const cfg = loadConfig(values["data-dir"] ? { dataDir: String(values["data-dir"]) } : {});
      openDb(cfg.dbPath);
      const results = await installUpdates();
      // `installUpdates` just asked the release feeds; a tool without an answer isn't known to be current.
      const unknown = (await checkUpdates()).tools.filter((t) => t.installed && t.updatable && t.track === "release" && t.latest === null);
      if (unknown.length) console.log(`Couldn't check ${unknown.map((t) => t.name).join(", ")} for a newer version — are you online?`);
      else if (!results.length) console.log("Everything is up to date.");
      for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name.padEnd(22)} ${!r.ok ? r.output.split("\n").pop() : r.upToDate ? "already up to date" : `${r.previous ?? "?"} → ${r.version ?? "?"}`}`);
      process.exit(results.every((r) => r.ok) ? 0 : 1);
    }
    case "license": {
      if (!process.env.GODMODE_LOG_LEVEL) setLogLevel("warn");
      const cfg = loadConfig(values["data-dir"] ? { dataDir: String(values["data-dir"]) } : {});
      openDb(cfg.dbPath);
      const key = positionals[1];
      const s = key ? await setLicenseKey(key) : licenseState();
      const until = s.trialEndsAt ?? s.renewsAt ?? s.graceEndsAt ?? s.unverifiedUntil;
      console.log(`${s.status}${s.plan ? ` · ${s.plan}` : ""}${s.keyHint ? ` · key …${s.keyHint}` : ""}${until ? ` · until ${until.slice(0, 10)}` : ""}`);
      if (s.message) console.log(s.message);
      process.exit(s.blocked ? 1 : 0);
    }
    case "cleanup": {
      const cfg = loadConfig(values["data-dir"] ? { dataDir: String(values["data-dir"]) } : {});
      openDb(cfg.dbPath);
      if (values.fix) {
        const run = await cleanUpFromCli();
        for (const r of run.results) console.log(`${r.ok ? "🧹" : "✋"} ${r.name.padEnd(30)} ${r.ok ? formatBytes(r.freedBytes) : r.output.split("\n")[0]}`);
        console.log(`Freed ${formatBytes(run.freedBytes)}.`);
      }
      const report = await scanCleanup();
      for (const s of report.storage) console.log(`   ${s.name.padEnd(30)} ${formatBytes(s.bytes)}`);
      for (const i of report.items.filter((i) => i.count)) {
        console.log(`${i.recommended ? "🧹" : "🔎"} ${i.name.padEnd(30)} ${formatBytes(i.bytes)}${i.blocked ? ` — ${i.blocked}` : ""}`);
      }
      for (const c of report.checks) console.log(`${c.status === "ok" ? "✅" : c.status === "warn" ? "⚠️ " : "❌"} ${c.name.padEnd(30)} ${c.detail}`);
      if (!values.fix && report.items.some((i) => i.recommended && i.count)) console.log("Run `godmode cleanup --fix` to remove what is marked 🧹.");
      process.exit(report.checks.some((c) => c.status === "error") ? 1 : 0);
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
