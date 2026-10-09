/**
 * CONTRACT (owner: browser agent). Managed Chromium instances (one per browser profile), CDP access,
 * secure secret filling, cookie/session import from the user's Chrome and live view. Chats share a profile's
 * browser but each works in its own tabs (tabs.ts, proxy.ts).
 */
import { existsSync, rmSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { Agent, BotCheckReport, BrowserChat, BrowserProfile, ChromeImportInput, ChromeImportResult, LocalChromeProfile } from "@godmode/shared";
import type { McpServerJson } from "../types";
import { config, ensureDir } from "../config";
import { bool, get, all, insert, run, update, tx } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { badRequest, conflict, HttpError, newId, notFound, now, sleep } from "../util";
import { getSettings } from "../services/settings";
import { getAppSecret, isUnlocked } from "../vault/vault";
import { onSettingsApplied } from "../services/runtime";
import { resolveUvx, toolPath } from "../services/doctor";
import { hasBrowserSubscribers, hasBrowserWatchers } from "../server/ws";
import { CdpClient, attachToPage, getCookies, pickActivePage, probeCdp, isUserPage, type CdpCookie, type PageSession, type PageTarget } from "./cdp";
import { clearLaunchMarker, findChrome, isProcessAlive, launchChrome, readLaunchMarker, writeLaunchMarker, type ChromeProcess } from "./chrome";
import { fillIntoActivePage, fillPrecheck, type FillKind } from "./fill";
import { browserUseCommand, browserUseEnv, writeBrowserUseConfig } from "./browserUse";
import { stealthArgs, stopProbes, windowedUserAgent } from "./stealth";
import { botCheckReport } from "./botCheck";
import { allRunning, getRegistered, getRunning, registerBrowser, touchBrowser, unregisterBrowser, type RunningBrowser } from "./state";
import { initLiveView, pauseLiveViews, resumeLiveViews } from "./screencast";
import { initFocusGuard } from "./focusGuard";
import { TabRegistry } from "./tabs";
import { leasedChats, openChatLease, releaseChatLease, stopChatProxy } from "./proxy";
import * as importer from "./importer";
import { projectOfChat } from "../services/projects";

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
    headless: rb ? rb.headless : null,
    stealth: rb ? rb.stealth : null,
    chats: rb ? chatsOf(rb) : [],
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

function chatsOf(rb: RunningBrowser): BrowserChat[] {
  const open = rb.tabs.openChats();
  if (!open.length) return [];
  const ids = open.map((c) => c.conversationId);
  const rows = all<{ id: string; title: string; agent_id: string }>(
    `SELECT id, title, agent_id FROM conversations WHERE id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const leased = leasedChats(rb.profileId);
  return open.map((c) => ({
    conversationId: c.conversationId,
    title: byId.get(c.conversationId)?.title ?? null,
    agentId: byId.get(c.conversationId)?.agent_id ?? null,
    url: c.current.url,
    pageTitle: c.current.title,
    tabs: c.tabs,
    active: leased.has(c.conversationId),
    lastUsedAt: new Date(c.usedAt).toISOString(),
  }));
}

function emitProfile(id: string) {
  const r = row(id);
  if (r) bus.emit({ type: "browser.updated", profile: toProfile(r) });
}

const emitTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Tabs change with every navigation: tell the UI at most twice a second. */
function emitProfileSoon(id: string) {
  if (emitTimers.has(id)) return;
  emitTimers.set(
    id,
    setTimeout(() => {
      emitTimers.delete(id);
      try {
        emitProfile(id);
      } catch {
        /* shutting down */
      }
    }, 500),
  );
}

export function listProfiles(): BrowserProfile[] {
  return all<ProfileRow>("SELECT * FROM browser_profiles ORDER BY (workspace_id IS NOT NULL), is_default DESC, created_at ASC").map(toProfile);
}

/** Ensure a global default profile exists (called at startup). */
export function ensureDefaultProfile(): BrowserProfile {
  initLiveView();
  initFocusGuard();
  if (!idleTimer) void adoptOrphans();
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
  assertWorkspace(workspaceId);
  // The first profile of a scope becomes its default.
  const profile = insertProfile(name, workspaceId, !scopeDefaultId(workspaceId));
  if (workspaceId && profile.isDefault) bus.changed("workspaces");
  return profile;
}

function assertWorkspace(workspaceId: string | null) {
  if (workspaceId && !get<{ id: string }>("SELECT id FROM workspaces WHERE id = ?", workspaceId)) throw notFound("Workspace");
}

function scopeDefaultId(workspaceId: string | null): string | null {
  const r = workspaceId
    ? get<{ id: string }>("SELECT id FROM browser_profiles WHERE workspace_id = ? AND is_default = 1", workspaceId)
    : get<{ id: string }>("SELECT id FROM browser_profiles WHERE workspace_id IS NULL AND is_default = 1");
  return r?.id ?? null;
}

/**
 * Rename, make (non-)default, or assign to another scope. A profile assigned to a workspace becomes that workspace's
 * default when it has none yet (or when `isDefault` asks for it); the workspace it leaves falls back to the global default.
 */
export function updateProfile(id: string, patch: { name?: string; isDefault?: boolean; workspaceId?: string | null }): BrowserProfile {
  const r = requireRow(id);
  const changes: Record<string, string | number | null> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw badRequest("Profile name is required");
    if (name.length > 80) throw badRequest("Profile name is too long (max 80 characters)");
    changes.name = name;
  }
  const workspaceId = patch.workspaceId === undefined ? r.workspace_id : patch.workspaceId || null;
  const moving = workspaceId !== r.workspace_id;
  if (moving) {
    if (!r.workspace_id && r.is_default) throw badRequest("The global default profile can't be moved. Make another global profile the default first.");
    assertWorkspace(workspaceId);
    changes.workspace_id = workspaceId;
  }
  const alreadyDefault = !!r.is_default && !moving;
  const isDefault = tx(() => {
    const next = patch.isDefault ?? (moving ? !scopeDefaultId(workspaceId) : alreadyDefault);
    if (next && !alreadyDefault) {
      if (workspaceId) run("UPDATE browser_profiles SET is_default = 0 WHERE workspace_id = ?", workspaceId);
      else run("UPDATE browser_profiles SET is_default = 0 WHERE workspace_id IS NULL");
    } else if (!next && alreadyDefault && !workspaceId) {
      throw badRequest("The global default profile can't be unset. Make another global profile the default instead.");
    }
    if (next !== !!r.is_default) changes.is_default = next ? 1 : 0;
    if (Object.keys(changes).length) update("browser_profiles", id, { ...changes, updated_at: now() });
    return next;
  });
  bus.changed("browser-profiles");
  if (moving || (workspaceId && isDefault !== alreadyDefault)) bus.changed("workspaces");
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
  let projects = 0;
  tx(() => {
    run("DELETE FROM browser_profiles WHERE id = ?", id);
    run("UPDATE conversations SET browser_profile_id = NULL WHERE browser_profile_id = ?", id);
    projects = run("UPDATE projects SET browser_profile_id = NULL WHERE browser_profile_id = ?", id).changes;
  });
  if (projects) bus.changed("workspaces");
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
  if (r.workspace_id && r.is_default) bus.changed("workspaces");
}

function chatRow(conversationId: string) {
  return get<{ browser_profile_id: string | null; workspace_id: string | null }>(
    "SELECT browser_profile_id, workspace_id FROM conversations WHERE id = ?",
    conversationId,
  );
}

/** Profile picked for the chat itself (not inherited from its agent). */
export function chatProfileId(conversationId: string): string | null {
  return chatRow(conversationId)?.browser_profile_id ?? null;
}

/** Workspace a chat was started in (set for global agents only). */
export function chatWorkspaceId(conversationId: string | null | undefined): string | null {
  return conversationId ? (chatRow(conversationId)?.workspace_id ?? null) : null;
}

/** Profile a run uses: its chat's ?? agent.browser.profileId ?? default of the agent's (or the chat's) workspace ?? global default. */
export function resolveProfileForAgent(agent: Agent, conversationId?: string | null): BrowserProfile {
  const chat = conversationId ? chatRow(conversationId) : null;
  const forChat = chat?.browser_profile_id ? row(chat.browser_profile_id) : null;
  if (forChat) return toProfile(forChat);
  const pinned = agent.browser?.profileId ? row(agent.browser.profileId) : null;
  if (pinned) return toProfile(pinned);
  if (agent.browser?.profileId) log.warn(`agent ${agent.id} references missing browser profile ${agent.browser.profileId}; using default`);
  const project = projectOfChat(conversationId, agent);
  const forProject = project?.browserProfileId ? row(project.browserProfileId) : null;
  if (forProject && (!forProject.workspace_id || forProject.workspace_id === project!.workspaceId)) return toProfile(forProject);
  const workspaceId = agent.workspaceId ?? project?.workspaceId ?? chat?.workspace_id ?? null;
  if (workspaceId) {
    const wsDefault = get<ProfileRow>("SELECT * FROM browser_profiles WHERE workspace_id = ? AND is_default = 1 ORDER BY created_at LIMIT 1", workspaceId);
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

/** A transient user (bot check, import) borrows the browser; anyone else keeps it running afterwards. */
function take(rb: RunningBrowser, transient?: boolean): RunningBrowser {
  if (transient) rb.borrowers++;
  else rb.transient = false;
  return rb;
}

/** Hand a borrowed browser back: the last borrower stops a browser only borrowers used. */
async function giveBack(rb: RunningBrowser) {
  rb.borrowers--;
  if (rb.transient && rb.borrowers <= 0 && getRegistered(rb.profileId) === rb) await stopBrowser(rb.profileId);
}

/** `transient`: only borrow the browser — pair with `giveBack` (see `RunningBrowser.transient`). */
async function ensureBrowser(profileId: string, opts: { headless?: boolean; transient?: boolean } = {}): Promise<RunningBrowser> {
  const pendingStop = stopping.get(profileId);
  if (pendingStop) await pendingStop;
  const current = getRunning(profileId);
  if (current) {
    current.lastUsedAt = Date.now();
    return take(current, opts.transient);
  }
  const inflight = launching.get(profileId);
  const p = inflight ?? startBrowser(profileId, opts).finally(() => launching.delete(profileId));
  if (!inflight) launching.set(profileId, p);
  return p.then((rb) => take(rb, opts.transient));
}

async function startBrowser(profileId: string, opts: { headless?: boolean; transient?: boolean }): Promise<RunningBrowser> {
  const profile = requireRow(profileId);
  ensureDir(profile.user_data_dir);
  const settings = getSettings();

  let proc: ChromeProcess | null = null;
  let pid: number;
  let port: number;
  let wsUrl: string;
  let headless: boolean;
  let stealth: boolean;
  // A Chromium left running by a previous core process still owns this profile dir — adopt it.
  const marker = readLaunchMarker(profile.user_data_dir);
  const orphan = marker && isProcessAlive(marker.pid) ? await probeCdp(marker.port) : null;
  if (marker && orphan) {
    pid = marker.pid;
    port = marker.port;
    wsUrl = orphan.webSocketDebuggerUrl;
    headless = marker.headless;
    stealth = !!marker.stealth;
    log.info(`adopting running browser for profile ${profileId} (pid ${pid}, port ${port})`);
  } else {
    if (marker) clearLaunchMarker(profile.user_data_dir);
    const chrome = requireChrome(settings.browser.chromePath);
    headless = opts.headless ?? settings.browser.headless;
    stealth = settings.browser.stealth;
    const extraArgs = [
      ...(stealth ? stealthArgs({ headless, userAgent: headless ? await windowedUserAgent(chrome.path) : null }) : []),
      ...(settings.browser.muteAudio ? ["--mute-audio"] : []),
    ];
    try {
      proc = await launchChrome({ executable: chrome.path, userDataDir: profile.user_data_dir, headless, extraArgs });
    } catch (err) {
      throw new HttpError(500, `Could not start ${chrome.browser}: ${err instanceof Error ? err.message : String(err)}`, "browser_launch_failed");
    }
    pid = proc.pid;
    port = proc.port;
    wsUrl = proc.wsUrl;
    writeLaunchMarker(profile.user_data_dir, { pid, port, headless, stealth });
    log.info(`started ${chrome.browser} for profile ${profileId} (pid ${pid}, port ${port}, ${headless ? "headless" : "headed"})`);
  }

  let client: CdpClient;
  let tabs: TabRegistry;
  try {
    client = await CdpClient.connect(wsUrl);
    tabs = new TabRegistry(client);
    await client.send("Target.setDiscoverTargets", { discover: true });
    tabs.addSpares(tabs.userPages().filter((p) => tabs.isBlank(p.targetId)).map((p) => p.targetId));
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
    stealth,
    client,
    tabs,
    process: proc,
    pid,
    userDataDir: profile.user_data_dir,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    stopping: false,
    transient: !!opts.transient && !!proc,
    borrowers: 0,
  };

  // Navigation / new tabs count as activity (this is how browser-use usage keeps the browser alive).
  const activity = (params: { targetInfo?: { type: string; url: string } }) => {
    if (params.targetInfo && isUserPage(params.targetInfo)) rb.lastUsedAt = Date.now();
  };
  client.on("Target.targetCreated", activity);
  client.on("Target.targetInfoChanged", activity);
  tabs.onChange((conversationId) => conversationId && emitProfileSoon(profileId));
  client.onClose(() => void onBrowserGone(rb, "CDP connection closed"));
  proc?.exited.then((code) => onBrowserGone(rb, code === null ? "killed by a signal" : `exited with code ${code}`));

  registerBrowser(rb);
  startIdleWatcher();
  emitProfile(profileId);
  return rb;
}

/**
 * Take over browsers a previous core process left running, so idle shutdown and the UI cover them. This core doesn't use
 * them, so they close right away unless something else still does (another CDP client, a focused window).
 */
export async function adoptOrphans() {
  let adopted = false;
  for (const r of all<ProfileRow>("SELECT * FROM browser_profiles")) {
    const marker = readLaunchMarker(r.user_data_dir);
    if (!marker || getRegistered(r.id)) continue;
    if (!isProcessAlive(marker.pid) || !(await probeCdp(marker.port))) {
      clearLaunchMarker(r.user_data_dir);
      continue;
    }
    const rb = await ensureBrowser(r.id).catch((err) => log.warn(`could not adopt browser for profile ${r.id}`, err));
    if (rb && !rb.process) {
      rb.lastUsedAt = 0;
      adopted = true;
    }
  }
  if (adopted) await sweepIdleBrowsers();
}

function requireChrome(customPath: string) {
  const chrome = findChrome(customPath);
  if (!chrome) {
    throw new HttpError(400, "No Chrome or Chromium browser found. Install Google Chrome, or install Chromium from Settings → Dependencies.", "chrome_missing");
  }
  return chrome;
}

function pidAlive(rb: RunningBrowser): boolean {
  if (rb.process) return rb.process.isAlive();
  return rb.pid !== null && isProcessAlive(rb.pid);
}

/** Wait up to `ms` for the browser process to exit. */
async function waitForExit(rb: RunningBrowser, ms: number) {
  if (rb.process) {
    await Promise.race([rb.process.exited, sleep(ms)]);
    return;
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && pidAlive(rb)) await sleep(100);
}

function killBrowser(rb: RunningBrowser, signal: NodeJS.Signals) {
  if (rb.process) rb.process.kill(signal);
  else if (rb.pid !== null) {
    try {
      process.kill(rb.pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Make sure the process is gone: SIGTERM, then SIGKILL. */
async function terminate(rb: RunningBrowser) {
  if (!pidAlive(rb)) return;
  killBrowser(rb, "SIGTERM");
  await waitForExit(rb, 3000);
  if (pidAlive(rb)) killBrowser(rb, "SIGKILL");
}

function forget(rb: RunningBrowser) {
  rb.client.close();
  if (unregisterBrowser(rb)) clearLaunchMarker(rb.userDataDir);
  emitProfile(rb.profileId);
}

/** The browser went away without us stopping it (crash, user closed the window, lost connection). */
async function onBrowserGone(rb: RunningBrowser, reason: string) {
  if (rb.stopping || getRegistered(rb.profileId) !== rb) return;
  rb.stopping = true;
  // Whether the browser itself went (crash, quit by the human) or only the connection to it: `processAlive`. A browser
  // that is still there is ended below, and the next run that needs it starts a new one.
  log.warn(`browser for profile ${rb.profileId} stopped unexpectedly (${reason})`, {
    pid: rb.pid,
    processAlive: pidAlive(rb),
    connection: rb.client.closeReason,
    headless: rb.headless,
    adopted: !rb.process,
    upMin: Math.round((Date.now() - rb.startedAt) / 60_000),
    idleS: rb.lastUsedAt ? Math.round((Date.now() - rb.lastUsedAt) / 1000) : null,
    chats: rb.tabs.openChats().length,
  });
  rb.client.close();
  await terminate(rb);
  forget(rb);
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
  await waitForExit(rb, 5000);
  await terminate(rb);
  forget(rb);
  log.info(`stopped browser for profile ${rb.profileId}`);
}

export async function shutdownBrowsers(): Promise<void> {
  stopIdleWatcher();
  stopProbes();
  stopChatProxy();
  for (const timer of emitTimers.values()) clearTimeout(timer);
  emitTimers.clear();
  await Promise.all(allRunning().map((rb) => stopBrowser(rb.profileId).catch((err) => log.warn("stop failed", err))));
}

/* ------------------------------------------------------------------ */
/* Idle shutdown                                                        */
/* ------------------------------------------------------------------ */

let idleTimer: ReturnType<typeof setInterval> | null = null;

function startIdleWatcher() {
  if (idleTimer) return;
  idleTimer = setInterval(() => void sweepIdleBrowsers(), 60_000);
  (idleTimer as unknown as { unref?: () => void }).unref?.();
}

function stopIdleWatcher() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
}

onSettingsApplied(() => {
  if (idleTimer) void sweepIdleBrowsers();
});

/**
 * Close chats' tabs and stop browsers unused for `settings.browser.keepAliveMinutes` (0 = never stop the browser;
 * idle chats' tabs still close after an hour, so a busy browser doesn't pile up windows).
 */
export async function sweepIdleBrowsers(): Promise<void> {
  let keepAlive: number;
  try {
    keepAlive = getSettings().browser.keepAliveMinutes;
  } catch {
    return;
  }
  await sweepIdleChats((keepAlive > 0 ? keepAlive : 60) * 60_000);
  if (!keepAlive || keepAlive <= 0) return;
  for (const rb of allRunning()) {
    if (rb.stopping || launching.has(rb.profileId)) continue;
    if (hasBrowserWatchers(rb.profileId)) {
      rb.lastUsedAt = Date.now();
      continue;
    }
    if (Date.now() - rb.lastUsedAt < keepAlive * 60_000) continue;
    const checkedAt = Date.now();
    const reason = rb.lastUsedAt ? `unused for ${keepAlive} min` : "left running by an earlier core";
    // Passive previews attach our own screencast to the tab; pause it so it doesn't look like another CDP client.
    const previewing = hasBrowserSubscribers(rb.profileId);
    if (previewing) await pauseLiveViews(rb.profileId);
    // An error means the browser is going away — the exit handler cleans up.
    const inUse = await browserInUse(rb).catch(() => true);
    if (inUse) {
      rb.lastUsedAt = Date.now();
      if (previewing) resumeLiveViews(rb.profileId);
      continue;
    }
    if ((handedOut.get(rb.profileId) ?? 0) >= checkedAt) continue;
    log.info(`stopping idle browser for profile ${rb.profileId} (${reason})`);
    await stopBrowser(rb.profileId).catch((err) => log.warn("idle stop failed", err));
  }
}

async function sweepIdleChats(idleMs: number) {
  for (const rb of allRunning()) {
    if (rb.stopping) continue;
    const leased = leasedChats(rb.profileId);
    for (const chat of rb.tabs.openChats()) {
      if (leased.has(chat.conversationId) || hasBrowserWatchers(rb.profileId, chat.conversationId)) {
        rb.tabs.touch(chat.conversationId);
        continue;
      }
      if (Date.now() - chat.usedAt < idleMs) continue;
      log.info(`closing the tabs of idle chat ${chat.conversationId} in profile ${rb.profileId}`);
      await closeTabsOf(rb, chat.conversationId).catch((err) => log.warn("closing idle chat tabs failed", err));
    }
  }
}

async function browserInUse(rb: RunningBrowser): Promise<boolean> {
  // Another CDP client (e.g. a browser-use MCP server of a running agent) attached to a tab = in use.
  const { targetInfos } = await rb.client.send<{ targetInfos: { type: string; url: string; attached: boolean }[] }>("Target.getTargets");
  if (targetInfos.some((t) => isUserPage(t) && t.attached)) return true;
  // A visible window the human is focused on is in use too.
  if (rb.headless) return false;
  const page = await pickActivePage(rb.client, { port: rb.port });
  return !!page && (await pageHasFocus(rb, page.targetId));
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

/* ------------------------------------------------------------------ */
/* Chat tabs                                                            */
/* ------------------------------------------------------------------ */

const opening = new Map<string, Promise<string>>();

/** The chat's tab: the one it works in, else a spare blank page, else a new background window. */
export async function ensureChatTab(rb: RunningBrowser, conversationId: string): Promise<string> {
  const current = rb.tabs.currentPage(conversationId);
  if (current) return current.targetId;
  const key = `${rb.profileId}:${conversationId}`;
  const inflight = opening.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const spare = rb.tabs.spareBlankPage();
    if (spare) {
      rb.tabs.claim(spare.targetId, conversationId);
      return spare.targetId;
    }
    const { targetId } = await rb.client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
    rb.tabs.claim(targetId, conversationId);
    return targetId;
  })().finally(() => opening.delete(key));
  opening.set(key, p);
  return p;
}

/** A chat's tab (with `urlContains`: its tab whose URL contains it, preferring the one it works in). */
function chatPage(rb: RunningBrowser, conversationId: string, urlContains?: string): PageTarget | null {
  const current = rb.tabs.currentPage(conversationId);
  const needle = urlContains?.toLowerCase();
  const page = needle
    ? [current, ...rb.tabs.pagesOf(conversationId).reverse()].find((p) => p?.url.toLowerCase().includes(needle))
    : current;
  return page ? { targetId: page.targetId, url: page.url, title: page.title, attached: true } : null;
}

/** Close a chat's tabs (deleted, archived or idle chats). The browser's last page stays open, blank, for the next chat. */
async function closeTabsOf(rb: RunningBrowser, conversationId: string) {
  if (leasedChats(rb.profileId).has(conversationId)) return;
  const pages = rb.tabs.pagesOf(conversationId);
  // Closing its last window quits Chromium on Windows and Linux.
  const keep = rb.tabs.userPages().length > pages.length ? null : pages[0];
  for (const page of pages) {
    if (page === keep) continue;
    await rb.client
      .send("Target.closeTarget", { targetId: page.targetId }, undefined, 5000)
      .then(() => rb.tabs.forget(page.targetId))
      .catch(() => {});
  }
  if (keep) {
    const session = await attachToPage(rb.client, keep.targetId).catch(() => null);
    await session?.navigate("about:blank").catch(() => {});
    await session?.detach();
  }
  rb.tabs.dropChat(conversationId, keep?.targetId);
}

export async function closeChatTabs(conversationId: string): Promise<void> {
  await Promise.all(
    allRunning()
      .filter((rb) => !rb.stopping)
      .map((rb) => closeTabsOf(rb, conversationId).catch((err) => log.warn(`could not close the tabs of chat ${conversationId}`, err))),
  );
}

/* ------------------------------------------------------------------ */
/* Pages                                                                */
/* ------------------------------------------------------------------ */

/**
 * Attach to the page a chat works in — or, without a chat, the browser's active page — optionally the one whose
 * URL contains `urlContains`.
 */
async function withPage<T>(
  rb: RunningBrowser,
  opts: { conversationId?: string; urlContains?: string },
  fn: (page: PageSession, url: string) => Promise<T>,
): Promise<T | null> {
  const target = opts.conversationId
    ? chatPage(rb, opts.conversationId, opts.urlContains)
    : await pickActivePage(rb.client, { port: rb.port, urlContains: opts.urlContains });
  if (!target) return null;
  const page = await attachToPage(rb.client, target.targetId);
  try {
    return await fn(page, target.url);
  } finally {
    await page.detach();
  }
}

/**
 * Type text into the focused (or selector-matched) element of the chat's page (without a chat: the active page)
 * WITHOUT the model seeing it. Used for passwords and TOTP codes. The field's frame must belong to `allowedHosts`
 * (https) or `httpHosts` (http) — see fill.ts — otherwise nothing is typed.
 */
export async function fillIntoPage(
  profileId: string,
  opts: {
    text: string;
    /** Field kind — used to auto-locate the input when nothing suitable is focused and no selector is given. */
    kind?: FillKind;
    selector?: string;
    urlContains?: string;
    /** The chat whose tab gets the text. */
    conversationId?: string;
    submit?: boolean;
    /** Sites the secret belongs to (credential domains + URL host); the field's frame must be https on one of them. */
    allowedHosts: string[];
    /** Hosts also allowed over plain http (the credential's own http:// URL host). */
    httpHosts?: string[];
  },
): Promise<{ ok: boolean; url: string; detail: string }> {
  requireRow(profileId);
  const refused = fillPrecheck(opts);
  if (refused) return refused;
  const rb = getRunning(profileId);
  if (!rb) return { ok: false, url: "", detail: "The browser is not running. Open the login page with the browser tools first." };
  rb.lastUsedAt = Date.now();
  try {
    const chat = opts.conversationId;
    return await fillIntoActivePage(
      { client: rb.client, port: rb.port, ...(chat ? { chatPage: (urlContains?: string) => chatPage(rb, chat, urlContains) } : {}) },
      opts,
    );
  } finally {
    rb.lastUsedAt = Date.now();
  }
}

/** URL + title of the page a chat works in, or without a chat of the most recently active page. */
export async function currentPage(profileId: string, conversationId?: string): Promise<{ url: string; title: string } | null> {
  const rb = getRunning(profileId);
  if (!rb) return null;
  if (conversationId) {
    const page = rb.tabs.currentPage(conversationId);
    return page ? { url: page.url, title: page.title } : null;
  }
  try {
    const page = await pickActivePage(rb.client, { port: rb.port });
    return page ? { url: page.url, title: page.title } : null;
  } catch {
    return null;
  }
}

/** Navigate the chat's tab — without a chat the active tab — (opening one if there is none), launching the browser if needed. */
export async function navigate(profileId: string, url: string, conversationId?: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw badRequest("Only http and https URLs can be opened");
  const rb = await ensureBrowser(profileId);
  rb.lastUsedAt = Date.now();
  if (conversationId) await ensureChatTab(rb, conversationId);
  const done = await withPage(rb, { conversationId }, async (page) => {
    await page.navigate(parsed.href);
    return true;
  });
  if (!done) await rb.client.send("Target.createTarget", { url: parsed.href, newWindow: true, background: true });
}

/** What bot detection sees in the profile's browser; a browser started just for the check is stopped again. */
export async function botCheck(profileId: string): Promise<BotCheckReport> {
  requireRow(profileId);
  const rb = await ensureBrowser(profileId, { transient: true });
  rb.lastUsedAt = Date.now();
  // The check's window may be the browser's last one: leave it blank for the next chat instead of closing the browser.
  const close = async (targetId: string) => {
    if (rb.tabs.userPages().some((p) => p.targetId !== targetId)) {
      await rb.client.send("Target.closeTarget", { targetId });
      rb.tabs.forget(targetId);
      return;
    }
    const page = await attachToPage(rb.client, targetId);
    try {
      await page.navigate("about:blank");
    } finally {
      await page.detach();
    }
    rb.tabs.addSpares([targetId]);
  };
  try {
    const { product } = await rb.client.send<{ product: string }>("Browser.getVersion");
    return await botCheckReport(rb.client, { profileId, browser: product.replace(/^HeadlessChrome/, "Chrome"), headless: rb.headless, stealth: rb.stealth }, close);
  } finally {
    await giveBack(rb);
  }
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

const runDirs = new Map<string, string>();
/** When a profile's browser was last handed to a run (the idle sweep must not close it right after). */
const handedOut = new Map<string, number>();
/** browser-use gives up on connecting after 15 s and can't recover within the same run. */
const BROWSER_USE_CONNECT_BUDGET_MS = 14_000;

type LaunchProblemListener = (runId: string, text: string) => void;
const launchProblemListeners = new Set<LaunchProblemListener>();

/** Told when a run's browser couldn't be started in time, so the run can tell the human. */
export function onLaunchProblem(fn: LaunchProblemListener): () => void {
  launchProblemListeners.add(fn);
  return () => {
    launchProblemListeners.delete(fn);
  };
}

function reportLaunchProblem(runId: string, text: string) {
  for (const fn of [...launchProblemListeners]) {
    try {
      fn(runId, text);
    } catch (err) {
      log.warn("launch problem listener failed", err);
    }
  }
}

/** Start (or reuse) the profile's browser for a run's endpoint, with a tab ready for its chat. */
async function openForRun(runId: string, profileId: string, conversationId: string, headless: boolean): Promise<RunningBrowser> {
  const startedAt = Date.now();
  let rb: RunningBrowser;
  try {
    rb = await ensureBrowser(profileId, { headless });
    if (rb.stopping) rb = await ensureBrowser(profileId, { headless });
    await ensureChatTab(rb, conversationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`could not start the browser for profile ${profileId} (run ${runId}): ${message}`);
    reportLaunchProblem(runId, `The browser couldn't start, so browser tools won't work in this run. ${message}`);
    throw err;
  }
  const took = Date.now() - startedAt;
  if (took > BROWSER_USE_CONNECT_BUDGET_MS) {
    reportLaunchProblem(runId, `The browser took ${Math.round(took / 1000)} s to start, too long for this run's browser tools. It's running now, so the next message can use it.`);
  }
  rb.lastUsedAt = Date.now();
  handedOut.set(profileId, rb.lastUsedAt);
  return rb;
}

/**
 * MCP server entry giving a run browser tools: browser-use MCP connected over CDP to the profile's Chromium — `profileId`
 * as resolved for the run, else the agent's — through the run's own endpoint that only reaches its chat's tabs
 * (proxy.ts). Returns null when browser is disabled for the agent or globally; throws (with a message fit for the
 * human) when browser tools are enabled but can't be provided. Call `releaseChatBrowser` when the run ends.
 */
export async function browserMcpServer(
  agent: Agent,
  run: { runId: string; conversationId: string },
  profileId?: string | null,
): Promise<McpServerJson | null> {
  const settings = getSettings();
  if (!settings.browser.enabled || !agent.browser?.enabled) return null;

  const command = browserUseCommand(settings.browser.browserUseCommand, resolveUvx());
  if (!command) {
    throw new HttpError(424, "uv (uvx) is not installed, so browser-use can't start. Install it in Settings → Dependencies.", "uv_missing");
  }

  const profile = profileId ? getProfile(profileId) : resolveProfileForAgent(agent, run.conversationId);
  const headless = agent.browser.headless ?? settings.browser.headless;
  const running = getRunning(profile.id);
  if (!running) requireChrome(settings.browser.chromePath);
  // No browser starts here: browser-use asks the run's endpoint for it on its first browser tool call.
  const cdpUrl = openChatLease({
    runId: run.runId,
    profileId: profile.id,
    conversationId: run.conversationId,
    open: () => openForRun(run.runId, profile.id, run.conversationId, headless),
  });
  emitProfileSoon(profile.id);

  const cfg = config();
  const configDir = join(cfg.dataDir, "browser-use", profile.id, agent.id);
  // Parallel runs of one agent each get their own config (their own endpoint) and scratch files, which browser-use
  // wipes on every start anyway.
  const runDir = join(configDir, "runs", run.runId);
  const configPath = join(runDir, "config.json");
  runDirs.set(run.runId, runDir);
  const workspace = agent.repoPath ? join(agent.repoPath, "workspace") : join(cfg.dataDir, "browser-use", profile.id, agent.id, "files");
  writeBrowserUseConfig({
    configDir,
    configPath,
    cdpUrl,
    headless: running?.headless ?? headless,
    stealth: running?.stealth ?? settings.browser.stealth,
    userDataDir: profile.userDataDir,
    downloadsPath: join(workspace, "downloads"),
    fileSystemPath: join(runDir, "files"),
  });
  touchBrowser(profile.id);
  const env = browserUseEnv(configDir, toolPath(), configPath);
  // browser-use's content extraction tools need an OpenAI-compatible LLM. Pass the key via env only (never into
  // browser-use's config file); without one, the runner hides those tools from Claude.
  const llmKey = browserLlmKey();
  if (llmKey) env.OPENAI_API_KEY = llmKey;
  return { command: command.command, args: command.args, env };
}

/** The run ended: its browser endpoint stops working; the chat keeps its tabs for its next message. */
export function releaseChatBrowser(runId: string) {
  const lease = releaseChatLease(runId);
  if (lease) {
    getRunning(lease.profileId)?.tabs.touch(lease.conversationId);
    emitProfileSoon(lease.profileId);
  }
  const runDir = runDirs.get(runId);
  runDirs.delete(runId);
  try {
    if (runDir) rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (err) {
    log.warn(`could not remove ${runDir}`, err);
  }
}

/** OpenAI API key for browser-use's LLM-backed tools (extract_content, retry agent), if configured. */
export function browserLlmKey(): string | null {
  try {
    return isUnlocked() ? getAppSecret("openai_api_key") : null;
  } catch {
    return null;
  }
}

/** browser-use MCP tools that only work with an LLM key configured. */
export const BROWSER_LLM_TOOLS = ["browser_extract_content", "retry_with_browser_use_agent"];

/* ------------------------------------------------------------------ */
/* Chrome session import                                                */
/* ------------------------------------------------------------------ */

export async function listLocalChromeProfiles(): Promise<LocalChromeProfile[]> {
  return importer.listLocalChromeProfiles();
}

/**
 * Every cookie of one of Godmode's own profiles (its browser starts headless just for this when it isn't running).
 * For copying the profile's sessions to a runner.
 */
export async function exportProfileCookies(profileId: string): Promise<CdpCookie[]> {
  requireRow(profileId);
  const rb = await ensureBrowser(profileId, { headless: true, transient: true });
  try {
    return await getCookies(rb.client);
  } finally {
    await giveBack(rb);
  }
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
  const rb = await ensureBrowser(profileId, { headless: true, transient: true });
  let result: { set: number; failed: number; total: number };
  try {
    result = await importer.injectCookies(rb.client, cookies);
  } finally {
    await giveBack(rb);
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
