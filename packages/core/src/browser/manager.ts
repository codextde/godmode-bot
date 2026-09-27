/**
 * CONTRACT (owner: browser agent). Managed Chromium instances (one per browser profile), CDP access,
 * secure secret filling, cookie/session import from the user's Chrome and live view.
 */
import { existsSync, rmSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { Agent, BrowserProfile, ChromeImportInput, ChromeImportResult, LocalChromeProfile } from "@godmode/shared";
import type { McpServerJson } from "../types";
import { config, ensureDir } from "../config";
import { bool, get, all, insert, run, update, tx } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { badRequest, conflict, HttpError, newId, notFound, now, sleep } from "../util";
import { getSettings } from "../services/settings";
import { onSettingsApplied } from "../services/runtime";
import { resolveUvx, toolPath } from "../services/doctor";
import { notify } from "../services/notifications";
import { hasBrowserSubscribers } from "../server/ws";
import { CdpClient, attachToPage, pickActivePage, probeCdp, isUserPage, type PageSession } from "./cdp";
import { findChrome, launchChrome, readDevToolsActivePort, type ChromeProcess } from "./chrome";
import { fillOnPage, type FillKind } from "./fill";
import { browserUseCommand, browserUseEnv, writeBrowserUseConfig } from "./browserUse";
import { allRunning, getRegistered, getRunning, registerBrowser, touchBrowser, unregisterBrowser, type RunningBrowser } from "./state";
import { initLiveView } from "./screencast";
import * as importer from "./importer";

const log = logger("browser");

export { touchBrowser };

/* ------------------------------------------------------------------ */
/* Profiles                                                             */
/* ------------------------------------------------------------------ */

interface ProfileRow {
  id: string;
  workspace_id: string | null;
  name: string;
  user_data_dir: string;
  is_default: number;
  imported_from: string | null;
  imported_at: string | null;
  cookie_count: number;
  created_at: string;
  updated_at: string;
}

function toProfile(r: ProfileRow): BrowserProfile {
  const rb = getRunning(r.id);
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    userDataDir: r.user_data_dir,
    isDefault: bool(r.is_default),
    importedFrom: r.imported_from,
    importedAt: r.imported_at,
    cookieCount: r.cookie_count,
    running: !!rb,
    cdpUrl: rb ? rb.httpUrl : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function row(id: string): ProfileRow | null {
  return get<ProfileRow>("SELECT * FROM browser_profiles WHERE id = ?", id);
}

function requireRow(id: string): ProfileRow {
  const r = row(id);
  if (!r) throw notFound("Browser profile");
  return r;
}

function emitProfile(id: string) {
  const r = row(id);
  if (r) bus.emit({ type: "browser.updated", profile: toProfile(r) });
}

export function listProfiles(): BrowserProfile[] {
  return all<ProfileRow>("SELECT * FROM browser_profiles ORDER BY (workspace_id IS NOT NULL), is_default DESC, created_at ASC").map(toProfile);
}

/** Ensure a global default profile exists (called at startup). */
export function ensureDefaultProfile(): BrowserProfile {
  initLiveView();
  startIdleWatcher();
  const existing = get<ProfileRow>("SELECT * FROM browser_profiles WHERE workspace_id IS NULL AND is_default = 1 ORDER BY created_at LIMIT 1");
  if (existing) {
    ensureDir(existing.user_data_dir);
    return toProfile(existing);
  }
  const oldestGlobal = get<ProfileRow>("SELECT * FROM browser_profiles WHERE workspace_id IS NULL ORDER BY created_at LIMIT 1");
  if (oldestGlobal) {
    update("browser_profiles", oldestGlobal.id, { is_default: 1, updated_at: now() });
    bus.changed("browser-profiles");
    return toProfile(requireRow(oldestGlobal.id));
  }
  return insertProfile("Default", null, true);
}

function insertProfile(name: string, workspaceId: string | null, isDefault: boolean): BrowserProfile {
  const id = newId("bpr");
  const userDataDir = join(config().browserDir, id);
  ensureDir(userDataDir);
  const ts = now();
  insert("browser_profiles", {
    id,
    workspace_id: workspaceId,
    name,
    user_data_dir: userDataDir,
    is_default: isDefault ? 1 : 0,
    cookie_count: 0,
    created_at: ts,
    updated_at: ts,
  });
  bus.changed("browser-profiles");
  const profile = toProfile(requireRow(id));
  bus.emit({ type: "browser.updated", profile });
  return profile;
}

export function getProfile(id: string): BrowserProfile {
  return toProfile(requireRow(id));
}

export function createProfile(input: { name: string; workspaceId: string | null }): BrowserProfile {
  const name = input.name?.trim();
  if (!name) throw badRequest("Profile name is required");
  if (name.length > 80) throw badRequest("Profile name is too long (max 80 characters)");
  const workspaceId = input.workspaceId || null;
  if (workspaceId && !get<{ id: string }>("SELECT id FROM workspaces WHERE id = ?", workspaceId)) throw notFound("Workspace");
  const hasDefault = workspaceId
    ? get<{ id: string }>("SELECT id FROM browser_profiles WHERE workspace_id = ? AND is_default = 1", workspaceId)
    : get<{ id: string }>("SELECT id FROM browser_profiles WHERE workspace_id IS NULL AND is_default = 1");
  // The first profile of a scope becomes its default.
  return insertProfile(name, workspaceId, !hasDefault);
}

export function updateProfile(id: string, patch: { name?: string; isDefault?: boolean }): BrowserProfile {
  const r = requireRow(id);
  const changes: Record<string, string | number> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw badRequest("Profile name is required");
    if (name.length > 80) throw badRequest("Profile name is too long (max 80 characters)");
    changes.name = name;
  }
  tx(() => {
    if (patch.isDefault === true && !r.is_default) {
      if (r.workspace_id) run("UPDATE browser_profiles SET is_default = 0 WHERE workspace_id = ?", r.workspace_id);
      else run("UPDATE browser_profiles SET is_default = 0 WHERE workspace_id IS NULL");
      changes.is_default = 1;
    } else if (patch.isDefault === false && r.is_default) {
      if (!r.workspace_id) throw badRequest("The global default profile can't be unset. Make another global profile the default instead.");
      changes.is_default = 0;
    }
    if (Object.keys(changes).length) update("browser_profiles", id, { ...changes, updated_at: now() });
  });
  bus.changed("browser-profiles");
  emitProfile(id);
  return getProfile(id);
}

/** Is `child` inside `parent` (after resolving)? */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

export async function deleteProfile(id: string): Promise<void> {
  const r = requireRow(id);
  if (!r.workspace_id && r.is_default) throw badRequest("The global default profile can't be deleted. Make another global profile the default first.");
  await stopBrowser(id);
  run("DELETE FROM browser_profiles WHERE id = ?", id);
  // Only ever delete directories Godmode created.
  const cfg = config();
  for (const dir of [r.user_data_dir, join(cfg.dataDir, "browser-use", id)]) {
    if (existsSync(dir) && (isInside(cfg.browserDir, dir) || isInside(cfg.dataDir, dir))) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        log.warn(`could not remove ${dir}`, err);
      }
    }
  }
  bus.changed("browser-profiles");
}

/** Profile an agent should use: agent.browser.profileId ?? workspace default ?? global default. */
export function resolveProfileForAgent(agent: Agent): BrowserProfile {
  const pinned = agent.browser?.profileId ? row(agent.browser.profileId) : null;
  if (pinned) return toProfile(pinned);
  if (agent.browser?.profileId) log.warn(`agent ${agent.id} references missing browser profile ${agent.browser.profileId}; using default`);
  if (agent.workspaceId) {
    const wsDefault = get<ProfileRow>("SELECT * FROM browser_profiles WHERE workspace_id = ? AND is_default = 1 ORDER BY created_at LIMIT 1", agent.workspaceId);
    if (wsDefault) return toProfile(wsDefault);
  }
  return ensureDefaultProfile();
}

/* ------------------------------------------------------------------ */
/* Browser lifecycle                                                    */
/* ------------------------------------------------------------------ */

const launching = new Map<string, Promise<RunningBrowser>>();
const stopping = new Map<string, Promise<void>>();

/** Start (or reuse) Chromium for the profile with remote debugging on a free loopback port. */
export async function launchBrowser(profileId: string, opts: { headless?: boolean } = {}): Promise<{ cdpUrl: string; port: number }> {
  const rb = await ensureBrowser(profileId, opts);
  return { cdpUrl: rb.httpUrl, port: rb.port };
}

async function ensureBrowser(profileId: string, opts: { headless?: boolean } = {}): Promise<RunningBrowser> {
  const pendingStop = stopping.get(profileId);
  if (pendingStop) await pendingStop;
  const current = getRunning(profileId);
  if (current) {
    current.lastUsedAt = Date.now();
    return current;
  }
  const inflight = launching.get(profileId);
  if (inflight) return inflight;
  const p = startBrowser(profileId, opts).finally(() => launching.delete(profileId));
  launching.set(profileId, p);
  return p;
}

async function startBrowser(profileId: string, opts: { headless?: boolean }): Promise<RunningBrowser> {
  const profile = requireRow(profileId);
  ensureDir(profile.user_data_dir);
  const settings = getSettings();

  // A Chromium left running by a previous core process still owns this profile dir — adopt it.
  let proc: ChromeProcess | null = null;
  let port: number;
  let wsUrl: string;
  let headless: boolean;
  const orphan = readDevToolsActivePort(profile.user_data_dir);
  const orphanVersion = orphan ? await probeCdp(orphan.port) : null;
  if (orphan && orphanVersion) {
    port = orphan.port;
    wsUrl = orphanVersion.webSocketDebuggerUrl;
    headless = /HeadlessChrome/.test(orphanVersion["User-Agent"] ?? "");
    log.info(`adopting running browser for profile ${profileId} on port ${port}`);
  } else {
    const chrome = findChrome(settings.browser.chromePath);
    if (!chrome) {
      throw new HttpError(
        400,
        "No Chrome or Chromium browser found. Install Google Chrome, or install Chromium from Settings → Dependencies.",
        "chrome_missing",
      );
    }
    headless = opts.headless ?? settings.browser.headless;
    try {
      proc = await launchChrome({ executable: chrome.path, userDataDir: profile.user_data_dir, headless });
    } catch (err) {
      throw new HttpError(500, `Could not start ${chrome.browser}: ${err instanceof Error ? err.message : String(err)}`, "browser_launch_failed");
    }
    port = proc.port;
    wsUrl = proc.wsUrl;
    log.info(`started ${chrome.browser} for profile ${profileId} (pid ${proc.pid}, port ${port}, ${headless ? "headless" : "headed"})`);
  }

  let client: CdpClient;
  try {
    client = await CdpClient.connect(wsUrl);
    await client.send("Target.setDiscoverTargets", { discover: true });
  } catch (err) {
    proc?.kill("SIGKILL");
    throw new HttpError(500, `Could not connect to the browser: ${err instanceof Error ? err.message : String(err)}`, "browser_connect_failed");
  }

  const rb: RunningBrowser = {
    profileId,
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl,
    headless,
    client,
    process: proc,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    stopping: false,
  };

  // Navigation / new tabs count as activity (this is how browser-use usage keeps the browser alive).
  const activity = (params: { targetInfo?: { type: string; url: string } }) => {
    if (params.targetInfo && isUserPage(params.targetInfo)) rb.lastUsedAt = Date.now();
  };
  client.on("Target.targetCreated", activity);
  client.on("Target.targetInfoChanged", activity);
  client.onClose(() => void onBrowserGone(rb, "CDP connection closed"));
  proc?.exited.then((code) => onBrowserGone(rb, `exited with code ${code}`));

  registerBrowser(rb);
  emitProfile(profileId);
  return rb;
}

/** The browser went away without us stopping it (crash, user closed the window, lost connection). */
async function onBrowserGone(rb: RunningBrowser, reason: string) {
  if (rb.stopping || getRegistered(rb.profileId) !== rb) return;
  rb.stopping = true;
  log.warn(`browser for profile ${rb.profileId} stopped unexpectedly (${reason})`);
  rb.client.close();
  if (rb.process?.isAlive()) {
    rb.process.kill("SIGTERM");
    await Promise.race([rb.process.exited, sleep(3000)]);
    if (rb.process.isAlive()) rb.process.kill("SIGKILL");
  }
  unregisterBrowser(rb);
  emitProfile(rb.profileId);
}

export async function stopBrowser(profileId: string): Promise<void> {
  const inflightLaunch = launching.get(profileId);
  if (inflightLaunch) await inflightLaunch.catch(() => {});
  const pending = stopping.get(profileId);
  if (pending) return pending;
  const rb = getRegistered(profileId);
  if (!rb) return;
  const p = shutdownOne(rb).finally(() => stopping.delete(profileId));
  stopping.set(profileId, p);
  return p;
}

async function shutdownOne(rb: RunningBrowser) {
  rb.stopping = true;
  emitProfile(rb.profileId);
  // Browser.close lets Chromium flush cookies and session state to disk.
  try {
    await rb.client.send("Browser.close", {}, undefined, 3000);
  } catch {
    /* connection already gone */
  }
  if (rb.process) {
    await Promise.race([rb.process.exited, sleep(5000)]);
    if (rb.process.isAlive()) {
      rb.process.kill("SIGTERM");
      await Promise.race([rb.process.exited, sleep(3000)]);
      if (rb.process.isAlive()) rb.process.kill("SIGKILL");
    }
  } else {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await probeCdp(rb.port, 500))) await sleep(200);
  }
  rb.client.close();
  unregisterBrowser(rb);
  emitProfile(rb.profileId);
  log.info(`stopped browser for profile ${rb.profileId}`);
}

export async function shutdownBrowsers(): Promise<void> {
  stopIdleWatcher();
  await Promise.all(allRunning().map((rb) => stopBrowser(rb.profileId).catch((err) => log.warn("stop failed", err))));
}

/* ------------------------------------------------------------------ */
/* Idle shutdown                                                        */
/* ------------------------------------------------------------------ */

let idleTimer: ReturnType<typeof setInterval> | null = null;

function startIdleWatcher() {
  if (idleTimer) return;
  idleTimer = setInterval(() => void idleSweep(), 60_000);
  (idleTimer as unknown as { unref?: () => void }).unref?.();
}

function stopIdleWatcher() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
}

onSettingsApplied(() => {
  if (idleTimer) void idleSweep();
});

/** Stop browsers unused for `settings.browser.keepAliveMinutes` (0 = never). */
async function idleSweep() {
  let keepAlive: number;
  try {
    keepAlive = getSettings().browser.keepAliveMinutes;
  } catch {
    return;
  }
  if (!keepAlive || keepAlive <= 0) return;
  for (const rb of allRunning()) {
    if (rb.stopping || launching.has(rb.profileId)) continue;
    if (hasBrowserSubscribers(rb.profileId)) {
      rb.lastUsedAt = Date.now();
      continue;
    }
    if (Date.now() - rb.lastUsedAt < keepAlive * 60_000) continue;
    try {
      // Another CDP client (e.g. a browser-use MCP server of a running agent) attached to a tab = in use.
      const { targetInfos } = await rb.client.send<{ targetInfos: { type: string; url: string; attached: boolean }[] }>("Target.getTargets");
      if (targetInfos.some((t) => isUserPage(t) && t.attached)) {
        rb.lastUsedAt = Date.now();
        continue;
      }
      // A visible window the human is focused on is in use too.
      if (!rb.headless) {
        const page = await pickActivePage(rb.client, { port: rb.port });
        if (page && (await pageHasFocus(rb, page.targetId))) {
          rb.lastUsedAt = Date.now();
          continue;
        }
      }
    } catch {
      /* browser going away — the exit handler cleans up */
      continue;
    }
    log.info(`stopping idle browser for profile ${rb.profileId} (unused for ${keepAlive} min)`);
    await stopBrowser(rb.profileId).catch((err) => log.warn("idle stop failed", err));
  }
}

async function pageHasFocus(rb: RunningBrowser, targetId: string): Promise<boolean> {
  const session = await attachToPage(rb.client, targetId);
  try {
    return await session.evaluate<boolean>("document.hasFocus()", { timeoutMs: 1500 });
  } catch {
    return false;
  } finally {
    await session.detach();
  }
}

/* ------------------------------------------------------------------ */
/* Pages                                                                */
/* ------------------------------------------------------------------ */

/** Attach to the active page of a running browser (optionally the one whose URL contains `urlContains`). */
async function withActivePage<T>(rb: RunningBrowser, urlContains: string | undefined, fn: (page: PageSession, url: string) => Promise<T>): Promise<T | null> {
  const target = await pickActivePage(rb.client, { port: rb.port, urlContains });
  if (!target) return null;
  const page = await attachToPage(rb.client, target.targetId);
  try {
    return await fn(page, target.url);
  } finally {
    await page.detach();
  }
}

/**
 * Type text into the focused (or selector-matched) element of the active page WITHOUT the model seeing it.
 * Used for passwords and TOTP codes.
 */
export async function fillIntoPage(
  profileId: string,
  opts: {
    text: string;
    /** Field kind — used to auto-locate the input when nothing suitable is focused and no selector is given. */
    kind?: FillKind;
    selector?: string;
    urlContains?: string;
    submit?: boolean;
  },
): Promise<{ ok: boolean; url: string; detail: string }> {
  requireRow(profileId);
  if (typeof opts.text !== "string" || opts.text.length === 0) return { ok: false, url: "", detail: "Nothing to type." };
  const rb = getRunning(profileId);
  if (!rb) return { ok: false, url: "", detail: "The browser is not running. Open the login page with the browser tools first." };
  rb.lastUsedAt = Date.now();
  try {
    const result = await withActivePage(rb, opts.urlContains, (page) =>
      fillOnPage(page, { text: opts.text, kind: opts.kind, selector: opts.selector, submit: opts.submit }),
    );
    if (!result) {
      return {
        ok: false,
        url: "",
        detail: opts.urlContains ? `No open tab has a URL containing "${opts.urlContains}".` : "The browser has no open tab.",
      };
    }
    return result;
  } catch (err) {
    // Error messages come from CDP/our scripts and never contain the typed text.
    return { ok: false, url: "", detail: `Could not fill the field: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    rb.lastUsedAt = Date.now();
  }
}

/** URL + title of the most recently active page of the profile browser. */
export async function currentPage(profileId: string): Promise<{ url: string; title: string } | null> {
  const rb = getRunning(profileId);
  if (!rb) return null;
  try {
    const page = await pickActivePage(rb.client, { port: rb.port });
    return page ? { url: page.url, title: page.title } : null;
  } catch {
    return null;
  }
}

/** Navigate the active tab (opening one if there is none), launching the browser if needed. */
export async function navigate(profileId: string, url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw badRequest("Only http and https URLs can be opened");
  const rb = await ensureBrowser(profileId);
  rb.lastUsedAt = Date.now();
  const done = await withActivePage(rb, undefined, async (page) => {
    await page.navigate(parsed.href);
    return true;
  });
  if (!done) await rb.client.send("Target.createTarget", { url: parsed.href });
}

/** Running browser for the profile or a 409. */
export function requireRunning(profileId: string): RunningBrowser {
  requireRow(profileId);
  const rb = getRunning(profileId);
  if (!rb) throw conflict("The browser for this profile is not running");
  return rb;
}

/* ------------------------------------------------------------------ */
/* Agent browser tools (browser-use MCP)                                */
/* ------------------------------------------------------------------ */

const warned = new Set<string>();

function warnOnce(key: string, title: string, body: string) {
  log.warn(`${title}: ${body}`);
  if (warned.has(key)) return;
  warned.add(key);
  try {
    notify("warning", title, body, "/settings");
  } catch {
    /* notifications unavailable */
  }
}

/**
 * MCP server entry giving the agent browser tools (browser-use MCP connected to the profile's Chromium via CDP).
 * Returns null when browser is disabled for the agent or globally (or when browser tools can't be provided;
 * the human is notified once).
 */
export async function browserMcpServer(agent: Agent): Promise<McpServerJson | null> {
  const settings = getSettings();
  if (!settings.browser.enabled || !agent.browser?.enabled) return null;

  const command = browserUseCommand(settings.browser.browserUseCommand, resolveUvx());
  if (!command) {
    warnOnce("uvx", "Browser tools unavailable", "uv (uvx) is not installed, so browser-use can't start. Install it from Settings → Dependencies.");
    return null;
  }

  const profile = resolveProfileForAgent(agent);
  const headless = agent.browser.headless ?? settings.browser.headless;
  let cdpUrl: string;
  try {
    ({ cdpUrl } = await launchBrowser(profile.id, { headless }));
  } catch (err) {
    warnOnce("launch", "Browser tools unavailable", err instanceof Error ? err.message : String(err));
    return null;
  }

  const cfg = config();
  const configDir = join(cfg.dataDir, "browser-use", profile.id, agent.id);
  const workspace = agent.repoPath ? join(agent.repoPath, "workspace") : join(cfg.dataDir, "browser-use", profile.id, agent.id, "files");
  writeBrowserUseConfig({
    configDir,
    cdpUrl,
    headless,
    userDataDir: profile.userDataDir,
    downloadsPath: join(workspace, "downloads"),
    fileSystemPath: join(cfg.dataDir, "browser-use", profile.id, agent.id, "files"),
  });
  touchBrowser(profile.id);
  return { command: command.command, args: command.args, env: browserUseEnv(configDir, toolPath()) };
}

/* ------------------------------------------------------------------ */
/* Chrome session import                                                */
/* ------------------------------------------------------------------ */

export async function listLocalChromeProfiles(): Promise<LocalChromeProfile[]> {
  return importer.listLocalChromeProfiles();
}

/** Import cookies/sessions from the user's Chrome (profile-use technique) or a cookie JSON into a Godmode profile. */
export async function importChromeSession(profileId: string, input: ChromeImportInput): Promise<ChromeImportResult> {
  requireRow(profileId);
  const { cookies, skipped, source, method } = await importer.collectCookies(input);
  if (cookies.length === 0) {
    const domains = (input.domains ?? []).filter((d) => d.trim());
    throw badRequest(
      domains.length && skipped > 0
        ? `No cookies match ${domains.join(", ")}.`
        : skipped > 0
          ? `None of the ${skipped} cookies could be imported (expired or invalid).`
          : "No cookies found to import.",
    );
  }

  // Import into the running browser, or start it headless just for the import and stop it afterwards
  // (Browser.close flushes the cookie store to disk).
  const wasRunning = !!getRunning(profileId);
  const rb = await ensureBrowser(profileId, wasRunning ? {} : { headless: true });
  let result: { set: number; failed: number; total: number };
  try {
    result = await importer.injectCookies(rb.client, cookies);
  } finally {
    if (!wasRunning) await stopBrowser(profileId);
  }

  update("browser_profiles", profileId, {
    imported_from: source,
    imported_at: now(),
    cookie_count: result.total,
    updated_at: now(),
  });
  emitProfile(profileId);
  bus.changed("browser-profiles");
  const domains = [...new Set(cookies.map((c) => (c.domain ?? (c.url ? new URL(c.url).hostname : "")).replace(/^\./, "")).filter(Boolean))].sort();
  return { imported: result.set, skipped: skipped + result.failed, domains, method };
}
