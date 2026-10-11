/**
 * adb, the Android Debug Bridge: finds the binary (settings, the Android SDK, PATH, Homebrew — the one the human
 * already uses comes first, so Godmode shares their adb server instead of fighting it over port 5037), runs it, parses
 * `adb devices -l`, and installs Google's platform-tools into Godmode's data directory when there is none (a pinned,
 * checksum-verified release).
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import type { AndroidConnection } from "@godmode/shared";
import { config } from "../config";
import { logger } from "../log";
import { getSettings } from "../services/settings";
import { childEnv, sleep, which } from "../util";

const log = logger("android");

export const PLATFORM_TOOLS_VERSION = "37.0.1";
const DOWNLOADS: Partial<Record<NodeJS.Platform, { file: string; sha256: string }>> = {
  darwin: { file: "platform-tools_r37.0.1-darwin.zip", sha256: "ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d" },
  linux: { file: "platform-tools_r37.0.1-linux.zip", sha256: "d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1" },
  win32: { file: "platform-tools_r37.0.1-win.zip", sha256: "45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99" },
};
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDERR = 1_000_000;
const EXE = process.platform === "win32" ? "adb.exe" : "adb";

export class AdbError extends Error {
  constructor(
    message: string,
    public code: "not_installed" | "failed" | "timeout" | "gone" | "unauthorized" = "failed",
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* Binary                                                               */
/* ------------------------------------------------------------------ */

export function androidDir(): string {
  return join(config().dataDir, "android");
}

export function managedAdbPath(): string {
  return join(androidDir(), "platform-tools", EXE);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sdkCandidates(): string[] {
  const home = homedir();
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  if (process.platform === "darwin") roots.push(join(home, "Library", "Android", "sdk"));
  else if (process.platform === "win32") roots.push(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : undefined);
  else roots.push(join(home, "Android", "Sdk"));
  return roots.filter((r): r is string => !!r).map((r) => join(r, "platform-tools", EXE));
}

/** The adb binary: the custom path from settings, else the human's own (SDK, PATH, Homebrew), else Godmode's copy. */
export function resolveAdb(): { path: string; managed: boolean } | null {
  const custom = getSettings().android.adbPath?.trim();
  if (custom) return isFile(custom) ? { path: custom, managed: false } : null;
  for (const p of [...sdkCandidates(), which("adb"), "/opt/homebrew/bin/adb", "/usr/local/bin/adb", "/usr/bin/adb"]) {
    if (p && isFile(p)) return { path: p, managed: false };
  }
  const managed = managedAdbPath();
  return isFile(managed) ? { path: managed, managed: true } : null;
}

/* ------------------------------------------------------------------ */
/* Running adb                                                          */
/* ------------------------------------------------------------------ */

export interface AdbResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface AdbOptions {
  /** adb's name for the device (`-s`). */
  serial?: string;
  timeoutMs?: number;
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
  /** Bytes of stdout kept (the end is cut). Default 64 MB: a raw screenshot of a large tablet fits. */
  maxOutput?: number;
}

let adbOverride: ((args: string[], opts: AdbOptions) => Promise<AdbResult>) | null = null;

/** Tests: answer adb calls without a real adb. */
export function __setAdbForTests(fn: typeof adbOverride): void {
  adbOverride = fn;
}

/** Run `adb [-s serial] <args>`; never throws for a failing command (see `code`), only when adb is missing. */
export async function adb(args: string[], opts: AdbOptions = {}): Promise<AdbResult> {
  if (adbOverride) return adbOverride(args, opts);
  const bin = resolveAdb();
  if (!bin) throw new AdbError("adb is not installed. Install it on the Android phones page.", "not_installed");
  const argv = [bin.path, ...(opts.serial ? ["-s", opts.serial] : []), ...args];
  const started = Date.now();
  const empty = (stderr: string, cancelled = false): AdbResult => ({ code: null, stdout: Buffer.alloc(0), stderr, timedOut: false, cancelled, durationMs: 0 });
  if (opts.signal?.aborted) return empty("Cancelled", true);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdin: opts.stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", env: childEnv() as Record<string, string> });
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
  let timedOut = false;
  const kill = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
  };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = timeoutMs > 0 ? setTimeout(() => ((timedOut = true), kill()), timeoutMs) : null;
  opts.signal?.addEventListener("abort", kill);
  const max = opts.maxOutput ?? 64 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let errText = "";
  const readOut = async () => {
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        chunks.push(chunk);
        size += chunk.length;
        while (size > max && chunks.length > 1) size -= chunks.shift()!.length;
      }
    } catch {
      /* closed */
    }
  };
  // A command can write without end to stderr too: keep its tail only.
  const readErr = async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        errText += decoder.decode(chunk, { stream: true });
        if (errText.length > 2 * MAX_STDERR) errText = errText.slice(-MAX_STDERR);
      }
    } catch {
      /* closed */
    }
    if (errText.length > MAX_STDERR) errText = errText.slice(-MAX_STDERR);
  };
  const outputs = Promise.all([readOut(), readErr()]);
  if (opts.stdin !== undefined) {
    const sink = proc.stdin as import("bun").FileSink;
    void (async () => {
      try {
        sink.write(opts.stdin!);
        await sink.end();
      } catch {
        /* exited without reading */
      }
    })();
  }
  const code = await proc.exited.catch(() => null);
  const cancelled = !!opts.signal?.aborted && !timedOut;
  await (timedOut || cancelled ? Promise.race([outputs, sleep(500)]) : outputs);
  if (timer) clearTimeout(timer);
  opts.signal?.removeEventListener("abort", kill);
  const durationMs = Date.now() - started;
  log.debug(`adb ${args.slice(0, 2).join(" ")} → ${timedOut ? "timeout" : cancelled ? "cancelled" : code} (${durationMs} ms)`);
  return { code: timedOut || cancelled ? null : code, stdout: Buffer.concat(chunks), stderr: errText, timedOut, cancelled, durationMs };
}

/** The reason adb gave, without its noise. */
export function adbErrorText(res: Pick<AdbResult, "stderr" | "stdout">): string {
  const text = `${res.stderr}\n${res.stdout.length < 4000 ? res.stdout.toString("utf8") : ""}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("* daemon") && !l.startsWith("adb: warning"))
    .slice(-3)
    .join(" ");
  return text.slice(0, 600);
}

/** What a failed device command means for the human. */
export function deviceError(res: Pick<AdbResult, "stderr" | "stdout" | "timedOut">, what: string): AdbError {
  if (res.timedOut) return new AdbError(`${what} timed out`, "timeout");
  const text = adbErrorText(res);
  if (/unauthorized/i.test(text)) return new AdbError("The phone hasn't allowed USB debugging from this computer yet. Unlock it and tap Allow.", "unauthorized");
  if (/not found|offline|no devices|device .* not found|closed/i.test(text)) return new AdbError("The phone isn't connected anymore.", "gone");
  return new AdbError(text || `${what} failed`);
}

/** Run a command on the device and return its output as text (throws on adb trouble, not on the command's exit code). */
export async function shellText(serial: string, command: string, opts: Omit<AdbOptions, "serial"> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const res = await adb(["shell", command], { ...opts, serial });
  if (res.timedOut || (res.code !== 0 && !res.stdout.length && /error:|not found|offline|unauthorized/i.test(res.stderr))) throw deviceError(res, "The command");
  return { code: res.code, out: res.stdout.toString("utf8"), err: res.stderr };
}

/** Quote one word for the device's shell (mksh / toybox sh). */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/* ------------------------------------------------------------------ */
/* Devices                                                              */
/* ------------------------------------------------------------------ */

export interface AdbDevice {
  /** adb's name for the connection, e.g. "R58M12ABCDE", "192.168.1.20:5555" or "emulator-5554". */
  serial: string;
  state: "device" | "unauthorized" | "offline" | "no-permissions" | "other";
  connection: AndroidConnection;
  model: string | null;
  product: string | null;
}

export function connectionOf(serial: string): AndroidConnection {
  if (/^emulator-\d+$/.test(serial)) return "emulator";
  if (/^[\w.-]+:\d+$/.test(serial) || serial.includes("._adb-tls-connect.") || serial.includes("._adb._tcp")) return "wifi";
  return "usb";
}

/** `adb devices -l` → one entry per connection. */
export function parseDevices(output: string): AdbDevice[] {
  const out: AdbDevice[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("*") || line.startsWith("adb ")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0]!;
    const word = parts[1]!;
    const state: AdbDevice["state"] =
      word === "device" ? "device" : word === "unauthorized" ? "unauthorized" : word === "offline" ? "offline" : word === "no" && parts[2] === "permissions" ? "no-permissions" : "other";
    const prop = (key: string) => parts.find((p) => p.startsWith(`${key}:`))?.slice(key.length + 1) || null;
    out.push({ serial, state, connection: connectionOf(serial), model: prop("model")?.replace(/_/g, " ") ?? null, product: prop("product") });
  }
  return out;
}

export async function listAdbDevices(): Promise<AdbDevice[]> {
  const res = await adb(["devices", "-l"], { timeoutMs: 15_000 });
  if (res.code !== 0) throw new AdbError(adbErrorText(res) || "adb devices failed");
  return parseDevices(res.stdout.toString("utf8"));
}

export interface DeviceProps {
  serialno: string | null;
  manufacturer: string | null;
  model: string | null;
  androidVersion: string | null;
  sdk: number | null;
  avdName: string | null;
}

const PROPS = ["ro.serialno", "ro.product.manufacturer", "ro.product.model", "ro.build.version.release", "ro.build.version.sdk", "ro.boot.qemu.avd_name", "ro.kernel.qemu.avd_name"];

export async function readProps(serial: string): Promise<DeviceProps> {
  const { out } = await shellText(serial, PROPS.map((p) => `echo "${p}=$(getprop ${p})"`).join("; "), { timeoutMs: 15_000 });
  const map = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) map.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const val = (k: string) => {
    const v = map.get(k);
    return v && v !== "unknown" ? v : null;
  };
  const sdk = Number(val("ro.build.version.sdk"));
  return {
    serialno: val("ro.serialno"),
    manufacturer: val("ro.product.manufacturer"),
    model: val("ro.product.model"),
    androidVersion: val("ro.build.version.release"),
    sdk: Number.isFinite(sdk) && sdk > 0 ? sdk : null,
    avdName: val("ro.boot.qemu.avd_name") ?? val("ro.kernel.qemu.avd_name"),
  };
}

/* ------------------------------------------------------------------ */
/* Version + install                                                    */
/* ------------------------------------------------------------------ */

let versionCache: { path: string; version: string | null } | null = null;

export async function adbVersion(): Promise<string | null> {
  const bin = resolveAdb();
  if (!bin) return null;
  if (versionCache?.path === bin.path) return versionCache.version;
  const res = await adb(["version"], { timeoutMs: 15_000 });
  const text = res.stdout.toString("utf8");
  const version = res.code === 0 ? (text.match(/Version\s+([\d.]+)/)?.[1] ?? text.match(/version\s+([\d.]+)/i)?.[1] ?? null) : null;
  versionCache = { path: bin.path, version };
  return version;
}

export function canInstallAdb(): boolean {
  return !!DOWNLOADS[process.platform] && !(process.platform === "linux" && process.arch !== "x64");
}

let installing: Promise<{ ok: boolean; output: string }> | null = null;

/** Download Google's platform-tools into `<data>/android`, verified against a pinned SHA-256. */
export function installAdb(): Promise<{ ok: boolean; output: string }> {
  installing ??= doInstall().finally(() => {
    installing = null;
  });
  return installing;
}

async function doInstall(): Promise<{ ok: boolean; output: string }> {
  const dl = DOWNLOADS[process.platform];
  if (!dl || !canInstallAdb()) return { ok: false, output: `Godmode can't download adb for ${process.platform} ${process.arch}. Install Android's platform-tools yourself.` };
  const url = `https://dl.google.com/android/repository/${dl.file}`;
  const root = androidDir();
  const staging = join(root, `.platform-tools-${process.pid}`);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    rmSync(staging, { recursive: true, force: true });
    log.info(`downloading Android platform-tools ${PLATFORM_TOOLS_VERSION}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!res.ok) return { ok: false, output: `Download failed: HTTP ${res.status} from ${url}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== dl.sha256) return { ok: false, output: `Checksum mismatch for ${dl.file} (got ${digest}); refusing to install.` };
    const files = unzipSync(bytes);
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith("/") || name.includes("..")) continue;
      const target = join(staging, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      // Everything at the top of platform-tools is a program (adb, fastboot, …).
      if (/^platform-tools\/[^/]+$/.test(name) && !/\.(txt|xml|properties)$|NOTICE/i.test(name)) chmodSync(target, 0o755);
    }
    const unpacked = join(staging, "platform-tools");
    if (!existsSync(join(unpacked, EXE))) return { ok: false, output: "The download did not contain adb." };
    const target = join(root, "platform-tools");
    rmSync(target, { recursive: true, force: true });
    renameSync(unpacked, target);
    versionCache = null;
    const version = await adbVersion();
    if (!version) return { ok: false, output: "adb was installed but does not run." };
    log.info(`installed adb ${version} into ${target}`);
    return { ok: true, output: `adb ${version} installed.` };
  } catch (err) {
    log.warn("adb install failed", err);
    return { ok: false, output: `Could not install adb: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
