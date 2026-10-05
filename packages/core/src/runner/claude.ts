/** Resolving and launching the Claude Code CLI (owner: runner). Shared by agent runs and the model catalog. */
import { existsSync } from "node:fs";
import type { Subprocess } from "bun";
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
