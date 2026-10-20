/**
 * The runners this Godmode works with (owner: remote) — the controller's side of remote runners.
 *
 *  registry     the `runners` table: who was paired, where it listens, its pinned key
 *  connections  one RemoteLink per runner, started with the core; its events go into the mirror (mirror.ts)
 *  sync         before a chat starts on a runner — and whenever the setup changes while it is connected — the runner
 *               gets a copy of the setup (snapshot.ts), the agent's memory is merged both ways (memorySync.ts) and the
 *               chat's browser sessions are copied
 *  health       the runner's own checks, passed through, with a summary kept for the list
 *  autofix      a local chat whose agent may run commands on the runner to repair it
 *  updates      the runner's Godmode brought to this computer's, its tools to their newest (runnerUpdates.ts)
 */
import { createHash } from "node:crypto";
import {
  type ClientEvent,
  type Conversation,
  type ConversationFollowup,
  type ConversationWithMessages,
  type LogEntry,
  type RemoteRunner,
  type RunnerAutofixInput,
  type RunnerFixResult,
  type RunnerHealth,
  type RunnerHealthSummary,
  type RunnerInfo,
  type RunnerPairingOffer,
  type RunnerKind,
  type RunnerPatch,
  type RunnerUpdate,
  type Run,
  type StartChatInput,
  type StartChatResult,
  parseRunnerCode,
  parseRunnerView,
} from "@godmode/shared";
import { getAgent, getDefaultAgentId } from "../agents/service";
import type { CdpCookie } from "../browser/cdp";
import { exportProfileCookies, resolveProfileForAgent } from "../browser/manager";
import { all, deleteMeta, get, getMeta, insert, run as sql, setMeta, tx, update } from "../db";
import { projectOfChat } from "../services/projects";
import { bus } from "../events/bus";
import { logger } from "../log";
import { computerName } from "../mobile/devices";
import { audit } from "../services/audit";
import {
  type RunnerChatState,
  conversationExists,
  createConversation,
  emitConversationUpdated,
  getConversationSummary,
  sendMessage,
  transcriptPath,
} from "../services/conversations";
import { MIN_DELAY_MS as MIN_FOLLOWUP_DELAY_MS, scheduleFollowup } from "../services/followups";
import { notify } from "../services/notifications";
import { addWelcomeEvents, setRemoteViewHandlers } from "../server/ws";
import { HttpError, badRequest, newId, notFound, now, parseJson } from "../util";
import * as vault from "../vault/vault";
import { remoteRuns } from "./activeRuns";
import { browserSignIns, cookiesFor } from "./browserSessions";
import { canonicalKey, fingerprint } from "./crypto";
import { loadIdentity } from "./identity";
import { RemoteLink, type LinkState } from "./linkClient";
import { mergeMemory, readMemoryState, writeMemoryState } from "./memorySync";
import { parseHandover, writeSession, writeTranscript, type ChatHandover } from "./handover";
import { adoptChat, applyRunnerEvent, catchUp, chatMovedHere, forgetHeavyChats, reconcileConversation, runnerDisconnected, setMirrorHooks } from "./mirror";
import { cancelOffer, createOffer } from "./pairing";
import { forgetRunnerUpdates, maybeAutoUpdate, prepareRunnerUpdates, resetRunnerUpdates, runnerConnected, runnerUpdate, setUpdateHost, updateRunnerSoftware } from "./runnerUpdates";
import { buildSnapshot, snapshotDigest } from "./snapshot";
import { requireLicense } from "../license/license";
import { VERSION, BUILD } from "../config";
import { isPrimary, isSecondary, primaryRunnerId } from "./group";

const log = logger("runners");

/** Changes to these copy the setup to every connected runner (after a short pause, so a burst of edits is one sync). */
const SETUP_ENTITIES = new Set(["workspaces", "agents", "credentials", "totp", "mcp-servers", "api-tools", "composio", "browser-profiles", "ssh-servers", "vms", "settings"]);
const SYNC_DEBOUNCE_MS = 5_000;
const SYNC_TIMEOUT_MS = 5 * 60_000;
const MAX_ADDRESSES = 10;
/** Runners with auto-update are looked at this often besides their connects (one that had to wait for its chats). */
const AUTO_UPDATE_EVERY_MS = 15 * 60_000;
const ADDRESS = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$|^[0-9a-fA-F:]{2,45}$/;

export interface RunnerRow {
  id: string;
  name: string;
  hostname: string;
  public_key: string;
  addresses: string;
  port: number;
  platform: string | null;
  arch: string | null;
  version: string | null;
  sync_browser: number;
  auto_update: number;
  last_address: string | null;
  last_seen_at: string | null;
  synced_at: string | null;
  sync_digest: string | null;
  sync_error: string | null;
  created_at: string;
  updated_at: string;
  kind: RunnerKind;
}

/** What a device link is told about events and states (remote/devices.ts sets it). */
export interface DeviceLinkHooks {
  /** An event of this secondary's primary: the app here shows it. */
  primaryEvent(event: import("@godmode/shared").ServerEvent): void;
  /** The link to this secondary's primary came up or went down. */
  primaryState(state: LinkState): void;
  /** A device of the group connected or went away (on either side). */
  deviceState(id: string, state: LinkState): void;
  /** A device went away while these chats worked there (told before the copies forget what worked). */
  deviceLost(id: string, conversationIds: string[]): void;
}

let deviceHooks: DeviceLinkHooks | null = null;

export function setDeviceLinkHooks(h: DeviceLinkHooks | null): void {
  deviceHooks = h;
}

/**
 * The link from a secondary to its primary only carries the app's requests and the primary's events: the secondary
 * neither mirrors the primary's chats nor copies its own setup there.
 */
function toPrimary(r: Pick<RunnerRow, "id" | "kind">): boolean {
  return r.kind === "device" && isSecondary() && r.id === primaryRunnerId();
}

/** The setup goes from the primary to the other computers of its group, and from any Godmode to its own runners. */
function maySendSetup(r: Pick<RunnerRow, "kind">): boolean {
  return r.kind !== "device" || isPrimary();
}

const DEVICE_UPDATE = (r: RunnerRow): RunnerUpdate => ({
  state: "current",
  target: { version: r.version ?? VERSION, build: BUILD },
  source: null,
  progress: null,
  detail: "Godmode keeps itself up to date on each computer of the group.",
  autoUpdate: false,
  tools: [],
  command: null,
});

const links = new Map<string, RemoteLink>();
/** What each runner said about itself at its last connect (or after a sync). */
const infos = new Map<string, RunnerInfo>();
const healths = new Map<string, RunnerHealth>();
const syncing = new Set<string>();
/** Syncs of one runner run one after another. */
const chains = new Map<string, Promise<unknown>>();
/** Live view subscriptions this computer holds on each runner, re-sent after a reconnect. */
const subscriptions = new Map<string, Map<string, ClientEvent>>();
const digestCache = new Map<RunnerKind, string>();
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let forceNextSync = false;
let offBus: (() => void) | null = null;
let started = false;
let autoUpdateTimer: ReturnType<typeof setInterval> | null = null;

/* ------------------------------------------------------------------ */
/* Registry                                                             */
/* ------------------------------------------------------------------ */

export function runnerRow(id: string): RunnerRow | null {
  return row(id);
}

function row(id: string): RunnerRow | null {
  return get<RunnerRow>("SELECT * FROM runners WHERE id = ?", id);
}

function requireRow(id: string): RunnerRow {
  const r = row(id);
  if (!r) throw notFound("Runner");
  return r;
}

/** The setup's digest as a runner (or a device) would report it after a sync; cached until the setup changes. */
function currentDigest(kind: RunnerKind = "runner"): string {
  let digest = digestCache.get(kind);
  if (!digest) digestCache.set(kind, (digest = snapshotDigest({ device: kind === "device" })));
  return digest;
}

function summary(health: RunnerHealth): RunnerHealthSummary {
  return {
    ok: health.ok,
    failing: health.checks.filter((c) => c.required && c.status === "fail").length,
    warnings: health.checks.filter((c) => c.status === "warn" || (!c.required && c.status === "fail")).length,
    checkedAt: health.checkedAt,
  };
}

function toRunner(r: RunnerRow): RemoteRunner {
  const state: LinkState = links.get(r.id)?.state ?? { state: "offline", error: null, address: null, info: null, latencyMs: null };
  let digest: string | null = null;
  try {
    digest = currentDigest(r.kind);
  } catch (err) {
    log.warn("could not compute the setup digest", err);
  }
  const synced = !!r.sync_digest && r.sync_digest === digest;
  const health = healths.get(r.id);
  return {
    id: r.id,
    name: r.name,
    hostname: r.hostname,
    platform: r.platform,
    arch: r.arch,
    version: r.version,
    build: infos.get(r.id)?.build ?? null,
    addresses: parseJson<string[]>(r.addresses, []),
    port: r.port,
    fingerprint: fingerprint(r.public_key),
    state: state.state,
    error: state.error,
    address: state.address,
    latencyMs: state.latencyMs,
    lastSeenAt: r.last_seen_at,
    pairedAt: r.created_at,
    sync: {
      state: syncing.has(r.id) ? "syncing" : synced ? "synced" : r.sync_error ? "failed" : "pending",
      syncedAt: r.synced_at,
      error: synced ? null : r.sync_error,
    },
    health: health ? summary(health) : null,
    activeRuns: remoteRuns(r.id).filter((x) => x.status !== "paused").length,
    conversations: get<{ c: number }>("SELECT COUNT(*) AS c FROM conversations WHERE runner_id = ?", r.id)?.c ?? 0,
    syncBrowser: r.sync_browser === 1,
    update: r.kind === "device" ? DEVICE_UPDATE(r) : runnerUpdate(r, state.state),
    kind: r.kind === "device" ? "device" : "runner",
  };
}

function emit(id: string) {
  const r = row(id);
  if (r) bus.emit({ type: "runner.updated", runner: toRunner(r) });
}

export function listRunners(): RemoteRunner[] {
  return all<RunnerRow>("SELECT * FROM runners ORDER BY created_at").map(toRunner);
}

export function getRunner(id: string): RemoteRunner {
  return toRunner(requireRow(id));
}

/** The runner a chat works on (null for a chat of this computer). */
export function runnerOfConversation(conversationId: string): string | null {
  return get<{ runner_id: string | null }>("SELECT runner_id FROM conversations WHERE id = ?", conversationId)?.runner_id ?? null;
}

export function link(id: string): RemoteLink {
  requireRow(id);
  const l = links.get(id);
  if (!l) throw new HttpError(409, "This runner isn't connected yet.", "runner_offline");
  return l;
}

function cleanAddresses(list: string[]): string[] {
  const out = [...new Set(list.map((a) => a.trim()).filter(Boolean))];
  if (!out.length) throw badRequest("Give at least one address");
  if (out.length > MAX_ADDRESSES) throw badRequest(`At most ${MAX_ADDRESSES} addresses`);
  for (const a of out) if (a.length > 253 || !ADDRESS.test(a)) throw badRequest(`"${a}" isn't a host name or IP address`);
  return out;
}

export function updateRunner(id: string, patch: RunnerPatch): RemoteRunner {
  const r = requireRow(id);
  const name = patch.name === undefined ? undefined : patch.name.trim().slice(0, 80);
  if (name !== undefined && !name) throw badRequest("Give the runner a name");
  const addresses = patch.addresses === undefined ? undefined : cleanAddresses(patch.addresses);
  if (patch.port !== undefined && !(Number.isInteger(patch.port) && patch.port >= 1 && patch.port <= 65535)) throw badRequest("The port is a number between 1 and 65535");
  update("runners", id, {
    name,
    addresses: addresses ? JSON.stringify(addresses) : undefined,
    port: patch.port,
    sync_browser: patch.syncBrowser === undefined ? undefined : patch.syncBrowser ? 1 : 0,
    auto_update: patch.autoUpdate === undefined ? undefined : patch.autoUpdate ? 1 : 0,
    updated_at: now(),
  });
  links.get(id)?.update({ ...(addresses ? { addresses } : {}), ...(patch.port ? { port: patch.port } : {}), ...(name ? { name } : {}) });
  audit("user", "runner.update", id, { name: name ?? r.name });
  emit(id);
  if (patch.autoUpdate) void maybeAutoUpdate(id);
  return getRunner(id);
}

/** Bring the runner's Godmode to this computer's and (with `tools`) its tools to their newest versions. */
export async function updateRunnerNow(id: string, opts: { tools?: boolean } = {}): Promise<RemoteRunner> {
  requireRow(id);
  await updateRunnerSoftware(id, opts);
  return getRunner(id);
}

/**
 * Unpair a runner. It is told to forget this computer when it can be reached; its chats stay here as ordinary chats of
 * this computer (with what they had), runs that were working there end.
 */
export async function removeRunner(id: string): Promise<void> {
  const r = requireRow(id);
  const l = links.get(id);
  if (l?.state.state === "online") await l.json("POST", "/api/link/forget", undefined, { timeoutMs: 5_000 }).catch(() => undefined);
  l?.stop();
  links.delete(id);
  infos.delete(id);
  healths.delete(id);
  subscriptions.delete(id);
  forgetRunnerUpdates(id);
  runnerDisconnected(id);
  const ts = now();
  const chats = all<{ id: string }>("SELECT id FROM conversations WHERE runner_id = ?", id).map((c) => c.id);
  if (r.kind === "device") {
    // A computer that leaves the group keeps its chats: the copies here go, and come back should it join again.
    tx(() => {
      sql("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE runner_id = ?)", id);
      sql("DELETE FROM conversations WHERE runner_id = ?", id);
    });
  } else {
    sql(
      "UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE status IN ('queued', 'running', 'paused') AND conversation_id IN (SELECT id FROM conversations WHERE runner_id = ?)",
      `${r.name} was removed`,
      ts,
      id,
    );
    // What servers and VMs a released chat may use is the runner's word: this computer's copy starts without any.
    sql("UPDATE conversations SET runner_id = NULL, runner_state = NULL, ssh_server_ids = '[]', android_device_ids = '[]', vm_id = NULL WHERE runner_id = ?", id);
  }
  sql("UPDATE conversations SET runner_tools_id = NULL WHERE runner_tools_id = ?", id);
  sql("DELETE FROM runners WHERE id = ?", id);
  for (const key of all<{ key: string }>("SELECT key FROM meta WHERE key LIKE ?", `link.cookies.${id}.%`)) sql("DELETE FROM meta WHERE key = ?", key.key);
  deleteMeta(releaseKey(id));
  audit("user", r.kind === "device" ? "device.remove" : "runner.remove", id, { name: r.name });
  for (const chat of chats) {
    if (r.kind === "device") bus.emit({ type: "conversation.deleted", id: chat });
    else emitConversationUpdated(chat);
  }
  bus.emit({ type: "runner.deleted", id });
  bus.changed("runners");
  bus.changed("runs");
}

/* ------------------------------------------------------------------ */
/* Pairing                                                              */
/* ------------------------------------------------------------------ */

/**
 * Pair with a runner from its pairing code (pasted, or delivered by `godmode runner install --pair`). `via`: the
 * address the code was delivered from, dialed first (it proved to reach this computer, e.g. over Tailscale).
 */
export async function pairWithCode(
  text: string,
  via: string | null = null,
  opts: { kind?: RunnerKind; /** Called with the row's id before its link starts. */ prepared?: (id: string) => void } = {},
): Promise<RemoteRunner> {
  const kind = opts.kind ?? "runner";
  const code = parseRunnerCode(text);
  if (!code) throw badRequest("That isn't a runner's pairing code. It starts with gmr1.");
  let key: string;
  try {
    key = canonicalKey(code.key);
  } catch {
    throw badRequest("That pairing code is damaged. Copy it again.");
  }
  if (via && code.addresses.includes(via)) code.addresses = [via, ...code.addresses.filter((a) => a !== via)];
  const { info, address } = await RemoteLink.pair({ identity: loadIdentity(), code, name: computerName() });
  const addresses = [...new Set([address, ...code.addresses])].slice(0, MAX_ADDRESSES);
  const ts = now();
  const existing = get<{ id: string }>("SELECT id FROM runners WHERE public_key = ?", key);
  let id: string;
  if (existing) {
    id = existing.id;
    update("runners", id, { addresses: JSON.stringify(addresses), port: code.port, hostname: code.hostname, platform: info.platform, arch: info.arch, version: info.version, kind, updated_at: ts });
    links.get(id)?.stop();
    links.delete(id);
  } else {
    id = newId("rnr");
    insert("runners", {
      id,
      name: code.name.trim().slice(0, 80) || code.hostname || "Runner",
      hostname: code.hostname,
      public_key: key,
      addresses: JSON.stringify(addresses),
      port: code.port,
      platform: info.platform,
      arch: info.arch,
      version: info.version,
      sync_browser: 1,
      kind,
      last_address: address,
      last_seen_at: ts,
      created_at: ts,
      updated_at: ts,
    });
  }
  infos.set(id, info);
  const runner = requireRow(id);
  audit("user", kind === "device" ? "device.pair" : "runner.pair", id, { name: runner.name, address });
  if (kind === "runner") notify("success", `${runner.name} is connected`, "Give it a chat with “Run on” in the message box. Godmode copies your setup there first.", "/runners");
  opts.prepared?.(id);
  if (started) startLink(runner);
  const model = getRunner(id);
  bus.emit({ type: "runner.paired", runner: model });
  bus.emit({ type: "runner.updated", runner: model });
  bus.changed("runners");
  return model;
}

/** Show an install command that pairs the runner by itself. */
export function createPairing(): Promise<RunnerPairingOffer> {
  return createOffer(async (code, from) => ({ name: (await pairWithCode(code, from)).name }));
}

export function cancelPairing(): void {
  cancelOffer();
}

/* ------------------------------------------------------------------ */
/* Connections                                                          */
/* ------------------------------------------------------------------ */

function startLink(r: RunnerRow) {
  if (links.has(r.id)) return;
  const id = r.id;
  let wasOnline = false;
  const l = new RemoteLink({
    identity: loadIdentity(),
    runnerKey: r.public_key,
    addresses: parseJson<string[]>(r.addresses, []),
    port: r.port,
    name: r.name,
    ownName: computerName(),
    onEvent: (event) => {
      if (toPrimary(r)) deviceHooks?.primaryEvent(event);
      else applyRunnerEvent(id, event);
    },
    onState: (state) => {
      if (r.kind === "device") deviceHooks?.deviceState(id, state);
      if (toPrimary(r)) deviceHooks?.primaryState(state);
      const online = state.state === "online";
      if (online && !wasOnline) void connected(id, state);
      if (!online && wasOnline) {
        if (r.kind === "device") deviceHooks?.deviceLost(id, [...new Set(remoteRuns(id).map((x) => x.conversationId))]);
        runnerDisconnected(id);
        update("runners", id, { last_seen_at: now() });
        bus.changed("runs");
      }
      wasOnline = online;
      emit(id);
    },
  });
  links.set(id, l);
  l.start();
}

/** Just connected: catch up on what happened there, bring its setup up to date, look at its health. */
async function connected(id: string, state: LinkState) {
  const info = state.info;
  if (info) {
    const before = infos.get(id);
    if (!before || before.build !== info.build || before.digest !== info.digest) forgetHeavyChats(id);
    infos.set(id, info);
    update("runners", id, {
      last_seen_at: now(),
      last_address: state.address,
      version: info.version,
      platform: info.platform,
      arch: info.arch,
      sync_digest: info.configDigest,
      updated_at: now(),
    });
  }
  const l = links.get(id);
  if (!l) return;
  // The link dropped on the way: the next connect starts over, the steps left would only fail as offline.
  const dropped = () => links.get(id) !== l || l.state.state !== "online";
  // What changed in a run, not its whole block list each time: a long run's list is tens of megabytes.
  l.sendClientEvent({ type: "deltas.patch" });
  for (const event of subscriptions.get(id)?.values() ?? []) l.sendClientEvent(event);
  const r = row(id);
  if (!r || toPrimary(r)) return;
  await releaseChats(id);
  const catchUpNow = async () => {
    try {
      await catchUp(id, l);
    } catch (err) {
      if (!dropped()) log.warn(`could not catch up with runner ${id}`, err);
    }
  };
  const syncNow = async () => {
    try {
      await syncRunner(id);
    } catch (err) {
      if (!dropped()) log.warn(`could not copy the setup to runner ${id}`, err instanceof Error ? err.message : err);
    }
  };
  // A computer that just joined the group knows this setup's agents only after the copy: its chats come after it.
  if (r.kind === "device") {
    await syncNow();
    if (!dropped()) await catchUpNow();
  } else {
    await catchUpNow();
    if (!dropped()) await syncNow();
  }
  if (dropped()) return;
  // Another computer of the group is a full Godmode: the runner checks and updates are not for it.
  if (r.kind === "device") return;
  try {
    await runnerHealth(id, false);
  } catch (err) {
    if (dropped()) return;
    log.warn(`could not check runner ${id}`, err instanceof Error ? err.message : err);
  }
  if (dropped()) return;
  await runnerConnected(id).catch((err) => log.warn(`could not look at the updates of runner ${id}`, err instanceof Error ? err.message : err));
}

let hubWired = false;

/** Live views and the welcome of a new UI connection know about runners from here on. */
function wireHub() {
  if (hubWired) return;
  hubWired = true;
  setRemoteViewHandlers({
    browser: (ref, subscribed, passive) => {
      if (!started || !ref.conversationId) return false;
      let runnerId: string | null = null;
      try {
        runnerId = runnerOfConversation(ref.conversationId);
      } catch (err) {
        log.warn("could not look up a chat's runner for its live view", err);
      }
      if (!runnerId) return false;
      const target = { profileId: ref.profileId, conversationId: ref.conversationId };
      remoteSubscription(runnerId, `browser:${ref.profileId}:${ref.conversationId}`, subscribed ? { type: "browser.subscribe", ...target, passive } : null, {
        type: "browser.unsubscribe",
        ...target,
      });
      return true;
    },
    computer: (view, subscribed) => {
      const remote = parseRunnerView(view);
      if (!remote) return;
      remoteSubscription(remote.runnerId, `computer:${remote.view}`, subscribed ? { type: "computer.subscribe", view: remote.view } : null, {
        type: "computer.unsubscribe",
        view: remote.view,
      });
    },
  });
  // A UI that connects learns what runs on runners are doing, like it does for this computer's runs.
  addWelcomeEvents(() =>
    started ? remoteRuns().flatMap((r) => (r.label ? [{ type: "run.activity" as const, runId: r.runId, agentId: r.agentId, label: r.label }] : [])) : [],
  );
}

export function startRunners(): void {
  if (started) return;
  started = true;
  wireHub();
  setUpdateHost({
    row: (id) => {
      const r = row(id);
      return r && r.kind !== "device" ? r : null;
    },
    link: (id) => links.get(id) ?? null,
    info: (id) => infos.get(id),
    setInfo: (id, info) => {
      infos.set(id, info);
      emit(id);
    },
    activeRuns: (id) => remoteRuns(id).filter((x) => x.status !== "paused").length,
    emit,
  });
  // Until this program's digest is known every runner looks current: tell the UI (and auto-update) once it is.
  void prepareRunnerUpdates().then(() => {
    for (const id of links.keys()) {
      emit(id);
      void maybeAutoUpdate(id);
    }
  });
  autoUpdateTimer = setInterval(() => {
    for (const id of links.keys()) void maybeAutoUpdate(id);
    // Chats that moved here and that a runner couldn't drop yet.
    for (const id of links.keys()) void releaseChats(id);
  }, AUTO_UPDATE_EVERY_MS);
  autoUpdateTimer.unref?.();
  for (const r of all<RunnerRow>("SELECT * FROM runners")) startLink(r);
  setMirrorHooks({
    runFinished: (runnerId, run) => {
      void syncRunner(runnerId, { agentId: run.agentId }).catch((err) => log.warn(`could not merge memory after run ${run.id}`, err instanceof Error ? err.message : err));
    },
    resync: (runnerId, runId) => links.get(runnerId)?.sendClientEvent({ type: "run.resync", runId }),
    released: (runnerId, conversationId) => pendingReleases(runnerId).includes(conversationId),
  });
  offBus = bus.on((event) => {
    if (event.type === "entity.changed" && SETUP_ENTITIES.has(event.entity)) scheduleSync(false);
    // An agent's own edits come as these (its status too: the digest tells a real change from that).
    else if (event.type === "agent.updated" || event.type === "agent.deleted") scheduleSync(false);
    else if (event.type === "vault.status" && event.status.unlocked) scheduleSync(true);
  });
}

export function stopRunners(): void {
  started = false;
  offBus?.();
  offBus = null;
  if (autoUpdateTimer) clearInterval(autoUpdateTimer);
  autoUpdateTimer = null;
  resetRunnerUpdates();
  setUpdateHost(null);
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  for (const l of links.values()) l.stop();
  links.clear();
  cancelOffer();
}

/** Try to connect now instead of at the next retry. */
export function connectRunner(id: string): RemoteRunner {
  const r = requireRow(id);
  const l = links.get(id);
  if (l) l.reconnect();
  else if (started) startLink(r);
  return getRunner(id);
}

/** The setup changed: copy it to every connected runner once the edits settle. The vault key needs a forced sync (it isn't in the digest). */
function scheduleSync(force: boolean) {
  digestCache.clear();
  forceNextSync ||= force;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const forced = forceNextSync;
    forceNextSync = false;
    for (const [id, l] of links) {
      const r = row(id);
      if (!r || !maySendSetup(r)) continue;
      if (l.state.state !== "online") {
        emit(id);
        continue;
      }
      void syncRunner(id, { force: forced }).catch((err) => log.warn(`could not copy the setup to runner ${id}`, err instanceof Error ? err.message : err));
    }
  }, SYNC_DEBOUNCE_MS);
  syncTimer.unref?.();
}

/** Live views of a runner's chat or screen: what this computer's viewers subscribe to goes over the link (server/ws.ts). */
export function remoteSubscription(runnerId: string, key: string, subscribe: ClientEvent | null, unsubscribe: ClientEvent): void {
  let subs = subscriptions.get(runnerId);
  if (!subs) subscriptions.set(runnerId, (subs = new Map()));
  if (subscribe) subs.set(key, subscribe);
  else subs.delete(key);
  links.get(runnerId)?.sendClientEvent(subscribe ?? unsubscribe);
}

/* ------------------------------------------------------------------ */
/* Sync                                                                 */
/* ------------------------------------------------------------------ */

function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(id) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  chains.set(
    id,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error:\s*/, "") : String(err);
}

/**
 * Bring a runner up to date: the setup when it differs (or `force`), then — for a chat that starts — the agent's memory
 * and the browser sessions of the profile it uses. Returns what was done; a failed setup copy throws.
 */
export function syncRunner(id: string, opts: { agentId?: string; profileId?: string | null; force?: boolean } = {}): Promise<{ config: boolean; memory: boolean; cookies: boolean; warnings: string[] }> {
  return serialized(id, async () => {
    const l = link(id);
    l.assertOnline();
    const r = requireRow(id);
    const warnings: string[] = [];
    let config = false;
    let memory = false;
    let cookies = false;

    const digest = currentDigest(r.kind);
    const info = infos.get(id);
    // The digest leaves the vault key out: a runner whose vault is still locked while this one's is open gets it now.
    const needsKey = vault.isUnlocked() && !!info && !info.vault.unlocked;
    if (maySendSetup(r) && (opts.force || needsKey || r.sync_digest !== digest)) {
      syncing.add(id);
      emit(id);
      try {
        const result = await l.json<{ digest: string; warnings: string[] }>("POST", "/api/link/sync", buildSnapshot({ device: r.kind === "device" }), { timeoutMs: SYNC_TIMEOUT_MS });
        for (const w of result.warnings ?? []) log.warn(`${r.name}: ${w}`);
        const complete = result.digest === digest;
        update("runners", id, {
          sync_digest: result.digest,
          synced_at: now(),
          sync_error: complete ? null : (result.warnings?.[0] ?? "Part of your setup couldn't be copied yet. Godmode tries again."),
          updated_at: now(),
        });
        config = true;
        try {
          infos.set(id, await l.json<RunnerInfo>("GET", "/api/link/info"));
        } catch {
          /* the next connect tells */
        }
      } catch (err) {
        update("runners", id, { sync_error: `Couldn't copy your setup: ${message(err)}`, updated_at: now() });
        throw new HttpError(502, `Couldn't copy your setup to ${r.name}: ${message(err)}`, "runner_sync_failed");
      } finally {
        syncing.delete(id);
        emit(id);
      }
    }

    if (opts.agentId) {
      try {
        memory = await exchangeMemory(id, l, r.name, opts.agentId);
      } catch (err) {
        warnings.push(`Couldn't merge the agent's memory with ${r.name}: ${message(err)}`);
      }
    }
    if (opts.profileId && r.sync_browser === 1) {
      try {
        cookies = await copyCookies(r, l, opts.profileId);
      } catch (err) {
        warnings.push(`Couldn't copy the browser sessions to ${r.name}: ${message(err)}`);
      }
    }
    for (const w of warnings) log.warn(w);
    return { config, memory, cookies, warnings };
  });
}

/** Three-way merge of an agent's memory files with the runner's; both sides end up with the same files. */
async function exchangeMemory(runnerId: string, l: RemoteLink, name: string, agentId: string): Promise<boolean> {
  const remote = await l.json<{ digest: string; snapshot: Parameters<typeof mergeMemory>[2] }>("GET", `/api/link/agents/${encodeURIComponent(agentId)}/memory`);
  const local = readMemoryState(agentId);
  const baseRow = get<{ digest: string; snapshot: string }>("SELECT digest, snapshot FROM runner_memory WHERE runner_id = ? AND agent_id = ?", runnerId, agentId);
  const store = (digest: string, snapshot: unknown) =>
    sql(
      "INSERT INTO runner_memory (runner_id, agent_id, digest, snapshot, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(runner_id, agent_id) DO UPDATE SET digest = excluded.digest, snapshot = excluded.snapshot, updated_at = excluded.updated_at",
      runnerId,
      agentId,
      digest,
      JSON.stringify(snapshot),
      now(),
    );
  if (remote.digest === local.digest) {
    if (baseRow?.digest !== local.digest) store(local.digest, local.snapshot);
    return false;
  }
  const base = baseRow ? parseJson<Parameters<typeof mergeMemory>[0]>(baseRow.snapshot, null) : null;
  const { merged, changedLocal, changedRemote } = mergeMemory(base, local.snapshot, remote.snapshot);
  let digest = local.digest;
  if (changedLocal) digest = (await writeMemoryState(agentId, merged, `Memory from ${name}`)).digest;
  if (changedRemote) digest = (await l.json<{ digest: string }>("PUT", `/api/link/agents/${encodeURIComponent(agentId)}/memory`, { snapshot: merged })).digest;
  store(digest, merged);
  return changedLocal || changedRemote;
}

/**
 * The sessions (cookies) of a browser profile that go to this runner or device (browserSessions.ts), copied when they
 * changed since the last copy there. `read`: tests.
 */
export async function copyCookies(
  target: { id: string; kind: RunnerKind },
  l: Pick<RemoteLink, "json">,
  profileId: string,
  read: (profileId: string) => Promise<CdpCookie[]> = exportProfileCookies,
): Promise<boolean> {
  const policy = browserSignIns();
  // Each device signs in by itself: its profile's browser isn't even started for this.
  if (target.kind === "device" && policy === "own") return false;
  const { cookies, mode } = cookiesFor(target.kind, policy, await read(profileId));
  if (!cookies.length) return false;
  const digest = createHash("sha256")
    .update(JSON.stringify([mode, ...cookies.map((c) => [c.domain, c.path, c.name, c.value, c.expires]).sort()]))
    .digest("hex");
  const key = `link.cookies.${target.id}.${profileId}`;
  if (getMeta(key) === digest) return false;
  await l.json("POST", `/api/link/browser/${encodeURIComponent(profileId)}/cookies`, { cookies, mode }, { timeoutMs: SYNC_TIMEOUT_MS });
  setMeta(key, digest);
  return true;
}

/* ------------------------------------------------------------------ */
/* Health                                                               */
/* ------------------------------------------------------------------ */

export async function runnerHealth(id: string, refresh: boolean): Promise<RunnerHealth> {
  const health = await link(id).json<RunnerHealth>("GET", `/api/link/health${refresh ? "?refresh=1" : ""}`, undefined, { timeoutMs: 180_000 });
  healths.set(id, health);
  emit(id);
  return health;
}

/** Fix one check. `sync` is done from here (copy the setup again); everything else on the runner. */
export async function fixRunner(id: string, checkId: string): Promise<RunnerFixResult> {
  const r = requireRow(id);
  const known = healths.get(id) ?? (await runnerHealth(id, false));
  const check = known.checks.find((c) => c.id === checkId);
  if (check?.fix?.kind === "sync") {
    try {
      await syncRunner(id, { force: true });
      const health = await runnerHealth(id, true);
      return { ok: true, output: `Copied your setup to ${r.name}.`, health };
    } catch (err) {
      return { ok: false, output: message(err), health: await runnerHealth(id, true).catch(() => known) };
    }
  }
  const result = await link(id).json<RunnerFixResult>("POST", "/api/link/health/fix", { id: checkId }, { timeoutMs: 20 * 60_000 });
  healths.set(id, result.health);
  audit("user", "runner.fix", id, { check: checkId, ok: result.ok });
  emit(id);
  return result;
}

/* ------------------------------------------------------------------ */
/* Chats                                                                */
/* ------------------------------------------------------------------ */

/**
 * Start a chat on a runner: copy what the work needs, start it there, and keep a copy here. Folders, shared screens and
 * VMs of this computer don't exist there, so they are left out.
 */
export async function startRemoteChat(runnerId: string, input: StartChatInput): Promise<StartChatResult> {
  // The runner doesn't check licences: the computer it works for does, before anything goes there.
  requireLicense();
  const l = link(runnerId);
  l.assertOnline();
  const agentId = input.agentId || getDefaultAgentId();
  if (!agentId) throw badRequest("No agent given and no default agent exists");
  const agent = getAgent(agentId);
  let profileId: string | null = input.browserProfileId ?? null;
  if (!profileId && agent.browser.enabled) {
    try {
      // The chat doesn't exist here yet: the project it starts in decides like a chat's would.
      const project = input.projectId ? projectOfChat(null, { workspaceId: agent.workspaceId, projectId: input.projectId }) : null;
      const forProject = !agent.browser.profileId && project?.browserProfileId && get("SELECT 1 FROM browser_profiles WHERE id = ?", project.browserProfileId);
      profileId = forProject ? project!.browserProfileId : resolveProfileForAgent(agent, null).id;
    } catch {
      profileId = null;
    }
  }
  await syncRunner(runnerId, { agentId, profileId });
  const { runnerId: _runner, workingDirectory, computerTarget, vmId, androidDeviceIds, ...rest } = input;
  // Another computer of the group is where the app that asked runs: its folders, screen, VMs and phones are named there.
  const own = row(runnerId)?.kind === "device" ? { workingDirectory, computerTarget, vmId, androidDeviceIds } : {};
  const result = await l.json<StartChatResult>("POST", "/api/chat", { ...rest, ...own, agentId }, { timeoutMs: 120_000 });
  const conversation = adoptChat(runnerId, result);
  return { ...result, conversation };
}

/** Before a message goes to a runner's chat: the runner gets the current setup, memory and sessions. */
export async function prepareRemoteMessage(conversationId: string): Promise<void> {
  const runnerId = runnerOfConversation(conversationId);
  if (!runnerId) return;
  const conv = getConversationSummary(conversationId);
  let profileId: string | null = conv.browserProfileId;
  if (!profileId) {
    try {
      const agent = getAgent(conv.agentId);
      if (agent.browser.enabled) profileId = resolveProfileForAgent(agent, conversationId).id;
    } catch {
      profileId = null;
    }
  }
  await syncRunner(runnerId, { agentId: conv.agentId, profileId });
}

/* ------------------------------------------------------------------ */
/* Moving a chat here                                                   */
/* ------------------------------------------------------------------ */

function releaseKey(runnerId: string): string {
  return `link.release.${runnerId}`;
}

function pendingReleases(runnerId: string): string[] {
  const ids = parseJson<unknown>(getMeta(releaseKey(runnerId)), []);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The runner drops its copy of the chats that moved to this computer. What it can't drop now is tried again after its
 * next connect and every 15 minutes. Never throws.
 */
async function releaseChats(runnerId: string): Promise<void> {
  const wanted = pendingReleases(runnerId);
  if (!wanted.length) return;
  const l = links.get(runnerId);
  const done = new Set<string>();
  if (l?.state.state === "online") {
    for (const id of wanted) {
      try {
        await l.json("DELETE", `/api/conversations/${encodeURIComponent(id)}`, undefined, { timeoutMs: 30_000 });
        done.add(id);
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) done.add(id);
        else log.info(`runner ${runnerId} didn't drop moved chat ${id} yet`, { error: message(err) });
      }
    }
  }
  const left = pendingReleases(runnerId).filter((id) => !done.has(id));
  if (left.length) setMeta(releaseKey(runnerId), JSON.stringify(left));
  else deleteMeta(releaseKey(runnerId));
}

function offline(err: unknown): boolean {
  return err instanceof HttpError && err.code === "runner_offline";
}

/** Chats on their way here: nothing new starts in them on the runner meanwhile (routing.ts). */
const moving = new Set<string>();

export function chatIsMoving(conversationId: string): boolean {
  return moving.has(conversationId);
}

function busyOnRunner(r: RunnerRow): HttpError {
  return new HttpError(409, `${r.name} is still working on this chat. Stop the run or let it finish, then move it.`, "runner_chat_busy");
}

/**
 * While the runner is there: bring the copy up to date, refuse while a run works or stands still there, and get what
 * the chat takes along. Null when the runner is away, or no longer has the chat. Nothing is changed when it fails.
 */
async function handoverFrom(r: RunnerRow, conversationId: string): Promise<ChatHandover | null> {
  const l = links.get(r.id);
  if (l?.state.state !== "online") return null;
  const path = encodeURIComponent(conversationId);
  const gone = (err: unknown) => err instanceof HttpError && err.status === 404;
  try {
    let remote: ConversationWithMessages;
    try {
      remote = await l.json<ConversationWithMessages>("GET", `/api/conversations/${path}`);
    } catch (err) {
      if (gone(err)) return null;
      throw err;
    }
    const runs = await l.json<Run[]>("GET", `/api/runs?conversationId=${path}&limit=500`).catch(() => undefined);
    const chat = reconcileConversation(r.id, remote, runs);
    if (chat.activeRunId || chat.running || chat.paused) throw busyOnRunner(r);
    // A runner from before moving chats has no handover: the next turn here starts a new session with a recap.
    return await l.json<unknown>("GET", `/api/link/conversations/${path}/handover`, undefined, { timeoutMs: 120_000 }).then(parseHandover, (err) => {
      if (gone(err)) return null;
      throw err;
    });
  } catch (err) {
    if (offline(err)) throw new HttpError(409, `${r.name} went away while the chat was moving. Nothing changed — try again.`, "runner_offline");
    if (err instanceof HttpError && err.code === "runner_chat_busy") throw err;
    throw new HttpError(502, `Couldn't copy the chat from ${r.name}: ${message(err)}. Nothing changed — try again.`, "runner_handover_failed");
  }
}

/** A follow-up the runner had for the chat continues here; one that came due meanwhile runs a minute later. */
function keepFollowup(conversationId: string, agentId: string, followup: ConversationFollowup): void {
  try {
    const due = Math.max(Date.parse(followup.dueAt), Date.now() + MIN_FOLLOWUP_DELAY_MS + 5_000);
    const note = followup.note.trim() || "Continue where you left off.";
    scheduleFollowup({ conversationId, agentId, dueAt: new Date(due), note });
  } catch (err) {
    log.info(`the follow-up of chat ${conversationId} didn't move along`, { error: message(err) });
  }
}

/**
 * Move a chat from its runner to this computer. It keeps its messages, runs and settings; its Claude session and
 * transcript come along, so the agent resumes with the whole conversation. The runner drops its copy — now, or after
 * its next connect when it is away. While a run works or stands still there, the chat stays.
 */
export async function moveChatHere(conversationId: string): Promise<Conversation> {
  const runnerId = runnerOfConversation(conversationId);
  if (!runnerId) {
    if (!conversationExists(conversationId)) throw notFound("Conversation");
    throw new HttpError(409, "This chat already works on this computer.", "not_on_runner");
  }
  if (moving.has(conversationId)) throw new HttpError(409, "This chat is already moving to this computer.", "runner_chat_moving");
  const r = requireRow(runnerId);
  moving.add(conversationId);
  try {
    const handover = await handoverFrom(r, conversationId);
    const conv = get<{ agent_id: string; runner_id: string | null; runner_state: string | null }>(
      "SELECT agent_id, runner_id, runner_state FROM conversations WHERE id = ?",
      conversationId,
    );
    if (!conv || conv.runner_id !== runnerId) throw notFound("Conversation");
    // Something started there while the chat was being copied (a follow-up on the runner).
    if (links.get(runnerId)?.state.state === "online" && remoteRuns(runnerId).some((x) => x.conversationId === conversationId)) throw busyOnRunner(r);
    const agent = getAgent(conv.agent_id);
    const session = !!handover?.sessionId && !!handover.session && writeSession(agent.workingDirectory ?? agent.repoPath, handover.sessionId, handover.session);
    if (handover?.transcript) writeTranscript(transcriptPath(agent, conversationId), handover.transcript);

    const followup = parseJson<Partial<RunnerChatState> | null>(conv.runner_state, null)?.followup ?? null;
    const ts = now();
    const ended = tx(() => {
      const changes = sql(
        "UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE conversation_id = ? AND status IN ('queued', 'running', 'paused')",
        `Ended: the chat moved from ${r.name} to this computer`,
        ts,
        conversationId,
      ).changes;
      // What servers and VMs a chat may use was the runner's word: here it starts without any, as after removing a runner.
      sql(
        `UPDATE conversations SET runner_id = NULL, runner_state = NULL, ssh_server_ids = '[]', android_device_ids = '[]', vm_id = NULL,
           claude_session_id = COALESCE(?, claude_session_id), updated_at = ? WHERE id = ?`,
        session ? handover!.sessionId : null,
        ts,
        conversationId,
      );
      const pending = new Set([...pendingReleases(runnerId), conversationId]);
      setMeta(releaseKey(runnerId), JSON.stringify([...pending]));
      return changes;
    });
    chatMovedHere(runnerId, conversationId);
    if (followup) keepFollowup(conversationId, conv.agent_id, followup);
    audit("user", "runner.chat.move", conversationId, { runner: r.name, session, transcript: !!handover?.transcript });
    log.info("moved a chat from a runner to this computer", { conversationId, runnerId, session });
    emitConversationUpdated(conversationId);
    emit(runnerId);
    if (ended) bus.changed("runs");
    void releaseChats(runnerId);
    return getConversationSummary(conversationId);
  } finally {
    moving.delete(conversationId);
  }
}

function describeHealth(health: RunnerHealth): string {
  return health.checks
    .map((c) => `- [${c.status}] ${c.name} (${c.id}, ${c.group}${c.required ? ", required" : ""}): ${c.detail}${c.fix ? ` — fix: ${c.fix.kind}${c.fix.hint ? ` (${c.fix.hint})` : ""}` : ""}`)
    .join("\n");
}

/**
 * A chat on this computer whose agent may run commands on the runner (runner_exec, runner_health, runner_fix): it gets
 * the runner's health report and the end of its log, and is asked to find and fix what's wrong.
 */
export async function startAutofix(runnerId: string, input: RunnerAutofixInput): Promise<StartChatResult> {
  const r = requireRow(runnerId);
  const l = link(runnerId);
  l.assertOnline();
  const health = await runnerHealth(runnerId, true);
  let logTail = "";
  try {
    const res = await l.json<{ stdout: string }>("POST", "/api/link/exec", { command: "tail -n 80 logs/godmode.jsonl", timeoutMs: 15_000 });
    logTail = res.stdout.slice(-15_000);
  } catch {
    logTail = "(the log couldn't be read)";
  }
  const agentId = getDefaultAgentId();
  if (!agentId) throw badRequest("No default agent exists");
  const focus = input.checkId ? health.checks.find((c) => c.id === input.checkId) : null;
  const prompt = [
    `Please get the runner "${r.name}" (${r.platform ?? "unknown OS"}, Godmode ${r.version ?? "?"}) into working order.`,
    focus ? `Start with the check "${focus.name}" (${focus.id}): ${focus.detail}` : "Fix everything that fails below.",
    input.note?.trim() ? `What I noticed: ${input.note.trim()}` : "",
    "",
    "You can run commands on the runner with `runner_exec` (a login shell in the runner's data folder; its log is logs/godmode.jsonl), look at its checks with `runner_health` and use the one-click fixes with `runner_fix`. Look before you change anything, change one thing at a time, and check again with `runner_health` after each fix.",
    "Some things only I can do on the runner itself — granting a macOS permission, signing in to Claude Code or GitHub, logging in on its screen. When you get to one of those, tell me exactly what to click or type and where, then check again once I say it's done.",
    "",
    "Health report:",
    describeHealth(health),
    "",
    "End of the runner's log:",
    "```",
    logTail || "(empty)",
    "```",
  ]
    .filter((line, i, lines) => line !== "" || lines[i - 1] !== "")
    .join("\n");
  const conversation = createConversation({ agentId, title: `Fix ${r.name}`.slice(0, 200), origin: "chat" });
  sql("UPDATE conversations SET runner_tools_id = ? WHERE id = ?", runnerId, conversation.id);
  try {
    const result = await sendMessage(conversation.id, { content: prompt, trigger: "chat" });
    return { ...result, conversation: getConversationSummary(conversation.id) };
  } catch (err) {
    sql("DELETE FROM conversations WHERE id = ?", conversation.id);
    bus.emit({ type: "conversation.deleted", id: conversation.id });
    throw err;
  }
}

/**
 * What a fix in Godmode's code needs from a runner: its diagnostic log (the overview and the report for an AI) and its
 * health checks. Asks the runner's own API over the link, so it works with every runner that has Settings → Logs.
 */
export async function runnerDiagnostics(runnerId: string): Promise<{ runner: RemoteRunner; entries: LogEntry[]; report: string; health: string | null }> {
  const l = link(runnerId);
  l.assertOnline();
  const [entries, res, health] = await Promise.all([
    l.json<LogEntry[]>("GET", "/api/logs/entries?level=warn&limit=2000", undefined, { timeoutMs: 60_000 }),
    l.request("GET", "/api/logs/report", { timeoutMs: 120_000 }),
    runnerHealth(runnerId, false).catch(() => null),
  ]);
  if (res.status < 200 || res.status >= 300) throw new HttpError(502, `${requireRow(runnerId).name} couldn't put its log together (${res.status}).`, "runner_log");
  return { runner: getRunner(runnerId), entries, report: Buffer.from(res.body).toString("utf8"), health: health ? describeHealth(health) : null };
}

/** For the autofix chat's tools: a command on the runner. */
export async function runnerExec(runnerId: string, command: string, timeoutSec?: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return link(runnerId).json("POST", "/api/link/exec", { command, ...(timeoutSec ? { timeoutMs: Math.min(timeoutSec, 900) * 1000 } : {}) }, { timeoutMs: 16 * 60_000 });
}
