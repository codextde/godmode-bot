/**
 * "Continue where Chrome left off": read the user's sessions (cookies) from a local Chromium-family
 * profile — or from an exported cookie file — and inject them into a Godmode browser profile.
 *
 * Local profiles use the same technique as browser-use's profile-use: copy the profile's cookie store to a
 * temporary user-data-dir, start the SAME browser binary headless on it (it can decrypt its own cookies
 * with the OS keychain / DPAPI / app-bound key), read them with `Storage.getCookies` and delete the copy.
 * Chrome 136+ refuses remote debugging on the default user-data-dir, which is why the copy is required.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ChromeImportInput, ChromeImportResult, LocalChromeProfile } from "@godmode/shared";
import { logger } from "../log";
import { badRequest, domainMatches, sleep } from "../util";
import { CdpClient, getCookies, setCookies, type CdpCookie, type CdpCookieParam } from "./cdp";
import { chromeCandidates, findChrome, launchChrome, type DetectOptions } from "./chrome";

const log = logger("browser-import");

/* ------------------------------------------------------------------ */
/* Local browser profiles                                               */
/* ------------------------------------------------------------------ */

export interface BrowserSource {
  browser: string;
  /** User-data-dir root containing "Local State" and the profile folders. */
  root: string;
}

/** Where each Chromium-family browser keeps its user data on this OS. */
export function browserSources(opts: DetectOptions = {}): BrowserSource[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  if (platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    return [
      { browser: "Google Chrome", root: join(base, "Google", "Chrome") },
      { browser: "Google Chrome Beta", root: join(base, "Google", "Chrome Beta") },
      { browser: "Google Chrome Dev", root: join(base, "Google", "Chrome Dev") },
      { browser: "Google Chrome Canary", root: join(base, "Google", "Chrome Canary") },
      { browser: "Chromium", root: join(base, "Chromium") },
      { browser: "Microsoft Edge", root: join(base, "Microsoft Edge") },
      { browser: "Brave", root: join(base, "BraveSoftware", "Brave-Browser") },
    ];
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    const w = (...parts: string[]) => [local, ...parts, "User Data"].join("\\");
    return [
      { browser: "Google Chrome", root: w("Google", "Chrome") },
      { browser: "Google Chrome Beta", root: w("Google", "Chrome Beta") },
      { browser: "Google Chrome Dev", root: w("Google", "Chrome Dev") },
      { browser: "Google Chrome Canary", root: w("Google", "Chrome SxS") },
      { browser: "Chromium", root: w("Chromium") },
      { browser: "Microsoft Edge", root: w("Microsoft", "Edge") },
      { browser: "Brave", root: w("BraveSoftware", "Brave-Browser") },
    ];
  }
  const base = env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    { browser: "Google Chrome", root: join(base, "google-chrome") },
    { browser: "Google Chrome Beta", root: join(base, "google-chrome-beta") },
    { browser: "Google Chrome Dev", root: join(base, "google-chrome-unstable") },
    { browser: "Chromium", root: join(base, "chromium") },
    { browser: "Chromium", root: join(home, "snap", "chromium", "common", "chromium") },
    { browser: "Microsoft Edge", root: join(base, "microsoft-edge") },
    { browser: "Brave", root: join(base, "BraveSoftware", "Brave-Browser") },
  ];
}

interface LocalState {
  profile?: { info_cache?: Record<string, { name?: string; user_name?: string; gaia_name?: string }> };
}

/** Parse a browser's "Local State" into its profiles (only folders that exist). */
export function profilesFromLocalState(browser: string, root: string, localStateJson: string): LocalChromeProfile[] {
  let state: LocalState;
  try {
    state = JSON.parse(localStateJson) as LocalState;
  } catch {
    return [];
  }
  const cache = state.profile?.info_cache ?? {};
  return Object.entries(cache)
    .filter(([dir]) => existsSync(join(root, dir)))
    .map(([dir, info]) => ({
      browser,
      profileDir: dir,
      name: info.name?.trim() || info.gaia_name?.trim() || dir,
      email: info.user_name?.trim() || null,
      path: join(root, dir),
    }))
    .sort((a, b) => (a.profileDir === "Default" ? -1 : b.profileDir === "Default" ? 1 : a.profileDir.localeCompare(b.profileDir, undefined, { numeric: true })));
}

export async function listLocalChromeProfiles(opts: DetectOptions = {}): Promise<LocalChromeProfile[]> {
  const out: LocalChromeProfile[] = [];
  for (const src of browserSources(opts)) {
    let json: string;
    try {
      json = readFileSync(join(src.root, "Local State"), "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") log.debug(`cannot read ${src.browser} Local State (${code})`);
      continue;
    }
    out.push(...profilesFromLocalState(src.browser, src.root, json));
  }
  return out;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "linux" ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Cookie normalization (JSON exports, Netscape cookies.txt, CDP)       */
/* ------------------------------------------------------------------ */

type SameSite = "Strict" | "Lax" | "None";

function mapSameSite(v: unknown): SameSite | undefined {
  if (typeof v !== "string") return undefined;
  switch (v.toLowerCase()) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "none":
    case "no_restriction":
      return "None";
    default:
      return undefined;
  }
}

function toSeconds(v: unknown): number | undefined {
  let n: number | undefined;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim()) n = /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : Date.parse(v) / 1000;
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e11 ? n / 1000 : n; // milliseconds → seconds
}

export const EXPIRED = Symbol("expired");

/**
 * Normalize one cookie from any supported format into a CDP CookieParam:
 *  - CDP (`Storage.getCookies`): expires (s, -1 = session), sameSite "Lax", partitionKey
 *  - Playwright storage_state: expires (s, -1 = session), sameSite "Lax"
 *  - Cookie-Editor / EditThisCookie (chrome.cookies API): expirationDate, hostOnly, session, sameSite "no_restriction"
 *  - Selenium: expiry
 * A leading dot (or hostOnly=false) means a domain cookie; otherwise the cookie is host-only and is set by URL.
 */
export function normalizeCookie(raw: unknown, nowSec = Date.now() / 1000): CdpCookieParam | null | typeof EXPIRED {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.name !== "string") return null;
  const name = c.name;
  const value = c.value == null ? "" : String(c.value);
  let domain = typeof c.domain === "string" ? c.domain.trim() : typeof c.host === "string" ? c.host.trim() : "";
  if (!domain && typeof c.url === "string") {
    try {
      domain = new URL(c.url).hostname;
    } catch {
      /* invalid */
    }
  }
  domain = domain.toLowerCase();
  if (!domain || /[\s/]/.test(domain)) return null;
  if (!name && !value) return null;

  const path = typeof c.path === "string" && c.path.startsWith("/") ? c.path : "/";
  const secure = c.secure === true || c.secure === "true";
  const httpOnly = c.httpOnly === true || c.httpOnly === "true";
  const session = c.session === true;
  const expires = session ? undefined : toSeconds(c.expires ?? c.expirationDate ?? c.expiry);
  if (expires !== undefined && expires < nowSec) return EXPIRED;

  const hostOnly = typeof c.hostOnly === "boolean" ? c.hostOnly : !domain.startsWith(".");
  const bare = domain.replace(/^\.+/, "");
  const param: CdpCookieParam = { name, value, path, secure, httpOnly };
  let hostUrl: string | null = null;
  if (hostOnly) {
    const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(bare);
    try {
      hostUrl = new URL(`${secure || !local ? "https" : "http"}://${bare}${path}`).href;
    } catch {
      hostUrl = null;
    }
  }
  if (hostUrl) param.url = hostUrl;
  else param.domain = `.${bare}`;

  let sameSite = mapSameSite(c.sameSite);
  // SameSite=None requires Secure; Chrome would reject the cookie otherwise.
  if (sameSite === "None" && !secure) sameSite = undefined;
  if (sameSite) param.sameSite = sameSite;
  if (expires !== undefined) param.expires = expires;
  if (c.priority === "Low" || c.priority === "Medium" || c.priority === "High") param.priority = c.priority;

  const pk = c.partitionKey;
  const topLevelSite = typeof pk === "string" ? pk : pk && typeof pk === "object" ? (pk as { topLevelSite?: unknown }).topLevelSite : undefined;
  if (secure && typeof topLevelSite === "string" && /^https:\/\/[^/]+$/.test(topLevelSite)) {
    param.partitionKey = { topLevelSite, hasCrossSiteAncestor: !!(pk && typeof pk === "object" && (pk as { hasCrossSiteAncestor?: unknown }).hasCrossSiteAncestor) };
  }
  return param;
}

/** Netscape / curl cookies.txt (tab separated: domain, includeSubdomains, path, secure, expiry, name, value). */
export function parseNetscapeCookies(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#") || !line.trim()) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    const [domain, includeSub, path, secure, expiry, name, ...rest] = f;
    const exp = Number(expiry);
    out.push({
      domain,
      hostOnly: includeSub!.toUpperCase() !== "TRUE",
      path,
      secure: secure!.toUpperCase() === "TRUE",
      httpOnly,
      name,
      value: rest.join("\t"),
      ...(exp > 0 ? { expires: exp } : { session: true }),
    });
  }
  return out;
}

export interface CookieBatch {
  cookies: CdpCookieParam[];
  skipped: number;
}

/** Keep cookies whose domain matches one of `domains` (exact, subdomain or parent domain). Empty = all. */
export function filterByDomains(cookies: CdpCookieParam[], domains: string[] | undefined): { kept: CdpCookieParam[]; dropped: number } {
  const wanted = (domains ?? []).map((d) => d.trim()).filter(Boolean);
  if (!wanted.length) return { kept: cookies, dropped: 0 };
  const kept = cookies.filter((c) => {
    const host = (c.domain ?? (c.url ? new URL(c.url).hostname : "")).replace(/^\./, "");
    return wanted.some((d) => domainMatches(host, d));
  });
  return { kept, dropped: cookies.length - kept.length };
}

export function normalizeCookies(list: unknown[], nowSec = Date.now() / 1000): CookieBatch {
  const cookies: CdpCookieParam[] = [];
  let skipped = 0;
  for (const raw of list) {
    const c = normalizeCookie(raw, nowSec);
    if (c && c !== EXPIRED) cookies.push(c);
    else skipped++;
  }
  return { cookies, skipped };
}

/** Parse an exported cookie file: JSON array, `{ cookies: [...] }` (Playwright/CDP) or Netscape cookies.txt. */
export function parseCookieExport(text: string, nowSec = Date.now() / 1000): CookieBatch {
  const trimmed = text.trim();
  if (!trimmed) throw badRequest("The cookie data is empty");
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    if (trimmed.includes("\t")) {
      const rows = parseNetscapeCookies(trimmed);
      if (rows.length) return normalizeCookies(rows, nowSec);
    }
    throw badRequest("Cookie data must be JSON (Cookie-Editor, EditThisCookie, Playwright storage_state or CDP) or a Netscape cookies.txt file");
  }
  let list: unknown[] | null = null;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object") {
    const obj = data as { cookies?: unknown; result?: { cookies?: unknown } };
    if (Array.isArray(obj.cookies)) list = obj.cookies;
    else if (obj.result && Array.isArray(obj.result.cookies)) list = obj.result.cookies;
  }
  if (!list) throw badRequest("Unrecognized cookie JSON: expected an array of cookies or an object with a `cookies` array");
  return normalizeCookies(list, nowSec);
}

/* ------------------------------------------------------------------ */
/* Reading cookies from a local profile                                 */
/* ------------------------------------------------------------------ */

function fsErrorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

function copyProfileFiles(profileDir: string, tmpRoot: string, browser: string) {
  const root = dirname(profileDir);
  const target = join(tmpRoot, "Default");
  mkdirSync(join(target, "Network"), { recursive: true });
  const files: [string, string][] = [[join(root, "Local State"), join(tmpRoot, "Local State")]];
  for (const rel of ["Network/Cookies", "Network/Cookies-journal", "Network/Cookies-wal", "Network/Cookies-shm", "Cookies", "Cookies-journal", "Preferences"]) {
    files.push([join(profileDir, ...rel.split("/")), join(target, ...rel.split("/"))]);
  }
  for (const [src, dst] of files) {
    if (!existsSync(src)) continue;
    try {
      copyFileSync(src, dst);
    } catch (err) {
      const code = fsErrorCode(err);
      if (process.platform === "win32" && (code === "EBUSY" || code === "EPERM" || code === "EACCES")) {
        throw badRequest(`Close ${browser} and try again — it locks its cookie database while it is running.`);
      }
      if (code === "EPERM" || code === "EACCES") {
        throw badRequest(
          process.platform === "darwin"
            ? `Godmode is not allowed to read ${browser}'s profile. Grant Godmode "Full Disk Access" in System Settings → Privacy & Security, then try again.`
            : `Permission denied reading ${src}`,
        );
      }
      throw err;
    }
  }
}

function countCookieRows(tmpRoot: string): number {
  for (const rel of [["Network", "Cookies"], ["Cookies"]]) {
    const path = join(tmpRoot, "Default", ...rel);
    if (!existsSync(path)) continue;
    let db: Database | null = null;
    try {
      db = new Database(path, { readonly: true });
      return db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM cookies").get()?.c ?? 0;
    } catch {
      return -1;
    } finally {
      db?.close();
    }
  }
  return 0;
}

function removeDir(path: string) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    log.warn(`could not remove temporary profile copy ${path}`, err);
  }
}

/** The executable that owns a user-data-dir root (same brand = same keychain item / encryption key). */
function executableFor(root: string): { browser: string; path: string } | null {
  const source = browserSources().find((s) => samePath(s.root, root));
  if (source) {
    const exe = chromeCandidates().find((c) => c.browser === source.browser && existsSync(c.path));
    if (exe) return { browser: source.browser, path: exe.path };
    return null;
  }
  const any = findChrome();
  return any ? { browser: any.browser, path: any.path } : null;
}

/** Decrypted cookies of a local profile folder (e.g. ".../Google/Chrome/Profile 1"). */
export async function readProfileCookies(sourcePath: string): Promise<{ cookies: CdpCookie[]; browser: string; profileLabel: string }> {
  const profileDir = resolve(sourcePath);
  try {
    if (!statSync(profileDir).isDirectory()) throw badRequest(`${sourcePath} is not a folder`);
  } catch (err) {
    if (err instanceof Error && "status" in err) throw err;
    const code = fsErrorCode(err);
    if (code === "EPERM" || code === "EACCES") throw badRequest(`Permission denied reading ${sourcePath}`);
    throw badRequest(`Browser profile folder not found: ${sourcePath}`);
  }
  if (!existsSync(join(profileDir, "Network", "Cookies")) && !existsSync(join(profileDir, "Cookies"))) {
    throw badRequest(`No cookie database found in ${sourcePath}`);
  }
  const root = dirname(profileDir);
  const owner = executableFor(root);
  const browser = owner?.browser ?? "the browser";
  if (!owner) throw badRequest(`Can't find the ${browserSources().find((s) => samePath(s.root, root))?.browser ?? "browser"} executable needed to decrypt this profile's cookies.`);

  let profileLabel = basename(profileDir);
  try {
    const listed = profilesFromLocalState(browser, root, readFileSync(join(root, "Local State"), "utf8")).find((p) => p.profileDir === basename(profileDir));
    if (listed) profileLabel = listed.name;
  } catch {
    /* no Local State */
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "godmode-import-"));
  let chrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let client: CdpClient | null = null;
  try {
    copyProfileFiles(profileDir, tmpRoot, browser);
    const rows = countCookieRows(tmpRoot);
    chrome = await launchChrome({
      executable: owner.path,
      userDataDir: tmpRoot,
      headless: true,
      startUrl: "about:blank",
      // Local State may point at another last-used profile; the copy is always "Default".
      extraArgs: ["--profile-directory=Default", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update"],
    });
    client = await CdpClient.connect(chrome.wsUrl);
    const cookies = await getCookies(client);
    if (rows > 0 && cookies.length === 0) {
      throw badRequest(
        process.platform === "darwin"
          ? `${browser} could not decrypt the cookies. If macOS asked for access to "${browser} Safe Storage" in the keychain, choose "Allow" and try again.`
          : `${browser} could not decrypt the cookies of this profile.`,
      );
    }
    log.info(`read ${cookies.length} cookies from ${browser} profile "${profileLabel}"`);
    return { cookies, browser, profileLabel };
  } finally {
    if (client) {
      try {
        await client.send("Browser.close", {}, undefined, 3000);
      } catch {
        /* ignore */
      }
      client.close();
    }
    if (chrome) {
      await Promise.race([chrome.exited, sleep(5000)]);
      if (chrome.isAlive()) {
        chrome.kill("SIGKILL");
        await Promise.race([chrome.exited, sleep(2000)]);
      }
    }
    removeDir(tmpRoot);
  }
}

/** A CDP cookie read from a browser → CookieParam that recreates it (host-only stays host-only). */
export function cdpCookieToParam(c: CdpCookie): CdpCookieParam | null {
  const param = normalizeCookie({ ...c, hostOnly: !c.domain.startsWith(".") });
  return param && typeof param === "object" ? param : null;
}

/* ------------------------------------------------------------------ */
/* Entry points used by the manager                                     */
/* ------------------------------------------------------------------ */

export async function collectCookies(
  input: ChromeImportInput,
): Promise<{ cookies: CdpCookieParam[]; skipped: number; source: string; method: ChromeImportResult["method"] }> {
  if (input.cookiesJson && input.cookiesJson.trim()) {
    const batch = parseCookieExport(input.cookiesJson);
    const { kept, dropped } = filterByDomains(batch.cookies, input.domains);
    return { cookies: kept, skipped: batch.skipped + dropped, source: "Cookie file", method: "json" };
  }
  if (input.sourcePath && input.sourcePath.trim()) {
    const { cookies, browser, profileLabel } = await readProfileCookies(input.sourcePath.trim());
    let skipped = 0;
    const params: CdpCookieParam[] = [];
    const nowSec = Date.now() / 1000;
    for (const c of cookies) {
      if (!c.session && c.expires > 0 && c.expires < nowSec) {
        skipped++;
        continue;
      }
      const p = cdpCookieToParam(c);
      if (p) params.push(p);
      else skipped++;
    }
    const { kept, dropped } = filterByDomains(params, input.domains);
    return { cookies: kept, skipped: skipped + dropped, source: `${browser} — ${profileLabel}`, method: "cdp" };
  }
  throw badRequest("Choose a local browser profile or paste exported cookies");
}

/** Set cookies in a running browser; returns how many were accepted and the store's new total. */
export async function injectCookies(client: CdpClient, cookies: CdpCookieParam[]): Promise<{ set: number; failed: number; total: number }> {
  const { set, failed } = await setCookies(client, cookies);
  let total = set;
  try {
    total = (await getCookies(client)).length;
  } catch {
    /* keep the imported count */
  }
  return { set, failed, total };
}
