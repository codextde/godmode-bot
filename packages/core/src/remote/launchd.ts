/**
 * The runner as a macOS LaunchAgent: it starts when the human logs in and comes back when it crashes. An agent of the
 * desktop session rather than a daemon, because browsers and screen control need that session.
 *
 * Everything that touches the machine (launchctl, the LaunchAgents folder) goes through `deps`, so tests never do.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultRunnerDataDir } from "../config";
import { logger } from "../log";
import { runCommand } from "../services/doctor";
import { sleep } from "../util";

const log = logger("launchd");

export const SERVICE_LABEL = "dev.codext.godmode.runner";
const LAUNCHCTL = "/bin/launchctl";
/** How long a removed service may take to disappear before the new one is loaded anyway. */
const UNLOAD_POLLS = 20;
const UNLOAD_POLL_MS = 250;

export interface ServiceOptions {
  /** The executable the service runs: the godmode binary, or bun when Godmode runs from source. */
  binary: string;
  /** Entry script, only when Godmode runs from source (`bun <script> runner serve`). */
  script?: string | null;
  /** The runner's data dir; its logs folder gets service.log. */
  dataDir: string;
}

export interface ServiceStatus {
  /** The service definition is in place. */
  installed: boolean;
  /** launchd knows the service (it starts at login and is kept alive). */
  loaded: boolean;
  pid: number | null;
  binary: string | null;
}

export interface LaunchdDeps {
  platform: NodeJS.Platform;
  exec(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** ~/Library/LaunchAgents */
  agentsDir: string;
  uid: number;
  sleep(ms: number): Promise<unknown>;
}

const defaults: LaunchdDeps = {
  platform: process.platform,
  exec: (argv) => runCommand(argv, { timeoutMs: 30_000 }),
  agentsDir: join(homedir(), "Library", "LaunchAgents"),
  uid: process.getuid?.() ?? 0,
  sleep,
};
let deps = defaults;

/** Replace launchctl and the LaunchAgents folder (tests); null restores the real ones. */
export function setLaunchdDeps(overrides: Partial<LaunchdDeps> | null) {
  deps = overrides ? { ...defaults, ...overrides } : defaults;
}

const domain = () => `gui/${deps.uid}`;
const target = () => `${domain()}/${SERVICE_LABEL}`;

/** launchd is macOS; elsewhere the runner is started by hand (`godmode runner serve`). */
export function serviceSupported(): boolean {
  return deps.platform === "darwin";
}

export function plistPath(): string {
  return join(deps.agentsDir, `${SERVICE_LABEL}.plist`);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const str = (value: string) => `<string>${escapeXml(value)}</string>`;

/** The service definition. `runnerHome`: the data dir when it isn't the default one (the service gets it as GODMODE_RUNNER_HOME). */
export function renderPlist(opts: ServiceOptions & { runnerHome?: string | null }): string {
  const logFile = join(opts.dataDir, "logs", "service.log");
  const program = [opts.binary, ...(opts.script ? [opts.script] : []), "runner", "serve"];
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `\t<key>Label</key>`,
    `\t${str(SERVICE_LABEL)}`,
    `\t<key>ProgramArguments</key>`,
    `\t<array>`,
    ...program.map((arg) => `\t\t${str(arg)}`),
    `\t</array>`,
    `\t<key>RunAtLoad</key>`,
    `\t<true/>`,
    // Back after a crash, but not after a clean stop (uninstall, an update that replaces the service).
    `\t<key>KeepAlive</key>`,
    `\t<dict>`,
    `\t\t<key>SuccessfulExit</key>`,
    `\t\t<false/>`,
    `\t</dict>`,
    `\t<key>ProcessType</key>`,
    `\t<string>Interactive</string>`,
    // Only in the desktop session: agents need its browser and screen.
    `\t<key>LimitLoadToSessionType</key>`,
    `\t<string>Aqua</string>`,
    ...(opts.runnerHome
      ? [`\t<key>EnvironmentVariables</key>`, `\t<dict>`, `\t\t<key>GODMODE_RUNNER_HOME</key>`, `\t\t${str(opts.runnerHome)}`, `\t</dict>`]
      : []),
    `\t<key>StandardOutPath</key>`,
    `\t${str(logFile)}`,
    `\t<key>StandardErrorPath</key>`,
    `\t${str(logFile)}`,
    `</dict>`,
    `</plist>`,
  ];
  return lines.join("\n") + "\n";
}

function reason(res: { code: number | null; stdout: string; stderr: string }): string {
  return (res.stderr.trim() || res.stdout.trim() || `exit code ${res.code}`).split("\n").slice(-3).join(" ");
}

function assertMac() {
  if (!serviceSupported()) throw new Error("The runner service is only available on macOS — start it with `godmode runner serve`.");
}

async function loaded(): Promise<{ loaded: boolean; pid: number | null }> {
  const res = await deps.exec([LAUNCHCTL, "print", target()]);
  if (res.code !== 0) return { loaded: false, pid: null };
  return { loaded: true, pid: Number(res.stdout.match(/^\s*pid = (\d+)/m)?.[1]) || null };
}

/**
 * Stop the service and take it out of launchd. Resolves once it is gone: loading a service right after removing it
 * fails while the old instance is still being torn down.
 */
async function unload(): Promise<boolean> {
  if (!(await loaded()).loaded) return false;
  const res = await deps.exec([LAUNCHCTL, "bootout", target()]);
  if (res.code !== 0 && existsSync(plistPath())) await deps.exec([LAUNCHCTL, "unload", plistPath()]);
  for (let i = 0; i < UNLOAD_POLLS && (await loaded()).loaded; i++) await deps.sleep(UNLOAD_POLL_MS);
  return true;
}

/** Write the service definition and start it; a service that is already there is replaced and restarted. */
export async function installService(opts: ServiceOptions): Promise<void> {
  assertMac();
  mkdirSync(deps.agentsDir, { recursive: true });
  mkdirSync(join(opts.dataDir, "logs"), { recursive: true, mode: 0o700 });
  // launchd reads a definition only when the service is loaded, so the old one has to go first.
  await unload();
  const path = plistPath();
  writeFileSync(path, renderPlist({ ...opts, runnerHome: opts.dataDir === defaultRunnerDataDir() ? null : opts.dataDir }), { mode: 0o644 });
  // An earlier `unload -w` leaves the label disabled, and a disabled service refuses to load.
  await deps.exec([LAUNCHCTL, "enable", target()]);
  const res = await deps.exec([LAUNCHCTL, "bootstrap", domain(), path]);
  if (res.code === 0) return;
  log.warn(`launchctl bootstrap failed (${reason(res)}), trying load -w`);
  const legacy = await deps.exec([LAUNCHCTL, "load", "-w", path]);
  if (legacy.code !== 0) throw new Error(`macOS didn't accept the runner service: ${reason(legacy)}`);
}

/** Stop the service and delete its definition. False when there was nothing to remove. */
export async function uninstallService(): Promise<boolean> {
  if (!serviceSupported()) return false;
  const wasLoaded = await unload();
  const path = plistPath();
  const existed = existsSync(path);
  rmSync(path, { force: true });
  return wasLoaded || existed;
}

export async function serviceStatus(): Promise<ServiceStatus> {
  if (!serviceSupported()) return { installed: false, loaded: false, pid: null, binary: null };
  let installed = false;
  let binary: string | null = null;
  try {
    const plist = readFileSync(plistPath(), "utf8");
    installed = true;
    const first = plist.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)?.[1];
    binary = first ? unescapeXml(first) : null;
  } catch {
    /* not installed */
  }
  return { installed, binary, ...(await loaded()) };
}

/** Stop the running instance and start a fresh one (after the binary was replaced). */
export async function restartService(): Promise<void> {
  assertMac();
  const res = await deps.exec([LAUNCHCTL, "kickstart", "-k", target()]);
  if (res.code === 0) return;
  log.warn(`launchctl kickstart failed (${reason(res)}), reloading the service`);
  const path = plistPath();
  await deps.exec([LAUNCHCTL, "unload", path]);
  const legacy = await deps.exec([LAUNCHCTL, "load", "-w", path]);
  if (legacy.code !== 0) throw new Error(`macOS didn't restart the runner service: ${reason(legacy)}`);
}
