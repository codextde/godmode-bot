/**
 * API tools: an API key the human hands to agents together with what it's for, how to call it (docs) and where it may
 * be sent, scoped global / workspace / agent like MCP servers.
 *
 * The key is sealed in `key_enc` (AAD `api_tools.key:<id>`) and never returned. Agents call the API through the
 * gateway (`api_tool_request`, see apiToolRequest.ts), which adds the key and only sends it to URLs under `base_url`.
 * With `env_var` set, runs also get the key in that environment variable — then the agent can read it.
 */
import type { Agent, ApiTool, ApiToolAuth, ApiToolInput } from "@godmode/shared";
import { all, bool, get, insert, run, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { audit } from "../services/audit";
import * as vault from "../vault/vault";
import { badRequest, HttpError, newId, notFound, now, parseJson, slugify } from "../util";

const log = logger("api-tools");

export const DEFAULT_AUTH: ApiToolAuth = { in: "header", name: "Authorization", prefix: "Bearer " };

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const QUERY_NAME_RE = /^[A-Za-z0-9_.~[\]-]+$/;
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRESET_RE = /^[a-z0-9-]{1,40}$/;
/** Only names of secrets: a variable like HTTPS_PROXY or BASH_ENV would change how programs in a run behave. */
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i;
const RESERVED_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE", "GODMODE_", "DYLD_", "LD_", "GIT_", "MCP_", "AWS_", "NODE_", "NPM_"];
const MIN_KEY_LENGTH = 8;

interface ApiToolRow {
  id: string;
  workspace_id: string | null;
  agent_id: string | null;
  name: string;
  description: string;
  docs: string;
  docs_url: string;
  base_url: string;
  auth: string;
  test_path: string;
  env_var: string | null;
  preset: string | null;
  key_enc: string | null;
  enabled: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

function toModel(r: ApiToolRow): ApiTool {
  const auth = parseJson<Partial<ApiToolAuth>>(r.auth, {});
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    name: r.name,
    description: r.description,
    docs: r.docs,
    docsUrl: r.docs_url,
    baseUrl: r.base_url,
    auth: {
      in: auth.in === "query" ? "query" : "header",
      name: typeof auth.name === "string" && auth.name ? auth.name : DEFAULT_AUTH.name,
      prefix: typeof auth.prefix === "string" ? auth.prefix : "",
    },
    testPath: r.test_path,
    envVar: r.env_var,
    preset: r.preset,
    hasKey: !!r.key_enc,
    enabled: bool(r.enabled),
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function getRow(id: string): ApiToolRow {
  const row = get<ApiToolRow>("SELECT * FROM api_tools WHERE id = ?", id);
  if (!row) throw notFound("API tool");
  return row;
}

/* ------------------------------------------------------------------ */
/* Queries                                                              */
/* ------------------------------------------------------------------ */

export function listApiTools(filter: { workspaceId?: string | null; agentId?: string | null } = {}): ApiTool[] {
  const where: string[] = [];
  const params: string[] = [];
  const ws = filter.workspaceId;
  if (ws === "global" || ws === null) where.push("workspace_id IS NULL");
  else if (ws && ws !== "all") {
    where.push("workspace_id = ?");
    params.push(ws);
  }
  if (filter.agentId) {
    where.push("agent_id = ?");
    params.push(filter.agentId);
  }
  const sql = `SELECT * FROM api_tools${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY name COLLATE NOCASE, created_at`;
  return all<ApiToolRow>(sql, ...params).map(toModel);
}

export function getApiTool(id: string): ApiTool {
  return toModel(getRow(id));
}

/* ------------------------------------------------------------------ */
/* Validation                                                           */
/* ------------------------------------------------------------------ */

function cleanName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw badRequest("Name is required");
  const n = name.trim();
  if (n.length > 100) throw badRequest("Name must be at most 100 characters");
  return n;
}

function cleanText(value: unknown, max: number, what: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw badRequest(`${what} must be text`);
  const t = value.trim();
  if (t.length > max) throw badRequest(`${what} must be at most ${max.toLocaleString("en-US")} characters`);
  return t;
}

function httpUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest(`${what} must be a full URL, e.g. https://api.example.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest(`${what} must start with https:// or http://`);
  if (url.username || url.password) throw badRequest(`${what} must not contain a user name or password — put the key in the API key field`);
  return url;
}

/** The API address: origin plus an optional path, without a trailing slash, query or fragment. */
export function cleanBaseUrl(value: unknown): string {
  const raw = cleanText(value, 2048, "API address");
  if (!raw) return "";
  const url = httpUrl(raw, "API address");
  if (url.search || url.hash) throw badRequest("API address must not contain a query (?…) or fragment (#…)");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function cleanDocsUrl(value: unknown): string {
  const raw = cleanText(value, 2048, "Documentation link");
  return raw ? httpUrl(raw, "Documentation link").toString() : "";
}

function cleanAuth(value: ApiToolAuth | undefined): ApiToolAuth {
  if (value === undefined) return { ...DEFAULT_AUTH };
  if (!value || typeof value !== "object") throw badRequest("Invalid key placement");
  const placement = value.in === "query" ? "query" : value.in === "header" ? "header" : null;
  if (!placement) throw badRequest('Key placement must be "header" or "query"');
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 100) throw badRequest(placement === "header" ? "Enter the header the key goes in" : "Enter the query parameter the key goes in");
  if (placement === "header" && !HEADER_NAME_RE.test(name)) throw badRequest(`Invalid header name: ${name}`);
  if (placement === "query" && !QUERY_NAME_RE.test(name)) throw badRequest(`Invalid query parameter name: ${name}`);
  const prefix = placement === "header" && typeof value.prefix === "string" ? value.prefix : "";
  if (prefix.length > 64 || /[\r\n\0]/.test(prefix)) throw badRequest("Invalid key prefix");
  return { in: placement, name, prefix };
}

export function cleanEnvVar(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest("Environment variable must be text");
  const name = value.trim();
  if (!name) return null;
  if (name.length > 100 || !ENV_VAR_RE.test(name)) throw badRequest(`Invalid environment variable name: ${name}. Use letters, digits and _ (e.g. GEMINI_API_KEY).`);
  if (!SECRET_NAME_RE.test(name)) throw badRequest(`${name} must end in _KEY, _TOKEN or _SECRET (e.g. GEMINI_API_KEY).`);
  const upper = name.toUpperCase();
  if (RESERVED_ENV_PREFIXES.some((p) => upper.startsWith(p))) throw badRequest(`${name} is used by Godmode or other programs; pick another name.`);
  return name;
}

function cleanPreset(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !PRESET_RE.test(value)) throw badRequest("Invalid preset");
  return value;
}

function cleanKey(value: string): string {
  const key = value.trim();
  if (key.length > 16_384) throw badRequest("The API key is too long");
  if (key.length < MIN_KEY_LENGTH) throw badRequest(`The API key must be at least ${MIN_KEY_LENGTH} characters`);
  if (/[\s\0]/.test(key)) throw badRequest("The API key must not contain spaces or line breaks");
  return key;
}

/**
 * The URL a request for `path` goes to: relative to the tool's address (a path that already starts with the address's
 * path isn't doubled), or a full URL that must lie under it. Anything outside the address is refused.
 */
export function resolveApiUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const raw = (path ?? "").trim();
  let url: URL;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
    try {
      url = new URL(raw, base);
    } catch {
      throw badRequest(`Invalid URL: ${raw}`);
    }
  } else {
    const rel = `/${raw.replace(/^\/+/, "")}`;
    const carriesBase = basePath && (rel === basePath || rel.startsWith(`${basePath}/`) || rel.startsWith(`${basePath}?`));
    url = new URL(carriesBase ? rel : `${basePath}${rel === "/" ? "" : rel}` || "/", base.origin);
  }
  url.hash = "";
  const inside = url.pathname === basePath || url.pathname.startsWith(`${basePath}/`) || (!basePath && url.pathname.startsWith("/"));
  if (url.origin !== base.origin || !inside || url.username || url.password) {
    throw new HttpError(403, `${url.origin}${url.pathname} is outside this tool's API address (${baseUrl}); the key is only sent there.`, "forbidden");
  }
  return url;
}

function assertScopeExists(workspaceId: string | null, agentId: string | null) {
  if (workspaceId && !get<{ id: string }>("SELECT id FROM workspaces WHERE id = ?", workspaceId)) throw badRequest(`Workspace ${workspaceId} does not exist`);
  if (agentId && !get<{ id: string }>("SELECT id FROM agents WHERE id = ?", agentId)) throw badRequest(`Agent ${agentId} does not exist`);
}

function assertUsable(baseUrl: string, envVar: string | null, testPath: string) {
  if (!baseUrl && !envVar) throw badRequest("Add the API's address so agents can call it, or give runs the key in an environment variable.");
  if (testPath) {
    if (!baseUrl) throw badRequest("A test path needs the API's address");
    resolveApiUrl(baseUrl, testPath);
  }
}

const keyContext = (id: string) => `api_tools.key:${id}`;

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

export function createApiTool(input: ApiToolInput, actor = "user"): ApiTool {
  if (!input || typeof input !== "object") throw badRequest("Invalid API tool");
  const id = newId("tool");
  const workspaceId = input.workspaceId ?? null;
  const agentId = input.agentId ?? null;
  assertScopeExists(workspaceId, agentId);
  const baseUrl = cleanBaseUrl(input.baseUrl);
  const envVar = cleanEnvVar(input.envVar);
  const testPath = cleanText(input.testPath, 2048, "Test path");
  assertUsable(baseUrl, envVar, testPath);
  const key = input.apiKey ? cleanKey(input.apiKey) : "";
  const name = cleanName(input.name);

  const ts = now();
  insert("api_tools", {
    id,
    workspace_id: workspaceId,
    agent_id: agentId,
    name,
    description: cleanText(input.description, 2000, "Description"),
    docs: cleanText(input.docs, 100_000, "Documentation"),
    docs_url: cleanDocsUrl(input.docsUrl),
    base_url: baseUrl,
    auth: JSON.stringify(cleanAuth(input.auth)),
    test_path: testPath,
    env_var: envVar,
    preset: cleanPreset(input.preset),
    key_enc: key ? vault.seal(key, keyContext(id)) : null,
    enabled: input.enabled === false ? 0 : 1,
    created_at: ts,
    updated_at: ts,
  });
  audit(actor, "api_tool.create", id, { name, baseUrl, envVar, hasKey: !!key });
  bus.changed("api-tools");
  return getApiTool(id);
}

/**
 * Changes that let a saved key reach new places need the vault passphrase (a grant) unless the patch brings a new key:
 * handing it to runs as an environment variable (agents can read it) or moving the API address elsewhere.
 */
export function apiToolPatchNeedsGrant(current: ApiTool, patch: Partial<ApiToolInput>): boolean {
  if (!current.hasKey || patch.apiKey !== undefined) return false;
  if (patch.envVar !== undefined && cleanEnvVar(patch.envVar) && !current.envVar) return true;
  if (patch.baseUrl !== undefined) {
    const next = cleanBaseUrl(patch.baseUrl);
    if (!next || !current.baseUrl) return !!next;
    try {
      resolveApiUrl(current.baseUrl, next);
    } catch {
      return true;
    }
  }
  return false;
}

export function updateApiTool(id: string, patch: Partial<ApiToolInput>, actor = "user"): ApiTool {
  const row = getRow(id);
  if (!patch || typeof patch !== "object") throw badRequest("Invalid API tool update");
  const current = toModel(row);
  const workspaceId = patch.workspaceId !== undefined ? (patch.workspaceId ?? null) : current.workspaceId;
  const agentId = patch.agentId !== undefined ? (patch.agentId ?? null) : current.agentId;
  if (patch.workspaceId !== undefined || patch.agentId !== undefined) assertScopeExists(workspaceId, agentId);
  const baseUrl = patch.baseUrl !== undefined ? cleanBaseUrl(patch.baseUrl) : current.baseUrl;
  const envVar = patch.envVar !== undefined ? cleanEnvVar(patch.envVar) : current.envVar;
  const testPath = patch.testPath !== undefined ? cleanText(patch.testPath, 2048, "Test path") : current.testPath;
  assertUsable(baseUrl, envVar, testPath);

  const changes: Record<string, string | number | null> = {
    workspace_id: workspaceId,
    agent_id: agentId,
    base_url: baseUrl,
    env_var: envVar,
    test_path: testPath,
    updated_at: now(),
  };
  if (patch.name !== undefined) changes.name = cleanName(patch.name);
  if (patch.description !== undefined) changes.description = cleanText(patch.description, 2000, "Description");
  if (patch.docs !== undefined) changes.docs = cleanText(patch.docs, 100_000, "Documentation");
  if (patch.docsUrl !== undefined) changes.docs_url = cleanDocsUrl(patch.docsUrl);
  if (patch.auth !== undefined) changes.auth = JSON.stringify(cleanAuth(patch.auth));
  if (patch.preset !== undefined) changes.preset = cleanPreset(patch.preset);
  if (patch.enabled !== undefined) changes.enabled = patch.enabled ? 1 : 0;
  if (patch.apiKey !== undefined) {
    const key = patch.apiKey ? cleanKey(patch.apiKey) : "";
    changes.key_enc = key ? vault.seal(key, keyContext(id)) : null;
  }
  update("api_tools", id, changes);

  audit(actor, "api_tool.update", id, {
    name: (changes.name as string | undefined) ?? current.name,
    ...(baseUrl !== current.baseUrl ? { baseUrl } : {}),
    ...(envVar !== current.envVar ? { envVar } : {}),
    ...(patch.apiKey !== undefined ? { key: patch.apiKey ? "replaced" : "removed" } : {}),
  });
  bus.changed("api-tools");
  return getApiTool(id);
}

export function deleteApiTool(id: string, actor = "user"): void {
  const row = getRow(id);
  run("DELETE FROM api_tools WHERE id = ?", id);
  audit(actor, "api_tool.delete", id, { name: row.name });
  bus.changed("api-tools");
}

export function markApiToolUsed(id: string): void {
  run("UPDATE api_tools SET last_used_at = ? WHERE id = ?", now(), id);
  bus.changed("api-tools");
}

/** The decrypted key, or null when the tool has none (needs an unlocked vault). */
export function apiToolKey(id: string): string | null {
  const row = getRow(id);
  if (!row.key_enc) return null;
  const key = vault.open(row.key_enc, keyContext(id));
  vault.rememberSecret(key);
  return key;
}

/* ------------------------------------------------------------------ */
/* Resolution for a run                                                 */
/* ------------------------------------------------------------------ */

/** Global, the agent's workspace, or pinned to the agent itself. */
export function apiToolInAgentScope(tool: { workspaceId: string | null; agentId: string | null }, agent: Pick<Agent, "id" | "workspaceId">): boolean {
  if (tool.agentId !== null) return tool.agentId === agent.id;
  return tool.workspaceId === null || (agent.workspaceId !== null && tool.workspaceId === agent.workspaceId);
}

const specificity = (t: ApiTool) => (t.agentId ? 2 : t.workspaceId ? 1 : 0);

/**
 * Enabled tools `agent` may use, most general first. Shared (global / workspace) ones only when the agent inherits
 * shared integrations (`inheritMcp`); tools pinned to the agent always.
 */
export function apiToolsForAgent(agent: Pick<Agent, "id" | "workspaceId" | "inheritMcp">): ApiTool[] {
  return all<ApiToolRow>("SELECT * FROM api_tools WHERE enabled = 1 ORDER BY name COLLATE NOCASE, created_at")
    .map(toModel)
    .filter((t) => apiToolInAgentScope(t, agent) && (t.agentId === agent.id || agent.inheritMcp))
    .sort((a, b) => specificity(a) - specificity(b));
}

export function hasApiTools(agent: Pick<Agent, "id" | "workspaceId" | "inheritMcp">): boolean {
  return apiToolsForAgent(agent).length > 0;
}

/** A tool of the agent by id, name or slug of its name. */
export function findApiToolForAgent(agent: Pick<Agent, "id" | "workspaceId" | "inheritMcp">, ref: string): ApiTool {
  const tools = apiToolsForAgent(agent);
  const wanted = ref.trim();
  const lower = wanted.toLowerCase();
  const tool =
    tools.find((t) => t.id === wanted) ??
    tools.findLast((t) => t.name.toLowerCase() === lower) ??
    tools.findLast((t) => slugify(t.name) === slugify(wanted));
  if (tool) return tool;
  const names = tools.map((t) => `"${t.name}" (${t.id})`).join(", ");
  throw new HttpError(404, `No API tool "${wanted}" is available to you.${names ? ` Available: ${names}.` : ""}`, "not_found");
}

/** Environment variable → the tool whose key it holds (the most specific tool wins a name). */
export function apiToolEnvOwners(tools: ApiTool[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const t of [...tools].sort((a, b) => specificity(a) - specificity(b))) if (t.envVar && t.hasKey) owners.set(t.envVar, t.id);
  return owners;
}

/** Environment variables with the keys of the agent's tools that hand them to runs. Keys that can't be opened (vault locked) are left out. */
export function apiToolEnv(agent: Pick<Agent, "id" | "workspaceId" | "inheritMcp">): Record<string, string> {
  const env: Record<string, string> = {};
  const tools = apiToolsForAgent(agent);
  const owners = apiToolEnvOwners(tools);
  for (const tool of tools) {
    if (!tool.envVar || owners.get(tool.envVar) !== tool.id) continue;
    try {
      const key = apiToolKey(tool.id);
      if (key) env[tool.envVar] = key;
    } catch (err) {
      const reason = err instanceof HttpError && err.status === 423 ? "vault is locked" : err instanceof Error ? err.message : String(err);
      log.warn(`no ${tool.envVar} for agent ${agent.id}: ${reason}`);
    }
  }
  return env;
}
