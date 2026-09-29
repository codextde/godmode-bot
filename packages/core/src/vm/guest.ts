/**
 * Godmode's agent inside a VM: what a run needs so that all of its work happens in the VM, never on this Mac.
 *
 * - Browser: Google Chrome runs in the VM (its own profile, DevTools on the guest's loopback) and browser-use's MCP
 *   server runs next to it. Claude Code starts that server as `tart exec -i <vm> …` — stdio through the Tart guest
 *   agent — so no browser starts on the host, and pages, downloads and uploads all stay in the VM.
 * - Computer use: Cua Driver's MCP server (`cua-driver mcp --direct`) runs in the VM the same way and controls its
 *   apps and windows. The Cirrus Labs images grant the Tart guest agent — and so everything started through
 *   `tart exec` — Accessibility and Screen Recording.
 * - Logins: vault fills reach the VM's Chrome over CDP through an SSH port forward (Godmode's key; the guest only lets
 *   this Mac connect, see `provision` in service.ts), so secrets are still typed into the page for the agent.
 *
 * The tools are installed on first use (`prepareGuest`): uv is copied from this Mac (the guest is macOS on Apple
 * silicon too) or comes from its official installer, Chrome from Google's disk image into ~/Applications, and the
 * pinned browser-use and Cua Driver packages are fetched once through uv. Stamps in ~/.godmode make later runs skip
 * all of it; a reset VM starts over.
 */
import { existsSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import { BROWSER_USE_SPEC, BROWSER_USE_VERSION, browserUseConfig } from "../browser/browserUse";
import { CdpClient, pickActivePage, probeCdp } from "../browser/cdp";
import { findFreePort } from "../browser/chrome";
import { fillIntoActivePage, fillPrecheck, type FillOptions, type FillResult } from "../browser/fill";
import { CUA_DRIVER_SPEC, CUA_DRIVER_VERSION } from "../computer/cua";
import { logger } from "../log";
import { resolveUvx } from "../services/doctor";
import type { McpServerJson } from "../types";
import { GUEST_USER, execInVm, onVmStopped, shq, sshKeyPath, vmAddress, vmName } from "./service";
import { TartError, resolveTart, tartEnv } from "./tart";

const log = logger("vm");

/** Chrome's DevTools port in the guest (loopback only). */
export const GUEST_CDP_PORT = 9322;
const CHROME_DMG = "https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg";
const UV_INSTALLER = "https://astral.sh/uv/install.sh";
/** browser-use's profile entry in the guest's config.json (any stable id). */
const BROWSER_PROFILE_ID = "6f1c7a52-3d0e-4d8b-9a41-0c5e2b7d9f13";
const INSTALL_TIMEOUT_MS = 15 * 60_000;
/** A tool that failed to install isn't tried again for this long (every run would wait for the same failure). */
const RETRY_AFTER_MS = 10 * 60_000;

type Tool = "uv" | "chrome" | "browser-use" | "cua";

const TOOL_LABEL: Record<Tool, string> = { uv: "uv", chrome: "Google Chrome", "browser-use": "browser-use", cua: "Cua Driver" };

/* ------------------------------------------------------------------ */
/* Guest scripts                                                        */
/* ------------------------------------------------------------------ */

const KIT = '"$HOME/.godmode"';
const UV = '"$HOME/.godmode/bin/uv"';
const CHROME_APP = '"$HOME/Applications/Google Chrome.app"';
const BROWSER_STAMP = `"$HOME/.godmode/stamps/browser-use-${BROWSER_USE_VERSION}"`;
const CUA_STAMP = `"$HOME/.godmode/stamps/cua-driver-${CUA_DRIVER_VERSION}"`;
const CDP_UP = `curl -fsS -m 2 http://127.0.0.1:${GUEST_CDP_PORT}/json/version >/dev/null 2>&1`;

const CHROME_FLAGS = [
  `--remote-debugging-port=${GUEST_CDP_PORT}`,
  "--remote-debugging-address=127.0.0.1",
  '"--user-data-dir=$HOME/.godmode/browser-profile"',
  "--no-first-run",
  "--no-default-browser-check",
  // No keychain prompt can block an unattended browser.
  "--use-mock-keychain",
  "--disable-features=Translate,MediaRouter",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
].join(" ");

/** Lines "uv", "chrome", "browser-use=<path>", "cua=<path>" for what is installed. */
const PROBE = [
  `[ -x ${UV} ] && echo uv`,
  `[ -d ${CHROME_APP} ] && echo chrome`,
  `[ -s ${BROWSER_STAMP} ] && p=$(cat ${BROWSER_STAMP}) && [ -x "$p" ] && echo "browser-use=$p"`,
  `[ -s ${CUA_STAMP} ] && p=$(cat ${CUA_STAMP}) && [ -x "$p" ] && echo "cua=$p"`,
  "true",
].join("\n");

/** Start Chrome with DevTools unless it already answers. Output goes to stderr (the MCP wrapper's stdout is JSON-RPC). */
const START_CHROME = `if ! ${CDP_UP}; then
  mkdir -p ${KIT}/browser-profile "$HOME/Downloads"
  open -n -a ${CHROME_APP} --args ${CHROME_FLAGS} >&2
  i=0
  until ${CDP_UP}; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then echo "Google Chrome did not start in the VM." >&2; exit 1; fi
    sleep 0.5
  done
fi`;

/** Warm a pinned package through uv and record `<its env's bin>/<name>` in `stamp`. */
function fetchPackage(spec: string, python: string, stamp: string): string {
  return [
    "set -e",
    `p=$(${UV} tool run --from ${shq(spec)} python -c ${shq(python)})`,
    `[ -x "$p" ] || { echo "${spec} installed, but its program is missing ($p)" >&2; exit 1; }`,
    `mkdir -p ${KIT}/stamps`,
    `printf %s "$p" > ${stamp}`,
  ].join("\n");
}

const INSTALL: Record<Exclude<Tool, "uv">, string> = {
  chrome: [
    "set -e",
    `[ -d ${CHROME_APP} ] && exit 0`,
    "tmp=$(mktemp -d /tmp/godmode-chrome.XXXXXX)",
    `trap 'hdiutil detach -quiet "$tmp/mnt" >/dev/null 2>&1; rm -rf "$tmp"' EXIT`,
    `curl -fsSL --retry 3 -o "$tmp/chrome.dmg" ${shq(CHROME_DMG)}`,
    'mkdir -p "$tmp/mnt"',
    'hdiutil attach -nobrowse -readonly -quiet -mountpoint "$tmp/mnt" "$tmp/chrome.dmg"',
    'mkdir -p "$HOME/Applications"',
    'rm -rf "$HOME/Applications/.Google Chrome.partial"',
    'ditto "$tmp/mnt/Google Chrome.app" "$HOME/Applications/.Google Chrome.partial"',
    `mv "$HOME/Applications/.Google Chrome.partial" ${CHROME_APP}`,
  ].join("\n"),
  "browser-use": fetchPackage(BROWSER_USE_SPEC, 'import os, sys; sys.stdout.write(os.path.join(os.path.dirname(sys.executable), "browser-use"))', BROWSER_STAMP),
  cua: fetchPackage(CUA_DRIVER_SPEC, "import cua_driver, sys; sys.stdout.write(str(cua_driver.get_binary_path()))", CUA_STAMP),
};

/** Environment for everything started in the guest: no telemetry, no update checks. */
const GUEST_ENV = [
  "ANONYMIZED_TELEMETRY=false",
  "BROWSER_USE_CLOUD_SYNC=false",
  "BROWSER_USE_VERSION_CHECK=false",
  "BROWSER_USE_LOGGING_LEVEL=warning",
  'CUA_DRIVER_RS_HOME="$HOME/.godmode/cua-driver"',
  'CUA_DRIVER_TELEMETRY_HOME="$HOME/.godmode/cua-driver"',
  "CUA_DRIVER_RS_TELEMETRY_ENABLED=false",
  "CUA_TELEMETRY_ENABLED=false",
  "CUA_DRIVER_RS_UPDATE_CHECK=0",
].join(" ");

/* ------------------------------------------------------------------ */
/* Install                                                              */
/* ------------------------------------------------------------------ */

interface Installed {
  uv: boolean;
  chrome: boolean;
  browserUse: string | null;
  cua: string | null;
}

async function probe(vmId: string, signal?: AbortSignal): Promise<Installed> {
  const res = await execInVm(vmId, PROBE, { timeoutMs: 30_000, signal });
  const lines = res.stdout.split("\n").map((l) => l.trim());
  const value = (key: string) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) || null;
  return { uv: lines.includes("uv"), chrome: lines.includes("chrome"), browserUse: value("browser-use"), cua: value("cua") };
}

let hostUvOverride: string | null | undefined;

/** Tests: the uv binary to copy into VMs (null = none, so the official installer runs). */
export function __setHostUvForTests(path: string | null | undefined) {
  hostUvOverride = path;
}

/** This Mac's uv binary (next to uvx), which also runs in the guest. */
function hostUv(): string | null {
  if (hostUvOverride !== undefined) return hostUvOverride;
  const uvx = resolveUvx();
  if (!uvx) return null;
  try {
    const uv = join(dirname(realpathSync(uvx)), "uv");
    return existsSync(uv) ? uv : null;
  } catch {
    return null;
  }
}

function failure(res: { exitCode: number | null; stderr: string; stdout: string; timedOut: boolean }): string {
  if (res.timedOut) return "it took too long";
  const lines = `${res.stderr}\n${res.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-2).join(" ").slice(0, 300) || `exit ${res.exitCode}`;
}

async function installUv(vmId: string): Promise<void> {
  const place = `mkdir -p ${KIT}/bin && cat > ${KIT}/bin/uv.partial && chmod 755 ${KIT}/bin/uv.partial && ${KIT}/bin/uv.partial --version >/dev/null && mv ${KIT}/bin/uv.partial ${UV}`;
  const local = hostUv();
  if (local) {
    const copied = await execInVm(vmId, place, { stdin: await Bun.file(local).bytes(), timeoutMs: 120_000 });
    if (copied.exitCode === 0) return;
    log.info(`copying uv into VM ${vmId} failed (${failure(copied)}); using the installer`);
  }
  const res = await execInVm(vmId, `set -e\nmkdir -p ${KIT}/bin\ncurl -LsSf ${shq(UV_INSTALLER)} | env UV_UNMANAGED_INSTALL=${KIT}/bin INSTALLER_NO_MODIFY_PATH=1 sh`, {
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (res.exitCode !== 0) throw new Error(failure(res));
}

async function installTool(vmId: string, tool: Tool): Promise<void> {
  if (tool === "uv") return installUv(vmId);
  const res = await execInVm(vmId, `export ${GUEST_ENV}\n${INSTALL[tool]}`, { timeoutMs: INSTALL_TIMEOUT_MS });
  if (res.exitCode !== 0) throw new Error(failure(res));
}

/** Installs in flight (`<vm>:<tool>`), shared by every run that waits for them. */
const installing = new Map<string, Promise<void>>();
const failed = new Map<string, { at: number; message: string }>();

function install(vmId: string, tool: Tool): Promise<void> {
  const key = `${vmId}:${tool}`;
  const recent = failed.get(key);
  if (recent && Date.now() - recent.at < RETRY_AFTER_MS) return Promise.reject(new Error(recent.message));
  let p = installing.get(key);
  if (!p) {
    log.info(`installing ${TOOL_LABEL[tool]} in VM ${vmId}`);
    p = installTool(vmId, tool)
      .then(() => {
        failed.delete(key);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        failed.set(key, { at: Date.now(), message });
        log.warn(`installing ${TOOL_LABEL[tool]} in VM ${vmId} failed: ${message}`);
        throw err;
      })
      .finally(() => installing.delete(key));
    installing.set(key, p);
  }
  return p;
}

/** Wait for `p` unless `signal` aborts first (the work goes on for whoever else waits for it). */
function until<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    p.then(resolve, reject);
  });
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/* ------------------------------------------------------------------ */
/* Runs                                                                 */
/* ------------------------------------------------------------------ */

export interface GuestTools {
  /** browser-use's program in the guest, with Chrome running next to it — null when the run has no browser. */
  browser: string | null;
  /** Cua Driver's program in the guest — null when computer use in the VM is unavailable. */
  cua: string | null;
  /** What couldn't be set up, for the human. */
  problems: string[];
}

/**
 * Make the VM ready for a run: install what is missing (first use only, shared by concurrent runs) and start Chrome
 * when the run gets a browser. Never throws for a tool that can't be set up — it is left out and named in `problems`.
 */
export async function prepareGuest(
  vmId: string,
  opts: { browser: boolean; onActivity?: (label: string) => void; signal?: AbortSignal },
): Promise<GuestTools> {
  const problems: string[] = [];
  let have = await probe(vmId, opts.signal);
  const wanted: Tool[] = [...(opts.browser ? (["chrome", "browser-use"] as const) : []), "cua"];
  const missing = wanted.filter((t) => (t === "chrome" ? !have.chrome : t === "browser-use" ? !have.browserUse : !have.cua));
  if (missing.length) {
    opts.onActivity?.(`Setting up ${joinNames(missing.map((t) => TOOL_LABEL[t]))} in "${vmName(vmId)}" (first time only)…`);
    try {
      if (!have.uv) await until(install(vmId, "uv"), opts.signal);
      const results = await until(Promise.allSettled(missing.map((t) => install(vmId, t))), opts.signal);
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          problems.push(`${TOOL_LABEL[missing[i]!]} couldn't be installed in the VM: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
        }
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      problems.push(`The VM's browser and computer-use tools need uv, which couldn't be installed: ${err instanceof Error ? err.message : String(err)}`);
    }
    have = await probe(vmId, opts.signal);
  }

  let browser = opts.browser && have.chrome ? have.browserUse : null;
  if (browser) {
    const home = `/Users/${GUEST_USER}`;
    opts.onActivity?.(`Opening Google Chrome in "${vmName(vmId)}"…`);
    const config = browserUseConfig(
      {
        cdpUrl: `http://127.0.0.1:${GUEST_CDP_PORT}`,
        headless: false,
        userDataDir: `${home}/.godmode/browser-profile`,
        downloadsPath: `${home}/Downloads`,
        fileSystemPath: `${home}/.godmode/browser-use/files`,
      },
      BROWSER_PROFILE_ID,
      "2026-01-01T00:00:00.000Z",
      `${home}/.godmode/browser-use`,
    );
    const script = `mkdir -p ${KIT}/browser-use/files && cat > ${KIT}/browser-use/config.json\n${START_CHROME}`;
    const res = await execInVm(vmId, script, { stdin: JSON.stringify(config, null, 2), timeoutMs: 90_000, signal: opts.signal });
    if (res.exitCode !== 0) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      problems.push(`Google Chrome didn't start in the VM: ${failure(res)}`);
      browser = null;
    }
  }
  return { browser, cua: have.cua, problems };
}

/** A stdio MCP server that runs in the guest: Claude Code talks to it through `tart exec -i`. */
function inGuest(vmId: string, script: string): McpServerJson {
  const bin = resolveTart();
  if (!bin) throw new TartError("Tart is not installed. Install it on the Virtual machines page.", "not_installed");
  const all = tartEnv();
  const env: Record<string, string> = {};
  for (const key of ["TART_HOME", "TART_NO_AUTO_PRUNE", "PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR"]) if (all[key]) env[key] = all[key];
  return { command: bin.path, args: ["exec", "-i", vmId, "/bin/zsh", "-l", "-c", script], env };
}

/** browser-use's MCP server in the VM, connected to the VM's Chrome (started again if it was closed). */
export function guestBrowserServer(vmId: string, browserUse: string): McpServerJson {
  return inGuest(vmId, `{\n${START_CHROME}\n} >&2 || exit 1\nexport BROWSER_USE_CONFIG_DIR=${KIT}/browser-use ${GUEST_ENV}\nexec ${shq(browserUse)} --mcp`);
}

/**
 * Cua Driver tools a run doesn't get: its own browser (the run's browser is browser-use's Chrome, where vault fills
 * land) and managing the driver itself (updates, extensions, recordings, settings).
 */
export const CUA_HIDDEN_TOOLS = [
  "get_browser_state",
  "browser_prepare",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_dialog",
  "browser_set_input_files",
  "browser_download",
  "browser_pointer",
  "install_extension",
  "check_for_update",
  "install_ffmpeg",
  "set_config",
  "start_recording",
  "stop_recording",
  "get_recording_state",
  "replay_trajectory",
];

/** Cua Driver's MCP server in the VM (computer use: its apps, windows and accessibility elements). */
export function guestCuaServer(vmId: string, cua: string): McpServerJson {
  return inGuest(vmId, `export ${GUEST_ENV}\nexec ${shq(cua)} mcp --direct`);
}

/* ------------------------------------------------------------------ */
/* The VM's Chrome from this Mac (vault fills)                          */
/* ------------------------------------------------------------------ */

interface Tunnel {
  port: number;
  proc: Subprocess;
}

const tunnels = new Map<string, Promise<Tunnel>>();
let cdpOverride: ((vmId: string) => number | null) | null = null;

/** Tests: the local port where a VM's Chrome answers (instead of an SSH port forward). */
export function __setGuestCdpForTests(fn: ((vmId: string) => number | null) | null) {
  cdpOverride = fn;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function openTunnel(vmId: string): Promise<Tunnel> {
  const ip = await vmAddress(vmId);
  if (!ip) throw new Error("The VM isn't running.");
  const port = findFreePort();
  const proc = Bun.spawn(
    [
      "/usr/bin/ssh",
      "-i",
      sshKeyPath(),
      "-N",
      "-L",
      `127.0.0.1:${port}:127.0.0.1:${GUEST_CDP_PORT}`,
      ...["BatchMode=yes", "StrictHostKeyChecking=no", "UserKnownHostsFile=/dev/null", "LogLevel=ERROR", "ExitOnForwardFailure=yes", "ConnectTimeout=10", "ServerAliveInterval=15", "ServerAliveCountMax=3"].flatMap((o) => ["-o", o]),
      `${GUEST_USER}@${ip}`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      const err = (await new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "")).trim();
      throw new Error(err.split("\n").pop() || "SSH to the VM failed");
    }
    if (await listening(port)) return { port, proc };
    await Bun.sleep(150);
  }
  proc.kill();
  throw new Error("SSH to the VM timed out");
}

let watching = false;

async function tunnelPort(vmId: string): Promise<number> {
  // Registered on first use: vm/service is still loading when this module is (they import each other indirectly).
  if (!watching) {
    watching = true;
    onVmStopped(closeTunnel);
  }
  if (cdpOverride) {
    const port = cdpOverride(vmId);
    if (!port) throw new Error("The VM isn't running.");
    return port;
  }
  const existing = tunnels.get(vmId);
  if (existing) {
    const t = await existing.catch(() => null);
    if (t && t.proc.exitCode === null && t.proc.signalCode === null) return t.port;
    if (tunnels.get(vmId) === existing) tunnels.delete(vmId);
  }
  const p = openTunnel(vmId);
  tunnels.set(vmId, p);
  p.catch(() => {
    if (tunnels.get(vmId) === p) tunnels.delete(vmId);
  });
  return (await p).port;
}

function closeTunnel(vmId: string) {
  const p = tunnels.get(vmId);
  tunnels.delete(vmId);
  void p?.then((t) => t.proc.kill()).catch(() => undefined);
}

export function closeGuestTunnels(): void {
  for (const vmId of [...tunnels.keys()]) closeTunnel(vmId);
}

/** A CDP connection to the VM's Chrome, or null when Chrome isn't running there. */
async function guestBrowser(vmId: string): Promise<{ client: CdpClient; port: number } | null> {
  const port = await tunnelPort(vmId);
  const version = await probeCdp(port, 3000);
  if (!version) return null;
  // The guest names its own port in the URL.
  const ws = new URL(version.webSocketDebuggerUrl);
  ws.hostname = "127.0.0.1";
  ws.port = String(port);
  return { client: await CdpClient.connect(ws.toString()), port };
}

/** Fill a secret into the active page of the VM's Chrome (see browser/fill.ts); the value never reaches the result. */
export async function fillIntoVm(vmId: string, opts: FillOptions & { urlContains?: string }): Promise<FillResult> {
  const refused = fillPrecheck(opts);
  if (refused) return refused;
  let browser: Awaited<ReturnType<typeof guestBrowser>>;
  try {
    browser = await guestBrowser(vmId);
  } catch (err) {
    return { ok: false, url: "", detail: `Could not reach the browser in the VM: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!browser) return { ok: false, url: "", detail: "The browser in the VM is not running. Open the login page with the browser tools first." };
  try {
    return await fillIntoActivePage(browser, opts);
  } finally {
    browser.client.close();
  }
}

/** URL and title of the page the VM's Chrome shows, or null. */
export async function currentVmPage(vmId: string): Promise<{ url: string; title: string } | null> {
  let browser: Awaited<ReturnType<typeof guestBrowser>> = null;
  try {
    browser = await guestBrowser(vmId);
    const page = browser ? await pickActivePage(browser.client, { port: browser.port }) : null;
    return page ? { url: page.url, title: page.title } : null;
  } catch {
    return null;
  } finally {
    browser?.client.close();
  }
}
