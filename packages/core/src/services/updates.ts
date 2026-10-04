/**
 * Updates of the tools Godmode relies on (Settings → System): which installed tool has a newer version, and
 * installing it.
 *
 * A tool follows one of three tracks. "release": its own releases (Claude Code, uv, Playwright's Chromium).
 * "pinned": the version this Godmode release was tested with (browser-use, Cua Driver, claude-mem, Tart) — an update
 * is due when Godmode itself was updated and now uses a newer one. "external": the system or a package manager keeps
 * it current (git, Google Chrome, anything from Homebrew), so Godmode only shows the version.
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolId, ToolUpdateResult, ToolUpdateStatus, UpdateReport } from "@godmode/shared";
import { BROWSER_USE_VERSION } from "../browser/browserUse";
import { findChrome, playwrightChromiumCandidates, type DetectOptions } from "../browser/chrome";
import { allRunning } from "../browser/state";
import { CUA_DRIVER_VERSION, cuaDriverInstalled } from "../computer/cua";
import { config } from "../config";
import { logger } from "../log";
import { CLAUDE_MEM_VERSION, claudeMemStatus } from "../memory/claudeMem";
import { childEnv, now } from "../util";
import { installTart } from "../vm/service";
import { TART_VERSION, listVms, resolveTart, tartVersion, vmSupport } from "../vm/tart";
import { claudeAutoUpdatesDisabled, claudeUpdateStatus, compareVersions, isPackageManaged, updateClaude } from "./claudeUpdate";
import { chromeVersion, doctorGeneration, exe, installDependency, isFile, resetDoctorCache, resolveClaudeBinary, resolveUvx, runCommand, runDoctor, runInstaller, stripAnsi, toolPath, versionFrom } from "./doctor";
import { onSettingsApplied } from "./runtime";
import { getSettings } from "./settings";

const log = logger("updates");

export const UV_RELEASE_URL = "https://pypi.org/pypi/uv/json";
const REPORT_TTL_MS = 30 * 60_000;
const LATEST_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 3 * 60_000;

export const TOOL_IDS = ["claude", "uv", "browser-use", "chrome", "git", "claude-mem", "cua-driver", "tart"] as const satisfies readonly ToolId[];

const NAMES: Record<ToolId, string> = {
  claude: "Claude Code",
  uv: "uv",
  "browser-use": "browser-use",
  chrome: "Chromium",
  git: "git",
  "claude-mem": "claude-mem",
  "cua-driver": "Cua Driver",
  tart: "Tart",
};

const PACKAGE_MANAGED = "Installed with a package manager — update it there";
/** What an update answers when the release feed gave no answer: neither done nor failed, just not known yet. */
export const NEWEST_UNKNOWN = "Couldn't find out whether there is a newer version. Try again later.";
const PINNED = "The version this Godmode release was tested with";

function missing(id: ToolId, track: ToolUpdateStatus["track"], latest: string | null = null): ToolUpdateStatus {
  return { id, name: NAMES[id], installed: false, current: null, latest, updateAvailable: false, updatable: false, track, detail: "Not installed" };
}

function external(id: ToolId, current: string | null, detail: string): ToolUpdateStatus {
  return { id, name: NAMES[id], installed: true, current, latest: null, updateAvailable: false, updatable: false, track: "external", detail };
}

/* ------------------------------------------------------------------ */
/* What Godmode remembers about its tools                               */
/* ------------------------------------------------------------------ */

/**
 * `<data>/tools.json`. Pinned tools that live in uv's cache leave no trace of the version an older Godmode used, so
 * the ones seen working are noted here: that tells "never installed" from "installed, and now out of date". It also
 * keeps what was learned the hard way — a uv that refuses to update itself.
 */
type Ledger = Record<string, string>;

const UV_NO_SELF_UPDATE = "uv-self-update";

const ledgerPath = () => join(config().dataDir, "tools.json");

function readLedger(): Ledger {
  try {
    const value: unknown = JSON.parse(readFileSync(ledgerPath(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Ledger) : {};
  } catch {
    return {};
  }
}

function remember(key: string, value: string) {
  const ledger = readLedger();
  if (ledger[key] === value) return;
  try {
    writeFileSync(ledgerPath(), JSON.stringify({ ...ledger, [key]: value }, null, 2), { mode: 0o600 });
  } catch (err) {
    log.debug(`could not note ${key}`, err);
  }
}

/**
 * Status of a tool whose version Godmode pins. `previous` is the version found instead of the pinned one (null =
 * none); `canInstall` whether Godmode can download the pinned one.
 */
function pinned(id: ToolId, version: string, state: { ready: boolean; previous: string | null; canInstall: boolean }): ToolUpdateStatus {
  const base = { id, name: NAMES[id], latest: version, track: "pinned" as const, updatable: state.canInstall };
  if (state.ready) return { ...base, installed: true, current: version, updateAvailable: false, detail: PINNED };
  if (!state.previous) return { ...base, installed: false, current: null, updateAvailable: false, detail: "Not installed" };
  const older = state.previous !== version;
  return {
    ...base,
    installed: true,
    current: older ? state.previous : null,
    updateAvailable: state.canInstall,
    detail: older ? `This Godmode release uses ${version}` : `${version} has to be downloaded again`,
  };
}

/* ------------------------------------------------------------------ */
/* Per tool                                                             */
/* ------------------------------------------------------------------ */

async function claudeStatus(refresh: boolean): Promise<ToolUpdateStatus> {
  const path = resolveClaudeBinary();
  const status = await claudeUpdateStatus(refresh);
  if (!path || !status.current) return missing("claude", "release", status.latest);
  if (isPackageManaged(path)) return external("claude", status.current, PACKAGE_MANAGED);
  return {
    id: "claude",
    name: NAMES.claude,
    installed: true,
    current: status.current,
    latest: status.latest,
    updateAvailable: status.updateAvailable,
    updatable: true,
    track: "release",
    detail: claudeAutoUpdatesDisabled()
      ? "Claude Code's own auto-updater is turned off, so Godmode only updates it when you ask"
      : `Follows Claude Code's ${status.channel} channel`,
  };
}

const latestCache = new Map<string, { at: number; value: string }>();

async function latestUv(refresh: boolean): Promise<string | null> {
  const cached = latestCache.get("uv");
  if (!refresh && cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.value;
  try {
    const res = await fetch(UV_RELEASE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const version = ((await res.json()) as { info?: { version?: unknown } }).info?.version;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) throw new Error("unexpected response");
    latestCache.set("uv", { at: Date.now(), value: version });
    return version;
  } catch (err) {
    log.debug(`latest uv version check failed: ${err instanceof Error ? err.message : String(err)}`);
    return cached?.value ?? null;
  }
}

/** `uv` itself, next to its launcher uvx. Only that one: another uv on the PATH is a different installation. */
function uvBinary(uvx: string): string | null {
  const sibling = join(dirname(uvx), exe("uv"));
  return isFile(sibling) ? sibling : null;
}

/** uv only updates itself when it came from its own installer; from pip, cargo or a package manager it refuses. */
const UV_REFUSES = /cannot update itself|external package manager|only available for uv binaries|standalone installation/i;

async function uvVersion(uvx: string): Promise<string | null> {
  const res = await runCommand([uvx, "--version"], { timeoutMs: 20_000 });
  return res.code === 0 ? versionFrom(res.stdout) : null;
}

async function uvStatus(refresh: boolean): Promise<ToolUpdateStatus> {
  const uvx = resolveUvx();
  const current = uvx ? await uvVersion(uvx) : null;
  if (!uvx || !current) return missing("uv", "release");
  const uv = uvBinary(uvx);
  if (isPackageManaged(uvx) || !uv || readLedger()[UV_NO_SELF_UPDATE] === `${uv} ${current}`) return external("uv", current, PACKAGE_MANAGED);
  const latest = await latestUv(refresh);
  return {
    id: "uv",
    name: NAMES.uv,
    installed: true,
    current,
    latest,
    updateAvailable: !!latest && compareVersions(latest, current) > 0,
    updatable: true,
    track: "release",
    detail: "Follows uv's releases",
  };
}

async function updateUv(): Promise<{ ok: boolean; output: string }> {
  const uvx = resolveUvx();
  const uv = uvx && uvBinary(uvx);
  if (!uv) return { ok: false, output: "uv was not found." };
  const result = await runInstaller([uv, "self", "update"]);
  // Learned once, kept until this uv changes: it is its package manager's to update. (A uv installed anew, with its
  // own installer, has another version — and gets asked again.)
  if (!result.ok && UV_REFUSES.test(result.output)) remember(UV_NO_SELF_UPDATE, `${uv} ${await uvVersion(uvx)}`);
  return result;
}

/** `playwright install chromium --dry-run`: the build the newest Playwright uses, and where it goes. */
export function parsePlaywrightDryRun(output: string): { version: string | null; location: string | null } | null {
  const block = output.split(/^browser: /m).find((b) => /^chromium(\s|$)/.test(b));
  if (!block) return null;
  return {
    version: block.match(/^chromium version (\S+)/)?.[1] ?? null,
    location: block.match(/^\s*Install location:\s+(.+)$/m)?.[1]?.trim() ?? null,
  };
}

let playwrightProbe: { at: number; value: ReturnType<typeof parsePlaywrightDryRun> } | null = null;

/**
 * The probe runs the newest Playwright, which uv may have to download first. That is more than a look at a version
 * number, so it only happens when someone asks for a fresh check — never just because the page was opened.
 */
async function newestChromium(uvx: string, refresh: boolean) {
  if (!refresh) return playwrightProbe && Date.now() - playwrightProbe.at < LATEST_TTL_MS ? playwrightProbe.value : null;
  const res = await runCommand([uvx, "playwright@latest", "install", "chromium", "--no-shell", "--dry-run"], {
    timeoutMs: PROBE_TIMEOUT_MS,
    env: childEnv({ PATH: toolPath() }),
  });
  const value = res.code === 0 ? parsePlaywrightDryRun(stripAnsi(res.stdout)) : null;
  if (!value) log.debug(`could not look up the newest Chromium build (exit ${res.code})`);
  playwrightProbe = { at: Date.now(), value };
  return value;
}

let chromeDetection: DetectOptions | undefined;

/** Tests: where browsers are looked for (so the machine's own Chrome doesn't win). undefined = the real places. */
export function __setChromeDetectionForTests(opts: DetectOptions | undefined) {
  chromeDetection = opts;
}

async function chromeStatus(refresh: boolean): Promise<ToolUpdateStatus> {
  const found = findChrome(getSettings().browser.chromePath, chromeDetection);
  if (!found) return missing("chrome", "release");
  const current = await chromeVersion(found.path);
  // A browser picked in the settings stays the one Godmode starts, whatever gets downloaded next to it.
  if (found.browser === "Custom") return external("chrome", current, "Your own browser (Settings → Browser)");
  // Chrome, Edge and Brave update themselves; only the build Playwright downloaded is Godmode's to refresh.
  if (!playwrightChromiumCandidates(chromeDetection).some((c) => c.path === found.path)) return external("chrome", current, `${found.browser} keeps itself up to date`);
  const uvx = resolveUvx();
  const newest = uvx ? await newestChromium(uvx, refresh) : null;
  const latest = newest?.version ?? null;
  // Playwright marks a finished download; a folder without the mark is a download that broke off.
  const updateAvailable = !!newest && (newest.location ? !existsSync(join(newest.location, "INSTALLATION_COMPLETE")) : !!latest && !!current && compareVersions(latest, current) > 0);
  return { id: "chrome", name: NAMES.chrome, installed: true, current, latest, updateAvailable, updatable: !!uvx, track: "release", detail: "Downloaded by Playwright" };
}

async function gitStatus(refresh: boolean): Promise<ToolUpdateStatus> {
  // From the system check: it knows not to wake the Command Line Tools installer on macOS.
  const git = (await runDoctor(refresh)).dependencies.find((d) => d.id === "git");
  if (!git?.ok) return missing("git", "external");
  const by = process.platform === "darwin" && git.path === "/usr/bin/git" ? "macOS updates it with the Command Line Tools" : process.platform === "win32" ? "Update it with Git for Windows" : "Your package manager updates it";
  return external("git", git.version, by);
}

async function browserUseStatus(refresh: boolean): Promise<ToolUpdateStatus> {
  const uvx = resolveUvx();
  // The system check knows whether the pinned version is downloaded (and never downloads it as a side effect).
  const ready = !!(await runDoctor(refresh)).dependencies.find((d) => d.id === "browser-use")?.ok;
  if (getSettings().browser.browserUseCommand.trim()) {
    return external("browser-use", ready ? BROWSER_USE_VERSION : null, "Started with your own command (Settings → Browser)");
  }
  if (ready) remember("browser-use", BROWSER_USE_VERSION);
  return pinned("browser-use", BROWSER_USE_VERSION, { ready, previous: readLedger()["browser-use"] ?? null, canInstall: !!uvx });
}

async function cuaDriverStatus(): Promise<ToolUpdateStatus> {
  const found = await cuaDriverInstalled();
  if (found.installed && found.source !== "uv") {
    return external("cua-driver", null, found.source === "custom" ? "Started with your own command (Settings → Computer)" : "Your own cua-driver — update it with its installer");
  }
  if (found.installed) remember("cua-driver", CUA_DRIVER_VERSION);
  return pinned("cua-driver", CUA_DRIVER_VERSION, { ready: found.installed, previous: readLedger()["cua-driver"] ?? null, canInstall: !!resolveUvx() });
}

const claudeMemRoot = () => join(config().dataDir, "plugins", "claude-mem");

/** Versions of claude-mem unpacked in the data folder, newest first. */
function claudeMemVersions(): string[] {
  try {
    return readdirSync(claudeMemRoot())
      .filter((v) => /^\d+\.\d+/.test(v) && existsSync(join(claudeMemRoot(), v, "plugin", ".claude-plugin", "plugin.json")))
      .sort((a, b) => compareVersions(b, a));
  } catch {
    return [];
  }
}

function claudeMemToolStatus(): ToolUpdateStatus {
  const status = claudeMemStatus();
  const previous = claudeMemVersions().find((v) => v !== CLAUDE_MEM_VERSION) ?? null;
  return pinned("claude-mem", CLAUDE_MEM_VERSION, { ready: status.installed, previous, canInstall: status.nodeAvailable });
}

async function tartStatus(): Promise<ToolUpdateStatus | null> {
  if (!vmSupport().supported) return null;
  const bin = resolveTart();
  if (!bin) return missing("tart", "pinned", TART_VERSION);
  const version = await tartVersion();
  if (!bin.managed) return external("tart", version, getSettings().vm.tartPath.trim() ? "Your own tart binary (Settings → Virtual machines)" : PACKAGE_MANAGED);
  const ready = !!version && compareVersions(version, TART_VERSION) >= 0;
  // A copy that doesn't start anymore still counts as installed: download it again.
  return pinned("tart", TART_VERSION, { ready, previous: version ?? TART_VERSION, canInstall: true });
}

function toolStatus(id: ToolId, refresh: boolean): Promise<ToolUpdateStatus | null> | ToolUpdateStatus {
  switch (id) {
    case "claude":
      return claudeStatus(refresh);
    case "uv":
      return uvStatus(refresh);
    case "browser-use":
      return browserUseStatus(refresh);
    case "chrome":
      return chromeStatus(refresh);
    case "git":
      return gitStatus(refresh);
    case "claude-mem":
      return claudeMemToolStatus();
    case "cua-driver":
      return cuaDriverStatus();
    case "tart":
      return tartStatus();
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                               */
/* ------------------------------------------------------------------ */

/** `generation`: the system check's change counter when the report was made — any install since then outdates it. */
let cached: { at: number; generation: number; report: UpdateReport } | null = null;
let inflight: Promise<UpdateReport> | null = null;

/** Tests: forget every cached report and release feed. */
export function __resetUpdatesForTests() {
  cached = null;
  latestCache.clear();
  playwrightProbe = null;
}

// Another browser, command or binary in the settings is another tool to report on.
onSettingsApplied(() => {
  cached = null;
});

/** Every tool with its installed and newest version. `refresh` asks the release feeds again. */
export async function checkUpdates(refresh = false): Promise<UpdateReport> {
  if (!refresh && cached && cached.generation === doctorGeneration() && Date.now() - cached.at < REPORT_TTL_MS) return cached.report;
  if (inflight) return inflight;
  inflight = (async () => {
    // Stamped before looking: whatever gets installed while this runs outdates the result.
    const generation = doctorGeneration();
    const tools = (await Promise.all(TOOL_IDS.map((id) => toolStatus(id, refresh)))).filter((t): t is ToolUpdateStatus => !!t);
    const report: UpdateReport = { checkedAt: now(), tools };
    cached = { at: Date.now(), generation, report };
    return report;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Tools with an update Godmode can install. */
export function dueUpdates(report: UpdateReport): ToolUpdateStatus[] {
  return report.tools.filter((t) => t.installed && t.updatable && t.updateAvailable);
}

/** Tools the background upkeep leaves to the human, with the reason (null = it may update them). */
export function leftToHuman(id: ToolId): string | null {
  return id === "claude" && claudeAutoUpdatesDisabled() ? "Claude Code's own auto-updater is turned off" : null;
}

/* ------------------------------------------------------------------ */
/* Update                                                               */
/* ------------------------------------------------------------------ */

/** Why a tool can't be replaced right now (null = it can): something runs from, or was saved by, what an update removes. */
export async function updateBlocked(id: ToolId): Promise<string | null> {
  if (id === "chrome" && allRunning().length) return "Godmode's browser is open — Chromium is updated once it is closed.";
  if (id === "tart") {
    // A suspended VM was saved by this Tart; whether the next one can wake it is not worth finding out the hard way.
    const inUse = await listVms()
      .then((vms) => vms.some((vm) => vm.state !== "stopped"))
      .catch(() => false);
    if (inUse) return "A virtual machine is running or suspended — Tart is updated once every VM is stopped.";
  }
  return null;
}

async function runUpdate(id: ToolId): Promise<{ ok: boolean; output: string }> {
  switch (id) {
    case "claude":
      return updateClaude();
    case "uv":
      return updateUv();
    case "chrome": {
      const uvx = resolveUvx();
      return uvx ? runInstaller([uvx, "playwright@latest", "install", "chromium", "--no-shell"]) : { ok: false, output: "uv is not installed." };
    }
    case "browser-use":
    case "cua-driver":
      return installDependency(id);
    case "claude-mem": {
      const result = await installDependency(id);
      // Each version is unpacked into its own folder; the ones before the pinned one are dead weight now.
      if (result.ok) for (const v of claudeMemVersions()) if (v !== CLAUDE_MEM_VERSION) rmSync(join(claudeMemRoot(), v), { recursive: true, force: true });
      return result;
    }
    case "tart":
      return installTart();
    case "git":
      return { ok: false, output: "git is updated by the system." };
  }
}

/** Install the update of one tool. Callers take turns (see maintenance.ts): two updaters never run side by side. */
export async function updateTool(id: ToolId): Promise<ToolUpdateResult> {
  let before = (TOOL_IDS as readonly string[]).includes(id) ? await toolStatus(id, false) : null;
  // "Not due" has to be known, not assumed: where the newest version isn't known right now, ask before deciding.
  if (before?.updatable && !before.updateAvailable && before.track === "release" && before.latest === null) before = await toolStatus(id, true);
  if (!before) return { id, name: NAMES[id] ?? String(id), ok: false, upToDate: false, previous: null, version: null, output: "This tool isn't used on this computer." };
  const name = before.name;
  const previous = before.current;
  const result = (ok: boolean, version: string | null, output: string, upToDate = false): ToolUpdateResult => ({ id, name, ok, upToDate, previous, version, output });
  if (!before.installed) return result(false, null, "Not installed — install it from the system check.");
  if (!before.updatable) return result(false, previous, before.detail);
  if (!before.updateAvailable) {
    // Asked, and still no answer (offline, a feed that is down): that is not the same as being up to date.
    if (before.track === "release" && before.latest === null) return result(false, previous, NEWEST_UNKNOWN);
    // Someone else got there first (the background upkeep, another window): don't run the updater a second time.
    return result(true, previous, "Already up to date.", true);
  }
  const blocked = await updateBlocked(id);
  if (blocked) return result(false, previous, blocked);

  log.info(`updating ${id} (currently ${previous ?? "unknown"})`);
  // The cached report can take this tool's new status — unless something else had outdated it already.
  const reportWasCurrent = cached?.generation === doctorGeneration();
  const res = await runUpdate(id);
  resetDoctorCache();
  const after = await toolStatus(id, true);
  if (cached && after && reportWasCurrent) cached = { ...cached, generation: doctorGeneration(), report: { ...cached.report, tools: cached.report.tools.map((t) => (t.id === id ? after : t)) } };
  const ok = res.ok && !!after?.installed && !after.updateAvailable;
  if (ok) log.info(`${id} is now ${after?.current ?? "up to date"}`);
  else log.warn(`updating ${id} did not work`);
  return result(ok, after?.current ?? previous, res.output);
}

/** Install every available update, one after the other. Asks the release feeds first: the human wants everything. */
export async function updateAll(): Promise<ToolUpdateResult[]> {
  const results: ToolUpdateResult[] = [];
  for (const tool of dueUpdates(await checkUpdates(true))) results.push(await updateTool(tool.id));
  return results;
}
