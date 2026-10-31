/**
 * More than one Claude subscription (owner: runner).
 *
 * Claude Code's own login on this computer is the system account. More accounts are signed in from Godmode with
 * `claude auth login` in a Claude config of their own, so the system login is never touched; their OAuth tokens move to
 * the vault and the config is thrown away. A run on such an account gets its access token as CLAUDE_CODE_OAUTH_TOKEN
 * (Claude Code's settings, plugins and sessions stay the same), refreshed here before it runs out.
 *
 * Runs use the default account (Godmode's, or the workspace's own choice). With auto-switch on, a run starts on another
 * account once the default is at the switch threshold, and a run that hits a usage limit continues right away on an
 * account with room left instead of waiting for the reset.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SYSTEM_CLAUDE_ACCOUNT,
  type ClaudeAccount,
  type ClaudeAccountLogin,
  type ClaudeAccountsState,
  type ClaudeUsage,
  type WorkspaceClaudeAccounts,
} from "@godmode/shared";
import { config } from "../config";
import { all, deleteMeta, get, getMeta, insert, run, setMeta, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { badRequest, childEnv, newId, notFound, now, parseJson } from "../util";
import { getAppSecret, isUnlocked, setAppSecret } from "../vault/vault";
import { claudeConfigDir } from "./claudeUpdate";
import { claudeUsage, keychainService, parseCredentials, parseUsage } from "./claudeUsage";
import { resolveClaudeBinary, runCommand, stripAnsi, toolPath } from "./doctor";
import { notify } from "./notifications";
import { getSettings } from "./settings";

const log = logger("claude-accounts");

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA = "oauth-2025-04-20";
/** A run gets a token that lasts at least this long; a longer one is refreshed first. */
const REFRESH_AHEAD_MS = 2 * 60 * 60_000;
const USAGE_FRESH_MS = 60_000;
/** Picking an account for a run waits this long at most for fresh usage. */
const USAGE_WAIT_MS = 5_000;
/** A limit that didn't say when it resets keeps the account aside this long. */
const LIMIT_FALLBACK_MS = 60 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const KEEPALIVE_MS = 30 * 60_000;
const DEFAULT_META = "claude.accounts.default";
const SYSTEM_LIMIT_META = "claude.accounts.system_limited";
const URL_RE = /https:\/\/\S+/;

interface AccountRow {
  id: string;
  email: string | null;
  name: string | null;
  organization: string | null;
  plan: string | null;
  limited_until: string | null;
  needs_sign_in: number;
  last_used_at: string | null;
  created_at: string;
}

/** Claude Code's `claudeAiOauth` block, as kept in the vault. */
interface OAuthBlock {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number | null;
  subscriptionType?: string | null;
  [key: string]: unknown;
}

/** The account a run works with. `token` is null for the system account (Claude Code signs in by itself). */
export interface RunAccount {
  id: string;
  label: string;
  token: string | null;
}

const secretKey = (id: string) => `claude_account:${id}`;
const usageCache = new Map<string, { at: number; value: ClaudeUsage }>();
let usageRefresh: Promise<void> | null = null;
let usageRefreshedAt = 0;
const refreshing = new Map<string, Promise<OAuthBlock | null>>();

function changed() {
  bus.changed("claude-accounts");
}

function rows(): AccountRow[] {
  return all<AccountRow>("SELECT * FROM claude_accounts ORDER BY created_at");
}

/** Whether accounts besides the system one exist: without them nothing here changes how runs start. */
export function hasClaudeAccounts(): boolean {
  return !!get<{ id: string }>("SELECT id FROM claude_accounts LIMIT 1");
}

/* ------------------------------------------------------------------ */
/* The system account                                                   */
/* ------------------------------------------------------------------ */

interface Identity {
  email: string | null;
  name: string | null;
  organization: string | null;
}

function identityOf(file: string): Identity {
  try {
    const acc = (JSON.parse(readFileSync(file, "utf8")) as { oauthAccount?: Record<string, unknown> }).oauthAccount;
    const str = (k: string) => (typeof acc?.[k] === "string" && acc[k] ? (acc[k] as string) : null);
    return { email: str("emailAddress")?.toLowerCase() ?? null, name: str("displayName"), organization: str("organizationName") };
  } catch {
    return { email: null, name: null, organization: null };
  }
}

function systemIdentity(): Identity {
  const custom = process.env.CLAUDE_CONFIG_DIR;
  const inDir = join(custom || claudeConfigDir(), ".claude.json");
  return identityOf(custom && existsSync(inDir) ? inDir : join(homedir(), ".claude.json"));
}

/* ------------------------------------------------------------------ */
/* Defaults and the list                                                */
/* ------------------------------------------------------------------ */

function defaultId(): string {
  const id = getMeta(DEFAULT_META);
  if (id && (id === SYSTEM_CLAUDE_ACCOUNT || get("SELECT id FROM claude_accounts WHERE id = ?", id))) return id;
  return SYSTEM_CLAUDE_ACCOUNT;
}

function limitedUntil(row: AccountRow | null): string | null {
  const until = row ? row.limited_until : getMeta(SYSTEM_LIMIT_META);
  return until && Date.parse(until) > Date.now() ? until : null;
}

function cachedUsage(id: string): ClaudeUsage | null {
  return usageCache.get(id)?.value ?? null;
}

function toModel(row: AccountRow | null, def: string): ClaudeAccount {
  if (!row) {
    const me = systemIdentity();
    const usage = cachedUsage(SYSTEM_CLAUDE_ACCOUNT);
    return {
      id: SYSTEM_CLAUDE_ACCOUNT,
      system: true,
      ...me,
      plan: usage?.plan ?? null,
      isDefault: def === SYSTEM_CLAUDE_ACCOUNT,
      usage,
      limitedUntil: limitedUntil(null),
      needsSignIn: usage?.state === "signed_out",
      lastUsedAt: getMeta("claude.accounts.system_used"),
      addedAt: null,
    };
  }
  return {
    id: row.id,
    system: false,
    email: row.email,
    name: row.name,
    organization: row.organization,
    plan: row.plan,
    isDefault: def === row.id,
    usage: cachedUsage(row.id),
    limitedUntil: limitedUntil(row),
    needsSignIn: !!row.needs_sign_in,
    lastUsedAt: row.last_used_at,
    addedAt: row.created_at,
  };
}

export function listClaudeAccounts(): ClaudeAccount[] {
  const def = defaultId();
  return [toModel(null, def), ...rows().map((r) => toModel(r, def))];
}

export function claudeAccountsState(): ClaudeAccountsState {
  if (Date.now() - usageRefreshedAt > USAGE_FRESH_MS) void refreshClaudeUsage();
  return { accounts: listClaudeAccounts(), login: loginStatus(), locked: !isUnlocked() };
}

export function setDefaultClaudeAccount(id: string): ClaudeAccount[] {
  if (id !== SYSTEM_CLAUDE_ACCOUNT && !get("SELECT id FROM claude_accounts WHERE id = ?", id)) throw notFound("Claude account");
  if (id === SYSTEM_CLAUDE_ACCOUNT) deleteMeta(DEFAULT_META);
  else setMeta(DEFAULT_META, id);
  changed();
  return listClaudeAccounts();
}

export function removeClaudeAccount(id: string): ClaudeAccount[] {
  if (id === SYSTEM_CLAUDE_ACCOUNT) throw badRequest("This computer's Claude Code login can't be removed here: sign out in Claude Code instead.");
  if (!get("SELECT id FROM claude_accounts WHERE id = ?", id)) throw notFound("Claude account");
  run("DELETE FROM claude_accounts WHERE id = ?", id);
  setAppSecret(secretKey(id), null);
  usageCache.delete(id);
  if (getMeta(DEFAULT_META) === id) deleteMeta(DEFAULT_META);
  // Workspaces that chose it: without it, the rest of their choice (or Godmode's) applies.
  for (const ws of all<{ id: string; claude_accounts: string }>("SELECT id, claude_accounts FROM workspaces WHERE claude_accounts IS NOT NULL")) {
    const next = cleanWorkspaceAccounts(parseJson<WorkspaceClaudeAccounts | null>(ws.claude_accounts, null));
    run("UPDATE workspaces SET claude_accounts = ? WHERE id = ?", next ? JSON.stringify(next) : null, ws.id);
  }
  bus.changed("workspaces");
  changed();
  return listClaudeAccounts();
}

/** A workspace's choice with accounts that no longer exist left out; null when nothing is left. */
export function cleanWorkspaceAccounts(value: WorkspaceClaudeAccounts | null | undefined): WorkspaceClaudeAccounts | null {
  if (!value || !Array.isArray(value.ids)) return null;
  const known = new Set([SYSTEM_CLAUDE_ACCOUNT, ...rows().map((r) => r.id)]);
  const ids = [...new Set(value.ids.filter((id) => typeof id === "string" && known.has(id)))];
  if (!ids.length) return null;
  return { ids, defaultId: ids.includes(value.defaultId) ? value.defaultId : ids[0]! };
}

/* ------------------------------------------------------------------ */
/* Tokens                                                               */
/* ------------------------------------------------------------------ */

function readTokens(id: string): OAuthBlock | null {
  if (!isUnlocked()) return null;
  try {
    const raw = getAppSecret(secretKey(id));
    const block = raw ? (JSON.parse(raw) as OAuthBlock) : null;
    return block && typeof block.accessToken === "string" && block.accessToken ? block : null;
  } catch (err) {
    log.warn(`could not read the tokens of Claude account ${id}`, err);
    return null;
  }
}

function markSignedOut(id: string, why: string) {
  const row = get<AccountRow>("SELECT * FROM claude_accounts WHERE id = ?", id);
  if (!row || row.needs_sign_in) return;
  run("UPDATE claude_accounts SET needs_sign_in = 1 WHERE id = ?", id);
  log.warn(`Claude account ${id} needs a new sign-in: ${why}`);
  notify("warning", `Sign in to ${row.email ?? "a Claude account"} again`, "Its sign-in ran out, so runs use your other Claude accounts for now.", "/settings/accounts");
  changed();
}

/** A run on this account found it signed out (the token was revoked or ran out). */
export function noteClaudeAccountSignedOut(id: string) {
  if (id !== SYSTEM_CLAUDE_ACCOUNT) markSignedOut(id, "a run was refused");
}

async function refreshTokens(id: string, block: OAuthBlock): Promise<OAuthBlock | null> {
  if (!block.refreshToken) {
    markSignedOut(id, "no refresh token");
    return null;
  }
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: block.refreshToken, client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok) {
      if (body.error === "invalid_grant") markSignedOut(id, "refresh token rejected");
      else log.warn(`refreshing Claude account ${id} failed`, { status: res.status, error: body.error });
      return null;
    }
    if (!body.access_token || typeof body.expires_in !== "number") return null;
    const next: OAuthBlock = {
      ...block,
      accessToken: body.access_token,
      refreshToken: body.refresh_token || block.refreshToken,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    // The old refresh token may be spent now: the new one is saved before anything else.
    setAppSecret(secretKey(id), JSON.stringify(next));
    return next;
  } catch (err) {
    log.warn(`refreshing Claude account ${id} failed`, { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** A working access token for a stored account, refreshed when it runs out soon; null when there is none. */
async function accessToken(id: string, aheadMs = REFRESH_AHEAD_MS): Promise<string | null> {
  const block = readTokens(id);
  if (!block) return null;
  const expires = typeof block.expiresAt === "number" ? block.expiresAt : null;
  if (expires === null || expires - Date.now() > aheadMs) return block.accessToken;
  let pending = refreshing.get(id);
  if (!pending) {
    pending = refreshTokens(id, block).finally(() => refreshing.delete(id));
    refreshing.set(id, pending);
  }
  const fresh = await pending;
  if (fresh) return fresh.accessToken;
  return expires > Date.now() + 60_000 ? block.accessToken : null;
}

/* ------------------------------------------------------------------ */
/* Usage                                                                */
/* ------------------------------------------------------------------ */

async function fetchAccountUsage(row: AccountRow): Promise<ClaudeUsage> {
  const empty = (state: ClaudeUsage["state"]): ClaudeUsage => ({ state, fiveHour: null, week: null, plan: row.plan, checkedAt: now() });
  if (row.needs_sign_in) return empty("signed_out");
  const token = await accessToken(row.id, 5 * 60_000);
  if (!token) return empty(isUnlocked() ? "signed_out" : "unavailable");
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": BETA, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return empty("signed_out");
    if (!res.ok) return cachedUsage(row.id) ?? empty("unavailable");
    return parseUsage(await res.json(), row.plan);
  } catch {
    return cachedUsage(row.id) ?? empty("unavailable");
  }
}

/** Fetches the usage of every account (one request each). */
export function refreshClaudeUsage(): Promise<void> {
  usageRefresh ??= (async () => {
    const list = rows();
    const results = await Promise.all([
      claudeUsage(true).catch(() => null),
      ...list.map((r) => fetchAccountUsage(r).catch(() => null)),
    ]);
    const at = (usageRefreshedAt = Date.now());
    if (results[0]) usageCache.set(SYSTEM_CLAUDE_ACCOUNT, { at, value: results[0] });
    list.forEach((r, i) => {
      const value = results[i + 1];
      if (value) usageCache.set(r.id, { at, value });
    });
    changed();
  })().finally(() => {
    usageRefresh = null;
  });
  return usageRefresh;
}

/** The higher of the session and weekly use; null when unknown. */
function binding(usage: ClaudeUsage | null): number | null {
  if (!usage || usage.state !== "ok") return null;
  return Math.max(usage.fiveHour?.percent ?? 0, usage.week?.percent ?? 0);
}

/* ------------------------------------------------------------------ */
/* Picking the account for a run                                        */
/* ------------------------------------------------------------------ */

function workspaceChoice(workspaceId: string | null): WorkspaceClaudeAccounts | null {
  if (!workspaceId) return null;
  const raw = get<{ claude_accounts: string | null }>("SELECT claude_accounts FROM workspaces WHERE id = ?", workspaceId)?.claude_accounts;
  return cleanWorkspaceAccounts(parseJson<WorkspaceClaudeAccounts | null>(raw ?? null, null));
}

/** The accounts a run may use, the default first. */
function pool(workspaceId: string | null): ClaudeAccount[] {
  const all = listClaudeAccounts();
  const choice = workspaceChoice(workspaceId);
  const ids = choice ? choice.ids : all.map((a) => a.id);
  const def = choice ? choice.defaultId : defaultId();
  const inPool = all.filter((a) => ids.includes(a.id));
  return [...inPool.filter((a) => a.id === def), ...inPool.filter((a) => a.id !== def)];
}

function label(a: ClaudeAccount): string {
  return a.email ?? (a.system ? "this computer's Claude login" : "a Claude account");
}

/** Usable at all: signed in, and its tokens are readable. */
function usable(a: ClaudeAccount): boolean {
  if (a.system) return true;
  return !a.needsSignIn && isUnlocked();
}

/** The order in which a run tries the accounts it may use. */
function ranked(candidates: ClaudeAccount[]): ClaudeAccount[] {
  const list = candidates.filter(usable);
  if (!getSettings().runner.accountAutoSwitch) return list;
  const threshold = getSettings().runner.accountSwitchPercent ?? 90;
  const room = (a: ClaudeAccount) => !a.limitedUntil && (binding(a.usage) ?? 0) < threshold;
  const [def, ...rest] = list;
  if (def && room(def)) return list;
  // Known room first; an account whose usage is unknown comes after them.
  const use = (a: ClaudeAccount) => binding(a.usage) ?? threshold - 0.5;
  const byUse = (x: ClaudeAccount, y: ClaudeAccount) => use(x) - use(y);
  const free = rest.filter(room).sort(byUse);
  const open = list.filter((a) => !room(a) && !a.limitedUntil).sort(byUse);
  // All at their limit: the one that resets first.
  const limited = list.filter((a) => a.limitedUntil).sort((x, y) => Date.parse(x.limitedUntil!) - Date.parse(y.limitedUntil!));
  return [...free, ...open, ...limited];
}

/**
 * The Claude account a run starts with, or null when only the system login exists (or this computer is a runner: its
 * runs use its own login).
 */
export async function accountForRun(workspaceId: string | null): Promise<RunAccount | null> {
  if (config().role === "runner" || !hasClaudeAccounts()) return null;
  if (getSettings().runner.accountAutoSwitch && Date.now() - usageRefreshedAt > 3 * USAGE_FRESH_MS) {
    await Promise.race([refreshClaudeUsage(), new Promise((r) => setTimeout(r, USAGE_WAIT_MS))]).catch(() => {});
  }
  for (const a of ranked(pool(workspaceId))) {
    if (a.system) {
      setMeta("claude.accounts.system_used", now());
      return { id: a.id, label: label(a), token: null };
    }
    const token = await accessToken(a.id);
    if (!token) continue;
    run("UPDATE claude_accounts SET last_used_at = ? WHERE id = ?", now(), a.id);
    return { id: a.id, label: label(a), token };
  }
  return null;
}

/** Points the run's Claude Code at the account: its token wins over a stored login and the vault's API key. */
export function applyAccountEnv(env: Record<string, string | undefined>, account: RunAccount | null) {
  if (!account?.token) return;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_OAUTH_TOKEN = account.token;
}

/**
 * A usage limit stopped a run on the account: it stays aside until the limit resets. Returns the account the run can go
 * on with right away, or null when none has room (or auto-switch is off).
 */
export function noteAccountLimit(id: string, resumeAt: string | null, workspaceId: string | null): { id: string; label: string } | null {
  const until = resumeAt && Date.parse(resumeAt) > Date.now() ? resumeAt : new Date(Date.now() + LIMIT_FALLBACK_MS).toISOString();
  if (id === SYSTEM_CLAUDE_ACCOUNT) setMeta(SYSTEM_LIMIT_META, until);
  else run("UPDATE claude_accounts SET limited_until = ? WHERE id = ?", until, id);
  changed();
  if (!getSettings().runner.accountAutoSwitch) return null;
  const next = ranked(pool(workspaceId)).find((a) => a.id !== id && !a.limitedUntil);
  return next ? { id: next.id, label: label(next) } : null;
}

/* ------------------------------------------------------------------ */
/* Signing in an account                                                */
/* ------------------------------------------------------------------ */

interface LoginSession {
  proc: ReturnType<typeof Bun.spawn>;
  timer: ReturnType<typeof setTimeout>;
  output: string;
  dir: string;
  accountId: string | null;
}

let session: LoginSession | null = null;
let status: ClaudeAccountLogin = { state: "idle", url: null, message: null, accountId: null };
let endedAt = 0;

function loginStatus(): ClaudeAccountLogin {
  if (!session && status.state !== "idle" && Date.now() - endedAt > 60_000) status = { state: "idle", url: null, message: null, accountId: null };
  return status;
}

function setStatus(next: ClaudeAccountLogin) {
  status = next;
  changed();
}

/** Starts `claude auth login` in a config of its own; `accountId` signs that account in again. */
export function startAccountLogin(accountId: string | null): ClaudeAccountLogin {
  if (session) return loginStatus();
  if (!isUnlocked()) throw badRequest("Unlock the vault first: Godmode keeps the account's sign-in there.");
  if (accountId && !get("SELECT id FROM claude_accounts WHERE id = ?", accountId)) throw notFound("Claude account");
  const bin = resolveClaudeBinary();
  if (!bin) {
    endedAt = Date.now();
    setStatus({ state: "failed", url: null, message: "Claude Code is not installed yet. Install it first, then add accounts.", accountId });
    return status;
  }
  const dir = join(config().dataDir, "claude-accounts", newId("login"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "auth", "login"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv({ PATH: toolPath(), CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: undefined, NO_COLOR: "1" }) as Record<string, string>,
      windowsHide: true,
    } as Parameters<typeof Bun.spawn>[1]);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    endedAt = Date.now();
    setStatus({ state: "failed", url: null, message: err instanceof Error ? err.message : String(err), accountId });
    return status;
  }
  const current: LoginSession = {
    proc,
    dir,
    accountId,
    output: "",
    timer: setTimeout(() => void finish(current, null, "The sign-in timed out. Try again."), LOGIN_TIMEOUT_MS),
  };
  session = current;
  setStatus({ state: "waiting", url: null, message: null, accountId });
  log.info(accountId ? `signing Claude account ${accountId} in again` : "adding a Claude account");

  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    try {
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        current.output = (current.output + decoder.decode(value, { stream: true })).slice(-20_000);
        if (session === current && !status.url) {
          const url = stripAnsi(current.output).match(URL_RE)?.[0];
          if (url) setStatus({ ...status, url });
        }
      }
    } catch {
      /* stream closed */
    }
  };
  void Promise.all([read(proc.stdout as ReadableStream<Uint8Array>), read(proc.stderr as ReadableStream<Uint8Array>)]).then(async () => {
    await finish(current, await proc.exited.catch(() => null));
  });
  return status;
}

export function submitAccountLoginCode(code: string): ClaudeAccountLogin {
  const value = code.trim();
  if (!session || !value) return loginStatus();
  const stdin = session.proc.stdin as { write(data: string): unknown; flush?(): unknown } | undefined;
  stdin?.write(`${value}\n`);
  stdin?.flush?.();
  return loginStatus();
}

export function cancelAccountLogin(): ClaudeAccountLogin {
  if (session) void finish(session, null, "Cancelled.");
  setStatus({ state: "idle", url: null, message: null, accountId: null });
  return status;
}

/** What the login left in its config: the OAuth block (file or keychain) and who signed in. */
async function capture(dir: string): Promise<{ block: OAuthBlock; who: Identity } | null> {
  let raw: string | null = null;
  const file = join(dir, ".credentials.json");
  if (existsSync(file)) raw = readFileSync(file, "utf8");
  else if (process.platform === "darwin") {
    const res = await runCommand(["/usr/bin/security", "find-generic-password", "-s", keychainService(dir), "-w"], { timeoutMs: 10_000 });
    if (res.code === 0) raw = res.stdout.trim();
  }
  if (!raw || !parseCredentials(raw)) return null;
  const block = (JSON.parse(raw) as { claudeAiOauth: OAuthBlock }).claudeAiOauth;
  return { block, who: identityOf(join(dir, ".claude.json")) };
}

/** Removes the login's config and its keychain item: from now on only Godmode refreshes these tokens. */
async function discard(dir: string) {
  if (process.platform === "darwin") {
    await runCommand(["/usr/bin/security", "delete-generic-password", "-s", keychainService(dir)], { timeoutMs: 10_000 }).catch(() => null);
  }
  rmSync(dir, { recursive: true, force: true });
}

async function finish(s: LoginSession, code: number | null, message?: string) {
  if (session !== s) return;
  session = null;
  endedAt = Date.now();
  clearTimeout(s.timer);
  try {
    s.proc.kill();
  } catch {
    /* already gone */
  }
  if (code !== 0 || message) {
    await discard(s.dir);
    const tail = stripAnsi(s.output)
      .split("\n")
      .map((l) => l.replace(/^Paste code here[^>]*>/i, "").trim())
      .filter((l) => l && !URL_RE.test(l) && !/^Opening browser/i.test(l))
      .slice(-3)
      .join(" ");
    log.warn(`claude auth login for an account ended (${code ?? "killed"})`);
    setStatus({ state: "failed", url: null, message: message ?? (tail || "The sign-in did not finish. Try again."), accountId: s.accountId });
    return;
  }
  try {
    const got = await capture(s.dir);
    if (!got) throw new Error("The sign-in finished, but Claude Code stored no credentials.");
    const id = saveAccount(got.block, got.who, s.accountId);
    log.info(`Claude account ${id} signed in`);
    setStatus({ state: "done", url: null, message: got.who.email, accountId: id });
    void refreshClaudeUsage();
  } catch (err) {
    log.warn("could not keep the new Claude account", err);
    setStatus({ state: "failed", url: null, message: err instanceof Error ? err.message : String(err), accountId: s.accountId });
  } finally {
    await discard(s.dir);
  }
}

function saveAccount(block: OAuthBlock, who: Identity, accountId: string | null): string {
  const existing =
    (accountId && get<AccountRow>("SELECT * FROM claude_accounts WHERE id = ?", accountId)) ||
    (who.email ? get<AccountRow>("SELECT * FROM claude_accounts WHERE email = ?", who.email) : null);
  const id = existing?.id ?? newId("cla");
  setAppSecret(secretKey(id), JSON.stringify(block));
  const fields = { email: who.email, name: who.name, organization: who.organization, plan: block.subscriptionType ?? null, needs_sign_in: 0 };
  if (existing) update("claude_accounts", id, fields);
  else insert("claude_accounts", { id, ...fields, limited_until: null, last_used_at: null, created_at: now() });
  usageCache.delete(id);
  changed();
  return id;
}

/* ------------------------------------------------------------------ */
/* Keeping sign-ins alive                                               */
/* ------------------------------------------------------------------ */

let keepalive: ReturnType<typeof setInterval> | null = null;

/** Refreshes tokens that run out soon, so an account nobody used for a while still works. */
export function startClaudeAccounts() {
  if (keepalive || config().role === "runner") return;
  keepalive = setInterval(() => {
    if (!isUnlocked()) return;
    for (const r of rows()) if (!r.needs_sign_in) void accessToken(r.id).catch(() => null);
  }, KEEPALIVE_MS);
  keepalive.unref?.();
}

export function stopClaudeAccounts() {
  if (keepalive) clearInterval(keepalive);
  keepalive = null;
  if (session) void finish(session, null, "Godmode is shutting down.");
}
