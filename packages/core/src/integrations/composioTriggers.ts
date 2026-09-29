/**
 * App triggers through Composio: the trigger catalog of a toolkit, one trigger instance per watched account + setup
 * (created with `trigger_instances/{slug}/upsert`), and delivery without a public URL over Composio's realtime channel
 * (Pusher, the same feed the Composio SDK's `triggers.subscribe` uses).
 *
 * Instances Godmode created are remembered in meta `composio.trigger_instances`; the sync deletes the ones no automation
 * references anymore (deleted or re-targeted automations, cascades) and disables the ones whose automations are off.
 */
import type { ComposioTriggerType, ServerEvent } from "@godmode/shared";
import { all, getMeta, setMeta } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { accountInScope, parseTrigger, patchTriggerState, type RoutineRow, type TriggerState } from "../services/routines";
import { describePayload, receiveEvent } from "../automations/events";
import { notify } from "../services/notifications";
import * as vault from "../vault/vault";
import { sha256 } from "../vault/crypto";
import { HttpError, parseJson } from "../util";
import { COMPOSIO_API_KEY_SECRET, composioRequest, upstreamStatus } from "./composio";
import { PusherConnection, type PusherOptions } from "./pusher";

const log = logger("composio-triggers");

const TYPES_TTL_MS = 10 * 60_000;
const SYNC_INTERVAL_MS = 5 * 60_000;
/** Re-upsert live instances this often: recreates instances deleted or disabled on Composio's side. */
const VERIFY_INTERVAL_MS = 6 * 60 * 60_000;
/** After the realtime service refused us for good, try again with fresh credentials after this long. */
const LISTENER_RETRY_MS = 60_000;
/** Per request while switching API keys (setApiKey waits for it). */
const RELEASE_TIMEOUT_MS = 5_000;
const NOT_CONFIGURED = "Composio is not configured — add your API key in Settings → Integrations";
const VAULT_LOCKED = "Unlock the vault so Godmode can reach Composio";
const CHUNK_TTL_MS = 60_000;
const INSTANCES_META = "composio.trigger_instances";
/** Composio SDK realtime endpoints (not versioned like the public API). */
const REALTIME_CREDENTIALS_PATH = "/api/v3/internal/sdk/realtime/credentials";
const REALTIME_AUTH_PATH = "/api/v3/internal/sdk/realtime/auth";

/* ------------------------------------------------------------------ */
/* Trigger catalog                                                      */
/* ------------------------------------------------------------------ */

interface RawTriggerType {
  slug?: string;
  name?: string;
  description?: string;
  instructions?: string;
  type?: string;
  config?: Record<string, unknown>;
  toolkit?: { slug?: string; logo?: string | null };
  requires_webhook_endpoint_setup?: boolean;
}

function mapTriggerType(raw: RawTriggerType, toolkit: string): ComposioTriggerType | null {
  if (!raw || typeof raw.slug !== "string" || !raw.slug) return null;
  const kind = raw.type === "poll" || raw.type === "webhook" ? raw.type : null;
  return {
    slug: raw.slug,
    name: raw.name || raw.slug,
    description: raw.description ?? "",
    instructions: raw.instructions ?? "",
    toolkit: raw.toolkit?.slug?.toLowerCase() || toolkit,
    toolkitLogo: raw.toolkit?.logo ?? null,
    kind,
    config: raw.config && typeof raw.config === "object" ? raw.config : {},
    requiresWebhookSetup: raw.requires_webhook_endpoint_setup === true,
  };
}

const typesCache = new Map<string, { at: number; types: ComposioTriggerType[] }>();

/** Events a toolkit can emit (e.g. "gmail" → new message, email sent…). */
export async function listTriggerTypes(toolkit: string): Promise<ComposioTriggerType[]> {
  const slug = toolkit.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(slug)) throw new HttpError(400, "Invalid toolkit", "bad_request");
  const cached = typesCache.get(slug);
  if (cached && Date.now() - cached.at < TYPES_TTL_MS) return cached.types;
  const data = await composioRequest<{ items?: RawTriggerType[] }>("GET", "/api/v3.1/triggers_types", {
    query: { toolkit_slugs: slug, limit: 200 },
  });
  const types = (data?.items ?? [])
    .map((t) => mapTriggerType(t, slug))
    .filter((t): t is ComposioTriggerType => t !== null && t.toolkit === slug);
  typesCache.set(slug, { at: Date.now(), types });
  return types;
}

export async function getTriggerType(triggerSlug: string): Promise<ComposioTriggerType> {
  const slug = triggerSlug.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_]{0,199}$/.test(slug)) throw new HttpError(400, "Invalid app event", "bad_request");
  for (const { types } of typesCache.values()) {
    const hit = types.find((t) => t.slug === slug);
    if (hit) return hit;
  }
  try {
    const raw = await composioRequest<RawTriggerType>("GET", `/api/v3.1/triggers_types/${encodeURIComponent(slug)}`);
    const mapped = mapTriggerType(raw, raw?.toolkit?.slug?.toLowerCase() ?? "");
    if (!mapped) throw new HttpError(502, "Composio returned an invalid trigger type", "composio_upstream");
    return mapped;
  } catch (err) {
    // Composio answers 400 for an unknown slug.
    if (err instanceof HttpError && (err.status === 404 || err.status === 400) && err.code !== "composio_not_configured") {
      throw new HttpError(404, `Unknown app event "${slug}"`, "not_found");
    }
    throw err;
  }
}

/** Missing required fields of a trigger's config (per its JSON schema). */
export function missingConfigFields(type: ComposioTriggerType, config: Record<string, unknown>): string[] {
  const required = Array.isArray(type.config.required) ? (type.config.required as unknown[]) : [];
  return required.filter((k): k is string => typeof k === "string" && (config[k] === undefined || config[k] === null || config[k] === ""));
}

/* ------------------------------------------------------------------ */
/* Incoming messages                                                    */
/* ------------------------------------------------------------------ */

export interface TriggerMessage {
  /** Delivery id (V3 `msg_…`, or the log id) — the same event delivered twice has the same id. */
  eventId: string | null;
  /** Trigger instance (`ti_…`). */
  triggerId: string | null;
  triggerSlug: string | null;
  connectedAccountId: string | null;
  data: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Normalize a realtime/webhook trigger payload (V3, V2, V1 and the legacy SDK shape). Null for anything else. */
export function normalizeTriggerMessage(input: unknown): TriggerMessage | null {
  let d = input;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!isObj(d)) return null;
  // V3: { id, type: "composio.trigger.message", metadata: { trigger_id, trigger_slug, connected_account_id, … }, data }
  if (typeof d.type === "string" && d.type.startsWith("composio.") && isObj(d.metadata)) {
    if (d.type !== "composio.trigger.message") return null;
    const m = d.metadata;
    return {
      eventId: str(d.id) ?? str(m.log_id),
      triggerId: str(m.trigger_id),
      triggerSlug: str(m.trigger_slug),
      connectedAccountId: str(m.connected_account_id),
      data: d.data ?? null,
    };
  }
  // V2: { type: "<slug>", log_id, data: { trigger_nano_id, connection_nano_id, …, event fields } }
  if (typeof d.type === "string" && typeof d.log_id === "string" && isObj(d.data)) {
    const { connection_id, connection_nano_id, trigger_nano_id, trigger_id, user_id: _userId, ...rest } = d.data;
    return {
      eventId: d.log_id,
      triggerId: str(trigger_nano_id) ?? str(trigger_id),
      triggerSlug: d.type.toUpperCase(),
      connectedAccountId: str(connection_nano_id) ?? str(connection_id),
      data: rest,
    };
  }
  // V1: { trigger_name, trigger_id, connection_id, payload, log_id }
  if (typeof d.trigger_name === "string" && typeof d.trigger_id === "string") {
    return { eventId: str(d.log_id), triggerId: d.trigger_id, triggerSlug: d.trigger_name, connectedAccountId: str(d.connection_id), data: d.payload ?? null };
  }
  // Legacy SDK: { appName, payload, metadata: { nanoId, triggerName, connection: { connectedAccountNanoId } } }
  if (isObj(d.metadata) && typeof d.metadata.nanoId === "string") {
    const connection = isObj(d.metadata.connection) ? d.metadata.connection : {};
    return {
      eventId: null,
      triggerId: d.metadata.nanoId,
      triggerSlug: str(d.metadata.triggerName),
      connectedAccountId: str(connection.connectedAccountNanoId),
      data: d.payload ?? d.originalPayload ?? null,
    };
  }
  return null;
}

type AppRoutineRow = RoutineRow & { agent_enabled: number; agent_workspace_id: string | null };

function appRoutines(): AppRoutineRow[] {
  return all<AppRoutineRow>(
    `SELECT r.*, a.enabled AS agent_enabled, a.workspace_id AS agent_workspace_id FROM routines r JOIN agents a ON a.id = r.agent_id
     WHERE CASE WHEN json_valid(r.trigger) THEN json_extract(r.trigger, '$.type') END = 'app'`,
  );
}

interface ConnectionRow {
  id: string;
  connected_account_id: string;
  toolkit: string;
  workspace_id: string | null;
  agent_id: string | null;
  user_id: string;
  status: string;
}

function connectionsById(): Map<string, ConnectionRow> {
  return new Map(
    all<ConnectionRow>("SELECT id, connected_account_id, toolkit, workspace_id, agent_id, user_id, status FROM composio_connections").map((c) => [c.id, c]),
  );
}

/**
 * Hand a trigger message to every automation watching its trigger instance. Only messages without an instance id
 * (older payload versions) fall back to slug + account: an unknown instance id belongs to someone else's setup.
 * Automations whose account is gone, or that their agent may no longer use, get nothing.
 */
export function routeTriggerMessage(msg: TriggerMessage): number {
  const connections = connectionsById();
  const rows = appRoutines().filter((r) => {
    const t = parseTrigger(r.trigger);
    const connection = t.type === "app" ? connections.get(t.connectionId) : undefined;
    return !!connection && accountInScope(connection, { id: r.agent_id, workspaceId: r.agent_workspace_id });
  });
  let targets = msg.triggerId ? rows.filter((r) => parseJson<TriggerState>(r.trigger_state, {}).composioTriggerId === msg.triggerId) : [];
  if (!msg.triggerId && msg.triggerSlug && msg.connectedAccountId) {
    targets = rows.filter((r) => {
      const t = parseTrigger(r.trigger);
      return (
        t.type === "app" &&
        t.triggerSlug === msg.triggerSlug!.toUpperCase() &&
        connections.get(t.connectionId)?.connected_account_id === msg.connectedAccountId
      );
    });
  }
  for (const row of targets) {
    const trigger = parseTrigger(row.trigger);
    const name = trigger.type === "app" ? trigger.triggerName : "App event";
    const described = describePayload(msg.data);
    try {
      receiveEvent(row.id, {
        source: "app",
        title: described ? `${name} · ${described}` : name,
        payload: msg.data,
        dedupeKey: msg.eventId,
      });
    } catch (err) {
      log.warn(`could not record an app event for automation ${row.id}`, err);
    }
  }
  if (!targets.length) log.debug(`trigger event for ${msg.triggerId ?? msg.triggerSlug ?? "?"} matched no automation`);
  return targets.length;
}

/* ------------------------------------------------------------------ */
/* Realtime listener                                                    */
/* ------------------------------------------------------------------ */

type ListenerState = { state: "off" | "connecting" | "ok" | "error"; message: string | null };

let listener: PusherConnection | null = null;
/** API key fingerprint the listener authenticated with: another key may mean another Composio project. */
let listenerKey: string | null = null;
let listenerStarting = false;
let listenerState: ListenerState = { state: "off", message: null };
const chunks = new Map<string, { parts: string[]; final: boolean; at: number }>();
/** Tests: replace the WebSocket implementation / endpoint of the realtime connection. */
let pusherOverrides: Pick<PusherOptions, "url" | "WebSocketImpl"> = {};

export function __setPusherForTests(overrides: Pick<PusherOptions, "url" | "WebSocketImpl">) {
  pusherOverrides = overrides;
}

function setListenerState(next: ListenerState) {
  if (next.state === listenerState.state && next.message === listenerState.message) return;
  listenerState = next;
  bus.changed("routines");
}

/** How app triggers are doing overall (for each automation's trigger status). */
export function appTriggerHealth(): { state: "ok" | "pending" | "error"; message: string | null } {
  switch (listenerState.state) {
    case "ok":
      return { state: "ok", message: null };
    case "error":
      return { state: "error", message: listenerState.message ?? "Can't receive app events from Composio" };
    default:
      return { state: "pending", message: "Connecting to Composio…" };
  }
}

function onRealtimeEvent(event: string, data: unknown) {
  if (event === "trigger_to_client") {
    const msg = normalizeTriggerMessage(data);
    if (msg) routeTriggerMessage(msg);
    return;
  }
  if (event === "chunked-trigger_to_client" && isObj(data) && typeof data.id === "string" && typeof data.chunk === "string") {
    const index = Number(data.index);
    if (!Number.isInteger(index) || index < 0 || index > 10_000) return;
    const t = Date.now();
    for (const [id, c] of chunks) if (t - c.at > CHUNK_TTL_MS) chunks.delete(id);
    const entry = chunks.get(data.id) ?? { parts: [], final: false, at: t };
    entry.parts[index] = data.chunk;
    if (data.final === true) entry.final = true;
    chunks.set(data.id, entry);
    const complete = entry.final && entry.parts.length === Object.keys(entry.parts).length;
    if (!complete) return;
    chunks.delete(data.id);
    const msg = normalizeTriggerMessage(entry.parts.join(""));
    if (msg) routeTriggerMessage(msg);
  }
}

async function startListener(keyFingerprint: string) {
  if (listener || listenerStarting) return;
  listenerStarting = true;
  setListenerState({ state: "connecting", message: null });
  try {
    const creds = await composioRequest<{ pusher_key?: string; pusher_cluster?: string; project_id?: string }>("GET", REALTIME_CREDENTIALS_PATH);
    if (!creds?.pusher_key || !creds.pusher_cluster || !creds.project_id) {
      throw new HttpError(502, "Composio returned no realtime credentials", "composio_upstream");
    }
    const connection = new PusherConnection({
      key: creds.pusher_key,
      cluster: creds.pusher_cluster,
      channel: `private-${creds.project_id}_triggers`,
      authorize: async (socketId, channel) => {
        const res = await composioRequest<{ auth?: string }>("POST", REALTIME_AUTH_PATH, { body: { socket_id: socketId, channel_name: channel } });
        if (!res?.auth) throw new HttpError(502, "Composio refused the realtime channel", "composio_upstream");
        return res.auth;
      },
      onEvent: onRealtimeEvent,
      onStatus: (status, message) => {
        if (listener !== connection) return;
        if (status === "connected") setListenerState({ state: "ok", message: null });
        else if (status === "error") setListenerState({ state: "error", message: `Can't receive app events: ${message ?? "connection failed"}` });
        else if (status === "connecting" && listenerState.state !== "error") setListenerState({ state: "connecting", message: null });
        // Refused for good (bad key, quota…): drop it so a later sync starts over with fresh credentials.
        if (status === "error" && connection.isClosed) {
          listener = null;
          listenerKey = null;
          requestAppTriggerSync(LISTENER_RETRY_MS);
        }
      },
      ...pusherOverrides,
    });
    listener = connection;
    listenerKey = keyFingerprint;
    connection.start();
    log.info("listening for Composio trigger events");
  } catch (err) {
    setListenerState({ state: "error", message: `Can't receive app events: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    listenerStarting = false;
  }
}

function stopListener() {
  const l = listener;
  listener = null;
  listenerKey = null;
  l?.close();
  chunks.clear();
  setListenerState({ state: "off", message: null });
}

/* ------------------------------------------------------------------ */
/* Instance sync                                                        */
/* ------------------------------------------------------------------ */

function knownInstances(): Set<string> {
  return new Set(parseJson<string[]>(getMeta(INSTANCES_META), []).filter((id) => typeof id === "string"));
}

function saveInstances(ids: Set<string>) {
  setMeta(INSTANCES_META, JSON.stringify([...ids].sort()));
}

/** Stable JSON (sorted keys) so equal configs give equal signatures. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

async function upsertInstance(slug: string, connection: ConnectionRow, config: Record<string, unknown>): Promise<string> {
  const res = await composioRequest<{ trigger_id?: string }>("POST", `/api/v3.1/trigger_instances/${encodeURIComponent(slug)}/upsert`, {
    body: { connected_account_id: connection.connected_account_id, user_id: connection.user_id, trigger_config: config ?? {} },
  });
  if (!res?.trigger_id) throw new HttpError(502, "Composio did not return a trigger id", "composio_upstream");
  return res.trigger_id;
}

/** Enable or disable an instance. Returns false when it no longer exists on Composio. */
async function setInstanceStatus(triggerId: string, status: "enable" | "disable"): Promise<boolean> {
  try {
    await composioRequest("PATCH", `/api/v3.1/trigger_instances/manage/${encodeURIComponent(triggerId)}`, { body: { status } });
    return true;
  } catch (err) {
    const upstream = upstreamStatus(err);
    if (upstream === 404 || upstream === 410) return false;
    if (upstream === 409) return true; // already in that state
    throw err;
  }
}

function setError(row: RoutineRow, state: TriggerState, error: string): boolean {
  if (state.error === error) return false;
  patchTriggerState(row.id, { error });
  return true;
}

let syncRunning = false;
let syncAgain = false;
/** Bumped by stopAppTriggers: a sync that was already running must not start a listener afterwards. */
let generation = 0;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;

/** Bring Composio trigger instances and the realtime listener in line with the app automations. Never throws. */
export async function syncAppTriggers(): Promise<void> {
  if (syncRunning) {
    syncAgain = true;
    return;
  }
  syncRunning = true;
  try {
    do {
      syncAgain = false;
      await syncOnce();
    } while (syncAgain);
  } catch (err) {
    log.warn("app trigger sync failed", err);
  } finally {
    syncRunning = false;
  }
}

/** Sync soon (coalesces bursts of changes). */
export function requestAppTriggerSync(delayMs = 250): void {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncAppTriggers();
  }, delayMs);
  syncTimer.unref?.();
}

async function syncOnce() {
  const gen = generation;
  const rows = appRoutines();
  const configured = vault.hasAppSecret(COMPOSIO_API_KEY_SECRET);
  const unlocked = vault.isUnlocked();
  // Instances belong to the Composio project of the key they were created with.
  const keyFingerprint = configured && unlocked ? sha256(vault.getAppSecret(COMPOSIO_API_KEY_SECRET) ?? "").slice(0, 12) : null;
  const connections = connectionsById();
  const live = new Set<string>();
  const toDisable = new Set<string>();
  let changed = false;

  for (const row of rows) {
    const trigger = parseTrigger(row.trigger);
    if (trigger.type !== "app") continue;
    const state = parseJson<TriggerState>(row.trigger_state, {});
    const wanted = row.enabled === 1 && row.agent_enabled === 1;
    if (!configured) {
      changed = setError(row, state, NOT_CONFIGURED) || changed;
      continue;
    }
    if (!unlocked) {
      changed = setError(row, state, VAULT_LOCKED) || changed;
      continue;
    }
    // A watched account that is gone or out of reach stops delivering: its instance is switched off below.
    const unusable = (error: string) => {
      changed = setError(row, state, error) || changed;
      if (state.composioTriggerId && !state.remoteDisabled) toDisable.add(state.composioTriggerId);
    };
    const connection = connections.get(trigger.connectionId);
    if (!connection) {
      unusable("The connected account was removed — choose another one");
      continue;
    }
    // Checked when the automation was saved, but the agent may have moved to another workspace since.
    if (!accountInScope(connection, { id: row.agent_id, workspaceId: row.agent_workspace_id })) {
      unusable("The watched account isn't available to this agent anymore — choose another one");
      continue;
    }
    if (connection.status !== "ACTIVE") {
      unusable(`The ${connection.toolkit} connection is ${connection.status.toLowerCase()} — reconnect it in Settings → Integrations`);
      continue;
    }
    const signature = sha256(stable([keyFingerprint, trigger.triggerSlug, connection.connected_account_id, trigger.config])).slice(0, 32);
    if (!wanted) {
      if (state.composioTriggerId && !state.remoteDisabled) toDisable.add(state.composioTriggerId);
      continue;
    }
    const verified = state.composioVerifiedAt ? Date.now() - Date.parse(state.composioVerifiedAt) < VERIFY_INTERVAL_MS : false;
    if (state.composioTriggerId && state.composioSignature === signature && !state.remoteDisabled && !state.error && verified) {
      live.add(state.composioTriggerId);
      continue;
    }
    // A known, unchanged instance whose only error was the missing key or locked vault (resolved by now) is merely
    // re-checked: failing to reach Composio then doesn't take it offline.
    const staleError = state.error === NOT_CONFIGURED || state.error === VAULT_LOCKED;
    const recheck =
      !!state.composioTriggerId && state.composioSignature === signature && !state.remoteDisabled && (!state.error || staleError);
    try {
      // Upsert is idempotent: it returns the existing instance, or recreates one deleted on Composio's side. It
      // may belong to another automation that disabled it, so it is switched on explicitly.
      const triggerId = await upsertInstance(trigger.triggerSlug, connection, trigger.config);
      await setInstanceStatus(triggerId, "enable");
      const known = knownInstances();
      if (!known.has(triggerId)) {
        known.add(triggerId);
        saveInstances(known);
      }
      patchTriggerState(row.id, {
        composioTriggerId: triggerId,
        composioSignature: signature,
        composioVerifiedAt: new Date().toISOString(),
        remoteDisabled: null,
        error: null,
      });
      live.add(triggerId);
      changed = true;
    } catch (err) {
      const upstream = upstreamStatus(err);
      const transient = upstream === null || upstream === 429 || upstream >= 500;
      if (recheck && transient) {
        // Composio is unreachable for now (offline, rate limited, 5xx): the instance keeps working; retry next sync.
        log.info(`could not re-check trigger ${state.composioTriggerId}: ${err instanceof Error ? err.message : String(err)}`);
        live.add(state.composioTriggerId!);
        if (staleError) {
          patchTriggerState(row.id, { error: null });
          changed = true;
        }
      } else if (err instanceof HttpError && err.status === 423) {
        changed = setError(row, state, VAULT_LOCKED) || changed;
      } else {
        changed = setError(row, state, `Couldn't set up the app trigger: ${err instanceof Error ? err.message : String(err)}`) || changed;
      }
    }
  }

  if (configured && unlocked) {
    for (const triggerId of toDisable) {
      if (live.has(triggerId)) continue; // another automation still listens to the same instance
      try {
        const exists = await setInstanceStatus(triggerId, "disable");
        // Every automation sharing the instance must set it up again when it runs next.
        for (const other of rows) {
          if (parseJson<TriggerState>(other.trigger_state, {}).composioTriggerId !== triggerId) continue;
          patchTriggerState(other.id, exists ? { remoteDisabled: true } : { composioTriggerId: null, composioSignature: null, remoteDisabled: null });
        }
        changed = true;
      } catch (err) {
        log.warn(`could not disable trigger ${triggerId}`, err);
      }
    }
    await deleteOrphans();
  }

  if (changed) bus.changed("routines");
  if (gen !== generation) return; // stopped meanwhile
  if (listener && listenerKey !== keyFingerprint) stopListener();
  if (live.size > 0 && keyFingerprint) {
    if (!listener && !listenerStarting) await startListener(keyFingerprint);
  } else if (listener || listenerState.state !== "off") {
    stopListener();
  }
}

/** Delete instances Godmode created that no automation references anymore. */
async function deleteOrphans() {
  const known = knownInstances();
  if (!known.size) return;
  const referenced = new Set(
    all<{ id: string | null }>(
      "SELECT CASE WHEN json_valid(trigger_state) THEN json_extract(trigger_state, '$.composioTriggerId') END AS id FROM routines",
    )
      .map((r) => r.id)
      .filter(Boolean),
  );
  let dirty = false;
  for (const id of known) {
    if (referenced.has(id)) continue;
    try {
      await composioRequest("DELETE", `/api/v3.1/trigger_instances/manage/${encodeURIComponent(id)}`);
    } catch (err) {
      const upstream = upstreamStatus(err);
      if (upstream !== 404 && upstream !== 410 && upstream !== 400) {
        log.warn(`could not delete trigger ${id}`, err);
        continue;
      }
    }
    known.delete(id);
    dirty = true;
  }
  if (dirty) saveInstances(known);
}

async function projectOf(apiKey: string): Promise<string | null> {
  try {
    const creds = await composioRequest<{ project_id?: string }>("GET", REALTIME_CREDENTIALS_PATH, { apiKey, timeoutMs: RELEASE_TIMEOUT_MS });
    return creds?.project_id ?? null;
  } catch {
    return null;
  }
}

/**
 * The API key is about to change. A new key of the same project keeps every instance (the next sync re-upserts them
 * with it). For another project — or when that can't be told — the instances Godmode created are deleted with the old
 * key while it still works, and the next sync sets every app automation up again under the new key. Bounded in time:
 * setApiKey waits for it.
 */
export async function releaseTriggerInstances(oldApiKey: string, newApiKey: string | null): Promise<void> {
  const known = [...knownInstances()];
  if (!known.length) return;
  const [oldProject, newProject] = await Promise.all([projectOf(oldApiKey), newApiKey ? projectOf(newApiKey) : Promise.resolve(null)]);
  if (oldProject && oldProject === newProject) return;
  const leftBehind: string[] = [];
  await Promise.all(
    known.map(async (id) => {
      try {
        await composioRequest("DELETE", `/api/v3.1/trigger_instances/manage/${encodeURIComponent(id)}`, { apiKey: oldApiKey, timeoutMs: RELEASE_TIMEOUT_MS });
      } catch (err) {
        const upstream = upstreamStatus(err);
        if (upstream !== 404 && upstream !== 410) leftBehind.push(id);
      }
    }),
  );
  saveInstances(new Set());
  for (const row of appRoutines()) {
    patchTriggerState(row.id, { composioTriggerId: null, composioSignature: null, composioVerifiedAt: null, remoteDisabled: null });
  }
  stopListener();
  if (leftBehind.length) {
    log.warn(`could not delete trigger instances of the previous Composio key: ${leftBehind.join(", ")}`);
    notify(
      "warning",
      "App triggers of your previous Composio key remain",
      `Godmode couldn't remove ${leftBehind.length} app trigger(s) created with the previous key (${leftBehind.join(", ")}) — the key may have been revoked. If they belong to a project you still use, disable them in the Composio dashboard. Your automations are set up again with the new key.`,
      "/integrations",
    );
  }
}

function onBusEvent(event: ServerEvent) {
  if (event.type === "vault.status" || (event.type === "entity.changed" && event.entity === "composio")) requestAppTriggerSync(1000);
}

/** Start syncing app triggers (and listening when any automation needs it). */
export function startAppTriggers(): void {
  if (!unsubscribe) unsubscribe = bus.on(onBusEvent);
  if (!interval) {
    interval = setInterval(() => void syncAppTriggers(), SYNC_INTERVAL_MS);
    interval.unref?.();
  }
  requestAppTriggerSync(0);
}

export function stopAppTriggers(): void {
  generation++;
  unsubscribe?.();
  unsubscribe = null;
  if (interval) clearInterval(interval);
  interval = null;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  stopListener();
  typesCache.clear();
}

/** Current listener state (diagnostics, tests). */
export function appTriggerListenerState(): ListenerState {
  return { ...listenerState };
}
