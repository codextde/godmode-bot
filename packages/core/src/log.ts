import { appendFileSync } from "node:fs";
import { join } from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = (process.env.GODMODE_LOG_LEVEL as Level) || "info";
let logFile: string | null = null;

export function setLogDir(dir: string) {
  logFile = join(dir, "core.log");
}

export function setLogLevel(level: Level) {
  minLevel = level;
}

function write(level: Level, scope: string, msg: string, extra?: unknown) {
  if (ORDER[level] < ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) {
    const detail = extra instanceof Error ? (extra.stack ?? extra.message) : safeJson(extra);
    line += ` ${detail}`;
  }
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(line + "\n");
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n");
    } catch {
      /* ignore */
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => write("debug", scope, msg, extra),
    info: (msg: string, extra?: unknown) => write("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => write("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => write("error", scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof logger>;
