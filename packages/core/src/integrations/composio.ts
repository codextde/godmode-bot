/**
 * Composio (https://composio.dev) v3.1 REST client: toolkits catalog, connected accounts (managed OAuth via
 * `connected_accounts/link`) and Tool Router sessions that expose an agent's connected toolkits as one MCP server.
 *
 * Composio `user_id` scoping: "global" | `ws_<workspaceId>` | `agent_<agentId>`.
 * The API key lives in the vault as app secret `composio_api_key` and is only ever sent to composio.dev origins.
 */
import type {
  Agent,
  ComposioConnectInput,
  ComposioConnectResult,
  ComposioConnection,
  ComposioStatus,
  ComposioToolkit,
} from "@godmode/shared";
import type { McpServerJson } from "../types";
import { all, get, getMeta, insert, run, setMeta } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { audit } from "../services/audit";
import * as vault from "../vault/vault";
import { sha256 } from "../vault/crypto";
import { releaseTriggerInstances } from "./composioTriggers";
import { badRequest, HttpError, newId, notFound, now, parseJson, sleep } from "../util";

const log = logger("composio");

export const COMPOSIO_BASE_URL = "https://backend.composio.dev";
export const COMPOSIO_API_KEY_SECRET = "composio_api_key";
export const COMPOSIO_SERVER_NAMES = ["composio-global", "composio-workspace", "composio-agent"] as const;

const REQUEST_TIMEOUT_MS = 30_000;
const STATUS_TTL_MS = 5 * 60_000;
const SESSION_VERIFY_TTL_MS = 10 * 60_000;
/** Retry a rate-limited request once when Composio asks us to wait at most this long. */
const MAX_AUTO_RETRY_WAIT_S = 5;
const SESSION_META_PREFIX = "composio.session.";
const PENDING_STATUSES = ["INITIALIZING", "INITIATED"];

/* ------------------------------------------------------------------ */
/* Upstream response shapes (subset, snake_case as returned by v3.1)    */
/* ------------------------------------------------------------------ */

interface RawToolkit {
  slug: string;
  name?: string;
  auth_schemes?: string[];
  composio_managed_auth_schemes?: string[];
  no_auth?: boolean;
  auth_config_details?: { mode?: string }[];
  meta?: { logo?: string | null; description?: string | null; categories?: { id?: string; name?: string }[] };
}

interface RawAuthConfig {
  id: string;
  toolkit?: { slug?: string };
  is_composio_managed?: boolean;
  status?: string;
}

interface RawLink {
  connected_account_id: string;
  redirect_url: string;
  expires_at?: string;
}

interface RawConnectedAccount {
  id: string;
  status?: string;
}

interface RawSession {
  session_id: string;
  mcp?: { type?: string; url?: string };
}

interface ConnectionRow {
  id: string;
  connected_account_id: string;
  toolkit: string;
  workspace_id: string | null;
  agent_id: string | null;
  user_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface CachedSession {
  fingerprint: string;
  sessionId: string;
  url: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                 */
/* ------------------------------------------------------------------ */

function notConfigured() {
  return new HttpError(
    400,
    "Composio is not configured. Add your Composio API key in Settings → Integrations.",
    "composio_not_configured",
  );
}

function requireApiKey(): string {
  if (!vault.hasAppSecret(COMPOSIO_API_KEY_SECRET)) throw notConfigured();
  const key = vault.getAppSecret(COMPOSIO_API_KEY_SECRET); // 423 when the vault is locked
  if (!key) throw notConfigured();
  return key;
}

/** Seconds to wait from a Retry-After header (delta-seconds or HTTP date). */
export function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, Math.ceil(secs));
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function upstreamMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const d = data as { error?: unknown; message?: unknown };
    if (d.error && typeof d.error === "object" && typeof (d.error as { message?: unknown }).message === "string") {
      return (d.error as { message: string }).message;
    }
    if (typeof d.error === "string") return d.error;
    if (typeof d.message === "string") return d.message;
  }
  return fallback;
}

function upstreamError(status: number, data: unknown, text: string): HttpError {
  const message = upstreamMessage(data, text.slice(0, 300) || `HTTP ${status}`);
  const details = { upstreamStatus: status };
  // Never surface 401 to the UI: it would be mistaken for an expired Godmode session.
  if (status === 401) return new HttpError(400, "Invalid Composio API key", "composio_invalid_key", details);
  if (status === 403) return new HttpError(403, `Composio denied the request: ${message}`, "composio_forbidden", details);
  if (status === 404) return new HttpError(404, message, "composio_not_found", details);
  if (status === 400 || status === 409 || status === 422) return new HttpError(400, `Composio: ${message}`, "composio_bad_request", details);
  return new HttpError(502, `Composio API error (HTTP ${status}): ${message}`, "composio_upstream", details);
}

/** HTTP status Composio answered with, for errors from `composioRequest` (null for network errors). */
export function upstreamStatus(err: unknown): number | null {
  const details = err instanceof HttpError ? (err.details as { upstreamStatus?: unknown } | undefined) : undefined;
  return typeof details?.upstreamStatus === "number" ? details.upstreamStatus : null;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export async function composioRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  opts: { query?: Query; body?: unknown; apiKey?: string; timeoutMs?: number } = {},
): Promise<T> {
  const key = opts.apiKey ?? requireApiKey();
  const url = new URL(path, COMPOSIO_BASE_URL);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { "x-api-key": key, accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new HttpError(
        502,
        timedOut ? `Composio did not respond within ${(opts.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000} seconds` : `Could not reach Composio: ${err instanceof Error ? err.message : String(err)}`,
        "composio_unreachable",
      );
    }
    if (res.status === 429) {
      const wait = retryAfterSeconds(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => undefined);
      if (attempt === 0 && wait !== null && wait <= MAX_AUTO_RETRY_WAIT_S) {
        await sleep(wait * 1000);
        continue;
      }
      throw new HttpError(
        429,
        wait !== null ? `Composio rate limit reached. Try again in ${wait} seconds.` : "Composio rate limit reached. Try again in a minute.",
        "composio_rate_limited",
        { retryAfter: wait },
      );
    }
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) throw upstreamError(res.status, data, text);
    return data as T;
  }
}

/* ------------------------------------------------------------------ */
/* API key + status                                                     */
/* ------------------------------------------------------------------ */

let statusCache: { at: number; keyHash: string; status: ComposioStatus } | null = null;
/** sessionId → last successful verification (ms) */
const verifiedSessions = new Map<string, number>();

/** Forget in-memory caches (after key change or backup restore). */
export function resetComposioState() {
  statusCache = null;
  verifiedSessions.clear();
}

function forgetSessions(userId?: string) {
  if (userId) run("DELETE FROM meta WHERE key = ?", SESSION_META_PREFIX + userId);
  else run("DELETE FROM meta WHERE key LIKE ?", `${SESSION_META_PREFIX}%`);
}

export async function getStatus(force = false): Promise<ComposioStatus> {
  if (!vault.hasAppSecret(COMPOSIO_API_KEY_SECRET)) return { configured: false, valid: null };
  if (!vault.isUnlocked()) return { configured: true, valid: null, error: "Unlock the vault to use Composio" };
  const key = vault.getAppSecret(COMPOSIO_API_KEY_SECRET);
  if (!key) return { configured: false, valid: null };
  const keyHash = sha256(key).slice(0, 16);
  if (!force && statusCache && statusCache.keyHash === keyHash && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.status;
  }
  let status: ComposioStatus;
  try {
    await composioRequest("GET", "/api/v3.1/toolkits", { query: { limit: 1 }, apiKey: key });
    status = { configured: true, valid: true };
  } catch (err) {
    if (err instanceof HttpError && err.code === "composio_invalid_key") {
      status = { configured: true, valid: false, error: "Invalid Composio API key" };
    } else {
      // Not a verdict on the key (offline, rate limited…): report but don't cache.
      return { configured: true, valid: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
  statusCache = { at: Date.now(), keyHash, status };
  return status;
}

export async function setApiKey(apiKey: string | null, actor = "user"): Promise<ComposioStatus> {
  const value = typeof apiKey === "string" ? apiKey.trim() : null;
  if (value !== null && value !== "" && (value.length < 8 || value.length > 512 || /\s/.test(value))) {
    throw badRequest("That does not look like a Composio API key");
  }
  const previous = vault.hasAppSecret(COMPOSIO_API_KEY_SECRET) ? vault.getAppSecret(COMPOSIO_API_KEY_SECRET) : null;
  if (previous && previous !== (value || null)) await releaseTriggerInstances(previous, value || null);
  vault.setAppSecret(COMPOSIO_API_KEY_SECRET, value || null);
  resetComposioState();
  forgetSessions();
  audit(actor, value ? "composio.key.set" : "composio.key.delete", COMPOSIO_API_KEY_SECRET);
  bus.changed("composio");
  return value ? getStatus(true) : { configured: false, valid: null };
}

/* ------------------------------------------------------------------ */
/* Toolkits                                                             */
/* ------------------------------------------------------------------ */

function mapToolkit(raw: RawToolkit): ComposioToolkit {
  return {
    slug: raw.slug,
    name: raw.name || raw.slug,
    logo: raw.meta?.logo || null,
    description: raw.meta?.description ?? "",
    categories: (raw.meta?.categories ?? []).map((c) => c.name || c.id || "").filter(Boolean),
    authSchemes: raw.auth_schemes ?? [],
    noAuth: raw.no_auth === true,
  };
}

export async function listToolkits(q: { search?: string; category?: string; cursor?: string } = {}): Promise<{
  items: ComposioToolkit[];
  nextCursor: string | null;
}> {
  const data = await composioRequest<{ items?: RawToolkit[]; next_cursor?: string | null }>("GET", "/api/v3.1/toolkits", {
    query: {
      search: q.search?.trim().slice(0, 200),
      category: q.category?.trim().slice(0, 100),
      cursor: q.cursor,
      limit: 48,
      sort_by: "usage",
    },
  });
  return { items: (data?.items ?? []).filter((t) => t && typeof t.slug === "string").map(mapToolkit), nextCursor: data?.next_cursor ?? null };
}

/* ------------------------------------------------------------------ */
/* Connections                                                          */
/* ------------------------------------------------------------------ */

function toConnection(r: ConnectionRow): ComposioConnection {
  return {
    id: r.id,
    connectedAccountId: r.connected_account_id,
    toolkit: r.toolkit,
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    userId: r.user_id,
    status: r.status,
    createdAt: r.created_at,
  };
}

/** Composio user id for a scope. */
export function composioUserId(scope: { workspaceId?: string | null; agentId?: string | null }): string {
  if (scope.agentId) return `agent_${scope.agentId}`;
  if (scope.workspaceId) return `ws_${scope.workspaceId}`;
  return "global";
}

function findConnectionRow(id: string): ConnectionRow {
  const row =
    get<ConnectionRow>("SELECT * FROM composio_connections WHERE id = ?", id) ??
    (id ? get<ConnectionRow>("SELECT * FROM composio_connections WHERE connected_account_id = ?", id) : null);
  if (!row) throw notFound("Composio connection");
  return row;
}

let lastPendingSync = 0;
let pendingSyncRunning = false;

/** Poll Composio for connections the user may have just authorized (OAuth completes outside the app). */
function syncPendingConnections() {
  if (pendingSyncRunning || Date.now() - lastPendingSync < 5_000) return;
  if (!vault.isUnlocked() || !vault.hasAppSecret(COMPOSIO_API_KEY_SECRET)) return;
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  const pending = all<ConnectionRow>(
    `SELECT * FROM composio_connections WHERE status IN (${PENDING_STATUSES.map(() => "?").join(", ")}) AND connected_account_id != '' AND created_at > ?`,
    ...PENDING_STATUSES,
    cutoff,
  );
  if (pending.length === 0) return;
  pendingSyncRunning = true;
  lastPendingSync = Date.now();
  void (async () => {
    let changed = false;
    for (const row of pending) {
      try {
        const updated = await refreshRow(row);
        if (updated.status !== row.status) changed = true;
      } catch (err) {
        log.debug(`could not refresh connection ${row.id}`, err instanceof Error ? err.message : err);
      }
    }
    if (changed) bus.changed("composio");
  })().finally(() => {
    pendingSyncRunning = false;
  });
}

export function listConnections(): ComposioConnection[] {
  syncPendingConnections();
  return all<ConnectionRow>("SELECT * FROM composio_connections ORDER BY created_at DESC").map(toConnection);
}

async function refreshRow(row: ConnectionRow): Promise<ComposioConnection> {
  if (!row.connected_account_id) return toConnection(row);
  let status = row.status;
  try {
    const acc = await composioRequest<RawConnectedAccount>("GET", `/api/v3.1/connected_accounts/${encodeURIComponent(row.connected_account_id)}`);
    if (acc && typeof acc.status === "string" && acc.status) status = acc.status;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) status = "DELETED";
    else throw err;
  }
  if (status !== row.status) {
    run("UPDATE composio_connections SET status = ?, updated_at = ? WHERE id = ?", status, now(), row.id);
    if (status !== "ACTIVE" || row.status !== "ACTIVE") forgetSessions(row.user_id);
  }
  return toConnection({ ...row, status });
}

export async function refreshConnection(id: string): Promise<ComposioConnection> {
  const row = findConnectionRow(id);
  const updated = await refreshRow(row);
  if (updated.status !== row.status) bus.changed("composio");
  return updated;
}

function isNoAuth(raw: RawToolkit): boolean | null {
  if (raw.no_auth === true) return true;
  if (raw.no_auth === false) return false;
  const schemes = [
    ...(raw.auth_schemes ?? []),
    ...(raw.composio_managed_auth_schemes ?? []),
    ...(raw.auth_config_details ?? []).map((d) => d.mode ?? ""),
  ].filter(Boolean);
  if (schemes.length === 0) return null; // unknown
  return schemes.every((s) => s.toUpperCase() === "NO_AUTH");
}

async function fetchToolkit(slug: string): Promise<RawToolkit> {
  let details: RawToolkit;
  try {
    details = await composioRequest<RawToolkit>("GET", `/api/v3.1/toolkits/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw new HttpError(404, `Unknown Composio toolkit "${slug}"`, "composio_not_found");
    throw err;
  }
  if (isNoAuth(details) === null) {
    // The detail payload has no auth info; the catalog listing carries `no_auth`.
    const list = await composioRequest<{ items?: RawToolkit[] }>("GET", "/api/v3.1/toolkits", { query: { search: slug, limit: 20 } });
    const match = list?.items?.find((t) => t.slug === slug);
    if (match) details = { ...match, ...details, no_auth: match.no_auth ?? details.no_auth };
  }
  return details;
}

function authConfigRequired(name: string) {
  return new HttpError(
    400,
    `${name} has no Composio-managed authentication. Create an auth config for it in the Composio dashboard (https://platform.composio.dev → Auth Configs), then connect again.`,
    "composio_auth_config_required",
  );
}

/** An enabled auth config for the toolkit: a custom one the user created, else a Composio-managed one (created on demand). */
async function resolveAuthConfig(slug: string, details: RawToolkit): Promise<string> {
  const list = await composioRequest<{ items?: RawAuthConfig[] }>("GET", "/api/v3.1/auth_configs", {
    query: { toolkit_slug: slug, limit: 50 },
  });
  const enabled = (list?.items ?? []).filter(
    (a) => a && a.id && (a.toolkit?.slug ?? slug).toLowerCase() === slug && (a.status ?? "ENABLED").toUpperCase() === "ENABLED",
  );
  const custom = enabled.find((a) => a.is_composio_managed === false);
  const managed = enabled.find((a) => a.is_composio_managed !== false);
  if (custom) return custom.id;
  if (managed) return managed.id;
  const name = details.name || slug;
  if (Array.isArray(details.composio_managed_auth_schemes) && details.composio_managed_auth_schemes.length === 0) {
    throw authConfigRequired(name);
  }
  try {
    const created = await composioRequest<{ auth_config?: { id?: string } }>("POST", "/api/v3.1/auth_configs", {
      body: { toolkit: { slug }, auth_config: { type: "use_composio_managed_auth" } },
    });
    const id = created?.auth_config?.id;
    if (!id) throw new HttpError(502, "Composio did not return an auth config id", "composio_upstream");
    return id;
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) throw authConfigRequired(name);
    throw err;
  }
}

function assertScope(workspaceId: string | null, agentId: string | null): string | null {
  if (workspaceId && !get<{ id: string }>("SELECT id FROM workspaces WHERE id = ?", workspaceId)) {
    throw badRequest(`Workspace ${workspaceId} does not exist`);
  }
  if (agentId) {
    const agent = get<{ workspace_id: string | null }>("SELECT workspace_id FROM agents WHERE id = ?", agentId);
    if (!agent) throw badRequest(`Agent ${agentId} does not exist`);
    return workspaceId ?? agent.workspace_id;
  }
  return workspaceId;
}

export async function connect(input: ComposioConnectInput, actor = "user"): Promise<ComposioConnectResult> {
  const slug = (input.toolkit ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(slug)) throw badRequest("Invalid toolkit");
  const agentId = input.agentId ?? null;
  const workspaceId = assertScope(input.workspaceId ?? null, agentId);
  const userId = composioUserId({ workspaceId: input.workspaceId ?? null, agentId });
  requireApiKey();

  const details = await fetchToolkit(slug);
  const ts = now();

  if (isNoAuth(details) === true) {
    const existing = get<ConnectionRow>(
      "SELECT * FROM composio_connections WHERE user_id = ? AND toolkit = ? AND connected_account_id = ''",
      userId,
      slug,
    );
    if (existing) {
      if (existing.status !== "ACTIVE") run("UPDATE composio_connections SET status = 'ACTIVE', updated_at = ? WHERE id = ?", ts, existing.id);
      return { redirectUrl: null, connectedAccountId: "", status: "ACTIVE", connectionId: existing.id };
    }
    const id = newId("cmp");
    insert("composio_connections", {
      id,
      connected_account_id: "",
      toolkit: slug,
      workspace_id: workspaceId,
      agent_id: agentId,
      user_id: userId,
      status: "ACTIVE",
      created_at: ts,
      updated_at: ts,
    });
    forgetSessions(userId);
    audit(actor, "composio.connect", id, { toolkit: slug, userId, noAuth: true });
    bus.changed("composio");
    return { redirectUrl: null, connectedAccountId: "", status: "ACTIVE", connectionId: id };
  }

  const authConfigId = await resolveAuthConfig(slug, details);
  const link = await composioRequest<RawLink>("POST", "/api/v3.1/connected_accounts/link", {
    body: { auth_config_id: authConfigId, user_id: userId },
  });
  if (!link?.connected_account_id || !isHttpUrl(link.redirect_url)) {
    throw new HttpError(502, "Composio returned an invalid connection link", "composio_upstream");
  }

  // Abandoned attempts for the same toolkit + scope would only clutter the list.
  const stale = all<ConnectionRow>(
    "SELECT * FROM composio_connections WHERE user_id = ? AND toolkit = ? AND status IN ('INITIALIZING', 'INITIATED', 'FAILED', 'EXPIRED')",
    userId,
    slug,
  );
  for (const row of stale) {
    run("DELETE FROM composio_connections WHERE id = ?", row.id);
    if (row.connected_account_id) {
      void composioRequest("DELETE", `/api/v3.1/connected_accounts/${encodeURIComponent(row.connected_account_id)}`).catch(() => undefined);
    }
  }

  const id = newId("cmp");
  insert("composio_connections", {
    id,
    connected_account_id: link.connected_account_id,
    toolkit: slug,
    workspace_id: workspaceId,
    agent_id: agentId,
    user_id: userId,
    status: "INITIATED",
    created_at: ts,
    updated_at: ts,
  });
  audit(actor, "composio.connect", id, { toolkit: slug, userId, connectedAccountId: link.connected_account_id });
  bus.changed("composio");
  return { redirectUrl: link.redirect_url, connectedAccountId: link.connected_account_id, status: "INITIATED", connectionId: id };
}

export async function disconnect(id: string, actor = "user"): Promise<void> {
  const row = findConnectionRow(id);
  if (row.connected_account_id) {
    try {
      await composioRequest("DELETE", `/api/v3.1/connected_accounts/${encodeURIComponent(row.connected_account_id)}`);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }
  run("DELETE FROM composio_connections WHERE id = ?", row.id);
  forgetSessions(row.user_id);
  audit(actor, "composio.disconnect", row.id, { toolkit: row.toolkit, userId: row.user_id });
  bus.changed("composio");
}

/* ------------------------------------------------------------------ */
/* Tool Router sessions → MCP servers for runs                          */
/* ------------------------------------------------------------------ */

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Only composio.dev (https) may receive the Composio API key. */
export function isComposioOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.origin === new URL(COMPOSIO_BASE_URL).origin) return true;
    return u.protocol === "https:" && (u.hostname === "composio.dev" || u.hostname.endsWith(".composio.dev"));
  } catch {
    return false;
  }
}

function composioServerJson(url: string, apiKey: string): McpServerJson {
  if (isComposioOrigin(url)) return { type: "http", url, headers: { "x-api-key": apiKey } };
  log.warn(`Composio MCP URL ${new URL(url).origin} is not a composio.dev origin; the API key was not attached`);
  return { type: "http", url };
}

async function ensureSession(userId: string, rows: ConnectionRow[], apiKey: string): Promise<CachedSession> {
  const toolkits = [...new Set(rows.map((r) => r.toolkit))].sort();
  // Pin the newest active account per toolkit so a scope with several accounts stays deterministic.
  const accounts: Record<string, string[]> = {};
  for (const r of rows) {
    if (r.connected_account_id && !accounts[r.toolkit]) accounts[r.toolkit] = [r.connected_account_id];
  }
  const fingerprint = sha256(JSON.stringify({ key: sha256(apiKey), userId, toolkits, accounts })).slice(0, 32);
  const metaKey = SESSION_META_PREFIX + userId;
  const cached = parseJson<CachedSession | null>(getMeta(metaKey), null);

  if (cached && cached.fingerprint === fingerprint && cached.sessionId && isHttpUrl(cached.url)) {
    if (Date.now() - (verifiedSessions.get(cached.sessionId) ?? 0) < SESSION_VERIFY_TTL_MS) return cached;
    try {
      const s = await composioRequest<RawSession>("GET", `/api/v3.1/tool_router/session/${encodeURIComponent(cached.sessionId)}`, { apiKey });
      const session = { ...cached, url: isHttpUrl(s?.mcp?.url) ? s.mcp!.url! : cached.url };
      if (session.url !== cached.url) setMeta(metaKey, JSON.stringify(session));
      verifiedSessions.set(session.sessionId, Date.now());
      return session;
    } catch (err) {
      const gone = err instanceof HttpError && (err.status === 404 || err.status === 400 || err.status === 403);
      if (!gone) {
        if (err instanceof HttpError && err.code === "composio_invalid_key") throw err;
        // Offline / rate limited: the cached session is still our best bet.
        return cached;
      }
      log.info(`Composio session for ${userId} is gone, creating a new one`);
    }
  }

  const created = await composioRequest<RawSession>("POST", "/api/v3.1/tool_router/session", {
    apiKey,
    body: {
      user_id: userId,
      toolkits: { enable: toolkits },
      ...(Object.keys(accounts).length ? { connected_accounts: accounts } : {}),
      manage_connections: { enable: false },
    },
  });
  if (!created?.session_id || !isHttpUrl(created.mcp?.url)) {
    throw new HttpError(502, "Composio did not return a Tool Router MCP URL", "composio_upstream");
  }
  const session: CachedSession = { fingerprint, sessionId: created.session_id, url: created.mcp!.url!, createdAt: now() };
  setMeta(metaKey, JSON.stringify(session));
  verifiedSessions.set(session.sessionId, Date.now());
  return session;
}

/**
 * Composio Tool Router MCP servers for an agent: one per scope (global, workspace, agent) that has at least one
 * ACTIVE connection. Global/workspace scopes follow `agent.inheritMcp`. Failing scopes are skipped with a warning.
 */
export async function composioMcpServersForAgent(
  agent: Pick<Agent, "id" | "workspaceId" | "inheritMcp">,
): Promise<Record<string, McpServerJson>> {
  if (!vault.hasAppSecret(COMPOSIO_API_KEY_SECRET)) return {};
  const scopes: { name: (typeof COMPOSIO_SERVER_NAMES)[number]; userId: string }[] = [];
  if (agent.inheritMcp) {
    scopes.push({ name: "composio-global", userId: "global" });
    if (agent.workspaceId) scopes.push({ name: "composio-workspace", userId: `ws_${agent.workspaceId}` });
  }
  scopes.push({ name: "composio-agent", userId: `agent_${agent.id}` });

  const active = scopes
    .map((s) => ({
      ...s,
      rows: all<ConnectionRow>(
        "SELECT * FROM composio_connections WHERE user_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC",
        s.userId,
      ),
    }))
    .filter((s) => s.rows.length > 0);
  if (active.length === 0) return {};
  if (!vault.isUnlocked()) {
    log.warn(`vault is locked: Composio tools are unavailable for agent ${agent.id}`);
    return {};
  }
  const apiKey = vault.getAppSecret(COMPOSIO_API_KEY_SECRET);
  if (!apiKey) return {};

  const out: Record<string, McpServerJson> = {};
  for (const scope of active) {
    try {
      const session = await ensureSession(scope.userId, scope.rows, apiKey);
      out[scope.name] = composioServerJson(session.url, apiKey);
    } catch (err) {
      log.warn(`Composio session for ${scope.userId} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
