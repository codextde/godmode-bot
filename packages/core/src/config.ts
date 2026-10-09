import { homedir, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";
import { DEFAULT_PORT } from "@godmode/shared";

export const VERSION = "0.2.0";
/** The commit a compiled core was built from (scripts/build.ts); "dev" when it runs from source. */
export const BUILD = process.env.GODMODE_BUILD || "dev";
/** A `bun build --compile` binary (release app sidecar, server binary, Docker image), not the sources. */
export const COMPILED = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");

export type RunMode = "desktop" | "server";

export interface CoreConfig {
  version: string;
  mode: RunMode;
  /** `main`: the Godmode the human uses · `runner`: a headless core on another computer that works for a main one. */
  role: "main" | "runner";
  dev: boolean;
  dataDir: string;
  dbPath: string;
  agentsDir: string;
  browserDir: string;
  attachmentsDir: string;
  backupsDir: string;
  /** macOS VMs: Tart's home (disks, image cache), shared folders and Godmode's copy of Tart. */
  vmDir: string;
  /** Checkouts of coding tasks: tasks/<task id>. */
  tasksDir: string;
  logsDir: string;
  host: string;
  port: number;
  /** Static UI directory to serve (server/dashboard mode). null = don't serve UI. */
  uiDir: string | null;
  /** Access token given by the desktop shell (or generated for server mode). */
  token: string | null;
  platform: NodeJS.Platform;
  arch: string;
}

/** Where a runner keeps its data unless told otherwise. */
export function defaultRunnerDataDir(): string {
  return join(homedir(), ".godmode-runner");
}

/** A runner has a data dir of its own, so it never shares a database with a Godmode app on the same computer. */
export function runnerDataDir(): string {
  if (process.env.GODMODE_RUNNER_HOME) return resolve(process.env.GODMODE_RUNNER_HOME);
  return defaultRunnerDataDir();
}

function defaultDataDir(role: CoreConfig["role"]): string {
  if (role === "runner") return runnerDataDir();
  if (process.env.GODMODE_HOME) return resolve(process.env.GODMODE_HOME);
  return join(homedir(), ".godmode");
}

export function ensureDir(path: string, mode = 0o700): string {
  mkdirSync(path, { recursive: true, mode });
  try {
    if (process.platform !== "win32") chmodSync(path, mode);
  } catch {
    /* ignore */
  }
  return path;
}

let current: CoreConfig | null = null;

export function loadConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  const role = overrides.role ?? (process.env.GODMODE_ROLE === "runner" ? "runner" : "main");
  const dataDir = overrides.dataDir ?? defaultDataDir(role);
  const cfg: CoreConfig = {
    version: VERSION,
    mode: (process.env.GODMODE_MODE as RunMode) || "server",
    role,
    dev: process.env.GODMODE_DEV === "1",
    dataDir,
    dbPath: join(dataDir, "godmode.db"),
    agentsDir: join(dataDir, "agents"),
    browserDir: join(dataDir, "browser"),
    attachmentsDir: join(dataDir, "attachments"),
    backupsDir: join(dataDir, "backups"),
    vmDir: join(dataDir, "vm"),
    tasksDir: join(dataDir, "tasks"),
    logsDir: join(dataDir, "logs"),
    host: process.env.GODMODE_HOST || "127.0.0.1",
    port: Number(process.env.GODMODE_PORT || DEFAULT_PORT),
    uiDir: process.env.GODMODE_UI_DIR || null,
    token: process.env.GODMODE_TOKEN || null,
    platform: platform(),
    arch: arch(),
    ...overrides,
  };
  for (const dir of [cfg.dataDir, cfg.agentsDir, cfg.browserDir, cfg.attachmentsDir, cfg.backupsDir, cfg.logsDir]) {
    ensureDir(dir);
  }
  current = cfg;
  return cfg;
}

export function config(): CoreConfig {
  if (!current) throw new Error("config not loaded");
  return current;
}

/** argv that starts this Godmode again: the compiled binary, or bun with the entry script when it runs from source. */
export function selfCommand(): string[] {
  return COMPILED ? [process.execPath] : [process.execPath, Bun.main];
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
