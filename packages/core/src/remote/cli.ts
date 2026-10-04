/**
 * `godmode runner <command>`: set this computer up as a runner, run it, look at it, take the service away again.
 *
 * The subcommands live in one table (`commands`), so further ones slot in next to them.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RUNNER_DEFAULT_PORT, parseRunnerOffer, type RunnerCheck, type RunnerHealth, type RunnerPairingOfferPayload } from "@godmode/shared";
import { loadConfig, runnerDataDir, VERSION, type CoreConfig } from "../config";
import { all, getMeta, openDb, setMeta } from "../db";
import { getAccessToken } from "../server/auth";
import { sleep } from "../util";
import { safeEqual } from "../vault/crypto";
import * as vault from "../vault/vault";
import { runnerHealth } from "./health";
import { installService, serviceStatus, serviceSupported, uninstallService } from "./launchd";
import { createRunnerCode, deliverCode } from "./pairing";

/** How long `runner install` waits for the service it just started. */
const START_TIMEOUT_MS = 30_000;
const START_POLL_MS = 250;
/** How long a runner gets to say that it is there. */
const ALIVE_TIMEOUT_MS = 3_000;
/** How long `runner status` waits for the runner's own checks: a fresh look asks every tool for its version. */
const HEALTH_TIMEOUT_MS = 60_000;

/** Where a serving runner tells `godmode runner status` what it finds itself: on its loopback API, behind the access token. */
export const HEALTH_PATH = "/api/runner/health";

/**
 * Checks whose answer depends on the process that asks: macOS grants permissions per program, a terminal (or an SSH
 * login) has a session of its own, and the helper that keeps the Mac awake is the serving process's. Only the serving
 * runner's answer says something about the runner.
 */
const RUNNER_ONLY = new Set(["accessibility", "screen-recording", "full-disk-access", "gui-session", "keep-awake"]);

/** What a serving runner writes to `<data dir>/runner.json`, and removes when it stops. */
export interface RunnerProcess {
  pid: number;
  apiPort: number;
  /** Port of the encrypted link (meta `link.port`); null when none is set yet. */
  linkPort: number | null;
  startedAt: string;
  version: string;
}

export function runnerFile(dataDir: string): string {
  return join(dataDir, "runner.json");
}

/** The runner serving from this data dir, or null when none does (a file a crash left behind doesn't count). */
export function runningRunner(dataDir: string): RunnerProcess | null {
  try {
    const info = JSON.parse(readFileSync(runnerFile(dataDir), "utf8")) as RunnerProcess;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

/**
 * The runner that really serves from this data dir: its process lives and it answers on the port it wrote down. The
 * pid alone doesn't tell — after a crash and a restart of the computer it can be another program's, and a runner that
 * took that for a running one would never start again.
 */
export async function servingRunner(dataDir: string): Promise<RunnerProcess | null> {
  const runner = runningRunner(dataDir);
  if (!runner) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${runner.apiPort}/api/health`, { signal: AbortSignal.timeout(ALIVE_TIMEOUT_MS) });
    return res.ok && ((await res.json()) as { name?: unknown }).name === "godmode-bot" ? runner : null;
  } catch {
    return null;
  }
}

/** The serving runner's answer on `HEALTH_PATH`: a fresh look of its own, for whoever holds the access token. */
export async function answerHealth(req: Request): Promise<Response> {
  const given = req.headers.get("authorization") ?? "";
  if (!given.startsWith("Bearer ") || !safeEqual(given.slice(7).trim(), getAccessToken())) {
    return Response.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  return Response.json(await runnerHealth(true));
}

/** What the serving runner finds itself; null when it can't be asked (nothing answers behind that pid, or an older Godmode does). */
async function askRunner(runner: RunnerProcess): Promise<RunnerHealth | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${runner.apiPort}${HEALTH_PATH}`, {
      headers: { authorization: `Bearer ${getAccessToken()}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const health = (await res.json()) as RunnerHealth | null;
    return Array.isArray(health?.checks) ? health : null;
  } catch {
    return null;
  }
}

/** What this process can find by itself, for when there is no runner to ask. */
async function terminalChecks(): Promise<RunnerCheck[]> {
  // A serving runner holds the vault key in its memory; this process gets its own from where the device remembers it.
  await vault.tryAutoUnlock();
  return (await runnerHealth(true)).checks.filter((check) => !RUNNER_ONLY.has(check.id));
}

export interface RunnerCliHost {
  /** Start the core in the foreground as a runner (index.ts owns the listener and its shutdown). */
  serve(values: Record<string, unknown>): Promise<void>;
  /** Where the output goes; the terminal unless a test collects it. */
  print?(line: string): void;
}

interface CommandContext {
  values: Record<string, string | boolean | undefined>;
  host: RunnerCliHost;
  print(line: string): void;
}

export const USAGE = `Usage:
  godmode runner install [--pair <gmo1…>] [--link-port <n>] [--no-service]
                                      Set this computer up as a runner that starts when you log in, and pair it
  godmode runner pair [<gmo1…>]       Show a new pairing code (or send it to the Godmode that made the offer)
  godmode runner serve [--link-port <n>] [--port <n>] [--data-dir <dir>]
                                      Run the runner in the foreground (--port: its loopback API, random by default)
  godmode runner status               Show the service, the link port, paired computers and the health checks
  godmode runner uninstall            Stop and remove the service (your data stays)`;

function dataDirOf(ctx: CommandContext): string {
  const dir = ctx.values["data-dir"];
  return typeof dir === "string" ? resolve(dir) : runnerDataDir();
}

/** The runner's config and database, for the commands that work next to (or without) a serving runner. */
function open(ctx: CommandContext): CoreConfig {
  const cfg = loadConfig({ role: "runner", dataDir: dataDirOf(ctx) });
  openDb(cfg.dbPath);
  return cfg;
}

/** How this Godmode was started: the compiled binary, or bun with the entry script when it runs from source. */
function self(): { binary: string; script: string | null } {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");
  return { binary: process.execPath, script: compiled ? null : Bun.main };
}

/** The runner that came up after `since`; an older runner.json belongs to the instance the service just replaced. */
async function waitForRunner(dataDir: string, since: number): Promise<RunnerProcess | null> {
  for (let waited = 0; waited <= START_TIMEOUT_MS; waited += START_POLL_MS) {
    const runner = runningRunner(dataDir);
    if (runner && Date.parse(runner.startedAt) >= since) return runner;
    await sleep(START_POLL_MS);
  }
  return null;
}

/** `--link-port`: the port Godmode dials (0 = any free one). Undefined when not given, NaN when it isn't a port. */
function linkPortOption(value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(port) && port >= 0 && port < 65536 ? port : Number.NaN;
}

/** The pairing offer of an install command, when one was given. */
function offerOption(ctx: CommandContext, value: string | boolean | undefined): RunnerPairingOfferPayload | null | false {
  if (value === undefined) return null;
  const offer = typeof value === "string" ? parseRunnerOffer(value) : null;
  if (!offer) {
    ctx.print("That pairing offer is damaged — copy the install command from Godmode again.");
    return false;
  }
  return offer;
}

/**
 * The last step of setting a runner up: a pairing code, sent to the Godmode that made the offer when there is one,
 * else shown to be pasted there. The code only works while the runner serves (it is checked by the serving process).
 */
async function pairStep(ctx: CommandContext, offer: RunnerPairingOfferPayload | null, serving: boolean): Promise<number> {
  const { code } = await createRunnerCode();
  if (offer && serving) {
    ctx.print(`Pairing with ${offer.name}…`);
    const result = await deliverCode(offer, code);
    if (result.ok) {
      ctx.print(`Paired with ${result.name ?? offer.name}. It can give this computer work now.`);
      return 0;
    }
    ctx.print(`Couldn't pair automatically: ${result.error ?? "Godmode didn't answer"}`);
  }
  ctx.print("");
  ctx.print("Pairing code (valid for 10 minutes, once):");
  ctx.print("");
  ctx.print(code);
  ctx.print("");
  ctx.print("In Godmode: Runners → Add runner → Enter a pairing code, and paste it there.");
  if (!serving) ctx.print("The code works once the runner is running: godmode runner serve");
  // The runner is set up either way, and the code on screen pairs it: not a failure of the command.
  return 0;
}

async function install(ctx: CommandContext): Promise<number> {
  // `--port` is still understood here, as it was before `--link-port` existed.
  const asked = ctx.values["link-port"] ?? ctx.values.port;
  const parsed = linkPortOption(asked);
  if (parsed !== undefined && (Number.isNaN(parsed) || parsed === 0)) {
    ctx.print(`"${String(asked)}" isn't a port — use a number between 1 and 65535.`);
    return 2;
  }
  const port = parsed ?? null;
  const offer = offerOption(ctx, ctx.values.pair);
  if (offer === false) return 2;
  const cfg = open(ctx);
  // The port Godmode reaches this runner on. One chosen earlier stays unless another is asked for: paired computers dial it.
  if (port !== null || getMeta("link.port") === null) setMeta("link.port", String(port ?? RUNNER_DEFAULT_PORT));

  let serving = false;
  if (ctx.values["no-service"] || !serviceSupported()) {
    ctx.print(`The runner is set up in ${cfg.dataDir}.`);
    ctx.print(serviceSupported() ? "Start it with: godmode runner serve" : "Starting at login is only available on macOS. Start it with: godmode runner serve");
    serving = !!runningRunner(cfg.dataDir);
  } else {
    const since = Date.now();
    await installService({ ...self(), dataDir: cfg.dataDir });
    const runner = await waitForRunner(cfg.dataDir, since);
    if (!runner) {
      ctx.print(`The service is installed, but the runner didn't start within ${START_TIMEOUT_MS / 1000} seconds. Its log: ${join(cfg.logsDir, "service.log")}`);
      return 1;
    }
    ctx.print(`The runner is running (pid ${runner.pid}) and starts whenever you log in on this Mac.`);
    serving = true;
  }
  return pairStep(ctx, offer, serving);
}

async function pair(ctx: CommandContext, positionals: string[] = []): Promise<number> {
  const offer = offerOption(ctx, positionals[0] ?? (ctx.values.pair as string | undefined));
  if (offer === false) return 2;
  const cfg = open(ctx);
  const serving = !!runningRunner(cfg.dataDir);
  if (!serving) ctx.print("The runner isn't running on this computer right now.");
  return pairStep(ctx, offer, serving);
}

async function serve(ctx: CommandContext): Promise<number> {
  const linkPort = linkPortOption(ctx.values["link-port"]);
  if (linkPort !== undefined && Number.isNaN(linkPort)) {
    ctx.print(`"${String(ctx.values["link-port"])}" isn't a port — use a number between 0 and 65535.`);
    return 2;
  }
  // Only what a runner takes: it has no dashboard to serve and its API never listens beyond loopback.
  await ctx.host.serve({ port: ctx.values.port, "data-dir": ctx.values["data-dir"], "link-port": linkPort });
  return 0;
}

/** Same glyphs as `godmode doctor`: ❌ only for what blocks work. */
function healthRow(check: RunnerCheck): string {
  const glyph = check.status === "ok" ? "✅" : check.required && check.status === "fail" ? "❌" : "⚠️ ";
  return `${glyph} ${check.name.padEnd(22)} ${check.detail}${check.fix?.hint ? ` — ${check.fix.hint}` : ""}`;
}

async function status(ctx: CommandContext): Promise<number> {
  const cfg = open(ctx);
  const runner = runningRunner(cfg.dataDir);
  // The checks are the serving runner's to make: what this process is allowed and finds says little about the service.
  const [service, reported] = await Promise.all([serviceStatus(), runner ? askRunner(runner) : null]);
  const checks = reported?.checks ?? (await terminalChecks());
  const linkPort = runner?.linkPort ?? (Number(getMeta("link.port")) || null);

  ctx.print(`Godmode runner ${VERSION} — ${cfg.dataDir}`);
  ctx.print(
    `Service    ${
      !serviceSupported()
        ? "not available on this system"
        : service.loaded
          ? `installed${service.pid ? `, running (pid ${service.pid})` : ", not running"}`
          : service.installed
            ? "installed, but not loaded — run `godmode runner install` again"
            : "not installed"
    }`,
  );
  ctx.print(`Runner     ${runner ? `running (pid ${runner.pid}) since ${runner.startedAt}` : "not running"}`);
  ctx.print(`Link port  ${linkPort ?? "not set — run `godmode runner install`"}`);
  const controllers = all<{ name: string; last_seen_at: string | null }>("SELECT name, last_seen_at FROM link_controllers ORDER BY created_at");
  ctx.print(
    `Paired     ${
      controllers.length
        ? controllers.map((c) => `${c.name}${c.last_seen_at ? ` (last connected ${c.last_seen_at})` : ""}`).join(", ")
        : "nothing yet — run `godmode runner pair`"
    }`,
  );
  ctx.print("");
  if (!reported) {
    ctx.print(
      `The runner ${runner ? "didn't answer" : "isn't running"}, so these checks were made from this terminal. ` +
        "Permissions, the desktop session and keep-awake are the runner's own to check, so they are left out.",
    );
  }
  for (const check of checks) ctx.print(healthRow(check));
  return checks.some((check) => check.required && check.status === "fail") ? 1 : 0;
}

async function uninstall(ctx: CommandContext): Promise<number> {
  const removed = await uninstallService();
  ctx.print(removed ? "The runner service is stopped and removed." : "There was no runner service to remove.");
  ctx.print(`Your runner's data stays in ${dataDirOf(ctx)} — delete that folder to remove it for good.`);
  return 0;
}

const commands: Record<string, (ctx: CommandContext, positionals: string[]) => Promise<number>> = { install, pair, serve, status, uninstall };

/** Runs `godmode runner <argv…>` and resolves with the exit code. `serve` resolves once the runner listens. */
export async function runRunnerCli(argv: string[], host: RunnerCliHost): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      "link-port": { type: "string" },
      pair: { type: "string" },
      "data-dir": { type: "string" },
      "no-service": { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });
  const print = host.print ?? ((line: string) => console.log(line));
  const name = positionals[0] ?? "";
  if (!Object.hasOwn(commands, name)) {
    print(name ? `Unknown command: runner ${name}\n\n${USAGE}` : USAGE);
    return 2;
  }
  return commands[name]!({ values, host, print }, positionals.slice(1));
}
