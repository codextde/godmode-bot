/**
 * Connected apps: Claude Code and other MCP clients outside Godmode that may call its management tools. Each has its
 * own key (stored as a hash) and acts as the built-in Godmode agent, with the limits that agent has: secret access,
 * management rights and the human's computer stay with the human.
 */
import {
  CONNECT_TOKEN_ENV,
  CONNECT_TOKEN_PREFIX,
  GODMODE_MCP_NAME,
  type Connector,
  type ConnectorAccess,
  type ConnectorClient,
  type ConnectorSetup,
} from "@godmode/shared";
import { config, selfCommand } from "../config";
import { all, bool, get, insert, run } from "../db";
import { bus } from "../events/bus";
import { getDefaultAgentId } from "../agents/service";
import { gatewayUrl } from "../runner/mcpConfig";
import { audit } from "../services/audit";
import type { RunContext } from "../types";
import { newId, notFound, now, randomToken } from "../util";
import { sha256 } from "../vault/crypto";

const USED_EVENT_MS = 5_000;

interface ConnectorRow {
  id: string;
  name: string;
  client: string;
  access: string;
  installed: number;
  calls: number;
  last_tool: string | null;
  last_used_at: string | null;
  created_at: string;
}

const COLUMNS = "id, name, client, access, installed, calls, last_tool, last_used_at, created_at";
const lastUsedEvents = new Map<string, number>();
const pendingUsedEvents = new Map<string, ReturnType<typeof setTimeout>>();

function toConnector(row: ConnectorRow): Connector {
  return {
    id: row.id,
    name: row.name,
    client: row.client === "claude-code" ? "claude-code" : "other",
    // Anything but an explicit "manage" only reads.
    access: row.access === "manage" ? "manage" : "read",
    installed: bool(row.installed),
    calls: row.calls,
    lastTool: row.last_tool,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

export function listConnectors(): Connector[] {
  return all<ConnectorRow>(`SELECT ${COLUMNS} FROM connectors ORDER BY created_at DESC`).map(toConnector);
}

export function getConnector(id: string): Connector {
  const row = get<ConnectorRow>(`SELECT ${COLUMNS} FROM connectors WHERE id = ?`, id);
  if (!row) throw notFound("Connected app");
  return toConnector(row);
}

export function createConnector(input: { name: string; client: ConnectorClient; access: ConnectorAccess; installed?: boolean }, actor = "user"): { connector: Connector; token: string } {
  const token = CONNECT_TOKEN_PREFIX + randomToken(32);
  const id = newId("con");
  insert("connectors", {
    id,
    name: input.name.trim().slice(0, 80) || (input.client === "claude-code" ? "Claude Code" : "App"),
    client: input.client,
    access: input.access,
    token_hash: sha256(token),
    installed: input.installed ? 1 : 0,
    created_at: now(),
  });
  const connector = getConnector(id);
  audit(actor, "connector.create", id, { name: connector.name, client: connector.client, access: connector.access });
  bus.changed("connectors");
  return { connector, token };
}

export function setConnectorInstalled(id: string, installed: boolean): Connector {
  run("UPDATE connectors SET installed = ? WHERE id = ?", installed ? 1 : 0, id);
  bus.changed("connectors");
  return getConnector(id);
}

export function removeConnector(id: string, actor = "user"): Connector {
  const connector = getConnector(id);
  run("DELETE FROM connectors WHERE id = ?", id);
  lastUsedEvents.delete(id);
  audit(actor, "connector.remove", id, { name: connector.name });
  bus.changed("connectors");
  return connector;
}

/** The gateway identity behind a connected app's key: it calls as the built-in agent, outside any run or chat. */
export function connectorContext(token: string): RunContext | null {
  if (!token.startsWith(CONNECT_TOKEN_PREFIX)) return null;
  const row = get<ConnectorRow>(`SELECT ${COLUMNS} FROM connectors WHERE token_hash = ?`, sha256(token));
  const agentId = row && getDefaultAgentId();
  if (!row || !agentId) return null;
  const { id, name, access } = toConnector(row);
  return { runId: "", agentId, conversationId: "", workspaceId: null, depth: 0, connector: { id, name, access } };
}

/** Remember that the app called a tool. The list in Settings follows: right away, then once per burst of calls. */
export function noteConnectorCall(id: string, tool: string): void {
  run("UPDATE connectors SET calls = calls + 1, last_tool = ?, last_used_at = ? WHERE id = ?", tool, now(), id);
  if (pendingUsedEvents.has(id)) return;
  const wait = Math.max(0, USED_EVENT_MS - (Date.now() - (lastUsedEvents.get(id) ?? 0)));
  const timer = setTimeout(() => {
    pendingUsedEvents.delete(id);
    lastUsedEvents.set(id, Date.now());
    bus.changed("connectors");
  }, wait);
  timer.unref?.();
  pendingUsedEvents.set(id, timer);
}

function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return process.platform === "win32" ? `"${arg.replace(/"/g, '\\"')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Everything an app needs to reach Godmode with `token`. */
export function connectorSetup(token: string): ConnectorSetup {
  const [command, ...script] = selfCommand() as [string, ...string[]];
  // The app starts the program with its own environment (another GODMODE_HOME, or none): the data dir is always named.
  const dataDir = ["--data-dir", config().dataDir];
  const args = [...script, "mcp", ...dataDir];
  const env = { [CONNECT_TOKEN_ENV]: token };
  const program = [command, ...script].map(shellQuote).join(" ");
  const dir = dataDir.map(shellQuote).join(" ");
  return {
    token,
    command,
    args,
    env,
    url: gatewayUrl(),
    claudeCommand: `claude mcp add --scope user ${GODMODE_MCP_NAME} -e ${CONNECT_TOKEN_ENV}=${token} -- ${[command, ...args].map(shellQuote).join(" ")}`,
    json: JSON.stringify({ mcpServers: { [GODMODE_MCP_NAME]: { command, args, env } } }, null, 2),
    cli: `export ${CONNECT_TOKEN_ENV}=${token}\n${program} tools ${dir}\n${program} call agents_list ${dir}`,
  };
}
