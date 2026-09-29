import { homedir, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";
import { DEFAULT_PORT } from "@godmode/shared";

export const VERSION = "0.1.0";

export type RunMode = "desktop" | "server";

export interface CoreConfig {
  version: string;
  mode: RunMode;
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

function defaultDataDir(): string {
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
  const dataDir = overrides.dataDir ?? defaultDataDir();
  const cfg: CoreConfig = {
    version: VERSION,
    mode: (process.env.GODMODE_MODE as RunMode) || "server",
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

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
