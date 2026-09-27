/**
 * Dependency detection + one-click install (claude CLI, uv/uvx, browser-use, Chrome, git).
 *
 * The desktop sidecar often starts with a minimal PATH (GUI apps on macOS get /usr/bin:/bin:…), so every
 * binary is also looked up in the locations its official installer uses.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { CLAUDE_MEM_VERSION, claudeMemStatus, installClaudeMem } from "../memory/claudeMem";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { DependencyId, DependencyStatus, DoctorReport } from "@godmode/shared";
import { getSettings } from "./settings";
import { hasAppSecret } from "../vault/vault";
import { logger } from "../log";
import { which } from "../util";
import { findChrome } from "../browser/chrome";
import { BROWSER_USE_SPEC, BROWSER_USE_VERSION } from "../browser/browserUse";

const log = logger("doctor");

const REPORT_TTL_MS = 5 * 60_000;
const BROWSER_USE_CHECK_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

const isWin = () => process.platform === "win32";
const exe = (name: string) => (isWin() ? `${name}.exe` : name);

/* ------------------------------------------------------------------ */
/* Process helper                                                       */
/* ------------------------------------------------------------------ */

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Run a command without a shell; never throws (spawn failures come back as code null). */
export async function runCommand(
  argv: string[],
  opts: { timeoutMs?: number; env?: Record<string, string | undefined>; cwd?: string; maxOutput?: number } = {},
): Promise<CommandResult> {
  const maxOutput = opts.maxOutput ?? 200_000;
  let finalArgv = argv;
  // .cmd/.bat shims (npm globals on Windows) must go through cmd.exe.
  if (isWin() && /\.(cmd|bat)$/i.test(argv[0] ?? "")) finalArgv = ["cmd.exe", "/d", "/c", ...argv];
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(finalArgv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: (opts.env ?? process.env) as Record<string, string>,
      cwd: opts.cwd,
      windowsHide: true,
    } as Parameters<typeof Bun.spawn>[1]);
  } catch (err) {
    return { code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false };
  }
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, opts.timeoutMs)
    : null;
  const read = async (stream: ReadableStream<Uint8Array> | number | undefined | null) => {
    if (!stream || typeof stream === "number") return "";
    let out = "";
    const decoder = new TextDecoder();
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
        if (out.length > maxOutput * 2) out = out.slice(-maxOutput);
      }
    } catch {
      /* stream closed */
    }
    return out.slice(-maxOutput);
  };
  const [stdout, stderr, code] = await Promise.all([
    read(proc.stdout as ReadableStream<Uint8Array>),
    read(proc.stderr as ReadableStream<Uint8Array>),
    proc.exited.catch(() => null),
  ]);
  if (timer) clearTimeout(timer);
  return { code: timedOut ? null : code, stdout, stderr, timedOut };
}

/* ------------------------------------------------------------------ */
/* Binary resolution                                                    */
/* ------------------------------------------------------------------ */

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function firstExisting(paths: (string | null | undefined)[]): string | null {
  for (const p of paths) if (p && isFile(p)) return p;
  return null;
}

function settingsOrNull() {
  try {
    return getSettings();
  } catch {
    return null;
  }
}

/** Absolute path to the claude CLI (settings.runner.claudePath or auto-detected), or null. */
export function resolveClaudeBinary(): string | null {
  const home = homedir();
  const custom = settingsOrNull()?.runner.claudePath?.trim();
  if (custom) {
    const found = firstExisting([custom]) ?? which(custom);
    if (found) return found;
    log.warn(`configured claude path not found: ${custom}`);
  }
  const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
  return firstExisting([
    which("claude"),
    join(home, ".local", "bin", exe("claude")),
    join(home, ".claude", "local", exe("claude")),
    ...(isWin()
      ? [join(appData, "npm", "claude.cmd"), join(home, ".bun", "bin", "claude.exe")]
      : [
          join(home, ".npm-global", "bin", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
          join(home, ".bun", "bin", "claude"),
          join(home, ".volta", "bin", "claude"),
          "/usr/bin/claude",
        ]),
  ]);
}

/** Absolute path to uvx (for browser-use), or null. */
export function resolveUvx(): string | null {
  const home = homedir();
  const profile = process.env.USERPROFILE || home;
  return firstExisting([
    which("uvx"),
    join(home, ".local", "bin", exe("uvx")),
    join(home, ".cargo", "bin", exe("uvx")),
    ...(isWin()
      ? [join(profile, ".local", "bin", "uvx.exe"), join(profile, ".cargo", "bin", "uvx.exe")]
      : ["/opt/homebrew/bin/uvx", "/usr/local/bin/uvx", "/usr/bin/uvx"]),
  ]);
}

/** Absolute path to a Chromium-family browser executable, or null. */
export function resolveChrome(): string | null {
  return findChrome(settingsOrNull()?.browser.chromePath ?? "")?.path ?? null;
}

function resolveGit(): string | null {
  return firstExisting([
    which("git"),
    ...(isWin()
      ? [join(process.env.ProgramFiles || "C:\\Program Files", "Git", "cmd", "git.exe")]
      : ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]),
  ]);
}

/** PATH with the install locations of our tools prepended (for spawned installers and MCP servers). */
export function toolPath(): string {
  const home = homedir();
  const dirs = [
    ...[resolveUvx(), resolveClaudeBinary()].filter((p): p is string => !!p).map((p) => dirname(p)),
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    ...(isWin() ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]),
    ...(process.env.PATH ?? process.env.Path ?? "").split(delimiter),
  ];
  return [...new Set(dirs.filter(Boolean))].join(delimiter);
}

function versionFrom(text: string): string | null {
  return text.match(/\d+\.\d+(?:\.\d+)*/)?.[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Checks                                                               */
/* ------------------------------------------------------------------ */

type Check = Omit<DependencyStatus, "required" | "installable" | "installHint">;

async function checkClaude(): Promise<Check> {
  const path = resolveClaudeBinary();
  if (!path) return { id: "claude", name: "Claude Code CLI", ok: false, version: null, path: null, detail: "claude CLI not found" };
  const res = await runCommand([path, "--version"], { timeoutMs: 20_000, env: { ...process.env, PATH: toolPath() } });
  const version = versionFrom(res.stdout);
  if (res.code !== 0 || !version) {
    return { id: "claude", name: "Claude Code CLI", ok: false, version: null, path, detail: `claude --version failed: ${stripAnsi(res.stderr).trim().slice(0, 300) || "no output"}` };
  }
  return { id: "claude", name: "Claude Code CLI", ok: true, version, path, detail: stripAnsi(res.stdout).trim() };
}

async function keychainHasClaudeCredentials(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  // Without -w the password is not printed; the exit code tells whether the item exists.
  const res = await runCommand(["/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials"], { timeoutMs: 10_000 });
  return res.code === 0;
}

function hasStoredAnthropicKey(): boolean {
  try {
    return hasAppSecret("anthropic_api_key");
  } catch {
    return false;
  }
}

async function checkClaudeAuth(claudePath: string | null): Promise<Check> {
  const base = { id: "claude-auth" as const, name: "Claude login", version: null, path: null };
  const apiKey = hasStoredAnthropicKey() || !!process.env.ANTHROPIC_API_KEY;
  if (claudePath) {
    const res = await runCommand([claudePath, "auth", "status", "--json"], { timeoutMs: 20_000, env: { ...process.env, PATH: toolPath() } });
    try {
      const status = JSON.parse(res.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      if (typeof status.loggedIn === "boolean") {
        if (status.loggedIn) {
          const how = [status.authMethod, status.subscriptionType].filter(Boolean).join(", ");
          return { ...base, ok: true, detail: `Logged in${how ? ` (${how})` : ""}` };
        }
        if (apiKey) return { ...base, ok: true, detail: "Using an Anthropic API key" };
        return { ...base, ok: false, detail: "Claude Code is not logged in" };
      }
    } catch {
      /* older CLI without `auth status` — fall back to heuristics */
    }
  }
  if (apiKey) return { ...base, ok: true, detail: "Using an Anthropic API key" };
  if (existsSync(join(homedir(), ".claude", ".credentials.json"))) return { ...base, ok: true, detail: "Claude Code credentials found" };
  if (await keychainHasClaudeCredentials()) return { ...base, ok: true, detail: "Claude Code credentials found in the macOS keychain" };
  return { ...base, ok: false, detail: "No Claude login or Anthropic API key found" };
}

async function checkUv(): Promise<Check> {
  const path = resolveUvx();
  if (!path) return { id: "uv", name: "uv (uvx)", ok: false, version: null, path: null, detail: "uvx not found" };
  const res = await runCommand([path, "--version"], { timeoutMs: 20_000 });
  const version = versionFrom(res.stdout);
  if (res.code !== 0) return { id: "uv", name: "uv (uvx)", ok: false, version: null, path, detail: `uvx --version failed: ${stripAnsi(res.stderr).trim().slice(0, 300)}` };
  return { id: "uv", name: "uv (uvx)", ok: true, version, path, detail: stripAnsi(res.stdout).trim() };
}

let browserUseCache: { at: number; uvx: string; check: Check } | null = null;

async function checkBrowserUse(uvx: string | null, refresh: boolean): Promise<Check> {
  const base = { id: "browser-use" as const, name: "browser-use", path: null };
  if (!uvx) return { ...base, ok: false, version: null, detail: "Requires uv (uvx)" };
  if (!refresh && browserUseCache && browserUseCache.uvx === uvx && Date.now() - browserUseCache.at < 30 * 60_000) return browserUseCache.check;
  // --offline: only report what is already downloaded; never install as a side effect of a check.
  const res = await runCommand([uvx, "--offline", "--from", BROWSER_USE_SPEC, "browser-use", "--version"], {
    timeoutMs: BROWSER_USE_CHECK_TIMEOUT_MS,
    env: { ...process.env, PATH: toolPath(), ANONYMIZED_TELEMETRY: "false", BROWSER_USE_VERSION_CHECK: "false" },
  });
  let check: Check;
  if (res.code === 0) {
    check = { ...base, ok: true, version: BROWSER_USE_VERSION, detail: `${BROWSER_USE_SPEC} is ready (MCP server via uvx)` };
  } else if (res.timedOut) {
    check = { ...base, ok: false, version: null, detail: "Timed out checking browser-use" };
  } else {
    const err = stripAnsi(res.stderr);
    check = {
      ...base,
      ok: false,
      version: null,
      detail: /network was disabled|offline|not found in the cache|No solution found/i.test(err)
        ? `${BROWSER_USE_SPEC} is not downloaded yet`
        : `browser-use failed: ${err.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`,
    };
  }
  browserUseCache = { at: Date.now(), uvx, check };
  return check;
}

function chromeVersion(path: string): Promise<string | null> | string | null {
  if (process.platform === "darwin") {
    // …/X.app/Contents/MacOS/X → …/X.app/Contents/Info.plist (no process spawn needed).
    try {
      const plist = readFileSync(join(dirname(dirname(path)), "Info.plist"), "utf8");
      return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
    } catch {
      return null;
    }
  }
  if (isWin()) {
    // chrome.exe --version opens a window on Windows; the install dir has a folder named after the version.
    try {
      return readdirSync(dirname(path)).find((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)) ?? null;
    } catch {
      return null;
    }
  }
  return runCommand([path, "--version"], { timeoutMs: 15_000 }).then((r) => (r.code === 0 ? versionFrom(r.stdout) : null));
}

async function checkChrome(): Promise<Check> {
  const found = findChrome(settingsOrNull()?.browser.chromePath ?? "");
  if (!found) return { id: "chrome", name: "Chrome / Chromium", ok: false, version: null, path: null, detail: "No Chromium-based browser found" };
  const version = await chromeVersion(found.path);
  return { id: "chrome", name: "Chrome / Chromium", ok: true, version, path: found.path, detail: found.browser };
}

async function checkGit(): Promise<Check> {
  const path = resolveGit();
  const missing = { id: "git" as const, name: "git", ok: false, version: null, path: null, detail: "git not found" };
  if (!path) return missing;
  if (process.platform === "darwin" && path === "/usr/bin/git") {
    // /usr/bin/git is a shim that pops up the Command Line Tools installer when they're missing.
    const clt = await runCommand(["/usr/bin/xcode-select", "-p"], { timeoutMs: 10_000 });
    if (clt.code !== 0) return { ...missing, detail: "Xcode Command Line Tools are not installed" };
  }
  const res = await runCommand([path, "--version"], { timeoutMs: 15_000 });
  if (res.code !== 0) return { ...missing, path, detail: "git --version failed" };
  return { id: "git", name: "git", ok: true, version: versionFrom(res.stdout), path, detail: stripAnsi(res.stdout).trim() };
}

function checkClaudeMem(): Check {
  const s = claudeMemStatus();
  if (s.installed) return { id: "claude-mem", name: "claude-mem (memory)", ok: true, version: s.version, path: s.path, detail: "Optional memory backend" };
  return {
    id: "claude-mem",
    name: "claude-mem (memory)",
    ok: false,
    version: null,
    path: null,
    detail: s.nodeAvailable ? "Not installed — optional memory backend" : "Needs Node.js 20+ — optional memory backend",
  };
}

function installHint(id: DependencyId): string {
  const win = isWin();
  switch (id) {
    case "claude":
      return win ? "Run in PowerShell: irm https://claude.ai/install.ps1 | iex" : "Run: curl -fsSL https://claude.ai/install.sh | bash";
    case "claude-auth":
      return "Open a terminal and run `claude` once to log in, or add an Anthropic API key in Settings → Integrations.";
    case "uv":
      return win
        ? 'Run: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
        : "Run: curl -LsSf https://astral.sh/uv/install.sh | sh";
    case "browser-use":
      return `Install uv first, then run: uvx --from ${BROWSER_USE_SPEC} browser-use --version`;
    case "chrome":
      return "Install Google Chrome, or install Playwright's Chromium: uvx playwright install chromium --no-shell";
    case "git":
      return process.platform === "darwin" ? "Run: xcode-select --install" : win ? "Install Git for Windows from https://git-scm.com" : "Install git with your package manager";
    case "claude-mem":
      return `Optional. Godmode downloads claude-mem ${CLAUDE_MEM_VERSION} from npm (needs Node.js 20+); then pick it in Settings → Memory.`;
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                               */
/* ------------------------------------------------------------------ */

let cachedReport: { at: number; report: DoctorReport } | null = null;
let inflight: Promise<DoctorReport> | null = null;

export async function runDoctor(refresh = false): Promise<DoctorReport> {
  if (!refresh && cachedReport && Date.now() - cachedReport.at < REPORT_TTL_MS) return cachedReport.report;
  if (inflight) return inflight;
  inflight = buildReport(refresh).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function buildReport(refresh: boolean): Promise<DoctorReport> {
  const browserEnabled = settingsOrNull()?.browser.enabled ?? true;
  const claudePath = resolveClaudeBinary();
  const uvx = resolveUvx();
  const checks = await Promise.all([checkClaude(), checkClaudeAuth(claudePath), checkUv(), checkBrowserUse(uvx, refresh), checkChrome(), checkGit(), checkClaudeMem()]);
  const required: Record<DependencyId, boolean> = {
    claude: true,
    "claude-auth": true,
    uv: browserEnabled,
    "browser-use": browserEnabled,
    chrome: browserEnabled,
    git: false,
    "claude-mem": settingsOrNull()?.memory.backend === "claude-mem",
  };
  const installable: Record<DependencyId, boolean> = {
    claude: true,
    "claude-auth": false,
    uv: true,
    "browser-use": !!uvx,
    chrome: !!uvx,
    git: false,
    "claude-mem": claudeMemStatus().nodeAvailable,
  };
  const dependencies: DependencyStatus[] = checks.map((c) => ({ ...c, required: required[c.id], installable: installable[c.id], installHint: installHint(c.id) }));
  const report: DoctorReport = {
    ok: dependencies.every((d) => d.ok || !d.required),
    platform: process.platform,
    arch: process.arch,
    checkedAt: new Date().toISOString(),
    dependencies,
  };
  cachedReport = { at: Date.now(), report };
  return report;
}

/* ------------------------------------------------------------------ */
/* Install                                                              */
/* ------------------------------------------------------------------ */

function installCommand(id: DependencyId): string[] | { error: string } {
  const win = isWin();
  const uvx = resolveUvx();
  switch (id) {
    case "claude":
      return win
        ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"]
        : ["/bin/bash", "-c", "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash"];
    case "uv":
      return win
        ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "ByPass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"]
        : ["/bin/sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"];
    case "browser-use":
      if (!uvx) return { error: "uv is not installed yet. Install uv first." };
      return [uvx, "--from", BROWSER_USE_SPEC, "browser-use", "--version"];
    case "chrome":
      if (!uvx) return { error: "uv is not installed yet. Install uv first." };
      // Same as `browser-use install`, minus `--with-deps` on Linux (which needs sudo and would hang without a TTY).
      return [uvx, "playwright", "install", "chromium", "--no-shell"];
    case "claude-auth":
      return { error: installHint("claude-auth") };
    case "git":
      return { error: installHint("git") };
    case "claude-mem":
      return { error: "handled separately" };
  }
}

export async function installDependency(id: DependencyId): Promise<{ ok: boolean; output: string }> {
  const valid: DependencyId[] = ["claude", "claude-auth", "uv", "browser-use", "chrome", "git", "claude-mem"];
  if (!valid.includes(id)) return { ok: false, output: `Unknown dependency: ${String(id)}` };
  if (id === "claude-mem") {
    const result = await installClaudeMem();
    cachedReport = null;
    return result;
  }
  const cmd = installCommand(id);
  if (!Array.isArray(cmd)) return { ok: false, output: cmd.error };
  log.info(`installing ${id}: ${cmd.join(" ")}`);
  const res = await runCommand(cmd, {
    timeoutMs: INSTALL_TIMEOUT_MS,
    env: { ...process.env, PATH: toolPath(), ANONYMIZED_TELEMETRY: "false", BROWSER_USE_VERSION_CHECK: "false", CI: "1" },
    maxOutput: 20_000,
  });
  cachedReport = null;
  if (id === "browser-use" || id === "uv") browserUseCache = null;
  const output = stripAnsi(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`).trim();
  if (res.timedOut) return { ok: false, output: `${output}\n\nTimed out after ${INSTALL_TIMEOUT_MS / 60_000} minutes.`.trim() };
  if (res.code !== 0) log.warn(`install ${id} failed (exit ${res.code})`);
  return { ok: res.code === 0, output: output || (res.code === 0 ? "Done." : `Failed with exit code ${res.code}`) };
}
