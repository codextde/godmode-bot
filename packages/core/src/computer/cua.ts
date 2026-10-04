/**
 * Cua Driver (https://github.com/trycua/cua, `libs/cua-driver`, MIT) — background computer use for single windows
 * on macOS, Windows and Linux: window screenshots, the window's accessibility tree with element tokens, and input
 * posted to the window's process without moving the human's cursor or bringing the app to the front.
 *
 * Godmode runs `cua-driver mcp --direct` as a child process and is its MCP client (the runtime lives in that
 * process, so on macOS it uses the Accessibility / Screen Recording grants of the app that runs Godmode). The
 * driver is downloaded from PyPI (`cua-driver` bundles the native binary per platform) through uv — the same
 * way browser-use is provided — or taken from `settings.computer.cuaDriverCommand` / an installed `cua-driver`.
 *
 * Pixel coordinates of Cua Driver's input tools are window-local pixels of the *last screenshot the driver took of
 * that window*, so every call goes through one queue and the size of each window's last driver screenshot is
 * tracked (see `pixelFor`).
 */
import { existsSync, statSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { logger } from "../log";
import { getSettings } from "../services/settings";
import { compareVersions } from "../services/claudeUpdate";
import { resolveUvx, runCommand, stripAnsi, toolPath, versionFrom } from "../services/doctor";
import { splitCommand } from "../browser/browserUse";
import { which } from "../util";
import { LineProcess } from "./lineProcess";

const log = logger("computer");

export const CUA_DRIVER_VERSION = "0.33.1";
export const CUA_DRIVER_SPEC = `cua-driver==${CUA_DRIVER_VERSION}`;
const PROTOCOL_VERSION = "2025-06-18";
/** Stop the driver after this long without calls (it is restarted on demand). */
const IDLE_STOP_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 45_000;
/** A download that failed isn't tried again unasked for this long. */
const FETCH_RETRY_MS = 10 * 60_000;
/** How long an action with nothing to fall back on waits for a first download of Cua Driver. */
const DOWNLOAD_WAIT_MS = 20_000;

export class CuaError extends Error {
  constructor(
    message: string,
    /** Driver refusal code, e.g. "off_space_or_ax_unresolved", "background_unavailable", "window_id_not_found". */
    public code: string,
    public result?: CuaResult,
  ) {
    super(message);
  }
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface CuaResult {
  content: McpContent[];
  structured: Record<string, unknown>;
  isError: boolean;
  /** Joined text content. */
  text: string;
}

export interface CuaWindow {
  window_id: number;
  pid: number;
  app_name: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  is_on_screen: boolean;
  z_index: number | null;
}

export interface CuaElement {
  element_index: number;
  element_token?: string;
  role?: string;
  label?: string | null;
  value?: string | null;
  actions?: string[];
  frame?: { x: number; y: number; w: number; h: number } | null;
  depth?: number;
}

export interface CuaWindowState {
  image: { data: string; mime: "image/png" | "image/jpeg"; width: number; height: number } | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  scale: number | null;
  title: string;
  app: string;
  elements: CuaElement[];
  markdown: string;
  snapshotId: string | null;
  degradedReason: string | null;
  truncated: boolean;
}

export type Delivery = "background" | "foreground";

/* ------------------------------------------------------------------ */
/* Command                                                              */
/* ------------------------------------------------------------------ */

let resolvedBinary: { spec: string; path: string } | null = null;
let fetching: Promise<string | null> | null = null;
/** The last download that failed, while it isn't tried again on its own. */
let fetchFailure: { at: number; error: string } | null = null;
let downloadWaitMs = DOWNLOAD_WAIT_MS;
let standaloneOverride: string | null | undefined;
let unsupportedOverride: string | null | undefined;
/** `--version` of installed cua-drivers that answered, per path and modification time. */
const standaloneVersions = new Map<string, { mtimeMs: number; version: string }>();
/** Installed cua-drivers whose `--version` hung, per path and modification time: not asked again for a while. */
const hungVersions = new Map<string, { mtimeMs: number; at: number }>();
const askingVersion = new Map<string, Promise<string | null>>();
let versionTimeoutMs = 20_000;

/**
 * Tests: forget what was found and downloaded. `standalone` replaces the lookup of an installed cua-driver (null =
 * none), `unsupported` the check for a PyPI build for this computer (null = there is one), `waitMs` how long an action
 * waits for a first download, `versionTimeoutMs` how long an installed cua-driver gets to say its version.
 */
export function __resetCuaDriverForTests(opts: { standalone?: string | null; unsupported?: string | null; waitMs?: number; versionTimeoutMs?: number } = {}) {
  const running = current;
  current = null;
  currentOutdated = false;
  starting = null;
  lastError = null;
  if (running) void running.close();
  resolvedBinary = null;
  fetching = null;
  fetchFailure = null;
  downloadWaitMs = opts.waitMs ?? DOWNLOAD_WAIT_MS;
  standaloneOverride = opts.standalone;
  unsupportedOverride = opts.unsupported;
  standaloneVersions.clear();
  hungVersions.clear();
  askingVersion.clear();
  versionTimeoutMs = opts.versionTimeoutMs ?? 20_000;
}

/** Path of the cua-driver binary bundled in the PyPI package (downloads it when `install`), or why there is none. */
async function binaryViaUv(install: boolean): Promise<{ path: string | null; error: string }> {
  if (resolvedBinary?.spec === CUA_DRIVER_SPEC && existsSync(resolvedBinary.path)) return { path: resolvedBinary.path, error: "" };
  // Not there yet: a look into uv's cache while the download writes into it could wait on the download's lock.
  if (!install && fetching) return { path: null, error: "it is being downloaded" };
  const uvx = resolveUvx();
  if (!uvx) return { path: null, error: "uv is not installed" };
  const script = "import cua_driver,sys; sys.stdout.write(str(cua_driver.get_binary_path()))";
  const args = [uvx, ...(install ? [] : ["--offline"]), "--from", CUA_DRIVER_SPEC, "python", "-c", script];
  const res = await runCommand(args, { timeoutMs: install ? 10 * 60_000 : 60_000, env: { ...cuaEnv(), PATH: toolPath() } });
  const path = stripAnsi(res.stdout).trim().split("\n").pop()?.trim() ?? "";
  if (res.code !== 0 || !path || !existsSync(path)) {
    const error = res.timedOut ? "uv took too long" : stripAnsi(res.stderr).trim().split("\n").slice(-2).join(" ").slice(-300) || `uv exited with ${res.code}`;
    if (install) log.warn(`could not install ${CUA_DRIVER_SPEC}: ${error}`);
    return { path: null, error };
  }
  resolvedBinary = { spec: CUA_DRIVER_SPEC, path };
  return { path, error: "" };
}

/** Download the pinned build with uv in the background: one download at a time, shared by everyone who needs it. */
function fetchPinned(): Promise<string | null> {
  fetching ??= binaryViaUv(true)
    .catch((err: unknown) => ({ path: null, error: err instanceof Error ? err.message : String(err) }))
    .then(({ path, error }) => {
      fetchFailure = path ? null : { at: Date.now(), error };
      if (path) log.info(`${CUA_DRIVER_SPEC} is downloaded`);
      return path;
    })
    .finally(() => {
      fetching = null;
    });
  return fetching;
}

let glibc: string | null | undefined;

/** The C library version of a glibc Linux (null = another libc, or it can't be told). */
function glibcVersion(): string | null {
  if (glibc === undefined) {
    try {
      const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined)?.header;
      glibc = typeof header?.glibcVersionRuntime === "string" ? header.glibcVersionRuntime : null;
    } catch {
      glibc = null;
    }
  }
  return glibc;
}

/**
 * Why PyPI has no cua-driver build for `host` (null = it has one, or that can't be told). 0.33.1 ships macOS 13+
 * (universal), manylinux_2_31 x86_64/aarch64 and Windows x64/arm64. `osRelease` is os.release() (Darwin 22 is macOS
 * 13); `glibc` null = another C library, or unknown.
 */
export function pinnedBuildMissing(host: { platform: string; arch: string; osRelease: string; glibc: string | null }): string | null {
  switch (host.platform) {
    case "darwin":
      return Number(host.osRelease.split(".")[0]) >= 22 ? null : "it needs macOS 13 or newer";
    case "win32":
      return host.arch === "x64" || host.arch === "arm64" ? null : `there is none for Windows on ${host.arch}`;
    case "linux":
      if (host.arch !== "x64" && host.arch !== "arm64") return `there is none for Linux on ${host.arch}`;
      return host.glibc && compareVersions(host.glibc, "2.31") < 0 ? `it needs glibc 2.31 or newer (this system has ${host.glibc})` : null;
    default:
      return `there is none for ${host.platform}`;
  }
}

/** Why PyPI has no cua-driver build for this computer (null = it has one, or that can't be told). */
export function cuaDownloadUnsupported(): string | null {
  if (unsupportedOverride !== undefined) return unsupportedOverride;
  return pinnedBuildMissing({ platform: process.platform, arch: process.arch, osRelease: release(), glibc: process.platform === "linux" ? glibcVersion() : null });
}

/** The download that failed, while it isn't tried again on its own (null = none, or it may be tried again). */
function recentFetchFailure(): { at: number; error: string } | null {
  return fetchFailure && Date.now() - fetchFailure.at < FETCH_RETRY_MS ? fetchFailure : null;
}

/** Godmode may download the pinned build now, unasked: uv is there, PyPI has a build, no failure to wait out. */
function mayFetch(): boolean {
  return !!resolveUvx() && !cuaDownloadUnsupported() && !recentFetchFailure();
}

/** Where the download of the pinned build stands: under way, impossible (no uv, no build), failed, or not started. */
export function cuaDownloadNote(): string {
  if (fetching) return `downloading ${CUA_DRIVER_SPEC} in the background`;
  if (!resolveUvx()) return "no uv to download it";
  const unsupported = cuaDownloadUnsupported();
  if (unsupported) return `PyPI has no ${CUA_DRIVER_SPEC} for this computer: ${unsupported}`;
  const failed = recentFetchFailure();
  return failed ? `downloading ${CUA_DRIVER_SPEC} failed (${failed.error}); it is tried again later` : `${CUA_DRIVER_SPEC} isn't downloaded yet`;
}

/** A standalone cua-driver (official installer: ~/.local/bin/cua-driver, or on PATH). */
function installedBinary(): string | null {
  if (standaloneOverride !== undefined) return standaloneOverride;
  const exe = process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
  const candidates = [which("cua-driver"), join(homedir(), ".local", "bin", exe)];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Programs", "cua-driver", exe));
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

/**
 * The version a standalone cua-driver reports (null = it didn't answer). An answer is kept until the binary changes; a
 * quick failure is asked again next time, a `--version` that hung only after a while (every status would wait for it).
 * Callers at the same moment share one `--version`.
 */
function standaloneVersion(path: string): Promise<string | null> {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return Promise.resolve(null);
  }
  const known = standaloneVersions.get(path);
  if (known?.mtimeMs === mtimeMs) return Promise.resolve(known.version);
  const hung = hungVersions.get(path);
  if (hung?.mtimeMs === mtimeMs && Date.now() - hung.at < FETCH_RETRY_MS) return Promise.resolve(null);
  let asking = askingVersion.get(path);
  if (!asking) {
    asking = runCommand([path, "--version"], { timeoutMs: versionTimeoutMs, env: cuaEnv() })
      .then((res) => {
        const version = res.code === 0 ? versionFrom(stripAnsi(res.stdout)) : null;
        if (version) standaloneVersions.set(path, { mtimeMs, version });
        else if (res.timedOut) hungVersions.set(path, { mtimeMs, at: Date.now() });
        return version;
      })
      .finally(() => askingVersion.delete(path));
    askingVersion.set(path, asking);
  }
  return asking;
}

/** Older than the version this Godmode release was tested with — or of unknown version. */
export function cuaDriverOutdated(version: string | null): boolean {
  return !version || compareVersions(version, CUA_DRIVER_VERSION) < 0;
}

export interface CuaDriverCommand {
  command: string;
  args: string[];
  source: "custom" | "uv" | "installed";
  /** null = unknown (a custom command, or a cua-driver that didn't say). */
  version: string | null;
}

/**
 * The command that starts Cua Driver: the custom command from settings, else the pinned PyPI build if uv has it, else
 * an installed cua-driver (maybe older than the pinned version). Never downloads anything.
 */
export async function resolveCuaDriver(): Promise<CuaDriverCommand | null> {
  const custom = getSettings().computer.cuaDriverCommand?.trim();
  if (custom) {
    const parts = splitCommand(custom);
    if (parts.length) {
      const command = parts[0]!;
      return { command: which(command) ?? command, args: parts.slice(1), source: "custom", version: null };
    }
  }
  const viaUv = (await binaryViaUv(false)).path;
  if (viaUv) return { command: viaUv, args: [], source: "uv", version: CUA_DRIVER_VERSION };
  const installed = installedBinary();
  return installed ? { command: installed, args: [], source: "installed", version: await standaloneVersion(installed) } : null;
}

/** Where cua-driver keeps its state for Godmode. It exists once the driver has run. */
export function cuaStateDir(): string {
  try {
    return join(config().dataDir, "cua-driver");
  } catch {
    return join(homedir(), ".godmode", "cua-driver");
  }
}

/** Environment for cua-driver: no telemetry, no update checks, its state under Godmode's data dir. */
export function cuaEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "SYSTEMROOT", "ComSpec", "PATH", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  const home = cuaStateDir();
  return {
    ...env,
    CUA_DRIVER_RS_HOME: home,
    CUA_DRIVER_TELEMETRY_HOME: home,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "0",
    // Godmode watches the window itself; don't hold every action for a second waiting for new windows.
    CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS: "350",
    CUA_DRIVER_WINDOW_CHANGE_POLL_MS: "50",
    // The driver ends its session after this long without calls and drops the session's window screenshots with it.
    // Longer than IDLE_STOP_MS: the session lasts as long as the process.
    CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS: String(IDLE_STOP_MS / 1000 + 300),
  };
}

/* ------------------------------------------------------------------ */
/* Client                                                               */
/* ------------------------------------------------------------------ */

function textOf(content: McpContent[]): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n")
    .trim();
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Remove what the driver reports about *other* apps' windows (it names them after an action). */
export function scrubSummary(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*🪟/.test(line) && !/opened new window/i.test(line))
    .join("\n")
    .trim();
}

interface WindowShotState {
  width: number;
  height: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export class CuaDriverClient {
  private queue: Promise<unknown> = Promise.resolve();
  /** Size of the last screenshot the driver took of each window (its pixel coordinate space). */
  private shots = new Map<number, WindowShotState>();
  /**
   * How much the driver's last desktop screenshot was downsized (native ÷ delivered pixels; null = not at all). The
   * driver multiplies every later desktop coordinate by it (desktop_capture_scale.rs), so `desktopAct` divides first.
   */
  private desktopScale: { x: number; y: number } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private proc: LineProcess,
    readonly version: string,
    readonly command: string,
  ) {
    this.touch();
  }

  get alive() {
    return this.proc.alive;
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (current === this) {
        log.info("stopping idle Cua Driver");
        void stopCuaDriver();
      }
    }, IDLE_STOP_MS);
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Run `fn` exclusively (the driver's per-window coordinate state must not change underneath). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Raw MCP tools/call (not queued — use inside `exclusive` or for stateless tools). */
  async rawCall(name: string, args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<CuaResult> {
    this.touch();
    let res: Record<string, unknown>;
    try {
      res = await this.proc.request({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args } }, timeoutMs);
    } catch (err) {
      // A call that never answered may still be running in the driver: restart it rather than overlap with it.
      if (this.proc.alive) {
        log.warn(`Cua Driver didn't answer ${name}; restarting it`);
        if (current === this) current = null;
        void this.close();
      }
      throw new CuaError(err instanceof Error ? err.message : String(err), "timeout");
    }
    if (res.error) {
      const e = res.error as { message?: string; code?: number };
      throw new CuaError(e.message ?? `Cua Driver ${name} failed`, "rpc_error");
    }
    const result = (res.result ?? {}) as { content?: McpContent[]; structuredContent?: Record<string, unknown>; isError?: boolean };
    const content = Array.isArray(result.content) ? result.content : [];
    const structured = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : {};
    return { content, structured, isError: result.isError === true, text: textOf(content) };
  }

  /** tools/call that throws CuaError when the driver refused or failed. */
  async call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CuaResult> {
    const r = await this.rawCall(name, args, timeoutMs);
    const code = typeof r.structured.code === "string" ? r.structured.code : null;
    const refused = r.structured.effect === "refused";
    if (r.isError || refused || (code && !r.structured.route && !r.structured.delivery)) {
      const reason = typeof r.structured.reason === "string" ? r.structured.reason : "";
      const message = scrubSummary(reason || r.text || `Cua Driver ${name} failed`);
      throw new CuaError(message.slice(0, 1200), code ?? (refused ? "refused" : "failed"), r);
    }
    return r;
  }

  async listWindows(pid?: number): Promise<CuaWindow[]> {
    const r = await this.call("list_windows", pid ? { pid } : {});
    const windows = (r.structured.windows as CuaWindow[] | undefined) ?? [];
    return windows.filter((w) => w && typeof w.window_id === "number");
  }

  private recordShot(windowId: number, s: Record<string, unknown>) {
    const width = num(s.screenshot_width);
    const height = num(s.screenshot_height);
    const b = s.window_bounds as WindowShotState["bounds"] | undefined;
    if (width && height && b && num(b.width) && num(b.height)) this.shots.set(windowId, { width, height, bounds: b });
  }

  private toState(r: CuaResult, windowId: number): CuaWindowState {
    const s = r.structured;
    const image = r.content.find((c) => c.type === "image" && c.data);
    const width = num(s.screenshot_width);
    const height = num(s.screenshot_height);
    // Every read replaces the window's snapshot: without a usable screenshot in this one, the driver refuses pixels
    // (screenshot_context_missing) until it has a screenshot again.
    this.shots.delete(windowId);
    if (image && width && height) this.recordShot(windowId, s);
    const b = s.window_bounds as CuaWindowState["bounds"] | undefined;
    return {
      image:
        image && width && height
          ? { data: image.data!, mime: image.mimeType === "image/jpeg" ? "image/jpeg" : "image/png", width, height }
          : null,
      bounds: b && num(b.width) ? b : null,
      scale: num(s.screenshot_scale),
      title: typeof s.window_title === "string" ? s.window_title : "",
      app: typeof s.app_name === "string" ? s.app_name : "",
      elements: Array.isArray(s.elements) ? (s.elements as CuaElement[]) : [],
      markdown: typeof s.tree_markdown === "string" ? s.tree_markdown : "",
      snapshotId: typeof s.snapshot_id === "string" ? s.snapshot_id : null,
      degradedReason: typeof s.degraded_reason === "string" ? s.degraded_reason : null,
      truncated: s.truncated === true,
    };
  }

  /** Screenshot of one window (no accessibility walk). */
  windowShot(pid: number, windowId: number, maxDimension: number): Promise<CuaWindowState> {
    return this.exclusive(async () => {
      const r = await this.call("get_window_state", { pid, window_id: windowId, include_accessibility_tree: false, max_image_dimension: maxDimension });
      return this.toState(r, windowId);
    });
  }

  /** Accessibility tree (element tokens) of one window, optionally with a screenshot. */
  windowState(
    pid: number,
    windowId: number,
    opts: { screenshot: boolean; maxDimension: number; query?: string; maxElements?: number },
  ): Promise<CuaWindowState> {
    return this.exclusive(async () => {
      const r = await this.call(
        "get_window_state",
        {
          pid,
          window_id: windowId,
          include_screenshot: opts.screenshot,
          ...(opts.screenshot ? { max_image_dimension: opts.maxDimension } : {}),
          ...(opts.query ? { query: opts.query } : {}),
          ...(opts.maxElements ? { max_elements: opts.maxElements } : {}),
          timeout_ms: 3000,
        },
        60_000,
      );
      return this.toState(r, windowId);
    });
  }

  /**
   * Window-local point (relative to the window's top-left, in points) → the driver's pixel space for that window.
   * Takes a screenshot first when the driver has none of the window at its current size. Call inside `exclusive`.
   */
  private async pixelFor(
    pid: number,
    windowId: number,
    local: { x: number; y: number },
    maxDimension: number,
    size?: { width: number; height: number },
  ): Promise<{ x: number; y: number }> {
    let shot = this.shots.get(windowId);
    const resized = !!shot && !!size && (Math.abs(shot.bounds.width - size.width) > 1 || Math.abs(shot.bounds.height - size.height) > 1);
    if (!shot || resized) {
      const r = await this.call("get_window_state", { pid, window_id: windowId, include_accessibility_tree: false, max_image_dimension: maxDimension });
      this.recordShot(windowId, r.structured);
      shot = this.shots.get(windowId);
      if (!shot) throw new CuaError("Cua Driver could not capture the window to place the pointer.", "px_capture_unavailable");
    }
    return { x: (local.x * shot.width) / shot.bounds.width, y: (local.y * shot.height) / shot.bounds.height };
  }

  /**
   * Run an action that sends pixels (`act` gets them from `pixelFor`). The driver drops a window's screenshot on its
   * own — it keeps 8 windows per app, and ends its session after a long pause — and then refuses pixels:
   * forget the recorded screenshot and run `act` once more, which captures again. Call inside `exclusive`.
   */
  private async withPixels(windowId: number, act: () => Promise<CuaResult>): Promise<CuaResult> {
    try {
      return await act();
    } catch (err) {
      if (!(err instanceof CuaError) || err.code !== "screenshot_context_missing") throw err;
      this.shots.delete(windowId);
      return act();
    }
  }

  /** Pointer action at a window-local point (points). */
  pointer(
    kind: "click" | "move",
    target: { pid: number; windowId: number },
    local: { x: number; y: number },
    opts: { button?: "left" | "right" | "middle"; count?: number; modifiers?: string[]; delivery?: Delivery; maxDimension: number; size?: { width: number; height: number } },
  ): Promise<CuaResult> {
    return this.exclusive(() =>
      this.withPixels(target.windowId, async () => {
        const px = await this.pixelFor(target.pid, target.windowId, local, opts.maxDimension, opts.size);
        const base = { target: { kind: "window", pid: target.pid, window_id: target.windowId }, x: px.x, y: px.y };
        if (kind === "move") return this.call("move_cursor", base);
        const args: Record<string, unknown> = { ...base, ...(opts.delivery ? { delivery_mode: opts.delivery } : {}) };
        if (opts.modifiers?.length) args.modifier = opts.modifiers;
        // Double and right clicks are `click` with a count / button: double_click and right_click take no `target`.
        if (opts.button && opts.button !== "left") args.button = opts.button;
        if (opts.count && opts.count > 1) args.count = opts.count;
        return this.call("click", args);
      }),
    );
  }

  /** Click an element from the last `windowState` of the window (accessibility path — works in the background). */
  clickElement(target: { pid: number; windowId: number }, token: string, opts: { button?: "left" | "right"; count?: number; delivery?: Delivery }): Promise<CuaResult> {
    return this.exclusive(() => {
      const tool = opts.count === 2 ? "double_click" : opts.button === "right" ? "right_click" : "click";
      return this.call(tool, { pid: target.pid, window_id: target.windowId, element_token: token, ...(opts.delivery ? { delivery_mode: opts.delivery } : {}) });
    });
  }

  typeText(target: { pid: number; windowId: number }, text: string, opts: { element?: string; delivery?: Delivery } = {}): Promise<CuaResult> {
    return this.exclusive(() =>
      this.call(
        "type_text",
        {
          pid: target.pid,
          window_id: target.windowId,
          text,
          ...(opts.element ? { element_token: opts.element } : {}),
          ...(opts.delivery ? { delivery_mode: opts.delivery } : {}),
        },
        120_000,
      ),
    );
  }

  pressKeys(target: { pid: number; windowId: number }, key: string, modifiers: string[], opts: { element?: string; delivery?: Delivery } = {}): Promise<CuaResult> {
    return this.exclusive(() => {
      const base = {
        pid: target.pid,
        window_id: target.windowId,
        ...(opts.element ? { element_token: opts.element } : {}),
        ...(opts.delivery ? { delivery_mode: opts.delivery } : {}),
      };
      return modifiers.length ? this.call("hotkey", { ...base, keys: [...modifiers, key] }) : this.call("press_key", { ...base, key });
    });
  }

  scroll(
    target: { pid: number; windowId: number },
    local: { x: number; y: number } | null,
    direction: "up" | "down" | "left" | "right",
    amount: number,
    opts: { element?: string; delivery?: Delivery; maxDimension: number; size?: { width: number; height: number } },
  ): Promise<CuaResult> {
    return this.exclusive(() =>
      this.withPixels(target.windowId, async () => {
        const args: Record<string, unknown> = { pid: target.pid, window_id: target.windowId, direction, amount };
        if (opts.element) args.element_token = opts.element;
        else if (local) Object.assign(args, await this.pixelFor(target.pid, target.windowId, local, opts.maxDimension, opts.size));
        if (opts.delivery) args.delivery_mode = opts.delivery;
        return this.call("scroll", args);
      }),
    );
  }

  drag(
    target: { pid: number; windowId: number },
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts: { button?: "left" | "right" | "middle"; modifiers?: string[]; delivery?: Delivery; maxDimension: number; size?: { width: number; height: number } },
  ): Promise<CuaResult> {
    return this.exclusive(() =>
      this.withPixels(target.windowId, async () => {
        const a = await this.pixelFor(target.pid, target.windowId, from, opts.maxDimension, opts.size);
        const b = await this.pixelFor(target.pid, target.windowId, to, opts.maxDimension, opts.size);
        return this.call("drag", {
          pid: target.pid,
          window_id: target.windowId,
          from_x: a.x,
          from_y: a.y,
          to_x: b.x,
          to_y: b.y,
          ...(opts.button && opts.button !== "left" ? { button: opts.button } : {}),
          ...(opts.modifiers?.length ? { modifier: opts.modifiers } : {}),
          ...(opts.delivery ? { delivery_mode: opts.delivery } : {}),
        });
      }),
    );
  }

  /** Screenshot of the primary display, downsized by the driver to `maxDimension`. Notes the driver's new desktop scale. */
  desktopState(maxDimension: number): Promise<CuaResult> {
    return this.exclusive(async () => {
      const r = await this.call("get_desktop_state", { max_image_dimension: maxDimension });
      // As record_desktop_state: original ÷ delivered on each axis; cleared when it is 1:1 or a size is missing.
      const s = r.structured;
      const factor = (delivered: unknown, original: unknown) => {
        const d = num(delivered);
        const o = num(original);
        return d && o && d > 0 && o > 0 ? o / d : null;
      };
      const x = factor(s.screenshot_width, s.screenshot_original_width);
      const y = factor(s.screenshot_height, s.screenshot_original_height);
      this.desktopScale = x && y && (x !== 1 || y !== 1) ? { x, y } : null;
      return r;
    });
  }

  /**
   * A desktop action (`target` desktop or `scope: "desktop"`) at native pixels of the primary display. The driver
   * reads desktop pixels off its last desktop screenshot, so they are sent at that screenshot's size.
   */
  desktopAct(tool: string, args: Record<string, unknown>): Promise<CuaResult> {
    return this.exclusive(() => {
      const scale = this.desktopScale;
      const sent = { ...args };
      if (scale) {
        for (const [keys, factor] of [
          [["x", "from_x", "to_x"], scale.x],
          [["y", "from_y", "to_y"], scale.y],
        ] as const) {
          // A hair past the point: ÷ then the driver's × can come back as 122.99999999999999, which Windows truncates.
          for (const key of keys) if (typeof sent[key] === "number") sent[key] = ((sent[key] as number) + 1e-6) / factor;
        }
      }
      return this.call(tool, sent);
    });
  }

  permissions(): Promise<{ accessibility: boolean | null; screenRecording: boolean | null }> {
    return this.exclusive(async () => {
      const r = await this.rawCall("check_permissions", {});
      const s = r.structured;
      return {
        accessibility: typeof s.accessibility === "boolean" ? s.accessibility : null,
        screenRecording: typeof s.screen_recording === "boolean" ? s.screen_recording : null,
      };
    });
  }

  forgetWindow(windowId: number) {
    this.shots.delete(windowId);
  }

  async close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.proc.close();
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

let current: CuaDriverClient | null = null;
/** The running driver is an installed cua-driver older than the pinned version (replaced once the pinned one is there). */
let currentOutdated = false;
let starting: Promise<CuaDriverClient> | null = null;
let lastError: string | null = null;

/** `cua-driver mcp` arguments: on macOS the MCP process owns the runtime (TCC grants of the app running Godmode). */
function mcpArgs(): string[] {
  const args = ["mcp"];
  if (process.platform === "darwin") args.push("--direct");
  if (!getSettings().computer.agentCursor) args.push("--cursor-reduced-motion", "on");
  return args;
}

/** The settings that decide which Cua Driver runs, if any: a driver that started under others isn't wanted. */
function wantedDriver(): string {
  const s = getSettings().computer;
  return JSON.stringify([s.enabled, s.useCuaDriver, s.cuaDriverCommand?.trim() ?? ""]);
}

function notWanted(): CuaError {
  return new CuaError(
    getSettings().computer.useCuaDriver ? "Cua Driver's settings changed while it started. Try again." : "Cua Driver is turned off in Settings → Computer.",
    "unavailable",
  );
}

/** `p`, or undefined when it takes longer than `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, ms, undefined);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const pinnedReady = () => resolvedBinary?.spec === CUA_DRIVER_SPEC && existsSync(resolvedBinary.path);

const DOWNLOADING = `Cua Driver ${CUA_DRIVER_VERSION} is being downloaded (first use)…`;

/**
 * What a caller does while Cua Driver isn't downloaded yet. "never": nothing — no download starts (listings, status,
 * the human's own views). "background": start the download and fail at once with code "downloading" (the caller has
 * something to fall back on meanwhile). "wait": start it and wait for it a little (there is nothing else).
 */
export type CuaDownload = "never" | "background" | "wait";

/**
 * The running Cua Driver (started on demand). Throws CuaError "downloading" while the pinned build is being
 * downloaded for its first use, and "unavailable" when it can't be provided.
 */
export async function getCuaDriver(opts: { download?: CuaDownload } = {}): Promise<CuaDriverClient> {
  const download = opts.download ?? "never";
  if (!getSettings().computer.useCuaDriver) throw new CuaError("Cua Driver is turned off in Settings → Computer.", "unavailable");
  if (current?.alive && currentOutdated && pinnedReady()) {
    // The pinned build arrived: it takes over once the older driver has finished what it was asked to do.
    const old = current;
    current = null;
    log.info(`switching to ${CUA_DRIVER_SPEC}`);
    void old.exclusive(() => old.close());
  }
  if (current?.alive) return current;
  if (starting) return starting;
  const wanted = wantedDriver();
  let cmd = await resolveCuaDriver();
  const outdated = cmd?.source === "installed" && cuaDriverOutdated(cmd.version);
  if ((!cmd || outdated) && download !== "never" && !fetching && mayFetch()) {
    log.info(cmd ? `cua-driver ${cmd.version ?? "(version unknown)"} at ${cmd.command} is older than ${CUA_DRIVER_VERSION}: downloading ${CUA_DRIVER_SPEC} with uv` : `downloading ${CUA_DRIVER_SPEC} with uv (first use)`);
    void fetchPinned();
  }
  if (!cmd && fetching) {
    if (download !== "wait") throw new CuaError(DOWNLOADING, "downloading");
    if ((await within(fetching, downloadWaitMs)) === undefined) {
      throw new CuaError(`Cua Driver ${CUA_DRIVER_VERSION} is still being downloaded (first use). Try again in a moment.`, "downloading");
    }
    cmd = await resolveCuaDriver();
  }
  if (!cmd) {
    const failed = recentFetchFailure();
    const unsupported = cuaDownloadUnsupported();
    const message = failed
      ? `Cua Driver ${CUA_DRIVER_VERSION} couldn't be downloaded: ${failed.error}. Install it in Settings → Computer to try again.`
      : !resolveUvx()
        ? "Cua Driver is not installed, and uv, which downloads it, isn't either. Install uv in Settings → System."
        : unsupported
          ? `Cua Driver can't be downloaded for this computer: ${unsupported}.`
          : `Cua Driver ${CUA_DRIVER_VERSION} isn't downloaded yet. Install it in Settings → Computer.`;
    throw new CuaError(message, "unavailable");
  }
  if (wantedDriver() !== wanted) throw notWanted();
  // Started by someone else meanwhile.
  if (current?.alive) return current;
  if (starting) return starting;
  starting = startDriver(cmd, wanted).finally(() => {
    starting = null;
  });
  return starting;
}

async function startDriver(cmd: CuaDriverCommand, wanted: string): Promise<CuaDriverClient> {
  const outdated = cmd.source === "installed" && cuaDriverOutdated(cmd.version);
  if (outdated) log.warn(`using cua-driver ${cmd.version ?? "(version unknown)"} at ${cmd.command}, older than the tested ${CUA_DRIVER_VERSION} (${cuaDownloadNote()})`);
  const proc = new LineProcess({ command: cmd.command, args: [...cmd.args, ...mcpArgs()], env: cuaEnv(), name: "cua-driver" });
  let client: CuaDriverClient;
  try {
    const init = await proc.request(
      {
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "godmode", version: config().version } },
      },
      30_000,
    );
    if (init.error) throw new Error((init.error as { message?: string }).message ?? "initialize failed");
    proc.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const info = ((init.result as { serverInfo?: { version?: string } } | undefined)?.serverInfo ?? {}) as { version?: string };
    client = new CuaDriverClient(proc, info.version ?? "unknown", cmd.command);
  } catch (err) {
    await proc.close(500);
    lastError = `Cua Driver could not start: ${err instanceof Error ? err.message : String(err)}`;
    throw new CuaError(lastError, "unavailable");
  }
  if (wantedDriver() !== wanted) {
    await client.close();
    throw notWanted();
  }
  current = client;
  currentOutdated = outdated;
  lastError = null;
  void proc.exited.then((code) => {
    if (current === client) {
      current = null;
      if (code !== 0) log.warn(`Cua Driver exited with code ${code}`);
    }
  });
  // On macOS Godmode's helper draws the agent cursor for every window-share action (Cua Driver's or its own).
  if (!getSettings().computer.agentCursor || process.platform === "darwin") {
    void client.rawCall("set_agent_cursor_enabled", { enabled: false }).catch(() => {});
  }
  log.info(`Cua Driver ${client.version} started (${cmd.source})`);
  return client;
}

export function cuaDriverRunning(): CuaDriverClient | null {
  return current?.alive ? current : null;
}

export async function stopCuaDriver(): Promise<void> {
  const c = current;
  current = null;
  if (c) await c.close();
}

/** What keeps Cua Driver from running: a failed start, a download under way, or one that failed a short while ago. */
export function cuaLastError(): string | null {
  if (lastError) return lastError;
  if (fetching) return DOWNLOADING;
  const failed = recentFetchFailure();
  return failed ? `Cua Driver ${CUA_DRIVER_VERSION} couldn't be downloaded: ${failed.error}` : null;
}

/** Download the pinned Cua Driver (uv). Asked for, so a download that failed a short while ago is tried again. */
export async function installCuaDriver(): Promise<{ ok: boolean; output: string }> {
  if (!resolveUvx()) return { ok: false, output: "uv is not installed yet. Install uv first (Settings → System)." };
  // Already there: nothing to download (and no download that would make it look missing meanwhile).
  const cached = (await binaryViaUv(false)).path;
  if (cached) return { ok: true, output: `${CUA_DRIVER_SPEC} is ready (${cached}).` };
  const path = await fetchPinned();
  return path
    ? { ok: true, output: `${CUA_DRIVER_SPEC} is ready (${path}).` }
    : { ok: false, output: `Could not download ${CUA_DRIVER_SPEC}: ${fetchFailure?.error ?? "unknown error"}. Check your internet connection and try again.` };
}

/**
 * Is Cua Driver downloaded/installed (without downloading anything)? `outdated`: an installed cua-driver older than
 * the pinned version; `fetchable`: Godmode downloads the pinned build when an agent needs the driver; `downloading`:
 * that download is under way.
 */
export async function cuaDriverInstalled(): Promise<{ installed: boolean; source: CuaDriverCommand["source"] | null; path: string | null; version: string | null; outdated: boolean; fetchable: boolean; downloading: boolean }> {
  const cmd = await resolveCuaDriver().catch(() => null);
  const outdated = cmd?.source === "installed" && cuaDriverOutdated(cmd.version);
  return { installed: !!cmd, source: cmd?.source ?? null, path: cmd?.command ?? null, version: cmd?.version ?? null, outdated, fetchable: (!cmd || outdated) && mayFetch(), downloading: !!fetching };
}

/**
 * Canonical key name (keys.ts) → the name Cua Driver takes for it on `platform` (null = none). macOS names keys as
 * its keyboard does: "delete" is ⌫, "forward_delete" is ⌦; on Windows and Linux "delete" is ⌦.
 */
export function cuaKeyName(key: string, platform: NodeJS.Platform = process.platform): string | null {
  const mac = platform === "darwin";
  const map: Record<string, string | null> = {
    enter: "return",
    kpenter: "return",
    backspace: mac ? "delete" : "backspace",
    delete: mac ? "forward_delete" : "delete",
    // A Mac keyboard has none.
    insert: mac ? null : "insert",
    escape: "escape",
    tab: "tab",
    space: "space",
    left: "left",
    right: "right",
    up: "up",
    down: "down",
    home: "home",
    end: "end",
    pageup: "pageup",
    pagedown: "pagedown",
  };
  if (key in map) return map[key] ?? null;
  if (/^f([1-9]|1[0-2])$/.test(key)) return key;
  if (/^[a-z0-9]$/i.test(key)) return key.toLowerCase();
  return null;
}

/** Canonical modifier → Cua Driver's name on `platform` (Linux clicks only know the Super key as "super"). */
export function cuaModifier(mod: string, platform: NodeJS.Platform = process.platform): string {
  if (mod === "alt") return platform === "darwin" ? "option" : "alt";
  if (mod === "cmd" && platform !== "darwin" && platform !== "win32") return "super";
  return mod;
}
