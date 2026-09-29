/**
 * Logging (owner: core). Every entry goes to the console and, as one JSON line, to the diagnostic log
 * `<data>/logs/godmode.jsonl` that Settings → Logs shows and copies as a report. Known secret values, tokens, API
 * keys and the home directory are masked before anything is written.
 */
import { appendFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LogEntry, LogLevel } from "@godmode/shared";

type Level = LogLevel;
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const LOG_FILE = "godmode.jsonl";
export const ROTATED_LOG_FILE = "godmode.1.jsonl";
/** At this size the file moves to ROTATED_LOG_FILE (replacing the previous one): the log never takes more than twice this. */
export const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MSG = 2000;
const MAX_STRING = 4000;
const MAX_STACK_LINES = 16;
const MAX_LINE_BYTES = 16 * 1024;
const MASK = "••••";

let consoleLevel: Level = (process.env.GODMODE_LOG_LEVEL as Level) || "info";
let fileLevel: Level = "info";
let logDir: string | null = null;
let fileBytes = 0;
let maskKnownSecrets: (text: string) => string = (text) => text;
const home = homedir();

export function setLogDir(dir: string) {
  logDir = dir;
  try {
    fileBytes = statSync(join(dir, LOG_FILE)).size;
  } catch {
    fileBytes = 0;
  }
}

export function logDirectory(): string | null {
  return logDir;
}

/** Console output (tests quiet it with "error"). */
export function setLogLevel(level: Level) {
  consoleLevel = level;
}

/** What goes into the log file: "debug" while detailed logging is on. */
export function setFileLogLevel(level: Level) {
  fileLevel = level;
}

export function fileLogLevel(): Level {
  return fileLevel;
}

/** The vault registers its masking of known secret values (passwords, 2FA seeds, API keys). */
export function setSecretMasker(fn: (text: string) => string) {
  maskKnownSecrets = fn;
}

/** The log files were deleted: rotation starts counting again. */
export function logFileCleared() {
  fileBytes = 0;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g, MASK],
  [/([?&;\s"']|^)((?:access_|refresh_|auth_|id_)?token|api[_-]?key|apikey|secret|client_secret|password|passwd|passphrase|sig|signature)=([^&\s"';]+)/gi, `$1$2=${MASK}`],
  [/("(?:password|passphrase|secret|token|accessToken|refreshToken|api[_-]?key|apiKey|authorization|cookie)"\s*:\s*")[^"]+"/gi, `$1${MASK}"`],
  [/\/\/([^/\s:@]+):([^/\s@]+)@/g, `//$1:${MASK}@`],
  [/\/hooks\/[A-Za-z0-9_-]{8,}/g, `/hooks/${MASK}`],
];

/** Mask secrets in free text and shorten the home directory to `~`. */
export function scrub(text: string): string {
  let out = text;
  try {
    out = maskKnownSecrets(out);
  } catch {
    /* the vault may not be ready yet */
  }
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  if (home.length > 1) out = out.split(home).join("~");
  return out;
}

const SENSITIVE_KEY = /^(?:pass(?:word|phrase)?|passwd|secret|clientsecret|token|accesstoken|refreshtoken|apikey|authorization|cookies?|otp|seed|privatekey)$/i;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function trimStack(stack: string): string {
  const lines = stack.split("\n");
  const kept = lines.slice(0, MAX_STACK_LINES).join("\n");
  return lines.length > MAX_STACK_LINES ? `${kept}\n    … ${lines.length - MAX_STACK_LINES} more frames` : kept;
}

function errorOf(err: { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown }): NonNullable<LogEntry["err"]> {
  const out: NonNullable<LogEntry["err"]> = { message: scrub(truncate(String(err.message ?? ""), MAX_STRING)) };
  if (typeof err.name === "string" && err.name !== "Error") out.name = err.name;
  if (typeof err.stack === "string") out.stack = scrub(trimStack(err.stack));
  if (err.cause instanceof Error) out.message += ` (cause: ${scrub(truncate(err.cause.message, MAX_MSG))})`;
  return out;
}

function clean(value: unknown, depth = 0, key = ""): unknown {
  if (typeof value === "string") return value && SENSITIVE_KEY.test(key.replace(/[-_]/g, "")) ? MASK : scrub(truncate(value, MAX_STRING));
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (value instanceof Error) return errorOf(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value === undefined ? null : String(value);
  if (depth >= 5) return "[…]";
  if (Array.isArray(value)) {
    const out = value.slice(0, 50).map((v) => clean(v, depth + 1, key));
    if (value.length > 50) out.push(`… ${value.length - 50} more`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value).slice(0, 60)) {
    if (v === undefined || typeof v === "function") continue;
    out[k] = clean(v, depth + 1, k);
  }
  return out;
}

/**
 * `extra` may be an Error, a details object (an `err` field in it becomes the entry's error) or any other value.
 */
function entryFor(level: Level, scope: string, msg: string, extra: unknown): LogEntry {
  const entry: LogEntry = { ts: new Date().toISOString(), level, scope, msg: scrub(truncate(String(msg), MAX_MSG)) };
  if (extra === undefined) return entry;
  if (extra instanceof Error) {
    entry.err = errorOf(extra);
    return entry;
  }
  if (!isPlainObject(extra)) {
    entry.data = { detail: clean(extra) };
    return entry;
  }
  const { err, ...rest } = extra;
  if (err instanceof Error || (isPlainObject(err) && typeof err.message === "string")) entry.err = errorOf(err as Error);
  else if (err !== undefined) rest.err = err;
  if (Object.keys(rest).length) entry.data = clean(rest) as Record<string, unknown>;
  return entry;
}

function consoleLine(e: LogEntry): string {
  let line = `${e.ts} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.msg}`;
  if (e.data) line += ` ${JSON.stringify(e.data)}`;
  if (e.err) line += ` ${e.err.stack ?? e.err.message}`;
  return line;
}

function appendLine(entry: LogEntry) {
  if (!logDir) return;
  let line = JSON.stringify(entry);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    const err = entry.err && { ...entry.err, stack: entry.err.stack?.slice(0, 2000) };
    line = JSON.stringify({ ...entry, data: { truncated: true }, ...(err ? { err } : {}) });
  }
  const bytes = Buffer.byteLength(line) + 1;
  const path = join(logDir, LOG_FILE);
  try {
    if (fileBytes > 0 && fileBytes + bytes > MAX_LOG_FILE_BYTES) {
      renameSync(path, join(logDir, ROTATED_LOG_FILE));
      fileBytes = 0;
    }
    appendFileSync(path, line + "\n", { mode: 0o600 });
    fileBytes += bytes;
  } catch {
    /* ignore */
  }
}

function write(level: Level, scope: string, msg: string, extra?: unknown) {
  const toConsole = ORDER[level] >= ORDER[consoleLevel];
  const toFile = logDir !== null && ORDER[level] >= ORDER[fileLevel];
  if (!toConsole && !toFile) return;
  let entry: LogEntry;
  try {
    entry = entryFor(level, scope, msg, extra);
  } catch {
    entry = { ts: new Date().toISOString(), level, scope, msg: scrub(String(msg)) };
  }
  if (toConsole) (level === "error" || level === "warn" ? process.stderr : process.stdout).write(consoleLine(entry) + "\n");
  if (toFile) appendLine(entry);
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
