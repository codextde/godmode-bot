/**
 * Device groups (owner: remote): several full Godmode apps on different computers that work as one.
 *
 * The primary holds what is shared and runs the schedules; each secondary pairs with it both ways, like a runner and its
 * controller at once:
 *
 *   secondary → primary   the secondary's app shows the primary's Godmode: its requests go there (deviceRouting.ts)
 *                         and the primary's events come back to its windows (server/ws.ts)
 *   primary → secondary   the primary copies its setup there, mirrors the chats that work there and forwards what
 *                         concerns them — exactly what it does for a runner (runners.ts, mirror.ts, routing.ts)
 *
 * Each chat lives on one computer. A chat moves between them with its Claude session (`moveChat`), also while it works:
 * the run stops, the chat moves, and the agent continues on the other computer. The primary does every move, so
 * secondaries ask it (their requests are forwarded).
 */
import type { Hono } from "hono";
import type { WebSocketHandler } from "bun";
import {
  encodeDeviceInvite,
  encodeRunnerCode,
  parseDeviceInvite,
  type Conversation,
  type DeviceGroup,
  type DeviceInvite,
  type GroupDevice,
  type HandoffResult,
  type MessageBlock,
  type Message,
  type MoveChatInput,
  type Run,
  type ServerEvent,
} from "@godmode/shared";
import { getAgent } from "../agents/service";
import { VERSION } from "../config";
import { all, deleteMeta, get, getMeta, run as sql, setMeta } from "../db";
import { bus } from "../events/bus";
import { logger } from "../log";
import { computerName } from "../mobile/devices";
import { activeRunForConversation, cancelRun, listActiveRuns, waitForRun } from "../runner/runner";
import { setForwarding, welcomeAll, type WsData } from "../server/ws";
import { audit } from "../services/audit";
import {
  type RunnerChatState,
  addMessage,
  conversationExists,
  emitConversationUpdated,
  getConversation,
  getConversationSummary,
  getMessage,
  sendMessage,
  setRemoteSender,
  transcriptPath,
} from "../services/conversations";
import { setRemoteAnswerer } from "../services/questions";
import { getRun } from "../runner/runner";
import { cancelFollowup, getFollowup, MIN_DELAY_MS as MIN_FOLLOWUP_DELAY_MS, scheduleFollowup } from "../services/followups";
import { clearQueue, listQueue } from "../services/messageQueue";
import { notify } from "../services/notifications";
import { pauseOf } from "../services/pauses";
import { HttpError, badRequest, now, parseJson, sleep } from "../util";
import { remoteRuns } from "./activeRuns";
import { canonicalKey } from "./crypto";
import { readHandover, writeSession, writeTranscript } from "./handover";
import { loadIdentity } from "./identity";
import { forgetController, linkServerPort, startLinkServer, stopLinkServer } from "./linkServer";
import { adoptChat, importChat } from "./mirror";
import { createRunnerCode } from "./pairing";
import { clearGroup, forwarding, groupRole, isPrimary, isSecondary, onGroupChange, primaryOnline, primaryRunnerId, setGroup, setPrimaryUp } from "./group";
import {
  getRunner,
  link,
  listRunners,
  remoteSubscription,
  moveChatHere,
  pairWithCode,
  prepareRemoteMessage,
  removeRunner,
  runnerOfConversation,
  runnerRow,
  setDeviceLinkHooks,
} from "./runners";
import type { LinkState } from "./linkClient";

const log = logger("devices");

const SELF_META = "link.group.self";
const DEFAULT_RUN_META = "link.group.defaultRunOn";
const FAILOVER_META = "link.group.failover";
const FAILOVER_MINUTES_META = "link.group.failoverMinutes";
const FAILOVER_DEFAULT_MINUTES = 3;
const ONLINE_WAIT_MS = 20_000;
const STOP_WAIT_MS = 45_000;

interface LinkHandler {
  app: Hono;
  websocket: WebSocketHandler<WsData>;
}

let handler: LinkHandler | null = null;
let forwardEvent: ((event: ServerEvent) => void) | null = null;
let groupTimer: ReturnType<typeof setTimeout> | null = null;
let offGroup: (() => void) | null = null;
let primaryError: string | null = null;
/** Devices that went away while chats worked there: their work continues here when they aren't back in time. */
const failovers = new Map<string, { timer: ReturnType<typeof setTimeout>; conversations: string[] }>();

/* ------------------------------------------------------------------ */
/* Start and stop                                                       */
/* ------------------------------------------------------------------ */

/**
 * `deliver`: hands one of the primary's events to this computer's windows (server/ws.ts). Listens for the other
 * computers of the group once there is one.
 */
export function startDevices(h: LinkHandler, deliver: (event: ServerEvent) => void): void {
  handler = h;
  forwardEvent = deliver;
  setDeviceLinkHooks({
    primaryEvent: (event) => {
      // The primary's view of the group is its own: this computer tells its windows about it itself.
      if (event.type === "devices.updated") return;
      if (event.type === "runner.updated" || event.type === "runner.deleted" || event.type === "runner.paired") emitGroupSoon();
      forwardEvent?.(event);
    },
    primaryState: (state) => {
      primaryError = state.state === "online" ? null : state.error;
      setPrimaryUp(state.state === "online");
      emitGroupSoon();
    },
    deviceState: (id, state) => {
      if (state.state === "online") cancelFailover(id);
      emitGroupSoon();
    },
    deviceLost: (id, conversations) => scheduleFailover(id, conversations),
  });
  let wasForwarding = forwarding();
  offGroup = onGroupChange(() => {
    emitGroupSoon();
    // The windows show the other Godmode now: they start over with what works there.
    if (forwarding() !== wasForwarding) {
      wasForwarding = forwarding();
      welcomeAll();
    }
  });
  setForwarding({
    active: forwarding,
    localBrowser: (ref) => !ref.conversationId || !!get<{ id: string }>("SELECT id FROM conversations WHERE id = ? AND runner_id IS NULL", ref.conversationId),
    browser: (ref, subscribed, passive) => {
      const pid = primaryRunnerId();
      if (!pid || !ref.conversationId) return;
      const target = { profileId: ref.profileId, conversationId: ref.conversationId };
      remoteSubscription(pid, `browser:${ref.profileId}:${ref.conversationId}`, subscribed ? { type: "browser.subscribe", ...target, passive } : null, { type: "browser.unsubscribe", ...target });
    },
    computer: (view, subscribed) => {
      const pid = primaryRunnerId();
      if (pid) remoteSubscription(pid, `computer:${view}`, subscribed ? { type: "computer.subscribe", view } : null, { type: "computer.unsubscribe", view });
    },
    send: (event) => {
      const pid = primaryRunnerId();
      try {
        if (pid) link(pid).sendClientEvent(event);
      } catch {
        /* the primary went away meanwhile */
      }
    },
    welcome: () => primaryLink().json<{ activeRunIds: string[]; events: ServerEvent[] }>("GET", "/api/link/devices/welcome", undefined, { timeoutMs: 15_000 }),
  });
  setRemoteSender(async (conversationId, owner, input) => {
    const result = await sendThere(conversationId, owner, input);
    return { message: getMessage(result.message.id), run: getRun(result.run.id) };
  });
  setRemoteAnswerer((owner, questionId, input) => {
    void (async () => {
      try {
        await link(owner).json("POST", `/api/questions/${encodeURIComponent(questionId)}/answer`, input, { timeoutMs: 60_000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`the answer to question ${questionId} didn't reach the computer it was asked on`, msg);
        notify("error", "Your answer didn't arrive", `${deviceName(owner)} couldn't take it: ${msg}. Answer again once it's back.`, "/inbox");
      }
    })();
  });
  if (groupRole()) listen();
}

export function stopDevices(): void {
  for (const id of [...failovers.keys()]) cancelFailover(id);
  setDeviceLinkHooks(null);
  setForwarding(null);
  setRemoteSender(null);
  setRemoteAnswerer(null);
  offGroup?.();
  offGroup = null;
  if (groupTimer) clearTimeout(groupTimer);
  groupTimer = null;
  handler = null;
  forwardEvent = null;
}

/** The other computers of the group reach this one at its link port. */
function listen(): number {
  if (!handler) throw new HttpError(503, "Godmode is still starting. Try again in a moment.", "not_ready");
  const port = startLinkServer(handler);
  if (port === null) throw new HttpError(500, "This computer couldn't listen for the other computers. Another program may use the port.", "link_listen_failed");
  return port;
}

/** Windows learn about the group a moment after it changed (a burst of changes is one event). */
function emitGroupSoon(): void {
  if (groupTimer) return;
  groupTimer = setTimeout(() => {
    groupTimer = null;
    void deviceGroup().then(
      (group) => bus.emit({ type: "devices.updated", group }),
      (err) => log.warn("could not describe the device group", err instanceof Error ? err.message : err),
    );
  }, 250);
  groupTimer.unref?.();
}

/* ------------------------------------------------------------------ */
/* The group                                                            */
/* ------------------------------------------------------------------ */

function primaryName(): string {
  const id = primaryRunnerId();
  try {
    return id ? getRunner(id).name : "The primary";
  } catch {
    return "The primary";
  }
}

/** The link to this secondary's primary, or a clear refusal while it can't be reached. */
export function primaryLink() {
  const id = primaryRunnerId();
  if (!isSecondary() || !id) throw new HttpError(409, "This computer isn't a secondary of a device group.", "not_secondary");
  try {
    const l = link(id);
    l.assertOnline();
    return l;
  } catch {
    throw new HttpError(409, `${primaryName()} (your primary) is offline. This works again once it's back.`, "primary_offline");
  }
}

/** The group as the primary sees it: itself first, then every other computer. Also what secondaries ask for. */
/** What a secondary's Settings → Devices shows of the group (GET /api/link/devices/list). */
export function groupForSecondary(): { devices: GroupDevice[]; failover: boolean; failoverMinutes: number } {
  return { devices: primaryView(), ...failoverSettings() };
}

export function primaryView(): GroupDevice[] {
  const self: GroupDevice = {
    id: null,
    name: computerName(),
    role: "primary",
    self: true,
    state: "online",
    platform: process.platform,
    version: VERSION,
    lastSeenAt: now(),
    latencyMs: null,
    activeRuns: listActiveRuns().length,
    conversations: get<{ c: number }>("SELECT COUNT(*) AS c FROM conversations WHERE runner_id IS NULL")?.c ?? 0,
  };
  const others = listRunners()
    .filter((r) => r.kind === "device")
    .map(
      (r): GroupDevice => ({
        id: r.id,
        name: r.name,
        role: "secondary",
        self: false,
        state: r.state,
        platform: r.platform,
        version: r.version,
        lastSeenAt: r.lastSeenAt,
        latencyMs: r.latencyMs,
        activeRuns: r.activeRuns,
        conversations: r.conversations,
      }),
    );
  return [self, ...others];
}

export async function deviceGroup(): Promise<DeviceGroup> {
  const role = groupRole();
  const defaultRunOn = getMeta(DEFAULT_RUN_META);
  const base = { port: linkServerPort(), defaultRunOn: role ? defaultRunOn : null, ...failoverSettings() };
  if (!role) return { ...base, role: null, primaryName: null, primaryOnline: false, primaryError: null, selfId: null, devices: [] };
  if (role === "primary") {
    return { ...base, role, primaryName: computerName(), primaryOnline: true, primaryError: null, selfId: null, devices: primaryView() };
  }
  const selfId = getMeta(SELF_META);
  let devices: GroupDevice[] | null = null;
  if (forwarding()) {
    try {
      const remote = await primaryLink().json<{ devices: GroupDevice[]; failover: boolean; failoverMinutes: number }>("GET", "/api/link/devices/list", undefined, { timeoutMs: 10_000 });
      // The primary is called what this computer calls it (its row here can be renamed).
      devices = remote.devices.map((d) => ({ ...d, self: d.id !== null && d.id === selfId, ...(d.id === null ? { name: primaryName() } : {}) }));
      Object.assign(base, { failover: remote.failover, failoverMinutes: remote.failoverMinutes });
    } catch (err) {
      log.info("could not ask the primary for the group", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!devices) {
    const pid = primaryRunnerId();
    const primary = pid ? runnerRow(pid) : null;
    const state = pid ? safeRunner(pid) : null;
    devices = [
      {
        id: null,
        name: primary?.name ?? "Primary",
        role: "primary",
        self: false,
        state: state?.state ?? "offline",
        platform: primary?.platform ?? null,
        version: primary?.version ?? null,
        lastSeenAt: primary?.last_seen_at ?? null,
        latencyMs: state?.latencyMs ?? null,
        activeRuns: state?.activeRuns ?? 0,
        conversations: 0,
      },
      {
        id: selfId,
        name: computerName(),
        role: "secondary",
        self: true,
        state: "online",
        platform: process.platform,
        version: VERSION,
        lastSeenAt: now(),
        latencyMs: null,
        activeRuns: listActiveRuns().length,
        conversations: get<{ c: number }>("SELECT COUNT(*) AS c FROM conversations WHERE runner_id IS NULL")?.c ?? 0,
      },
    ];
  }
  return { ...base, role, primaryName: primaryName(), primaryOnline: primaryOnline(), primaryError: primaryOnline() ? null : primaryError, selfId, devices };
}

/* ------------------------------------------------------------------ */
/* Fail-over                                                            */
/* ------------------------------------------------------------------ */

function failoverSettings(): { failover: boolean; failoverMinutes: number } {
  const minutes = Number(getMeta(FAILOVER_MINUTES_META));
  return {
    failover: getMeta(FAILOVER_META) !== "0",
    failoverMinutes: Number.isFinite(minutes) && minutes >= 1 && minutes <= 120 ? minutes : FAILOVER_DEFAULT_MINUTES,
  };
}

export function setFailover(input: { failover?: boolean; failoverMinutes?: number }): void {
  if (input.failover !== undefined) setMeta(FAILOVER_META, input.failover ? "1" : "0");
  if (input.failoverMinutes !== undefined) {
    if (!Number.isInteger(input.failoverMinutes) || input.failoverMinutes < 1 || input.failoverMinutes > 120) throw badRequest("Give 1 to 120 minutes");
    setMeta(FAILOVER_MINUTES_META, String(input.failoverMinutes));
  }
  emitGroupSoon();
}

function cancelFailover(id: string): void {
  const f = failovers.get(id);
  if (!f) return;
  clearTimeout(f.timer);
  failovers.delete(id);
}

/** On the primary: a computer went away while chats worked there (its lid closed, its network dropped). */
function scheduleFailover(id: string, conversations: string[]): void {
  const settings = failoverSettings();
  if (!isPrimary() || !settings.failover || !conversations.length) return;
  cancelFailover(id);
  // GODMODE_FAILOVER_MS: tests don't wait minutes.
  const wait = Number(process.env.GODMODE_FAILOVER_MS) || settings.failoverMinutes * 60_000;
  const timer = setTimeout(() => void failover(id, conversations), wait);
  timer.unref?.();
  failovers.set(id, { timer, conversations });
  log.info("a device with working chats went away; its work continues here if it isn't back in time", { id, chats: conversations.length, minutes: settings.failoverMinutes });
}

/**
 * Its work continues here: each chat that still lives there moves to this computer and the agent picks up from a recap
 * (the Claude session stayed on the computer that went away). When that computer comes back it drops its copies.
 */
async function failover(id: string, conversations: string[]): Promise<void> {
  failovers.delete(id);
  const row = runnerRow(id);
  const moved: string[] = [];
  for (const conversationId of conversations) {
    if (runnerOfConversation(conversationId) !== id) continue;
    try {
      await moveChat(conversationId, { to: null, force: true });
      moved.push(conversationId);
    } catch (err) {
      log.warn(`could not continue chat ${conversationId} here`, err instanceof Error ? err.message : err);
    }
  }
  if (moved.length) {
    audit("system", "device.failover", id, { name: row?.name ?? null, chats: moved.length });
    notify(
      "info",
      `${row?.name ?? "A computer"} went away — its work continues here`,
      `${moved.length === 1 ? "1 chat" : `${moved.length} chats`} moved to ${computerName()}. Hand work off before the lid closes to keep the whole session.`,
      moved.length === 1 ? `/chat/${moved[0]}` : "/settings/devices",
    );
  }
}

function safeRunner(id: string) {
  try {
    return getRunner(id);
  } catch {
    return null;
  }
}

/** Where new chats from this computer run unless picked otherwise (a device of the group, or null = here). */
export function setDefaultRunOn(id: string | null): void {
  if (id === null) deleteMeta(DEFAULT_RUN_META);
  else {
    if (!groupRole()) throw badRequest("This computer isn't part of a device group.");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw badRequest("Unknown device");
    setMeta(DEFAULT_RUN_META, id);
  }
  emitGroupSoon();
}

/* ------------------------------------------------------------------ */
/* Invites, joining and leaving                                         */
/* ------------------------------------------------------------------ */

/** An invite another computer pastes to join. A secondary hands out its primary's: everyone joins the primary. */
export async function createInvite(): Promise<DeviceInvite> {
  if (isSecondary()) return primaryLink().json<DeviceInvite>("POST", "/api/link/devices/invite", undefined, { timeoutMs: 30_000 });
  return makeInvite();
}

/** On the primary (or a computer that becomes one with its first member). */
export async function makeInvite(): Promise<DeviceInvite> {
  listen();
  const { payload } = await createRunnerCode();
  return {
    code: encodeDeviceInvite(payload),
    primaryName: payload.name,
    addresses: payload.addresses,
    port: payload.port,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

async function waitOnline(id: string, timeoutMs = ONLINE_WAIT_MS) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const l = link(id);
      if (l.state.state === "online") return l;
      if (Date.now() > end) throw new HttpError(504, l.state.error ?? "The other computer didn't answer.", "device_unreachable");
    } catch (err) {
      if (err instanceof HttpError && err.code === "device_unreachable") throw err;
      if (Date.now() > end) throw err;
    }
    await sleep(100);
  }
}

/**
 * Join the group of the computer whose invite this is. This computer becomes a secondary: it pairs with the primary,
 * gives the primary its own code so it can pair back, and from then on shows the primary's Godmode. Its setup is
 * replaced by the primary's; its chats stay and show up on every computer of the group.
 */
export async function joinGroup(text: string): Promise<DeviceGroup> {
  const code = parseDeviceInvite(text);
  if (!code) throw badRequest("That isn't an invite to a device group. It starts with gmd1.");
  if (code.exp * 1000 < Date.now()) throw badRequest("This invite has expired. Make a new one on the other computer.");
  if (groupRole()) throw new HttpError(409, "This computer is already part of a device group. Leave it first.", "already_in_group");
  let key: string;
  try {
    key = canonicalKey(code.key);
  } catch {
    throw badRequest("This invite is damaged. Copy it again.");
  }
  if (key === loadIdentity().publicKey) throw badRequest("That's this computer's own invite. Paste it in Godmode on the other computer.");
  listen();
  let primaryId: string | null = null;
  try {
    const primary = await pairWithCode(encodeRunnerCode(code), null, {
      kind: "device",
      prepared: (id) => {
        primaryId = id;
        setGroup("secondary", id);
      },
    });
    const l = await waitOnline(primary.id);
    const own = await createRunnerCode();
    const answer = await l.json<{ selfId: string; primaryName: string }>("POST", "/api/link/devices/join", { code: own.code }, { timeoutMs: 120_000 });
    setMeta(SELF_META, answer.selfId);
    audit("user", "device.join", primary.id, { primary: primary.name });
    log.info("joined a device group", { primary: primary.name });
    notify("success", `This computer is part of ${primary.name}'s group`, "Chats, agents, the board and automations are shared now. Chats can run on either computer.", "/settings/devices");
    emitGroupSoon();
    return await deviceGroup();
  } catch (err) {
    if (primaryId) await removeRunner(primaryId).catch(() => undefined);
    forgetPeerKey(key);
    clearGroup();
    deleteMeta(SELF_META);
    throw err instanceof HttpError ? err : new HttpError(502, `Couldn't join: ${err instanceof Error ? err.message : String(err)}`, "join_failed");
  }
}

/** On the primary: a computer that paired with this one's invite asks to be paired back. */
export async function acceptJoin(code: string): Promise<{ selfId: string; primaryName: string }> {
  if (isSecondary()) throw new HttpError(409, "This computer is a secondary. Use an invite from the primary.", "not_primary");
  const wasAlone = !groupRole();
  if (wasAlone) setGroup("primary");
  try {
    const device = await pairWithCode(code, null, { kind: "device" });
    audit("controller", "device.accept", device.id, { name: device.name });
    notify("success", `${device.name} joined your device group`, "Its chats show up here, and new chats can run on it with “Run on”.", "/settings/devices");
    emitGroupSoon();
    return { selfId: device.id, primaryName: computerName() };
  } catch (err) {
    if (wasAlone && !listRunners().some((r) => r.kind === "device")) clearGroup();
    throw err;
  }
}

/** A peer's pairing on this side: its runner row and the controller entry with its key. */
function forgetPeerKey(publicKey: string): void {
  for (const c of all<{ id: string; public_key: string }>("SELECT id, public_key FROM link_controllers")) {
    try {
      if (canonicalKey(c.public_key) === publicKey) forgetController(c.id);
    } catch {
      /* a damaged row never matches */
    }
  }
}

function deviceRows() {
  return all<{ id: string; public_key: string; name: string }>("SELECT id, public_key, name FROM runners WHERE kind = 'device'");
}

/** Back to a Godmode of its own: no more forwarding, the shared services start here again (index.ts listens). */
function becomeAlone(): void {
  clearGroup();
  deleteMeta(SELF_META);
  deleteMeta(DEFAULT_RUN_META);
  if (!all("SELECT id FROM link_controllers").length) stopLinkServer();
}

/**
 * Leave the group. A secondary tells its primary and becomes a Godmode of its own again (with the copy of the setup it
 * has, and its own chats). The primary dissolves the group: every other computer leaves.
 */
export async function leaveGroup(): Promise<DeviceGroup> {
  const role = groupRole();
  if (!role) return deviceGroup();
  if (role === "secondary") {
    const pid = primaryRunnerId();
    const row = pid ? runnerRow(pid) : null;
    if (pid && primaryOnline()) {
      await primaryLink()
        .json("POST", "/api/link/devices/leave", undefined, { timeoutMs: 30_000 })
        .catch((err) => log.warn("the primary didn't hear that this computer leaves", err instanceof Error ? err.message : err));
    }
    if (pid) await removeRunner(pid).catch((err) => log.warn("could not remove the primary", err instanceof Error ? err.message : err));
    if (row) forgetPeerKey(row.public_key);
    audit("user", "device.leave", pid, { primary: row?.name ?? null });
  } else {
    for (const d of deviceRows()) await removeDevice(d.id).catch((err) => log.warn(`could not remove ${d.name}`, err instanceof Error ? err.message : err));
    audit("user", "device.dissolve", null);
  }
  becomeAlone();
  emitGroupSoon();
  return deviceGroup();
}

/** On the primary: a computer leaves the group (it is told when it can be reached). */
export async function removeDevice(id: string): Promise<DeviceGroup> {
  if (isSecondary()) return primaryLink().json<DeviceGroup>("DELETE", `/api/devices/${encodeURIComponent(id)}`);
  const row = runnerRow(id);
  if (!row || row.kind !== "device") throw new HttpError(404, "Device not found", "not_found");
  try {
    const l = link(id);
    if (l.state.state === "online") await l.json("POST", "/api/link/devices/leave", undefined, { timeoutMs: 15_000 });
  } catch (err) {
    log.info(`${row.name} didn't hear that it leaves the group`, { error: err instanceof Error ? err.message : String(err) });
  }
  await removeRunner(id);
  forgetPeerKey(row.public_key);
  if (!deviceRows().length) becomeAlone();
  emitGroupSoon();
  return deviceGroup();
}

/**
 * Over the link: the computer at the other end leaves the group, or removes this one from it. Answered first; the
 * pairing goes right after, since forgetting it closes the link the answer travels on.
 */
export function peerLeft(controllerId: string): void {
  const controller = get<{ public_key: string }>("SELECT public_key FROM link_controllers WHERE id = ?", controllerId);
  if (!controller) return;
  const key = canonicalKey(controller.public_key);
  const row = deviceRows().find((r) => {
    try {
      return canonicalKey(r.public_key) === key;
    } catch {
      return false;
    }
  });
  setTimeout(() => {
    void (async () => {
      if (row) await removeRunner(row.id).catch((err) => log.warn("could not remove the device that left", err instanceof Error ? err.message : err));
      forgetController(controllerId);
      if (isSecondary() ? row?.id === primaryRunnerId() || !primaryRunnerId() : !deviceRows().length) becomeAlone();
      if (row) notify("info", isPrimary() || !groupRole() ? `${row.name} left the device group` : `${row.name} removed this computer from its group`, "", "/settings/devices");
      emitGroupSoon();
    })();
  }, 50);
}

/** Over the link: the id the calling computer has in this primary's list. */
export function deviceIdOf(controllerId: string): string | null {
  const controller = get<{ public_key: string }>("SELECT public_key FROM link_controllers WHERE id = ?", controllerId);
  if (!controller) return null;
  const key = canonicalKey(controller.public_key);
  return deviceRows().find((r) => canonicalKey(r.public_key) === key)?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* Moving chats                                                         */
/* ------------------------------------------------------------------ */

function deviceName(id: string | null): string {
  if (id === null) return isSecondary() ? primaryName() : computerName();
  try {
    return getRunner(id).name;
  } catch {
    return "another computer";
  }
}

/** A run works or stands still in the chat, where it lives. */
function busy(conversationId: string, owner: string | null): boolean {
  if (owner === null) return !!activeRunForConversation(conversationId) || !!pauseOf(conversationId);
  const state = parseJson<Partial<RunnerChatState> | null>(get<{ runner_state: string | null }>("SELECT runner_state FROM conversations WHERE id = ?", conversationId)?.runner_state, null);
  return remoteRuns(owner).some((r) => r.conversationId === conversationId) || !!state?.running || !!state?.paused;
}

/** Stop what works in the chat (and a run that stands still), and wait until it ended. */
async function stopWork(conversationId: string, owner: string | null, to: string): Promise<void> {
  const reason = `Stopped: the chat moves to ${to}`;
  if (owner === null) {
    const active = activeRunForConversation(conversationId);
    if (active) {
      await cancelRun(active, reason, { byHuman: true });
      await waitForRun(active, STOP_WAIT_MS).catch(() => undefined);
    }
    const paused = pauseOf(conversationId);
    if (paused) await cancelRun(paused.run_id, reason, { byHuman: true });
    return;
  }
  let l: ReturnType<typeof link>;
  try {
    l = link(owner);
    l.assertOnline();
  } catch {
    // Away: what it still does there ends when it drops its copy after the move.
    return;
  }
  const state = parseJson<Partial<RunnerChatState> | null>(get<{ runner_state: string | null }>("SELECT runner_state FROM conversations WHERE id = ?", conversationId)?.runner_state, null);
  const runIds = new Set(remoteRuns(owner).filter((r) => r.conversationId === conversationId).map((r) => r.runId));
  if (state?.paused?.runId) runIds.add(state.paused.runId);
  for (const runId of runIds) {
    // A computer from before device groups only knows the plain stop.
    await l.json("POST", `/api/link/runs/${encodeURIComponent(runId)}/stop`, { reason }).catch(() => l.json("POST", `/api/runs/${encodeURIComponent(runId)}/cancel`, {}).catch(() => undefined));
  }
  const end = Date.now() + STOP_WAIT_MS;
  while (busy(conversationId, owner) && Date.now() < end && l.state.state === "online") await sleep(250);
}

function marker(from: string, to: string, continued: boolean): MessageBlock[] {
  return [{ type: "moved", from, to, at: now(), continued }];
}

function continuePrompt(from: string, to: string, queued: string[]): string {
  return [
    `This chat just moved from the computer "${from}" to "${to}" (both run the same Godmode), so your last turn stopped where it was.`,
    "Continue where you left off. Files you made outside your repository on the other computer may not be here; check before you rely on them.",
    ...(queued.length ? ["", "Messages that were waiting for you:", ...queued.map((q) => `- ${q}`)] : []),
  ].join("\n");
}

/** Push a chat of this computer to another computer of the group: it continues there with its session and transcript. */
async function pushChat(conversationId: string, targetId: string, extra: MessageBlock[] | null): Promise<void> {
  const target = runnerRow(targetId);
  if (!target) throw new HttpError(404, "Device not found", "not_found");
  const l = link(targetId);
  l.assertOnline();
  const conv = getConversation(conversationId);
  await prepareRemoteMessage(conversationId).catch(() => undefined);
  const { messages, activeRunId: _active, queue: _queue, ...summary } = conv as typeof conv & { activeRunId?: unknown; queue?: unknown };
  const runs = all<Record<string, unknown>>(
    `SELECT id, agent_id AS agentId, conversation_id AS conversationId, parent_run_id AS parentRunId, trigger, status, prompt, result, error,
            cost_usd AS costUsd, duration_ms AS durationMs, num_turns AS numTurns, usage, model, started_at AS startedAt,
            finished_at AS finishedAt, created_at AS createdAt
       FROM runs WHERE conversation_id = ? ORDER BY created_at`,
    conversationId,
  ).map((r) => ({ ...r, usage: parseJson(r.usage as string | null, null) }));
  const followup = getFollowup(conversationId);
  const moved = extra ? [...messages, { ...addMessage({ conversationId, role: "system", content: "", blocks: extra }, { emit: false }) }] : messages;
  await l.json(
    "POST",
    "/api/link/devices/adopt-chat",
    {
      conversation: summary,
      messages: moved,
      runs,
      handover: readHandover(conversationId),
      followup: followup ? { note: followup.note, dueAt: followup.dueAt } : null,
    },
    { timeoutMs: 180_000 },
  );
  const state: RunnerChatState = { running: false, paused: null, followup: followup ? { note: followup.note, dueAt: followup.dueAt, createdAt: followup.createdAt } : null };
  sql("UPDATE conversations SET runner_id = ?, runner_state = ?, working_directory = NULL, computer_target = NULL, updated_at = ? WHERE id = ?", targetId, JSON.stringify(state), now(), conversationId);
  if (followup) cancelFollowup(conversationId);
  audit("user", "device.chat.push", conversationId, { to: target.name });
  emitConversationUpdated(conversationId);
}

/** On the computer a chat moves to: it becomes this computer's own, with its session, transcript and follow-up. */
export function adoptPushedChat(input: { conversation: unknown; messages: unknown; runs: unknown; handover: unknown; followup: unknown }): Conversation {
  const { id, agentId } = importChat(input.conversation, input.messages, input.runs);
  const agent = getAgent(agentId);
  const h = (input.handover ?? {}) as { sessionId?: unknown; session?: unknown; transcript?: unknown };
  const sessionId = typeof h.sessionId === "string" ? h.sessionId : null;
  if (sessionId && typeof h.session === "string") {
    try {
      if (writeSession(agent.workingDirectory ?? agent.repoPath, sessionId, h.session)) sql("UPDATE conversations SET claude_session_id = ? WHERE id = ?", sessionId, id);
    } catch (err) {
      log.warn(`could not keep the Claude session of chat ${id}`, err instanceof Error ? err.message : err);
    }
  }
  if (typeof h.transcript === "string") {
    try {
      writeTranscript(transcriptPath(agent, id), h.transcript);
    } catch (err) {
      log.warn(`could not keep the transcript of chat ${id}`, err instanceof Error ? err.message : err);
    }
  }
  const f = input.followup as { note?: unknown; dueAt?: unknown } | null;
  if (f && typeof f.dueAt === "string" && !Number.isNaN(Date.parse(f.dueAt))) {
    try {
      const due = Math.max(Date.parse(f.dueAt), Date.now() + MIN_FOLLOWUP_DELAY_MS + 5_000);
      scheduleFollowup({ conversationId: id, agentId, dueAt: new Date(due), note: typeof f.note === "string" && f.note.trim() ? f.note : "Continue where you left off." });
    } catch (err) {
      log.info(`the follow-up of chat ${id} didn't move along`, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  audit("controller", "device.chat.adopt", id, {});
  emitConversationUpdated(id);
  return getConversationSummary(id);
}

/** Send a turn into a chat that lives on another computer (a continuation, a human task's answer, a ticket's note). */
async function sendThere(
  conversationId: string,
  owner: string,
  input: { content: string; prompt?: string; marker?: MessageBlock[]; trigger?: string },
): Promise<{ message: Message; run: Run }> {
  await prepareRemoteMessage(conversationId).catch(() => undefined);
  const l = link(owner);
  l.assertOnline();
  const result = await l.json<{ conversation: Conversation; message: Message; run: Run }>("POST", `/api/link/conversations/${encodeURIComponent(conversationId)}/send`, input, {
    timeoutMs: 120_000,
  });
  adoptChat(owner, result);
  return result;
}

/**
 * Move a chat to another computer of the group (`to`: its id, null = this primary). With `force` a run that works
 * there stops first and the agent continues on the new computer; otherwise a busy chat is refused.
 */
export async function moveChat(conversationId: string, input: MoveChatInput): Promise<Conversation> {
  if (isSecondary()) throw new HttpError(409, "Chats move between computers on the primary.", "not_primary");
  if (!conversationExists(conversationId)) throw new HttpError(404, "Conversation not found", "not_found");
  const to = input.to ?? null;
  if (to !== null) {
    const target = runnerRow(to);
    if (!target) throw new HttpError(404, "That computer isn't part of the group anymore.", "not_found");
    link(to).assertOnline();
  }
  const owner = runnerOfConversation(conversationId);
  if (owner === to) throw new HttpError(409, `This chat already works on ${deviceName(to)}.`, "already_there");
  const from = deviceName(owner);
  const dest = deviceName(to);
  const working = busy(conversationId, owner);
  if (working && !input.force) {
    throw new HttpError(409, `A run is working in this chat on ${from}. Move it anyway: the run stops and the agent continues on ${dest}.`, "chat_busy");
  }
  const queued = owner === null ? listQueue(conversationId).map((q) => q.content) : [];
  if (queued.length && !input.force) throw new HttpError(409, "Messages are waiting in this chat's queue. Send or remove them first, or move it anyway.", "chat_queued");

  if (working) await stopWork(conversationId, owner, dest);
  if (queued.length) clearQueue(conversationId);
  const resume = working || queued.length > 0;
  if (owner !== null) await moveChatHere(conversationId);

  const blocks = marker(from, dest, resume);
  if (to !== null) {
    await pushChat(conversationId, to, resume ? null : blocks);
    if (resume) await sendThere(conversationId, to, { content: `Continued on ${dest}`, prompt: continuePrompt(from, dest, queued), marker: blocks });
  } else if (resume) {
    await sendMessage(conversationId, { content: `Continued on ${dest}`, prompt: continuePrompt(from, dest, queued), marker: blocks, trigger: "chat" });
  } else {
    addMessage({ conversationId, role: "system", content: "", blocks });
  }
  log.info("moved a chat", { conversationId, from, to: dest, resume });
  audit("user", "device.chat.move", conversationId, { from, to: dest, resume });
  emitConversationUpdated(conversationId);
  return getConversationSummary(conversationId);
}

/**
 * Hand a computer's work to another one before it goes away (the lid closes): every chat there that works, stands
 * still, waits in its queue or has a follow-up moves, and running work continues on the other computer.
 */
export async function handoff(from: string | null, to: string | null): Promise<HandoffResult> {
  if (isSecondary()) return primaryLink().json<HandoffResult>("POST", "/api/devices/handoff", { from, to }, { timeoutMs: 10 * 60_000 });
  if (from === to) throw badRequest("Pick another computer to hand the work to.");
  const chats = all<{ id: string; title: string; runner_state: string | null }>(
    `SELECT id, title, runner_state FROM conversations WHERE ${from === null ? "runner_id IS NULL" : "runner_id = ?"} AND origin NOT IN ('dream', 'task') AND archived = 0`,
    ...(from === null ? [] : [from]),
  );
  const result: HandoffResult = { moved: [], failed: [] };
  for (const chat of chats) {
    const followup = from === null ? !!getFollowup(chat.id) : !!parseJson<Partial<RunnerChatState> | null>(chat.runner_state, null)?.followup;
    const queued = from === null && listQueue(chat.id).length > 0;
    if (!busy(chat.id, from) && !followup && !queued) continue;
    try {
      await moveChat(chat.id, { to, force: true });
      result.moved.push(chat.id);
    } catch (err) {
      result.failed.push({ id: chat.id, title: chat.title, error: err instanceof Error ? err.message : String(err) });
    }
  }
  audit("user", "device.handoff", null, { from: deviceName(from), to: deviceName(to), moved: result.moved.length, failed: result.failed.length });
  return result;
}

