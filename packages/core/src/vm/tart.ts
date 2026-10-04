/**
 * Tart (https://tart.run, Fair Source — free on personal machines) runs macOS VMs with Apple's Virtualization.framework.
 * Godmode drives its CLI: `tart pull` / `tart clone` turn images into template VMs and APFS copy-on-write VMs (see
 * ./images.ts), `tart run` boots them headless, `tart exec` runs commands through the Tart guest agent that the Cirrus
 * Labs images ship with, `tart suspend` saves a VM's memory, and `tart stop` powers a VM off (Godmode asks macOS to
 * shut down first — see service.ts).
 *
 * Everything lives in Godmode's data directory: TART_HOME is `<data>/vm/tart` (VM disks in `vms/`, the image cache in
 * `cache/`), and Godmode installs its own pinned, checksum-verified copy of Tart into `<data>/vm/bin` on demand — so
 * nothing depends on Homebrew, and the user's own Tart VMs (in ~/.tart) are never touched.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { release } from "node:os";
import { join } from "node:path";
import { config, ensureDir } from "../config";
import { logger } from "../log";
import { getSettings } from "../services/settings";
import { stripAnsi } from "../services/doctor";
import { childEnv, sleep, which } from "../util";

const log = logger("vm");

export const TART_VERSION = "2.40.1";
const TART_SHA256 = "363e2701154a8155cbc1bb6d845430c9b42697d2a186bc49574471ca2877db46";
const TART_URL = `https://github.com/cirruslabs/tart/releases/download/${TART_VERSION}/tart.tar.gz`;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 2 * 60_000;

export class TartError extends Error {
  constructor(
    message: string,
    public code: "not_installed" | "unsupported" | "failed" | "timeout" = "failed",
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* Support + paths                                                      */
/* ------------------------------------------------------------------ */

let supportOverride: boolean | null = null;

/** Tests: pretend VMs are (not) supported on this machine. null = detect. */
export function setVmSupportForTests(value: boolean | null) {
  supportOverride = value;
}

/** macOS VMs need a Mac with Apple silicon running macOS 13 (Ventura) or newer. */
export function vmSupport(): { supported: boolean; reason: string | null } {
  if (supportOverride !== null) return { supported: supportOverride, reason: supportOverride ? null : "Disabled for tests" };
  if (process.platform !== "darwin") return { supported: false, reason: "macOS VMs need a Mac — Godmode is running on " + process.platform + "." };
  if (process.arch !== "arm64") return { supported: false, reason: "macOS VMs need a Mac with Apple silicon (M1 or newer)." };
  // Darwin 22 = macOS 13.
  const darwin = Number(release().split(".")[0]);
  if (Number.isFinite(darwin) && darwin < 22) return { supported: false, reason: "macOS VMs need macOS 13 (Ventura) or newer." };
  return { supported: true, reason: null };
}

export function vmRoot(): string {
  return config().vmDir;
}

/** TART_HOME: VM disks (`vms/<name>`) and the OCI image cache (`cache/OCIs`). */
export function tartHome(): string {
  return join(vmRoot(), "tart");
}

export function managedTartPath(): string {
  return join(vmRoot(), "bin", "tart.app", "Contents", "MacOS", "tart");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The tart binary: the custom path from settings, else Godmode's own copy, else one on PATH / from Homebrew. */
export function resolveTart(): { path: string; managed: boolean } | null {
  const custom = getSettings().vm.tartPath?.trim();
  if (custom) return isFile(custom) ? { path: custom, managed: false } : null;
  const managed = managedTartPath();
  if (isFile(managed)) return { path: managed, managed: true };
  for (const p of [which("tart"), "/opt/homebrew/bin/tart", "/usr/local/bin/tart"]) {
    if (p && isFile(p)) return { path: p, managed: false };
  }
  return null;
}

let rootSecured: string | null = null;

export function tartEnv(): Record<string, string | undefined> {
  // VM disks hold the agents' work: only this user may enter the VM folder (Tart creates its own folders 0755).
  if (rootSecured !== vmRoot()) {
    ensureDir(vmRoot(), 0o700);
    rootSecured = vmRoot();
  }
  return childEnv({
    TART_HOME: tartHome(),
    // Tart prunes its image cache on its own when the disk runs low; Godmode's images are cached on purpose.
    TART_NO_AUTO_PRUNE: "1",
  });
}

/* ------------------------------------------------------------------ */
/* Process helper                                                       */
/* ------------------------------------------------------------------ */

export interface TartResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface TartCallOptions {
  timeoutMs?: number;
  /** Bytes for the command's stdin (closed afterwards). */
  stdin?: string | Uint8Array;
  /** Output as it arrives (progress parsing). */
  onOutput?: (chunk: string) => void;
  maxOutput?: number;
  signal?: AbortSignal;
}

/** Run `tart <args>`; never throws for a failing command (see `code`), only when Tart is missing. */
export async function tart(args: string[], opts: TartCallOptions = {}): Promise<TartResult> {
  const bin = resolveTart();
  if (!bin) throw new TartError("Tart is not installed. Install it on the Virtual machines page.", "not_installed");
  const started = Date.now();
  const res = await spawnCollect([bin.path, ...args], opts);
  log.debug(`tart ${args[0]} ${args[1] ?? ""} → ${res.timedOut ? "timeout" : res.code} (${Date.now() - started} ms)`);
  return res;
}

/** Like `tart()`, but throws a TartError with the command's error output when it fails. */
export async function tartOk(args: string[], opts: TartCallOptions = {}): Promise<string> {
  const res = await tart(args, opts);
  if (res.timedOut) throw new TartError(`tart ${args[0]} timed out`, "timeout");
  if (res.code !== 0) throw new TartError(tartErrorText(res) || `tart ${args[0]} failed (exit ${res.code})`);
  return res.stdout;
}

export function tartErrorText(res: TartResult): string {
  const text = stripAnsi(`${res.stderr}\n${res.stdout}`).trim();
  return text.split("\n").filter(Boolean).slice(-4).join(" ").slice(0, 800);
}

async function spawnCollect(argv: string[], opts: TartCallOptions): Promise<TartResult> {
  const maxOutput = opts.maxOutput ?? 1_000_000;
  if (opts.signal?.aborted) return { code: null, stdout: "", stderr: "Cancelled", timedOut: false };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      stdin: opts.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: tartEnv() as Record<string, string>,
    });
  } catch (err) {
    return { code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false };
  }
  let timedOut = false;
  const kill = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  // Timeout, cancellation and readers are in place before any input is written: a guest that doesn't read its
  // input (or writes a lot first) can't hang the call.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, timeoutMs)
      : null;
  const onAbort = () => kill();
  opts.signal?.addEventListener("abort", onAbort);
  const collected = ["", ""];
  const read = async (stream: ReadableStream<Uint8Array> | number | undefined | null, i: 0 | 1) => {
    if (!stream || typeof stream === "number") return;
    // ignoreBOM: file contents read through `cat` keep a byte order mark (edit_file writes them back unchanged).
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        opts.onOutput?.(chunk);
        collected[i] += chunk;
        if (collected[i]!.length > maxOutput * 2) collected[i] = collected[i]!.slice(-maxOutput);
      }
    } catch {
      /* stream closed */
    }
  };
  const outputs = Promise.all([read(proc.stdout as ReadableStream<Uint8Array>, 0), read(proc.stderr as ReadableStream<Uint8Array>, 1)]);
  if (opts.stdin !== undefined) {
    const sink = proc.stdin as import("bun").FileSink;
    void (async () => {
      try {
        sink.write(opts.stdin!);
        await sink.end();
      } catch {
        /* the command exited without reading its input */
      }
    })();
  }
  const code = await proc.exited.catch(() => null);
  const cancelled = !!opts.signal?.aborted && !timedOut;
  // A killed command's children may keep its output open: don't wait for them.
  await (timedOut || cancelled ? Promise.race([outputs, sleep(500)]) : outputs);
  if (timer) clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
  const clip = (t: string) => (t.length > maxOutput ? t.slice(-maxOutput) : t);
  const [stdout, stderr] = [clip(collected[0]!), clip(collected[1]!)];
  return { code: timedOut || cancelled ? null : code, stdout, stderr: cancelled ? `${stderr}${stderr ? "\n" : ""}Cancelled` : stderr, timedOut };
}

/** Last percentage in Tart's progress output ("pulling disk (27.3 GB compressed)...\r 42%"). */
export function parseProgress(chunk: string): number | null {
  const matches = [...chunk.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)];
  const last = matches.at(-1);
  if (!last) return null;
  const n = Number(last[1]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/* ------------------------------------------------------------------ */
/* Version + install                                                    */
/* ------------------------------------------------------------------ */

let versionCache: { path: string; version: string | null } | null = null;

export async function tartVersion(): Promise<string | null> {
  const bin = resolveTart();
  if (!bin) return null;
  if (versionCache?.path === bin.path) return versionCache.version;
  const res = await spawnCollect([bin.path, "--version"], { timeoutMs: 20_000 });
  const version = res.code === 0 ? (stripAnsi(res.stdout).trim().match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null) : null;
  versionCache = { path: bin.path, version };
  return version;
}

let installing: Promise<{ ok: boolean; output: string }> | null = null;

/**
 * Download Tart's notarized release into `<data>/vm/bin`, verified against a pinned SHA-256. Concurrent calls share
 * one download.
 */
export function installTart(): Promise<{ ok: boolean; output: string }> {
  installing ??= doInstall().finally(() => {
    installing = null;
  });
  return installing;
}

async function doInstall(): Promise<{ ok: boolean; output: string }> {
  const support = vmSupport();
  if (!support.supported) return { ok: false, output: support.reason ?? "Not supported on this machine" };
  const binDir = join(vmRoot(), "bin");
  const staging = join(vmRoot(), `.tart-install-${process.pid}`);
  try {
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    log.info(`downloading Tart ${TART_VERSION}`);
    const res = await fetch(TART_URL, { signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, output: `Download failed: HTTP ${res.status} from ${TART_URL}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== TART_SHA256) return { ok: false, output: `Checksum mismatch for tart.tar.gz (got ${digest}); refusing to install.` };
    const archive = join(staging, "tart.tar.gz");
    await Bun.write(archive, bytes);
    const untar = Bun.spawnSync(["/usr/bin/tar", "-xzf", archive, "-C", staging], { stdout: "pipe", stderr: "pipe" });
    if (untar.exitCode !== 0) return { ok: false, output: `Could not unpack Tart: ${untar.stderr.toString().trim()}` };
    const app = join(staging, "tart.app");
    if (!existsSync(join(app, "Contents", "MacOS", "tart"))) return { ok: false, output: "The Tart download did not contain tart.app" };
    const target = join(binDir, "tart.app");
    rmSync(target, { recursive: true, force: true });
    renameSync(app, target);
    versionCache = null;
    const version = await tartVersion();
    if (!version) return { ok: false, output: "Tart was installed but does not run." };
    log.info(`installed Tart ${version} into ${target}`);
    return { ok: true, output: `Tart ${version} installed.` };
  } catch (err) {
    log.warn("Tart install failed", err);
    return { ok: false, output: `Could not install Tart: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

export interface TartVmInfo {
  name: string;
  source: string;
  state: "running" | "stopped" | "suspended";
  /** Disk size in GB. */
  diskGb: number | null;
  /** Bytes the VM takes on the host. */
  sizeBytes: number | null;
}

/** Tart prints sizes as numbers of GB or as "12.3 GB" (humanized, since 2.36). */
function gigabytes(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^([\d.]+)\s*([KMGT]i?B|B)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "GB").toUpperCase();
  const factor: Record<string, number> = { B: 1e-9, KB: 1e-6, MB: 1e-3, GB: 1, TB: 1e3, KIB: 1.024e-6, MIB: 1.048576e-3, GIB: 1.073741824, TIB: 1099.511627776 };
  return n * (factor[unit] ?? 1);
}

function stateOf(v: unknown, running: unknown): TartVmInfo["state"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "running" || s === "suspended" || s === "stopped") return s;
  return running === true ? "running" : "stopped";
}

export function parseList(stdout: string): TartVmInfo[] {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && typeof (r as { Name?: unknown }).Name === "string")
    .map((r) => {
      const size = gigabytes(r.Size);
      return {
        name: r.Name as string,
        source: String(r.Source ?? ""),
        state: stateOf(r.State, r.Running),
        diskGb: gigabytes(r.Disk),
        sizeBytes: size === null ? null : Math.round(size * 1e9),
      };
    });
}

/** Local VMs (not the image cache). */
export async function listVms(): Promise<TartVmInfo[]> {
  const out = await tartOk(["list", "--source", "local", "--format", "json"], { timeoutMs: 30_000 });
  return parseList(out);
}

/** Images in Tart's OCI cache, by reference. */
export async function listOciNames(): Promise<string[]> {
  const out = await tartOk(["list", "--source", "oci", "--format", "json"], { timeoutMs: 30_000 });
  return parseList(out).map((v) => v.name);
}

/** `tart get`: the guest OS ("darwin" / "linux") and the configured resources. */
export async function getVmConfig(name: string): Promise<{ os: string; cpu: number | null; memoryMb: number | null; display: string | null; diskGb: number | null }> {
  const out = await tartOk(["get", name, "--format", "json"], { timeoutMs: 30_000 });
  let v: Record<string, unknown> = {};
  try {
    v = JSON.parse(out) as Record<string, unknown>;
  } catch {
    /* older tart: text output */
  }
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  return {
    os: String(v.OS ?? "darwin").toLowerCase(),
    cpu: num(v.CPU),
    memoryMb: num(v.Memory),
    display: typeof v.Display === "string" ? v.Display : null,
    diskGb: gigabytes(v.Disk),
  };
}

export async function ipOf(name: string, waitSeconds = 0): Promise<string | null> {
  const res = await tart(["ip", name, "--wait", String(waitSeconds)], { timeoutMs: (waitSeconds + 15) * 1000 });
  const ip = res.code === 0 ? res.stdout.trim().split(/\s+/)[0] : "";
  return ip && /^[\d.]+$|^[0-9a-f:]+$/i.test(ip) ? ip : null;
}

export async function setVm(name: string, opts: { cpu?: number; memoryMb?: number; display?: string; diskGb?: number }): Promise<void> {
  const args = ["set", name];
  if (opts.cpu) args.push("--cpu", String(opts.cpu));
  if (opts.memoryMb) args.push("--memory", String(opts.memoryMb));
  if (opts.display) args.push("--display", opts.display);
  if (opts.diskGb) args.push("--disk-size", String(opts.diskGb));
  if (args.length > 2) await tartOk(args, { timeoutMs: 60_000 });
}
