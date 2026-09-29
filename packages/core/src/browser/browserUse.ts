/**
 * browser-use MCP server wiring: command line, environment and the `config.json` that points
 * browser-use at Godmode's managed Chromium over CDP instead of letting it launch its own browser.
 *
 * browser-use 0.13.x reads `$BROWSER_USE_CONFIG_DIR/config.json` in its "DB-style" format:
 * `{ browser_profile: { <uuid>: {...} }, llm: {...}, agent: {...} }` — all three keys must be objects and
 * every profile entry needs an `id`, otherwise browser-use discards the file and writes a fresh default.
 * The default profile's fields are passed to `BrowserProfile(...)`; with `cdp_url` set it connects to
 * that browser (and only ever kills processes it launched itself).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { which } from "../util";

export const BROWSER_USE_VERSION = "0.13.10";
export const BROWSER_USE_SPEC = `browser-use==${BROWSER_USE_VERSION}`;

/** Split a command line into argv (supports single/double quotes and backslash escapes outside single quotes). */
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && (input[i + 1] === '"' || input[i + 1] === "\\")) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) out.push(cur);
      cur = "";
      hasToken = false;
    } else if (ch === "\\" && process.platform !== "win32" && i + 1 < input.length) {
      cur += input[++i];
      hasToken = true;
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (hasToken) out.push(cur);
  return out;
}

/**
 * The browser-use MCP command: `settings.browser.browserUseCommand` when set, otherwise
 * `uvx --from browser-use==<pinned> browser-use --mcp`. Returns null when uvx is unavailable.
 */
export function browserUseCommand(custom: string, uvx: string | null): { command: string; args: string[] } | null {
  const parts = custom.trim() ? splitCommand(custom.trim()) : [];
  if (parts.length > 0) {
    let command = parts[0]!;
    if (command === "uvx" && uvx) command = uvx;
    else if (!isAbsolute(command)) command = which(command) ?? command;
    return { command, args: parts.slice(1) };
  }
  if (!uvx) return null;
  return { command: uvx, args: ["--from", BROWSER_USE_SPEC, "browser-use", "--mcp"] };
}

export interface BrowserUseConfigInput {
  configDir: string;
  cdpUrl: string;
  headless: boolean;
  /** Only used if browser-use ever has to launch a browser itself (e.g. after a crash). */
  userDataDir: string;
  downloadsPath: string;
  /** Where browser-use's MCP file system (extracted content) lives. */
  fileSystemPath: string;
}

interface ConfigShape {
  browser_profile: Record<string, Record<string, unknown>>;
  llm: Record<string, Record<string, unknown>>;
  agent: Record<string, Record<string, unknown>>;
}

/** The `config.json` content: one default profile that connects to the browser at `cdpUrl`. */
export function browserUseConfig(input: BrowserUseConfigInput, profileId: string, createdAt: string): ConfigShape {
  return {
    browser_profile: {
      [profileId]: {
        id: profileId,
        default: true,
        created_at: createdAt,
        cdp_url: input.cdpUrl,
        headless: input.headless,
        // browser-use copies any user_data_dir whose path contains "chrome" into a temp dir on every start;
        // never hand it such a path.
        user_data_dir: /chrome/i.test(input.userDataDir) ? join(input.configDir, "user-data") : input.userDataDir,
        downloads_path: input.downloadsPath,
        file_system_path: input.fileSystemPath,
        keep_alive: true,
      },
    },
    llm: {},
    agent: {},
  };
}

/** Write `<configDir>/config.json` (0600, atomically); keeps entry ids stable across rewrites. */
export function writeBrowserUseConfig(input: BrowserUseConfigInput): string {
  mkdirSync(input.configDir, { recursive: true, mode: 0o700 });
  mkdirSync(input.downloadsPath, { recursive: true });
  mkdirSync(input.fileSystemPath, { recursive: true });
  const path = join(input.configDir, "config.json");

  let profileId: string = randomUUID();
  let createdAt = new Date().toISOString();
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, "utf8")) as Partial<ConfigShape>;
      const entry = Object.values(prev.browser_profile ?? {})[0];
      if (entry && typeof entry.id === "string") {
        profileId = entry.id;
        if (typeof entry.created_at === "string") createdAt = entry.created_at;
      }
    } catch {
      /* rewrite */
    }
  }

  const config = browserUseConfig(input, profileId, createdAt);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Variables the MCP child needs even when the parent passes a minimal environment. */
const PASSTHROUGH_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "UV_CACHE_DIR",
  "UV_TOOL_DIR",
  "UV_PYTHON_INSTALL_DIR",
  "SSL_CERT_FILE",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
];

export function browserUseEnv(configDir: string, path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  return {
    ...env,
    PATH: path,
    BROWSER_USE_CONFIG_DIR: configDir,
    ANONYMIZED_TELEMETRY: "false",
    BROWSER_USE_CLOUD_SYNC: "false",
    BROWSER_USE_VERSION_CHECK: "false",
    BROWSER_USE_LOGGING_LEVEL: "warning",
  };
}
