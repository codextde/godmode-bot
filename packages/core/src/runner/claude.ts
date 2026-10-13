/** Resolving and launching the Claude Code CLI (owner: runner). Shared by agent runs and the model catalog. */
import { existsSync } from "node:fs";
import { ZAI_ANTHROPIC_BASE_URL, ZAI_KEY_SECRET } from "@godmode/shared";
import type { Subprocess } from "bun";
import { join } from "node:path";
import { config, ensureDir } from "../config";
import { logger } from "../log";
import { which } from "../util";
import { getAppSecret, isUnlocked } from "../vault/vault";
import { resolveClaudeBinary } from "../services/doctor";
import { getSettings } from "../services/settings";

const log = logger("runner");
const KILL_GRACE_MS = 5000;

/** Environment variables of the parent that must not leak into claude processes. */
const STRIP_ENV = [
  "GODMODE_TOKEN",
  "GODMODE_CONNECT_TOKEN",
  "GODMODE_LICENSE",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
];

let commandOverride: string[] | false | null = null;

/**
 * Tests: run this command (prefix) instead of the resolved claude binary; `false` simulates a missing
 * CLI; `null` restores normal resolution.
 */
export function __setClaudeBinaryForTests(command: string | string[] | false | null) {
  commandOverride = command === null || command === false ? command : Array.isArray(command) ? command : [command];
}

/** argv prefix that starts the claude CLI, or null when it is not installed. */
export function resolveClaudeCommand(): string[] | null {
  if (commandOverride === false) return null;
  if (commandOverride) return commandOverride;
  let bin: string | null;
  try {
    bin = resolveClaudeBinary();
  } catch {
    // Doctor unavailable: honor the configured path, then PATH.
    const configured = getSettings().runner.claudePath.trim();
    bin = configured && existsSync(configured) ? configured : which("claude");
  }
  if (!bin) return null;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) return ["cmd.exe", "/d", "/c", bin];
  return [bin];
}

/** Parent environment minus Godmode/Claude session variables, plus the vault's Anthropic API key. */
export function claudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of STRIP_ENV) delete env[key];
  env.DISABLE_AUTOUPDATER = "1";
  if (isUnlocked()) {
    try {
      const key = getAppSecret("anthropic_api_key");
      if (key) env.ANTHROPIC_API_KEY = key;
    } catch (err) {
      log.warn("could not read the Anthropic API key from the vault", err);
    }
  }
  return env;
}

/** The Z.ai API key from the vault; null when none is saved or the vault is locked. */
export function zaiKey(): string | null {
  if (!isUnlocked()) return null;
  try {
    return getAppSecret(ZAI_KEY_SECRET) || null;
  } catch (err) {
    log.warn("could not read the Z.ai API key from the vault", err);
    return null;
  }
}

/** Other providers and credentials Claude Code would pick up: none of them may reach (or replace) Z.ai. */
const NON_ZAI_ENV = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_CUSTOM_HEADERS",
];

/**
 * Points a run's Claude Code at Z.ai for a GLM model. Every credential Claude Code sends is the Z.ai key (the bearer
 * token and the x-api-key it would otherwise fill from a helper or a stored Console key), other providers are switched
 * off, and every model role (subagents, background calls) resolves to the GLM model. GLM gets a Claude Code config of
 * its own: Claude's login and sessions aren't there, so a chat that switches provider (even mid-pause) can't resume the
 * other one's session and goes on in a new one with a recap.
 */
export function applyZaiEnv(env: Record<string, string | undefined>, model: string, key: string) {
  for (const k of NON_ZAI_ENV) delete env[k];
  env.CLAUDE_CONFIG_DIR = ensureDir(join(config().dataDir, "claude-zai"));
  env.ANTHROPIC_BASE_URL = ZAI_ANTHROPIC_BASE_URL;
  env.ANTHROPIC_AUTH_TOKEN = key;
  env.ANTHROPIC_API_KEY = key;
  env.API_TIMEOUT_MS = "3000000";
  for (const k of ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
    env[k] = model;
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  // Claude Code loads MCP tools on demand only for Anthropic's own API unless told otherwise. Z.ai supports it, and
  // without it every MCP tool's schema goes into each request: a plugin with many tools fills GLM's window by itself.
  env.ENABLE_TOOL_SEARCH = "true";
}

/** Stop a claude process and everything it started: its process group on POSIX (spawn it `detached`), taskkill /T on Windows. */
export function killTree(proc: Subprocess, force = false) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const pid = proc.pid;
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    } catch (err) {
      log.warn(`taskkill ${pid} failed`, err);
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
  if (!force) {
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) killTree(proc, true);
    }, KILL_GRACE_MS).unref?.();
  }
}
