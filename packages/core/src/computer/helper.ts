/**
 * Godmode's native computer helper — one JSON-lines protocol on every platform:
 *  - macOS (`native/macos/GodmodeComputer.swift`): displays and windows, capture of a display or one window
 *    (ScreenCaptureKit), mouse/keyboard input globally or to one app's process (a shared window in the background).
 *    The binary is embedded into the compiled core by scripts/build.ts and extracted to `<data>/bin` on first use;
 *    from source it is compiled on demand with `xcrun swiftc`. `GODMODE_COMPUTER_HELPER` overrides the path.
 *  - Windows (helpers/windowsHelper.ts): a PowerShell-hosted C# class — every monitor, screenshots, global input.
 *  - Linux/X11 (helpers/x11Helper.ts): xrandr + ImageMagick + xdotool — every monitor, screenshots, global input.
 * Single app windows on Windows and Linux are Cua Driver's job.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "../config";
import { logger } from "../log";
import { which } from "../util";
import { LineProcess } from "./lineProcess";
import { HelperError } from "./helperError";
import { WINDOWS_HELPER_CS, WINDOWS_HELPER_PS1 } from "./helpers/windowsHelper";
import { X11Helper, x11Tools } from "./helpers/x11Helper";

export { HelperError };

const log = logger("computer");

export const HELPER_NAME = "godmode-computer";
const SOURCE = resolve(import.meta.dir, "../../native/macos/GodmodeComputer.swift");
const DEV_BUILD = resolve(import.meta.dir, "../../native/macos/build", HELPER_NAME);

export interface HelperDisplay {
  /** CGDirectDisplayID on macOS, device name on Windows, output name on Linux. */
  id: number | string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
}

export interface HelperWindow {
  id: number;
  pid: number;
  app: string;
  bundleId: string | null;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  onScreen: boolean;
  frontmost: boolean;
}

export interface HelperCapture {
  data: string;
  format: "jpeg" | "png";
  width: number;
  height: number;
  /** Captured area in global points. */
  x: number;
  y: number;
  pointWidth: number;
  pointHeight: number;
}

export interface HelperPermissions {
  accessibility: boolean;
  screenRecording: boolean;
}

/* ------------------------------------------------------------------ */
/* Binary                                                               */
/* ------------------------------------------------------------------ */

function embeddedHelper(): Blob | null {
  try {
    for (const file of Bun.embeddedFiles as Blob[]) {
      const name = (file as Blob & { name?: string }).name ?? "";
      if (name.includes(`native/${HELPER_NAME}`)) return file;
    }
  } catch {
    /* not compiled */
  }
  return null;
}

/** Extract the embedded helper to `<data>/bin/godmode-computer-<hash>` (once per build). */
async function extractEmbedded(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const dir = join(config().dataDir, "bin");
  const dest = join(dir, `${HELPER_NAME}-${hash}`);
  if (existsSync(dest) && statSync(dest).size === bytes.length) return dest;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
  return dest;
}

let devBuild: Promise<string | null> | null = null;

/** Development: compile the helper from source when it is missing or older than the source. */
function buildFromSource(): Promise<string | null> {
  if (devBuild) return devBuild;
  devBuild = (async () => {
    if (!existsSync(SOURCE)) return null;
    if (existsSync(DEV_BUILD) && statSync(DEV_BUILD).mtimeMs >= statSync(SOURCE).mtimeMs) return DEV_BUILD;
    const xcrun = which("xcrun") ?? (existsSync("/usr/bin/xcrun") ? "/usr/bin/xcrun" : null);
    if (!xcrun) return null;
    mkdirSync(dirname(DEV_BUILD), { recursive: true });
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    log.info("compiling the native computer helper (first use from source)…");
    const proc = Bun.spawn(
      [xcrun, "swiftc", "-O", "-swift-version", "5", "-target", `${arch}-apple-macos13.0`, SOURCE, "-o", DEV_BUILD],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) {
      log.warn(`could not compile the computer helper: ${stderr.slice(-800)}`);
      return null;
    }
    return DEV_BUILD;
  })().finally(() => {
    // Allow a retry after the source changes or a failed build.
    setTimeout(() => (devBuild = null), 5_000);
  });
  return devBuild;
}

/** Absolute path of the helper, or null when there is none (not macOS, or no build and no compiler). */
export async function resolveHelperBinary(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const override = process.env.GODMODE_COMPUTER_HELPER;
  if (override && existsSync(override)) return override;
  const embedded = embeddedHelper();
  if (embedded) return extractEmbedded(embedded);
  const sibling = join(dirname(process.execPath), HELPER_NAME);
  if (existsSync(sibling)) return sibling;
  return buildFromSource();
}

/* ------------------------------------------------------------------ */
/* Process                                                              */
/* ------------------------------------------------------------------ */

export class NativeHelper {
  constructor(
    private proc: LineProcess,
    readonly path: string,
  ) {}

  get alive() {
    return this.proc.alive;
  }

  get exited() {
    return this.proc.exited;
  }

  async call<T>(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const res = await this.proc.request({ cmd, ...params }, timeoutMs);
    if (res.ok === true) return res.result as T;
    throw new HelperError(typeof res.error === "string" ? res.error : "The computer helper failed", typeof res.code === "string" ? res.code : "failed");
  }

  permissions() {
    return this.call<HelperPermissions>("permissions");
  }

  displays() {
    return this.call<HelperDisplay[]>("displays");
  }

  windows(all = false) {
    return this.call<HelperWindow[]>("windows", { all });
  }

  window(id: number) {
    return this.call<HelperWindow | null>("window", { window: id });
  }

  capture(params: {
    display?: number | string;
    window?: number;
    maxWidth: number;
    maxHeight: number;
    format?: "jpeg" | "png";
    quality?: number;
    cursor?: boolean;
    region?: { x: number; y: number; width: number; height: number };
  }) {
    const { region, ...rest } = params;
    const extra = region ? { rx: region.x, ry: region.y, rw: region.width, rh: region.height } : {};
    return this.call<HelperCapture>("capture", { ...rest, ...extra }, 20_000);
  }

  close() {
    return this.proc.close();
  }
}

/** The helper of this platform (same calls everywhere; the X11 one runs in-process). */
export type ComputerHelper = NativeHelper | X11Helper;

let current: ComputerHelper | null = null;
let starting: Promise<ComputerHelper> | null = null;

function helperEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "USER", "LOGNAME", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "USERPROFILE", "PSModulePath"]) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  return env;
}

/** Windows: write the PowerShell host + C# source to `<data>/bin/computer-<hash>/` and return the .ps1 path. */
function windowsScript(): string {
  const hash = createHash("sha256").update(WINDOWS_HELPER_PS1).update(WINDOWS_HELPER_CS).digest("hex").slice(0, 12);
  const dir = join(config().dataDir, "bin", `computer-${hash}`);
  const ps1 = join(dir, "godmode-computer.ps1");
  const cs = join(dir, "godmode-computer.cs");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(cs) || readFileSync(cs, "utf8") !== WINDOWS_HELPER_CS) writeFileSync(cs, WINDOWS_HELPER_CS);
  if (!existsSync(ps1) || readFileSync(ps1, "utf8") !== WINDOWS_HELPER_PS1) writeFileSync(ps1, WINDOWS_HELPER_PS1);
  return ps1;
}

/** Spawn a JSON-lines helper process and wait for its ready line. */
async function spawnHelper(command: string, args: string[], name: string, path: string, readyMs: number): Promise<NativeHelper> {
  let ready: () => void = () => {};
  const readyPromise = new Promise<void>((r) => (ready = r));
  const proc = new LineProcess({
    command,
    args,
    env: helperEnv(),
    name,
    onMessage: (msg) => {
      if (msg.ready === true) ready();
    },
  });
  const ok = await Promise.race([readyPromise.then(() => true), proc.exited.then(() => false), Bun.sleep(readyMs).then(() => false)]);
  if (!ok) {
    await proc.close(500);
    throw new HelperError("Godmode's computer helper did not start.", "failed");
  }
  return new NativeHelper(proc, path);
}

async function startHelper(): Promise<ComputerHelper> {
  if (process.platform === "win32") {
    const ps1 = windowsScript();
    const powershell = which("powershell.exe") ?? which("powershell") ?? "powershell.exe";
    // Add-Type compiles the C# class on start (a second or two).
    return spawnHelper(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1], "godmode-computer.ps1", ps1, 60_000);
  }
  if (process.platform === "linux") {
    const tools = x11Tools();
    if ("missing" in tools) throw new HelperError(tools.missing, "unsupported");
    return new X11Helper(tools);
  }
  const path = await resolveHelperBinary();
  if (!path) {
    throw new HelperError(
      process.platform === "darwin"
        ? "Godmode's computer helper is missing. Reinstall Godmode (or install the Xcode Command Line Tools when running from source)."
        : "Sharing the whole desktop isn't supported on this system yet.",
      "unsupported",
    );
  }
  return spawnHelper(path, [], HELPER_NAME, path, 10_000);
}

/** The running helper (started on demand). Throws HelperError("unsupported") when there is none. */
export async function getHelper(): Promise<ComputerHelper> {
  if (current?.alive) return current;
  if (starting) return starting;
  starting = startHelper()
    .then((helper) => {
      current = helper;
      if (helper instanceof NativeHelper) {
        void helper.exited.then(() => {
          if (current === helper) current = null;
        });
      }
      return helper;
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

export async function stopHelper(): Promise<void> {
  const h = current;
  current = null;
  if (h) await h.close();
}

/** Is the helper usable here, and why not. Never throws. */
export async function helperAvailability(): Promise<{ available: boolean; detail: string; path: string | null }> {
  try {
    const helper = await getHelper();
    return { available: true, detail: "Ready", path: helper.path };
  } catch (err) {
    return { available: false, detail: err instanceof Error ? err.message : String(err), path: null };
  }
}
