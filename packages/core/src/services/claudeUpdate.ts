/**
 * Claude Code update check + one-click `claude update`.
 *
 * The latest version comes from the same release feed the official installer uses, on the channel Claude Code itself
 * follows (`autoUpdatesChannel`), so we never offer a version `claude update` would refuse to install.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeReleaseChannel, ClaudeUpdateResult, ClaudeUpdateStatus } from "@godmode/shared";
import { logger } from "../log";
import { childEnv, now } from "../util";
import { resetDoctorCache, resolveClaudeBinary, runCommand, stripAnsi, toolPath, versionFrom } from "./doctor";

const log = logger("claude-update");

export const CLAUDE_RELEASES_URL = "https://downloads.claude.ai/claude-code-releases";
const LATEST_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;

/** Numeric semver compare; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const [coreA = "", preA] = a.split("-", 2);
  const [coreB = "", preB] = b.split("-", 2);
  const pa = coreA.split(".").map(Number);
  const pb = coreB.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  if (!preA === !preB) return 0;
  return preA ? -1 : 1;
}

export function claudeChannel(): ClaudeReleaseChannel {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  try {
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { autoUpdatesChannel?: unknown };
    return settings.autoUpdatesChannel === "stable" ? "stable" : "latest";
  } catch {
    return "latest";
  }
}

const latestCache = new Map<ClaudeReleaseChannel, { at: number; version: string }>();

async function latestVersion(channel: ClaudeReleaseChannel, refresh: boolean): Promise<string | null> {
  const cached = latestCache.get(channel);
  if (!refresh && cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.version;
  try {
    const res = await fetch(`${CLAUDE_RELEASES_URL}/${channel}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = res.ok ? (await res.text()).trim() : "";
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(text)) throw new Error(res.ok ? "unexpected response" : `HTTP ${res.status}`);
    latestCache.set(channel, { at: Date.now(), version: text });
    return text;
  } catch (err) {
    log.debug(`latest ${channel} version check failed: ${err instanceof Error ? err.message : String(err)}`);
    return cached?.version ?? null;
  }
}

/** Homebrew, Nix and winget installs only get upgraded by their package manager; `claude update` just prints how. */
export function isPackageManaged(path: string): boolean {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    /* keep the unresolved path */
  }
  return /[\\/](Caskroom|Cellar|WinGet)[\\/]|^\/nix\/store\//i.test(real);
}

async function installedVersion(path: string): Promise<string | null> {
  const res = await runCommand([path, "--version"], { timeoutMs: 20_000, env: childEnv({ PATH: toolPath() }) });
  return res.code === 0 ? versionFrom(res.stdout) : null;
}

export async function claudeUpdateStatus(refresh = false): Promise<ClaudeUpdateStatus> {
  const path = resolveClaudeBinary();
  const current = path ? await installedVersion(path) : null;
  const channel = claudeChannel();
  const latest = current ? await latestVersion(channel, refresh) : null;
  const updateAvailable = !!path && !!current && !!latest && compareVersions(latest, current) > 0 && !isPackageManaged(path);
  return { current, latest, channel, updateAvailable, checkedAt: now() };
}

let updating: Promise<ClaudeUpdateResult> | null = null;

export function updateClaude(): Promise<ClaudeUpdateResult> {
  updating ??= runUpdate().finally(() => {
    updating = null;
  });
  return updating;
}

async function runUpdate(): Promise<ClaudeUpdateResult> {
  const path = resolveClaudeBinary();
  if (!path) return { ok: false, previous: null, version: null, output: "Claude Code CLI not found" };
  const previous = await installedVersion(path);
  log.info(`updating claude (currently ${previous ?? "unknown"})`);
  const res = await runCommand([path, "update"], { timeoutMs: UPDATE_TIMEOUT_MS, env: childEnv({ PATH: toolPath() }), maxOutput: 20_000 });
  resetDoctorCache();
  const version = await installedVersion(resolveClaudeBinary() ?? path);
  const latest = await latestVersion(claudeChannel(), true);
  const upgraded = !!version && !!previous && compareVersions(version, previous) > 0;
  const current = !!version && !!latest && compareVersions(version, latest) >= 0;
  const ok = upgraded || current;
  const output = stripAnsi(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`).trim();
  if (!ok) log.warn(`claude update did not upgrade (exit ${res.code}${res.timedOut ? ", timed out" : ""})`);
  else log.info(`claude is now ${version}`);
  return {
    ok,
    previous,
    version,
    output: res.timedOut ? `${output}\n\nTimed out after ${UPDATE_TIMEOUT_MS / 60_000} minutes.`.trim() : output,
  };
}
