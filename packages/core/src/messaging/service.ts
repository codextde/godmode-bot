/**
 * Messaging connections (owner: messaging): bots on Slack, Telegram and Teams, their tokens (sealed in the vault),
 * the people who wrote to them and the platform chats they talk in. Each enabled connection runs an adapter while the
 * vault is unlocked; incoming messages go to the bridge (./bridge.ts).
 */
import type {
  MessagingAccess,
  MessagingBot,
  MessagingChat,
  MessagingConfig,
  MessagingConnection,
  MessagingConnectionInput,
  MessagingConnectionPatch,
  MessagingCredentials,
  MessagingProvider,
  MessagingState,
  MessagingStatus,
  MessagingUser,
  MessagingUserStatus,
  MessagingVerifyResult,
  ServerEvent,
} from "@godmode/shared";
import { MESSAGING_PROVIDER_LABELS } from "@godmode/shared";
import type { Context } from "hono";
import { all, bool, get, insert, run as exec, update } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { audit } from "../services/audit";
import { notify } from "../services/notifications";
import * as vault from "../vault/vault";
import { sha256 } from "../vault/crypto";
import { badRequest, conflict, HttpError, newId, notFound, now, parseJson, randomToken } from "../util";
import { handleInbound, welcomeApproved } from "./bridge";
import { SlackAdapter, verifySlack } from "./slack";
import { TelegramAdapter, verifyTelegram } from "./telegram";
import { TeamsAdapter, normalizePublicUrl, verifyTeams } from "./teams";
import { MessagingError, type AdapterContext, type MessagingAdapter } from "./types";

const log = logger("messaging");

const ENDPOINT_PREFIX = "msg_";
export const ENDPOINT_ROUTE = "/hooks/messaging";

export interface ConnectionRow {
  id: string;
  provider: MessagingProvider;
  name: string;
  enabled: number;
  bot: string;
  config: string;
  secrets_enc: string | null;
  agent_ids: string;
  default_agent_id: string | null;
  access: MessagingAccess;
  endpoint_hash: string | null;
  state: string;
  created_at: string;
  updated_at: string;
}

interface UserRow {
  id: string;
  connection_id: string;
  external_id: string;
  name: string;
  username: string | null;
  status: MessagingUserStatus;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatRow {
  id: string;
  connection_id: string;
  external_id: string;
  kind: "direct" | "group";
  user_id: string | null;
  title: string;
  agent_id: string | null;
  conversation_id: string | null;
  reply: string;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Tokens as sealed; Teams keeps its endpoint token here too. */
interface StoredSecrets {
  botToken?: string;
  appToken?: string;
  appPassword?: string;
  endpointToken?: string;
}

interface Runtime {
  adapter: MessagingAdapter;
  status: MessagingStatus;
  /** Tokens the adapter was started with (a change restarts it). */
  fingerprint: string;
}

const runtimes = new Map<string, Runtime>();
/** Why a connection's adapter couldn't start. */
const startErrors = new Map<string, string>();
/** Teams endpoint paths (decrypted once: listing bots must not keep the vault from locking). */
const endpointPaths = new Map<string, string | null>();
/** Last error per connection that the human was notified about (one notification per new problem). */
const notified = new Map<string, string>();
let unsubscribe: (() => void) | null = null;
let syncing: Promise<void> | null = null;
let syncAgain = false;

const secretsContext = (id: string) => `messaging_connections.secrets:${id}`;

export const providerLabel = (p: MessagingProvider) => MESSAGING_PROVIDER_LABELS[p];

/* ------------------------------------------------------------------ */
/* Rows → models                                                       */
/* ------------------------------------------------------------------ */

export function connectionRow(id: string): ConnectionRow | null {
  return get<ConnectionRow>("SELECT * FROM messaging_connections WHERE id = ?", id);
}

function requireRow(id: string): ConnectionRow {
  const row = connectionRow(id);
  if (!row) throw notFound("Messaging connection");
  return row;
}

/** The connection's agents that still exist (deleted ones drop out). */
export function agentIdsOf(row: Pick<ConnectionRow, "agent_ids">): string[] {
  const ids = parseJson<string[]>(row.agent_ids, []).filter((x) => typeof x === "string");
  if (!ids.length) return [];
  const existing = new Set(all<{ id: string }>(`SELECT id FROM agents WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids).map((r) => r.id));
  return ids.filter((x) => existing.has(x));
}

export function defaultAgentOf(row: Pick<ConnectionRow, "agent_ids" | "default_agent_id">): string | null {
  const ids = agentIdsOf(row);
  return row.default_agent_id && ids.includes(row.default_agent_id) ? row.default_agent_id : (ids[0] ?? null);
}

function sealSecrets(id: string, secrets: StoredSecrets): string {
  vault.rememberSecretValues(secrets as Record<string, unknown>);
  endpointPaths.delete(id);
  return vault.seal(JSON.stringify(secrets), secretsContext(id));
}

function readSecrets(row: ConnectionRow): StoredSecrets {
  if (!row.secrets_enc) return {};
  return parseJson<StoredSecrets>(vault.open(row.secrets_enc, secretsContext(row.id)), {});
}

function statusOf(row: ConnectionRow): MessagingStatus {
  const lastEventAt = parseJson<{ lastEventAt?: string }>(row.state, {}).lastEventAt ?? null;
  if (!bool(row.enabled)) return { state: "off", message: null, lastEventAt };
  const rt = runtimes.get(row.id);
  if (rt) return { ...rt.status, lastEventAt };
  if (!vault.isUnlocked()) return { state: "off", message: "Unlock the vault to connect", lastEventAt };
  const failed = startErrors.get(row.id);
  if (failed) return { state: "error", message: failed, lastEventAt };
  return { state: "connecting", message: null, lastEventAt };
}

function endpointPathOf(row: ConnectionRow): string | null {
  if (row.provider !== "teams" || !vault.isUnlocked()) return null;
  const cached = endpointPaths.get(row.id);
  if (cached !== undefined) return cached;
  try {
    const token = readSecrets(row).endpointToken;
    const path = token ? `${ENDPOINT_ROUTE}/${token}` : null;
    endpointPaths.set(row.id, path);
    return path;
  } catch {
    return null;
  }
}

function toModel(row: ConnectionRow): MessagingConnection {
  const counts = get<{ pending: number; chats: number }>(
    `SELECT (SELECT COUNT(*) FROM messaging_users WHERE connection_id = ?1 AND status = 'pending') AS pending,
            (SELECT COUNT(*) FROM messaging_chats WHERE connection_id = ?1 AND last_message_at IS NOT NULL) AS chats`,
    row.id,
  );
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: bool(row.enabled),
    bot: parseJson<MessagingBot>(row.bot, { id: "", name: row.name, username: null, team: null, url: null }),
    config: parseJson<MessagingConfig>(row.config, {}),
    agentIds: agentIdsOf(row),
    defaultAgentId: defaultAgentOf(row),
    access: row.access,
    status: statusOf(row),
    endpointPath: endpointPathOf(row),
    // With open access nobody waits for approval (people who wrote are listed, still unapproved, for a later lockdown).
    pendingUsers: row.access === "approved" ? (counts?.pending ?? 0) : 0,
    chats: counts?.chats ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUser(r: UserRow): MessagingUser {
  return {
    id: r.id,
    connectionId: r.connection_id,
    externalId: r.external_id,
    name: r.name,
    username: r.username,
    status: r.status,
    lastSeenAt: r.last_seen_at,
    createdAt: r.created_at,
  };
}

function toChat(r: ChatRow): MessagingChat {
  return {
    id: r.id,
    connectionId: r.connection_id,
    kind: r.kind,
    title: r.title,
    agentId: r.agent_id,
    conversationId: r.conversation_id,
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
  };
}

export function listConnections(): MessagingConnection[] {
  return all<ConnectionRow>("SELECT * FROM messaging_connections ORDER BY created_at ASC").map(toModel);
}

export function getConnection(id: string): MessagingConnection {
  return toModel(requireRow(id));
}

/** Open access requests across connections (sidebar badge). */
export function pendingRequestCount(): number {
  return (
    get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messaging_users u JOIN messaging_connections m ON m.id = u.connection_id
       WHERE u.status = 'pending' AND m.access = 'approved'`,
    )?.c ?? 0
  );
}

/* ------------------------------------------------------------------ */
/* Verify / create / update / delete                                   */
/* ------------------------------------------------------------------ */

export async function verifyCredentials(credentials: MessagingCredentials): Promise<MessagingVerifyResult> {
  try {
    switch (credentials.provider) {
      case "telegram":
        return await verifyTelegram(credentials);
      case "slack":
        return await verifySlack(credentials);
      case "teams":
        return await verifyTeams(credentials);
    }
  } catch (err) {
    if (err instanceof MessagingError) throw badRequest(err.message);
    throw err;
  }
}

function storedSecretsOf(credentials: MessagingCredentials, previous: StoredSecrets = {}): StoredSecrets {
  switch (credentials.provider) {
    case "telegram":
      return { botToken: credentials.botToken.trim() };
    case "slack":
      return { botToken: credentials.botToken.trim(), appToken: credentials.appToken.trim() };
    case "teams":
      return { appPassword: credentials.appPassword, endpointToken: previous.endpointToken ?? `${ENDPOINT_PREFIX}${randomToken(24)}` };
  }
}

function teamsConfig(credentials: MessagingCredentials, publicUrl: string | undefined, previous: MessagingConfig = {}): MessagingConfig {
  if (credentials.provider !== "teams") return previous;
  return {
    appId: credentials.appId.trim(),
    tenantId: credentials.tenantId.trim(),
    publicUrl: publicUrl !== undefined ? normalizePublicUrl(publicUrl) : previous.publicUrl,
  };
}

function checkAgents(agentIds: string[], defaultAgentId: string | null | undefined): { agentIds: string[]; defaultAgentId: string | null } {
  const unique = [...new Set(agentIds)];
  const existing = agentIdsOf({ agent_ids: JSON.stringify(unique) });
  if (existing.length !== unique.length) throw badRequest("Some of these agents don't exist anymore");
  if (!existing.length) throw badRequest("Choose at least one agent people can talk to");
  if (defaultAgentId && !existing.includes(defaultAgentId)) throw badRequest("The first agent must be one of the bot's agents");
  return { agentIds: existing, defaultAgentId: defaultAgentId ?? existing[0]! };
}

export async function createConnection(input: MessagingConnectionInput, actor = "user"): Promise<MessagingConnection> {
  if (!vault.isUnlocked()) throw vaultLocked();
  const agents = checkAgents(input.agentIds, input.defaultAgentId);
  const { bot } = await verifyCredentials(input.credentials);
  const provider = input.credentials.provider;
  const same = all<ConnectionRow>("SELECT * FROM messaging_connections WHERE provider = ?", provider).find(
    (r) => parseJson<MessagingBot>(r.bot, { id: "" } as MessagingBot).id === bot.id,
  );
  if (same) throw conflict(`${bot.name} is already connected as “${same.name}”`);
  const id = newId("msg");
  const ts = now();
  const secrets = storedSecretsOf(input.credentials);
  insert("messaging_connections", {
    id,
    provider,
    name: input.name?.trim() || bot.name || providerLabel(provider),
    enabled: 1,
    bot: JSON.stringify(bot),
    config: JSON.stringify(teamsConfig(input.credentials, input.publicUrl)),
    secrets_enc: sealSecrets(id, secrets),
    agent_ids: JSON.stringify(agents.agentIds),
    default_agent_id: agents.defaultAgentId,
    access: input.access ?? "approved",
    endpoint_hash: secrets.endpointToken ? sha256(secrets.endpointToken) : null,
    state: "{}",
    created_at: ts,
    updated_at: ts,
  });
  audit(actor, "messaging.connect", id, { provider, bot: bot.username ?? bot.name, agents: agents.agentIds, access: input.access ?? "approved" });
  bus.changed("messaging");
  requestSync();
  return getConnection(id);
}

export async function updateConnection(id: string, patch: MessagingConnectionPatch, actor = "user"): Promise<MessagingConnection> {
  const row = requireRow(id);
  const changes: Record<string, string | number | null | undefined> = { updated_at: now() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw badRequest("Name must not be empty");
    changes.name = name.slice(0, 100);
  }
  if (patch.enabled !== undefined) changes.enabled = patch.enabled ? 1 : 0;
  if (patch.access !== undefined) changes.access = patch.access;
  if (patch.agentIds !== undefined || patch.defaultAgentId !== undefined) {
    const agents = checkAgents(patch.agentIds ?? agentIdsOf(row), patch.defaultAgentId === undefined ? defaultAgentOf(row) : patch.defaultAgentId);
    changes.agent_ids = JSON.stringify(agents.agentIds);
    changes.default_agent_id = agents.defaultAgentId;
  }
  const config = parseJson<MessagingConfig>(row.config, {});
  if (patch.credentials) {
    if (patch.credentials.provider !== row.provider) throw badRequest(`These are ${providerLabel(patch.credentials.provider)} credentials`);
    if (!vault.isUnlocked()) throw vaultLocked();
    const { bot } = await verifyCredentials(patch.credentials);
    const current = parseJson<MessagingBot>(row.bot, { id: "" } as MessagingBot);
    if (current.id && bot.id !== current.id) throw badRequest(`These tokens belong to another bot (${bot.username ? `@${bot.username}` : bot.name}). Connect it separately.`);
    const secrets = storedSecretsOf(patch.credentials, readSecrets(row));
    changes.bot = JSON.stringify(bot);
    changes.secrets_enc = sealSecrets(id, secrets);
    changes.config = JSON.stringify(teamsConfig(patch.credentials, patch.publicUrl, config));
  } else if (patch.publicUrl !== undefined && row.provider === "teams") {
    changes.config = JSON.stringify({ ...config, publicUrl: normalizePublicUrl(patch.publicUrl) });
  }
  update("messaging_connections", id, changes);
  if (patch.access && patch.access !== row.access) audit(actor, "messaging.access", id, { access: patch.access });
  if (patch.credentials) audit(actor, "messaging.credentials", id, { provider: row.provider });
  if (patch.enabled !== undefined && patch.enabled !== bool(row.enabled)) audit(actor, patch.enabled ? "messaging.enable" : "messaging.disable", id, {});
  if (patch.enabled === false) notified.delete(id);
  bus.changed("messaging");
  requestSync();
  return getConnection(id);
}

export async function deleteConnection(id: string, actor = "user"): Promise<void> {
  const row = requireRow(id);
  await stopRuntime(id);
  exec("DELETE FROM messaging_connections WHERE id = ?", id);
  notified.delete(id);
  startErrors.delete(id);
  endpointPaths.delete(id);
  requestSync();
  audit(actor, "messaging.disconnect", id, { provider: row.provider, name: row.name });
  bus.changed("messaging");
}

function vaultLocked() {
  return new HttpError(423, "Unlock the vault to connect a bot: its tokens are stored there.", "vault_locked");
}

/* ------------------------------------------------------------------ */
/* People and chats                                                    */
/* ------------------------------------------------------------------ */

export function listUsers(connectionId: string): MessagingUser[] {
  requireRow(connectionId);
  return all<UserRow>(
    `SELECT * FROM messaging_users WHERE connection_id = ?
     ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, COALESCE(last_seen_at, created_at) DESC`,
    connectionId,
  ).map(toUser);
}

export function userRow(connectionId: string, externalId: string): UserRow | null {
  return get<UserRow>("SELECT * FROM messaging_users WHERE connection_id = ? AND external_id = ?", connectionId, externalId);
}

/** Record who wrote (name changes, last seen). New people wait for approval. */
export function upsertUser(connectionId: string, user: { id: string; name: string; username: string | null }): { row: UserRow; created: boolean } {
  const ts = now();
  const existing = userRow(connectionId, user.id);
  if (existing) {
    exec(
      "UPDATE messaging_users SET name = ?, username = ?, last_seen_at = ?, updated_at = ? WHERE id = ?",
      user.name.slice(0, 200) || existing.name,
      user.username,
      ts,
      ts,
      existing.id,
    );
    return { row: { ...existing, name: user.name || existing.name, username: user.username, last_seen_at: ts }, created: false };
  }
  const row: UserRow = {
    id: newId("mu"),
    connection_id: connectionId,
    external_id: user.id,
    name: user.name.slice(0, 200),
    username: user.username,
    status: "pending",
    last_seen_at: ts,
    created_at: ts,
    updated_at: ts,
  };
  insert("messaging_users", { ...row });
  return { row, created: true };
}

export async function setUserStatus(connectionId: string, userId: string, status: MessagingUserStatus, actor = "user"): Promise<MessagingUser> {
  requireRow(connectionId);
  const row = get<UserRow>("SELECT * FROM messaging_users WHERE id = ? AND connection_id = ?", userId, connectionId);
  if (!row) throw notFound("Person");
  if (row.status === status) return toUser(row);
  exec("UPDATE messaging_users SET status = ?, updated_at = ? WHERE id = ?", status, now(), userId);
  audit(actor, `messaging.user.${status === "approved" ? "approve" : status === "blocked" ? "block" : "reset"}`, connectionId, {
    user: row.name,
    externalId: row.external_id,
  });
  bus.changed("messaging");
  if (status === "approved") void welcomeApproved(connectionId, row.id).catch((err) => log.warn("could not welcome an approved person", err));
  return toUser({ ...row, status });
}

export function deleteUser(connectionId: string, userId: string, actor = "user"): void {
  requireRow(connectionId);
  const row = get<UserRow>("SELECT * FROM messaging_users WHERE id = ? AND connection_id = ?", userId, connectionId);
  if (!row) throw notFound("Person");
  exec("DELETE FROM messaging_users WHERE id = ?", userId);
  audit(actor, "messaging.user.remove", connectionId, { user: row.name, externalId: row.external_id });
  bus.changed("messaging");
}

export function listChats(connectionId: string, limit = 50): MessagingChat[] {
  requireRow(connectionId);
  return all<ChatRow>(
    `SELECT ch.*, CASE WHEN EXISTS (SELECT 1 FROM conversations c WHERE c.id = ch.conversation_id) THEN ch.conversation_id END AS conversation_id
     FROM messaging_chats ch WHERE ch.connection_id = ? AND ch.last_message_at IS NOT NULL
     ORDER BY ch.last_message_at DESC LIMIT ?`,
    connectionId,
    Math.min(Math.max(1, limit), 200),
  ).map(toChat);
}

export function chatRow(connectionId: string, externalId: string): ChatRow | null {
  return get<ChatRow>("SELECT * FROM messaging_chats WHERE connection_id = ? AND external_id = ?", connectionId, externalId);
}

export function insertChat(row: ChatRow): void {
  insert("messaging_chats", { ...row });
}

/** Change only the given columns: concurrent messages of a chat each update what they own. */
export function patchChat(id: string, patch: Partial<Omit<ChatRow, "id" | "connection_id" | "external_id" | "created_at">>): void {
  update("messaging_chats", id, { ...patch, updated_at: now() });
}

export function chatById(id: string): ChatRow | null {
  return get<ChatRow>("SELECT * FROM messaging_chats WHERE id = ?", id);
}

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

export function runtimeOf(id: string): MessagingAdapter | null {
  return runtimes.get(id)?.adapter ?? null;
}

function saveState(id: string, patch: Record<string, unknown>) {
  const row = connectionRow(id);
  if (!row) return;
  exec("UPDATE messaging_connections SET state = ? WHERE id = ?", JSON.stringify({ ...parseJson<object>(row.state, {}), ...patch }), id);
}

export function touchConnection(id: string) {
  saveState(id, { lastEventAt: now() });
}

function setStatus(id: string, state: MessagingState, message: string | null = null) {
  const rt = runtimes.get(id);
  if (!rt) return;
  if (rt.status.state === state && rt.status.message === message) return;
  rt.status = { ...rt.status, state, message };
  bus.changed("messaging");
  if (state === "connected") {
    notified.delete(id);
    return;
  }
  if (state !== "error" || !message || notified.get(id) === message) return;
  notified.set(id, message);
  const row = connectionRow(id);
  if (row) notify("warning", `${row.name} can't receive messages`, message, "/messaging");
}

function fingerprintOf(row: ConnectionRow): string {
  return sha256(`${row.secrets_enc ?? ""}|${row.config}|${row.bot}`);
}

function adapterFor(row: ConnectionRow, ctx: AdapterContext): MessagingAdapter {
  const secrets = readSecrets(row);
  switch (row.provider) {
    case "telegram":
      return new TelegramAdapter(ctx, { botToken: secrets.botToken ?? "" });
    case "slack":
      return new SlackAdapter(ctx, { botToken: secrets.botToken ?? "", appToken: secrets.appToken ?? "" });
    case "teams": {
      const config = parseJson<MessagingConfig>(row.config, {});
      return new TeamsAdapter(ctx, { appId: config.appId ?? "", tenantId: config.tenantId ?? "", appPassword: secrets.appPassword ?? "" });
    }
  }
}

async function startRuntime(row: ConnectionRow) {
  const ctx: AdapterContext = {
    connectionId: row.id,
    bot: parseJson<MessagingBot>(row.bot, { id: "", name: row.name, username: null, team: null, url: null }),
    config: parseJson<MessagingConfig>(row.config, {}),
    state: parseJson<Record<string, unknown>>(row.state, {}),
    saveState: (patch) => {
      if (runtimes.get(row.id)?.adapter === adapter) saveState(row.id, patch);
    },
    onMessage: (message) => {
      if (runtimes.get(row.id)?.adapter !== adapter) return;
      void handleInbound(row.id, message).catch((err) => log.error(`message for ${row.id} failed`, err));
    },
    onStatus: (state, message) => {
      if (runtimes.get(row.id)?.adapter === adapter) setStatus(row.id, state, message ?? null);
    },
  };
  const adapter = adapterFor(row, ctx);
  runtimes.set(row.id, { adapter, status: { state: "connecting", message: null, lastEventAt: null }, fingerprint: fingerprintOf(row) });
  adapter.start();
  log.info(`${row.provider} bot ${row.name} (${row.id}) started`);
}

async function stopRuntime(id: string) {
  const rt = runtimes.get(id);
  if (!rt) return;
  runtimes.delete(id);
  await rt.adapter.stop().catch((err) => log.warn(`stopping ${id} failed`, err));
}

async function syncOnce() {
  const rows = all<ConnectionRow>("SELECT * FROM messaging_connections");
  const unlocked = vault.isUnlocked();
  const wanted = new Map(rows.filter((r) => bool(r.enabled) && unlocked).map((r) => [r.id, r]));
  // Keep running adapters when the vault locks: their tokens are already in memory, and people keep talking.
  for (const id of [...runtimes.keys()]) {
    const row = rows.find((r) => r.id === id);
    if (!row || !bool(row.enabled) || (unlocked && runtimes.get(id)!.fingerprint !== fingerprintOf(row))) await stopRuntime(id);
  }
  for (const id of wanted.keys()) {
    const row = connectionRow(id);
    if (runtimes.has(id) || !row || !bool(row.enabled)) continue;
    try {
      await startRuntime(row);
      startErrors.delete(id);
    } catch (err) {
      startErrors.set(id, `Couldn't start: ${err instanceof Error ? err.message : String(err)}`);
      log.error(`could not start messaging connection ${id}`, err);
    }
  }
  bus.changed("messaging");
}

export function syncMessaging(): Promise<void> {
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = (async () => {
    try {
      do {
        syncAgain = false;
        await syncOnce();
      } while (syncAgain);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

function requestSync() {
  void syncMessaging().catch((err) => log.error("messaging sync failed", err));
}

function onBusEvent(event: ServerEvent) {
  if (event.type === "vault.status") requestSync();
}

export function startMessaging(): void {
  unsubscribe ??= bus.on(onBusEvent);
  requestSync();
}

export async function stopMessaging(): Promise<void> {
  unsubscribe?.();
  unsubscribe = null;
  await Promise.all([...runtimes.keys()].map((id) => stopRuntime(id)));
}

/* ------------------------------------------------------------------ */
/* Teams endpoint (public)                                              */
/* ------------------------------------------------------------------ */

/** POST /hooks/messaging/:token — Bot Framework deliveries; the adapter checks their signature. */
export async function handleMessagingHook(c: Context): Promise<Response> {
  const token = c.req.param("token") ?? "";
  const row =
    token.startsWith(ENDPOINT_PREFIX) && token.length <= 100
      ? get<{ id: string }>("SELECT id FROM messaging_connections WHERE endpoint_hash = ?", sha256(token))
      : null;
  if (!row) return c.json({ error: "Unknown endpoint", code: "not_found" }, 404);
  const adapter = runtimeOf(row.id);
  if (!adapter?.receive) return c.json({ error: "This bot is turned off", code: "unavailable" }, 503);
  try {
    return await adapter.receive(c.req.raw);
  } catch (err) {
    log.error("messaging delivery failed", err instanceof Error ? err.message : err);
    return c.json({ error: "Internal error", code: "internal" }, 500);
  }
}
