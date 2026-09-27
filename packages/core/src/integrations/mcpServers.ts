/**
 * Custom MCP servers (stdio / streamable HTTP / legacy SSE), scoped global / workspace / agent,
 * plus the Composio Tool Router servers an agent gets from its connected accounts.
 *
 * Secrets (stdio env, HTTP headers) are stored as one encrypted JSON object per server
 * (`env_enc` / `headers_enc`, AAD `mcp_servers.env:<id>` / `mcp_servers.headers:<id>`); only the
 * key names are readable without the vault.
 */
import type { Agent, McpServer, McpServerInput, McpSource, McpTransport } from "@godmode/shared";
import { BROWSER_MCP_NAME, GODMODE_MCP_NAME, SECRET_MASK } from "@godmode/shared";
import type { McpServerJson } from "../types";
import { all, bool, get, insert, run, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { audit } from "../services/audit";
import * as vault from "../vault/vault";
import { badRequest, HttpError, newId, notFound, now, parseJson, slugify } from "../util";
import { COMPOSIO_SERVER_NAMES, composioMcpServersForAgent } from "./composio";

const log = logger("mcp-servers");

export const TRANSPORTS: readonly McpTransport[] = ["stdio", "http", "sse"];

/** Server names Godmode injects itself; custom servers never get these keys. */
const RESERVED_NAMES = new Set<string>([GODMODE_MCP_NAME, BROWSER_MCP_NAME, ...COMPOSIO_SERVER_NAMES]);

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token characters. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_SECRET_ENTRIES = 100;
const MAX_VALUE_LENGTH = 16_384;

interface McpServerRow {
  id: string;
  workspace_id: string | null;
  agent_id: string | null;
  name: string;
  description: string;
  source: string;
  transport: string;
  command: string;
  args: string;
  url: string;
  env_enc: string | null;
  headers_enc: string | null;
  env_keys: string;
  header_keys: string;
  enabled: number;
  composio: string | null;
  created_at: string;
  updated_at: string;
}

function toModel(r: McpServerRow): McpServer {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    name: r.name,
    description: r.description,
    source: (r.source === "composio" ? "composio" : "custom") as McpSource,
    transport: (TRANSPORTS.includes(r.transport as McpTransport) ? r.transport : "stdio") as McpTransport,
    command: r.command,
    args: parseJson<string[]>(r.args, []),
    url: r.url,
    envKeys: parseJson<string[]>(r.env_keys, []),
    headerKeys: parseJson<string[]>(r.header_keys, []),
    enabled: bool(r.enabled),
    composio: parseJson<McpServer["composio"]>(r.composio, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function getRow(id: string): McpServerRow {
  const row = get<McpServerRow>("SELECT * FROM mcp_servers WHERE id = ?", id);
  if (!row) throw notFound("MCP server");
  return row;
}

/* ------------------------------------------------------------------ */
/* Queries                                                              */
/* ------------------------------------------------------------------ */

export interface McpServerFilter {
  /** "all" (default) | "global" | workspace id */
  workspaceId?: string | null;
  /** Only servers pinned to this agent */
  agentId?: string | null;
}

export function listMcpServers(filter: McpServerFilter = {}): McpServer[] {
  const where: string[] = [];
  const params: string[] = [];
  const ws = filter.workspaceId;
  if (ws === "global" || ws === null) {
    where.push("workspace_id IS NULL");
  } else if (ws && ws !== "all") {
    where.push("workspace_id = ?");
    params.push(ws);
  }
  if (filter.agentId) {
    where.push("agent_id = ?");
    params.push(filter.agentId);
  }
  const sql = `SELECT * FROM mcp_servers${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY name COLLATE NOCASE, created_at`;
  return all<McpServerRow>(sql, ...params).map(toModel);
}

export function getMcpServer(id: string): McpServer {
  return toModel(getRow(id));
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                   */
/* ------------------------------------------------------------------ */

function cleanName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw badRequest("Name is required");
  const n = name.trim();
  if (n.length > 100) throw badRequest("Name must be at most 100 characters");
  return n;
}

function cleanTransport(t: unknown): McpTransport {
  if (!TRANSPORTS.includes(t as McpTransport)) throw badRequest(`Transport must be one of: ${TRANSPORTS.join(", ")}`);
  return t as McpTransport;
}

function cleanUrl(url: unknown, transport: McpTransport): string {
  if (typeof url !== "string" || !url.trim()) throw badRequest(`A URL is required for ${transport.toUpperCase()} MCP servers`);
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw badRequest(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw badRequest("MCP server URL must start with http:// or https://");
  return parsed.toString();
}

function cleanCommand(command: unknown): string {
  if (typeof command !== "string" || !command.trim()) throw badRequest("A command is required for stdio MCP servers (e.g. npx)");
  const c = command.trim();
  if (c.length > 1024 || /[\r\n\0]/.test(c)) throw badRequest("Invalid command");
  return c;
}

function cleanArgs(args: unknown): string[] {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw badRequest("args must be an array of strings");
  if (args.length > 200) throw badRequest("Too many arguments");
  for (const a of args as string[]) {
    if (a.length > 8192 || a.includes("\0")) throw badRequest("Invalid argument");
  }
  return args as string[];
}

async function assertScopeExists(workspaceId: string | null, agentId: string | null) {
  if (workspaceId && !get<{ id: string }>("SELECT id FROM workspaces WHERE id = ?", workspaceId)) {
    throw badRequest(`Workspace ${workspaceId} does not exist`);
  }
  if (agentId && !get<{ id: string }>("SELECT id FROM agents WHERE id = ?", agentId)) {
    throw badRequest(`Agent ${agentId} does not exist`);
  }
}

/**
 * Merge an incoming secret map with the stored one. `SECRET_MASK` values keep the stored value;
 * keys missing from `incoming` are removed.
 */
function mergeSecrets(
  kind: "env" | "headers",
  incoming: Record<string, string>,
  loadStored: () => Record<string, string>,
): Record<string, string> {
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    throw badRequest(`${kind} must be an object of string values`);
  }
  const entries = Object.entries(incoming);
  if (entries.length > MAX_SECRET_ENTRIES) throw badRequest(`Too many ${kind} entries`);
  let stored: Record<string, string> | null = null;
  const out: Record<string, string> = {};
  for (const [rawKey, value] of entries) {
    const key = rawKey.trim();
    if (kind === "env" && !ENV_KEY_RE.test(key)) throw badRequest(`Invalid environment variable name: ${rawKey}`);
    if (kind === "headers" && !HEADER_NAME_RE.test(key)) throw badRequest(`Invalid header name: ${rawKey}`);
    if (typeof value !== "string") throw badRequest(`${kind === "env" ? "Environment variable" : "Header"} ${key} must be a string`);
    if (value === SECRET_MASK) {
      stored ??= loadStored();
      if (!(key in stored)) throw badRequest(`No stored value for ${key}; enter a value`);
      out[key] = stored[key]!;
      continue;
    }
    if (value.length > MAX_VALUE_LENGTH) throw badRequest(`Value of ${key} is too long`);
    if (kind === "headers" && /[\r\n\0]/.test(value)) throw badRequest(`Header ${key} contains invalid characters`);
    if (kind === "env" && value.includes("\0")) throw badRequest(`Environment variable ${key} contains invalid characters`);
    out[key] = value;
  }
  return out;
}

function sealSecrets(values: Record<string, string>, context: string): string | null {
  if (Object.keys(values).length === 0) return null;
  return vault.seal(JSON.stringify(values), context);
}

function openSecrets(ciphertext: string | null, context: string): Record<string, string> {
  if (!ciphertext) return {};
  const parsed = parseJson<Record<string, string>>(vault.open(ciphertext, context), {});
  for (const v of Object.values(parsed)) vault.rememberSecret(v);
  return parsed;
}

const envContext = (id: string) => `mcp_servers.env:${id}`;
const headersContext = (id: string) => `mcp_servers.headers:${id}`;

/** Decrypted env + headers of a server (requires an unlocked vault when it has any). */
export function mcpServerSecrets(id: string): { env: Record<string, string>; headers: Record<string, string> } {
  const row = getRow(id);
  return { env: openSecrets(row.env_enc, envContext(id)), headers: openSecrets(row.headers_enc, headersContext(id)) };
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

export async function createMcpServer(input: McpServerInput, actor = "user"): Promise<McpServer> {
  if (!input || typeof input !== "object") throw badRequest("Invalid MCP server");
  const id = newId("mcp");
  const name = cleanName(input.name);
  const transport = cleanTransport(input.transport);
  const workspaceId = input.workspaceId ?? null;
  const agentId = input.agentId ?? null;
  await assertScopeExists(workspaceId, agentId);

  const command = transport === "stdio" ? cleanCommand(input.command) : "";
  const args = transport === "stdio" ? cleanArgs(input.args) : [];
  const url = transport === "stdio" ? "" : cleanUrl(input.url, transport);
  const noStored = () => ({}) as Record<string, string>;
  const env = mergeSecrets("env", input.env ?? {}, noStored);
  const headers = mergeSecrets("headers", input.headers ?? {}, noStored);

  const ts = now();
  insert("mcp_servers", {
    id,
    workspace_id: workspaceId,
    agent_id: agentId,
    name,
    description: (input.description ?? "").trim().slice(0, 2000),
    source: "custom",
    transport,
    command,
    args: JSON.stringify(args),
    url,
    env_enc: sealSecrets(env, envContext(id)),
    headers_enc: sealSecrets(headers, headersContext(id)),
    env_keys: JSON.stringify(Object.keys(env)),
    header_keys: JSON.stringify(Object.keys(headers)),
    enabled: input.enabled === false ? 0 : 1,
    composio: null,
    created_at: ts,
    updated_at: ts,
  });
  audit(actor, "mcp_server.create", id, { name, transport, envKeys: Object.keys(env), headerKeys: Object.keys(headers) });
  bus.changed("mcp-servers");
  return getMcpServer(id);
}

export async function updateMcpServer(id: string, patch: Partial<McpServerInput>, actor = "user"): Promise<McpServer> {
  const row = getRow(id);
  if (!patch || typeof patch !== "object") throw badRequest("Invalid MCP server update");
  const current = toModel(row);
  const transport = patch.transport !== undefined ? cleanTransport(patch.transport) : current.transport;
  const workspaceId = patch.workspaceId !== undefined ? patch.workspaceId : current.workspaceId;
  const agentId = patch.agentId !== undefined ? patch.agentId : current.agentId;
  if (patch.workspaceId !== undefined || patch.agentId !== undefined) await assertScopeExists(workspaceId, agentId);

  const changes: Record<string, string | number | null | undefined> = {
    workspace_id: workspaceId,
    agent_id: agentId,
    transport,
    updated_at: now(),
  };
  if (patch.name !== undefined) changes.name = cleanName(patch.name);
  if (patch.description !== undefined) changes.description = (patch.description ?? "").trim().slice(0, 2000);
  if (patch.enabled !== undefined) changes.enabled = patch.enabled ? 1 : 0;

  if (transport === "stdio") {
    changes.command = cleanCommand(patch.command !== undefined ? patch.command : current.command);
    changes.args = JSON.stringify(cleanArgs(patch.args !== undefined ? patch.args : current.args));
    changes.url = "";
  } else {
    changes.url = cleanUrl(patch.url !== undefined ? patch.url : current.url, transport);
    changes.command = "";
    changes.args = "[]";
  }

  const secretChanges: Record<string, string[]> = {};
  if (patch.env !== undefined) {
    const env = mergeSecrets("env", patch.env ?? {}, () => openSecrets(row.env_enc, envContext(id)));
    changes.env_enc = sealSecrets(env, envContext(id));
    changes.env_keys = JSON.stringify(Object.keys(env));
    secretChanges.envKeys = Object.keys(env);
  }
  if (patch.headers !== undefined) {
    const headers = mergeSecrets("headers", patch.headers ?? {}, () => openSecrets(row.headers_enc, headersContext(id)));
    changes.headers_enc = sealSecrets(headers, headersContext(id));
    changes.header_keys = JSON.stringify(Object.keys(headers));
    secretChanges.headerKeys = Object.keys(headers);
  }

  // `update` skips undefined but must be able to set NULL (cleared secrets / scope).
  const sets = Object.keys(changes).filter((k) => changes[k] !== undefined);
  run(`UPDATE mcp_servers SET ${sets.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...sets.map((k) => changes[k] as string | number | null), id);

  audit(actor, "mcp_server.update", id, { name: (changes.name as string | undefined) ?? current.name, ...secretChanges });
  bus.changed("mcp-servers");
  return getMcpServer(id);
}

export function deleteMcpServer(id: string, actor = "user"): void {
  const row = getRow(id);
  run("DELETE FROM mcp_servers WHERE id = ?", id);
  audit(actor, "mcp_server.delete", id, { name: row.name });
  bus.changed("mcp-servers");
}

export function setMcpServerEnabled(id: string, enabled: boolean): McpServer {
  getRow(id);
  update("mcp_servers", id, { enabled: enabled ? 1 : 0, updated_at: now() });
  bus.changed("mcp-servers");
  return getMcpServer(id);
}

/* ------------------------------------------------------------------ */
/* Resolution for a run                                                 */
/* ------------------------------------------------------------------ */

/** Custom servers that apply to `agent`, in a stable order. */
export function mcpServerRowsForAgent(agent: Pick<Agent, "id" | "workspaceId" | "inheritMcp" | "mcpServerIds">): McpServer[] {
  const pinnedIds = new Set(agent.mcpServerIds ?? []);
  return all<McpServerRow>("SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY created_at, id")
    .filter((r) => {
      if (r.agent_id === agent.id || pinnedIds.has(r.id)) return true;
      if (!agent.inheritMcp || r.agent_id !== null) return false;
      return r.workspace_id === null || (agent.workspaceId !== null && r.workspace_id === agent.workspaceId);
    })
    .map(toModel);
}

function uniqueKey(name: string, taken: Set<string>): string {
  const base = slugify(name);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/** `--mcp-config` entry for one server with decrypted secrets. */
export function mcpServerJson(server: McpServer, secrets: { env: Record<string, string>; headers: Record<string, string> }): McpServerJson {
  if (server.transport === "stdio") {
    return {
      type: "stdio",
      command: server.command,
      args: server.args,
      ...(Object.keys(secrets.env).length ? { env: secrets.env } : {}),
    };
  }
  return {
    type: server.transport,
    url: server.url,
    ...(Object.keys(secrets.headers).length ? { headers: secrets.headers } : {}),
  };
}

/**
 * All external MCP servers (custom + composio) an agent gets for a run, keyed by a unique server name,
 * with secrets (env/headers) decrypted. Respects agent.inheritMcp and agent.mcpServerIds.
 *
 * A server whose secrets cannot be decrypted (vault locked) is skipped with a warning instead of
 * failing the whole run; Composio problems (offline, invalid key) likewise only drop the Composio servers.
 */
export async function mcpServersForAgent(agent: Agent): Promise<Record<string, McpServerJson>> {
  const out: Record<string, McpServerJson> = {};
  const taken = new Set(RESERVED_NAMES);
  for (const server of mcpServerRowsForAgent(agent)) {
    let secrets: { env: Record<string, string>; headers: Record<string, string> };
    try {
      secrets = mcpServerSecrets(server.id);
    } catch (err) {
      const reason = err instanceof HttpError && err.status === 423 ? "vault is locked" : err instanceof Error ? err.message : String(err);
      log.warn(`skipping MCP server "${server.name}" for agent ${agent.id}: ${reason}`);
      continue;
    }
    out[uniqueKey(server.name, taken)] = mcpServerJson(server, secrets);
  }
  try {
    Object.assign(out, await composioMcpServersForAgent(agent));
  } catch (err) {
    log.warn(`Composio tools unavailable for agent ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}
