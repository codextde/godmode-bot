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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { logger } from "../log";
import { getSettings } from "../services/settings";
import { resolveUvx, runCommand, stripAnsi, toolPath } from "../services/doctor";
import { splitCommand } from "../browser/browserUse";
import { which } from "../util";
import { LineProcess } from "./lineProcess";

const log = logger("computer");

export const CUA_DRIVER_VERSION = "0.30.4";
export const CUA_DRIVER_SPEC = `cua-driver==${CUA_DRIVER_VERSION}`;
const PROTOCOL_VERSION = "2025-06-18";
/** Stop the driver after this long without calls (it is restarted on demand). */
const IDLE_STOP_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 45_000;

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

/** Path of the cua-driver binary bundled in the PyPI package (downloads it when `install`). */
async function binaryViaUv(install: boolean): Promise<string | null> {
  if (resolvedBinary?.spec === CUA_DRIVER_SPEC && existsSync(resolvedBinary.path)) return resolvedBinary.path;
  const uvx = resolveUvx();
  if (!uvx) return null;
  const script = "import cua_driver,sys; sys.stdout.write(str(cua_driver.get_binary_path()))";
  const args = [uvx, ...(install ? [] : ["--offline"]), "--from", CUA_DRIVER_SPEC, "python", "-c", script];
  const res = await runCommand(args, { timeoutMs: install ? 10 * 60_000 : 60_000, env: { ...cuaEnv(), PATH: toolPath() } });
  const path = stripAnsi(res.stdout).trim().split("\n").pop()?.trim() ?? "";
  if (res.code !== 0 || !path || !existsSync(path)) {
    if (install) log.warn(`could not install ${CUA_DRIVER_SPEC}: ${stripAnsi(res.stderr).trim().slice(-400)}`);
    return null;
  }
  resolvedBinary = { spec: CUA_DRIVER_SPEC, path };
  return path;
}

/** A standalone cua-driver (official installer: ~/.local/bin/cua-driver, or on PATH). */
function installedBinary(): string | null {
  const exe = process.platform === "win32" ? "cua-driver.exe" : "cua-driver";
  const candidates = [which("cua-driver"), join(homedir(), ".local", "bin", exe)];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Programs", "cua-driver", exe));
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

/**
 * The command that starts Cua Driver: the custom command from settings, else the pinned PyPI build via uv, else an
 * installed cua-driver. `install` downloads the pinned build when it isn't cached yet.
 */
export async function resolveCuaDriver(opts: { install?: boolean } = {}): Promise<{ command: string; args: string[]; source: "custom" | "uv" | "installed" } | null> {
  const custom = getSettings().computer.cuaDriverCommand?.trim();
  if (custom) {
    const parts = splitCommand(custom);
    if (parts.length) {
      const command = parts[0]!;
      return { command: which(command) ?? command, args: parts.slice(1), source: "custom" };
    }
  }
  const viaUv = await binaryViaUv(!!opts.install);
  if (viaUv) return { command: viaUv, args: [], source: "uv" };
  const installed = installedBinary();
  if (installed) return { command: installed, args: [], source: "installed" };
  return null;
}

/** Environment for cua-driver: no telemetry, no update checks, its state under Godmode's data dir. */
export function cuaEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "SYSTEMROOT", "ComSpec", "PATH", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  let home: string;
  try {
    home = join(config().dataDir, "cua-driver");
  } catch {
    home = join(homedir(), ".godmode", "cua-driver");
  }
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

  /** Pointer action at a window-local point (points). */
  pointer(
    kind: "click" | "double_click" | "right_click" | "move",
    target: { pid: number; windowId: number },
    local: { x: number; y: number },
    opts: { button?: "left" | "right" | "middle"; count?: number; modifiers?: string[]; delivery?: Delivery; maxDimension: number; size?: { width: number; height: number } },
  ): Promise<CuaResult> {
    return this.exclusive(async () => {
      const px = await this.pixelFor(target.pid, target.windowId, local, opts.maxDimension, opts.size);
      const base = { target: { kind: "window", pid: target.pid, window_id: target.windowId }, x: px.x, y: px.y };
      if (kind === "move") return this.call("move_cursor", base);
      const args: Record<string, unknown> = { ...base, ...(opts.delivery ? { delivery_mode: opts.delivery } : {}) };
      if (opts.modifiers?.length) args.modifier = opts.modifiers;
      if (kind === "click") {
        if (opts.button && opts.button !== "left") args.button = opts.button;
        if (opts.count && opts.count > 1) args.count = opts.count;
      }
      return this.call(kind, args);
    });
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
    return this.exclusive(async () => {
      const args: Record<string, unknown> = { pid: target.pid, window_id: target.windowId, direction, amount };
      if (opts.element) args.element_token = opts.element;
      else if (local) Object.assign(args, await this.pixelFor(target.pid, target.windowId, local, opts.maxDimension, opts.size));
      if (opts.delivery) args.delivery_mode = opts.delivery;
      return this.call("scroll", args);
    });
  }

  drag(
    target: { pid: number; windowId: number },
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts: { button?: "left" | "right" | "middle"; modifiers?: string[]; delivery?: Delivery; maxDimension: number; size?: { width: number; height: number } },
  ): Promise<CuaResult> {
    return this.exclusive(async () => {
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
let starting: Promise<CuaDriverClient> | null = null;
let lastError: string | null = null;

/** `cua-driver mcp` arguments: on macOS the MCP process owns the runtime (TCC grants of the app running Godmode). */
function mcpArgs(): string[] {
  const args = ["mcp"];
  if (process.platform === "darwin") args.push("--direct");
  if (!getSettings().computer.agentCursor) args.push("--cursor-reduced-motion", "on");
  return args;
}

/** The running Cua Driver (started on demand). Throws CuaError("unavailable") when it can't be provided. */
export async function getCuaDriver(): Promise<CuaDriverClient> {
  if (!getSettings().computer.useCuaDriver) throw new CuaError("Cua Driver is turned off in Settings → Computer.", "unavailable");
  if (current?.alive) return current;
  if (starting) return starting;
  starting = (async () => {
    const cmd = await resolveCuaDriver();
    if (!cmd) {
      lastError = `Cua Driver is not installed. Install it in Settings → Computer (downloads ${CUA_DRIVER_SPEC} with uv).`;
      throw new CuaError(lastError, "unavailable");
    }
    const proc = new LineProcess({ command: cmd.command, args: [...cmd.args, ...mcpArgs()], env: cuaEnv(), name: "cua-driver" });
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
      const client = new CuaDriverClient(proc, info.version ?? "unknown", cmd.command);
      current = client;
      lastError = null;
      void proc.exited.then((code) => {
        if (current === client) {
          current = null;
          if (code !== 0) log.warn(`Cua Driver exited with code ${code}`);
        }
      });
      if (!getSettings().computer.agentCursor) {
        void client.rawCall("set_agent_cursor_enabled", { enabled: false }).catch(() => {});
      }
      log.info(`Cua Driver ${client.version} started (${cmd.source})`);
      return client;
    } catch (err) {
      await proc.close(500);
      lastError = `Cua Driver could not start: ${err instanceof Error ? err.message : String(err)}`;
      throw new CuaError(lastError, "unavailable");
    }
  })().finally(() => {
    starting = null;
  });
  return starting;
}

export function cuaDriverRunning(): CuaDriverClient | null {
  return current?.alive ? current : null;
}

export async function stopCuaDriver(): Promise<void> {
  const c = current;
  current = null;
  if (c) await c.close();
}

export function cuaLastError(): string | null {
  return lastError;
}

/** Download the pinned Cua Driver (uv). */
export async function installCuaDriver(): Promise<{ ok: boolean; output: string }> {
  if (!resolveUvx()) return { ok: false, output: "uv is not installed yet. Install uv first (Settings → System)." };
  resolvedBinary = null;
  const path = await binaryViaUv(true);
  return path ? { ok: true, output: `${CUA_DRIVER_SPEC} is ready (${path}).` } : { ok: false, output: `Could not download ${CUA_DRIVER_SPEC}. Check your internet connection and try again.` };
}

/** Is Cua Driver downloaded/installed (without downloading anything)? */
export async function cuaDriverInstalled(): Promise<{ installed: boolean; source: string | null; path: string | null }> {
  const cmd = await resolveCuaDriver().catch(() => null);
  return { installed: !!cmd, source: cmd?.source ?? null, path: cmd?.command ?? null };
}

/** Canonical key name (keys.ts) → Cua Driver key name. null when Cua Driver has no name for it. */
export function cuaKeyName(key: string): string | null {
  const map: Record<string, string> = {
    enter: "return",
    kpenter: "return",
    backspace: "delete",
    delete: "forwarddelete",
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
  if (map[key]) return map[key]!;
  if (/^f([1-9]|1[0-2])$/.test(key)) return key;
  if (/^[a-z0-9]$/i.test(key)) return key.toLowerCase();
  return null;
}

export function cuaModifier(mod: string): string {
  return mod === "alt" ? (process.platform === "darwin" ? "option" : "alt") : mod;
}
