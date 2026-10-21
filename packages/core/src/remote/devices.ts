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
  type BrowserSignIns,
  type MobilePeer,
  type RetireRunnerResult,
  type RunnerInfo,
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
import { setForwarding, setLinkEventFilter, welcomeAll, type WsData } from "../server/ws";
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
import { forgetController, linkServerPort, runnerInfo, setPhoneInfo, startLinkServer, stopLinkServer } from "./linkServer";
import { adoptChat, catchUp, fetchConversation, importChat } from "./mirror";
import { createRunnerCode } from "./pairing";
import {
  clearGroup,
  forwarding,
  groupRole,
  isPrimary,
  isSecondary,
  onGroupChange,
  primaryOnline,
  primaryRunnerId,
  runsShared,
  setGroup,
  setPrimaryUp,
  standingIn,
  standingInSince,
} from "./group";
import {
  getRunner,
  link,
  listRunners,
  remoteSubscription,
  moveChatHere,
  pairWithCode,
  prepareRemoteMessage,
  releaseChatsNow,
  connectRunner,
  removeRunner,
  takenFrom,
  forgetRelease,
  runnerExec,
  runnerInfoOf,
  runnerOfConversation,
  runnerRow,
  setDeviceLinkHooks,
} from "./runners";
import { browserSignIns, setBrowserSignIns } from "./browserSessions";
import { forgetPeer, keepPreJoinLocal, pendingFor, replicaSeq } from "./replica";
import { pendingChanges, pullFrom, replicaHint, startReplicaSync, stopReplicaSync } from "./replicaSync";
import { endStandIn, forgetStandIn, primaryIsBack, primaryLeftNow, primaryWentAway, setStandInHooks, setStandInSettings, standInSettings, standInState, type TakeOver } from "./standIn";
import { SERVICE_LABEL } from "./launchd";
import { runMissedSince, setScheduleGroup } from "../scheduler/scheduler";
import { instanceInfo } from "../mobile/devices";
import { mobileUrls } from "../mobile/access";
import { getSettings } from "../services/settings";
import type { LinkState } from "./linkClient";

const log = logger("devices");

const SELF_META = "link.group.self";
const DEFAULT_RUN_META = "link.group.defaultRunOn";
const FAILOVER_META = "link.group.failover";
const FAILOVER_MINUTES_META = "link.group.failoverMinutes";
const FAILOVER_DEFAULT_MINUTES = 3;
const ONLINE_WAIT_MS = 20_000;
const STOP_WAIT_MS = 45_000;
const HAND_BACK_WAIT_MS = 30_000;
/** A secondary's copy of its primary's chats has the messages of this many days. */
const PRIMARY_MESSAGES_DAYS = 30;
const WAKE_GAP_MS = 90_000;
const SETTLE_MS = 45_000;
const START_SETTLE_MS = 20_000;
const FETCHES_AT_ONCE = 3;

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
      // The primary's view of the group is its own: this computer tells its windows about it itself (and keeps the
      // primary's settings for while it is away).
      if (event.type === "devices.updated") return emitGroupSoon();
      if (event.type === "runner.updated" || event.type === "runner.deleted" || event.type === "runner.paired") emitGroupSoon();
      forwardEvent?.(event);
    },
    primaryState: (state) => {
      primaryError = state.state === "online" ? null : state.error;
      if (state.state === "online") primaryIsBack();
      else {
        setPrimaryUp(false);
        primaryWentAway(primaryLastSeen());
      }
      emitGroupSoon();
    },
    deviceState: (id, state) => {
      if (state.state === "online") {
        cancelFailover(id);
        linkUpAt.set(id, Date.now());
      } else linkUpAt.delete(id);
      emitGroupSoon();
    },
    deviceLost: (id, conversations) => {
      if (isPrimary()) scheduleFailover(id, conversations);
    },
    deviceConnected: (id) => (isSecondary() && id === primaryRunnerId() ? primaryArrived(id) : deviceArrived(id)),
    replicaHint: (id) => replicaHint(id),
  });
  setStandInHooks({ takeOver, changed: emitGroupSoon, online: internetReachable });
  startReplicaSync({ fetchChat: (peer, id) => void fetchChatFrom(peer, id) });
  setLinkEventFilter(echoToPrimary);
  setScheduleGroup({ active: () => groupRole() !== null, settle: settled });
  setPhoneInfo(() => (getSettings().mobile.enabled ? { instance: instanceInfo(), urls: mobileUrls() } : null));
  startWakeWatch();
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
    // Its computer is away and this one runs the group's work now: the chat continues here.
    if (awayDevice(owner) && runsShared()) {
      await continueHere(conversationId, { resume: false });
      return sendMessage(conversationId, { content: input.content, prompt: input.prompt, marker: input.marker, trigger: input.trigger as never });
    }
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
  if (groupRole()) {
    listen();
    // Started while the primary is away (or before its link is up): the stand-in clock starts now.
    if (isSecondary() && !primaryOnline()) primaryWentAway(primaryLastSeen());
  }
}

export function stopDevices(): void {
  for (const id of [...failovers.keys()]) cancelFailover(id);
  setDeviceLinkHooks(null);
  setStandInHooks(null);
  stopReplicaSync();
  setLinkEventFilter(null);
  setScheduleGroup(null);
  setPhoneInfo(null);
  stopWakeWatch();
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

/** Godmode quits here: the other computers of the group take over at once instead of waiting to see if it's back. */
export async function sayGoodbye(): Promise<void> {
  if (!groupRole()) return;
  const peers = isSecondary() ? [primaryRunnerId()].filter((x): x is string => !!x) : deviceRows().map((d) => d.id);
  await Promise.all(
    peers.map(async (id) => {
      try {
        const l = link(id);
        if (l.state.state === "online") await l.json("POST", "/api/link/devices/away", {}, { timeoutMs: 1_500 });
      } catch {
        /* it hears it from the dropped link instead */
      }
    }),
  );
}

/** Over the link: the other computer goes away now. */
export function peerAway(peer: string): void {
  if (isSecondary() && peer === primaryRunnerId()) primaryLeftNow();
  else if (isPrimary()) goneNow.add(peer);
}

/** Whether this computer reaches the internet at all (any answer from Anthropic's API counts). */
async function internetReachable(): Promise<boolean> {
  try {
    await fetch("https://api.anthropic.com/", { method: "HEAD", signal: AbortSignal.timeout(8_000) });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Phones                                                               */
/* ------------------------------------------------------------------ */

function phoneKey(id: string): string {
  return `link.group.phone.${id}`;
}

/** Where phones reach another computer of the group: what it said at its last connect, kept for while it is away. */
function phoneOf(id: string): RunnerInfo["phone"] | null {
  const told = runnerInfoOf(id)?.phone;
  if (told !== undefined) {
    const raw = told ? JSON.stringify(told) : null;
    if (raw !== getMeta(phoneKey(id))) {
      if (raw) setMeta(phoneKey(id), raw);
      else deleteMeta(phoneKey(id));
    }
    return told;
  }
  return parseJson<RunnerInfo["phone"] | null>(getMeta(phoneKey(id)), null);
}

/**
 * The computers of the group a phone can talk to (GET /api/mobile/me), this one first: a phone paired with one of them
 * works with all of them, so it reaches another when one is away.
 */
export function phonePeers(): MobilePeer[] {
  const role = groupRole();
  if (!role) return [];
  const peers: MobilePeer[] = [];
  if (getSettings().mobile.enabled) peers.push({ instance: instanceInfo(), urls: mobileUrls(), role });
  const ids = role === "secondary" ? [primaryRunnerId()].filter((x): x is string => !!x) : deviceRows().map((d) => d.id);
  for (const id of ids) {
    const phone = phoneOf(id);
    if (phone?.urls.length) peers.push({ instance: phone.instance, urls: phone.urls, role: role === "secondary" ? "primary" : "secondary" });
  }
  return peers;
}

/* ------------------------------------------------------------------ */
/* Arriving                                                             */
/* ------------------------------------------------------------------ */

/** When each device's link came up last (ms): late ticks wait until what it changed meanwhile is here. */
const linkUpAt = new Map<string, number>();
/** Devices that said goodbye: their work continues here without the grace time. */
const goneNow = new Set<string>();

function primaryLastSeen(): string | null {
  const pid = primaryRunnerId();
  return pid ? (runnerRow(pid)?.last_seen_at ?? null) : null;
}

/** A device of the group whose link is down. */
function awayDevice(id: string): boolean {
  const r = runnerRow(id);
  if (!r || r.kind !== "device") return false;
  try {
    return link(id).state.state !== "online";
  } catch {
    return true;
  }
}

/**
 * On the primary: a secondary connected. What it changed while it was away (standing in, or just on its own) is taken
 * first, so the setup copied there next already has it.
 */
async function deviceArrived(id: string): Promise<void> {
  goneNow.delete(id);
  await pullFrom(id);
  const l = link(id);
  try {
    // Chats it continued while this computer was away are its own now: nothing here may pick them up again.
    const taken = await l.json<{ ids: string[] }>("GET", "/api/link/devices/taken", undefined, { timeoutMs: 30_000 });
    if (taken.ids?.length) await releaseChatsTo(id, taken.ids);
    // Its own link to here may still be waiting to retry: it hands everything back now instead.
    await l.json("POST", "/api/link/devices/hello", {}, { timeoutMs: 10_000 });
    // Nothing runs twice: the shared work starts here once it stopped standing in.
    const end = Date.now() + HAND_BACK_WAIT_MS + 10_000;
    while (Date.now() < end && l.state.state === "online") {
      const there = await l.json<{ standingIn: boolean }>("GET", "/api/link/devices/state", undefined, { timeoutMs: 10_000 });
      if (!there.standingIn) break;
      await sleep(500);
    }
  } catch (err) {
    log.info("could not settle the hand-back with a device", { error: err instanceof Error ? err.message : String(err) });
  }
  arrivedAt.set(id, Date.now());
}

/** Over the link: where this computer stands (the primary asks before it starts the shared work again). */
export function deviceState(): { standingIn: boolean } {
  return { standingIn: standingIn() };
}

/** When each device was last caught up with after its link came up (ms). */
const arrivedAt = new Map<string, number>();

/** Over the link: chats this computer took over from the asking one (it is back), not handed back yet. */
export function chatsTakenFrom(peer: string): { ids: string[] } {
  return { ids: takenFrom(peer) };
}

/** Over the link: the primary is there again; this secondary connects to it now instead of at its next retry. */
export function peerHello(peer: string): void {
  if (isSecondary() && peer === primaryRunnerId() && !primaryOnline()) {
    try {
      connectRunner(peer);
    } catch {
      /* gone meanwhile */
    }
  }
}

/**
 * On a secondary: its primary is there again. Its changes come here, what changed here goes there, chats this computer
 * took over are handed back as this computer's, the shared work stops here, and then the app shows the primary again.
 */
async function primaryArrived(id: string): Promise<void> {
  try {
    await pullFrom(id);
  } catch (err) {
    log.info("could not take the primary's changes yet", { error: err instanceof Error ? err.message : String(err) });
  }
  // Chats continued here while it was away (also before standing in began) live here now.
  await releaseChatsNow(id);
  const since = standingInSince();
  if (since && !(await handBack(id, since))) return;
  if (link(id).state.state === "online") setPrimaryUp(true);
  emitGroupSoon();
  void catchUpWithPrimary(id);
}

/** False when the primary went away again meanwhile: this computer keeps standing in. */
async function handBack(id: string, since: string): Promise<boolean> {
  // Tells the primary there is something to pull; then wait until it has it (it pulls when its link to here is up).
  bus.emit({ type: "replica.changed", seq: replicaSeq() });
  const end = Date.now() + HAND_BACK_WAIT_MS;
  while (pendingFor(id) > 0 && Date.now() < end && link(id).state.state === "online") await sleep(250);
  if (link(id).state.state !== "online") {
    log.info("the primary went away again during the hand-back; still standing in");
    return false;
  }
  const left = pendingFor(id);
  endStandIn();
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(since)) / 60_000));
  log.info("the primary is back; standing in ends", { minutes, pending: left });
  notify(
    "info",
    `${primaryName()} is back`,
    `${computerName()} stood in for ${minutes === 1 ? "a minute" : `${minutes} minutes`}. ${left ? "What changed here goes over in a moment." : "Everything that changed here is there now."}`,
    "/settings/devices",
  );
  return true;
}

/** A copy of the primary's chats, for while it is away (messages without screenshots; old chats without messages). */
async function catchUpWithPrimary(id: string): Promise<void> {
  try {
    await catchUp(id, link(id), { lite: true, messagesSince: new Date(Date.now() - PRIMARY_MESSAGES_DAYS * 86_400_000).toISOString() });
  } catch (err) {
    log.info("could not copy the primary's chats", { error: err instanceof Error ? err.message : String(err) });
  }
}

/** A change of the shared data points at a chat that isn't here yet: fetched, a few at a time. */
function fetchChatFrom(peer: string, conversationId: string): Promise<void> {
  if (fetching.has(conversationId)) return Promise.resolve();
  fetching.add(conversationId);
  return new Promise((done) => {
    fetchQueue.push(async () => {
      try {
        const l = link(peer);
        if (l.state.state !== "online") return;
        if (await fetchConversation(peer, l, conversationId, { lite: isSecondary() && peer === primaryRunnerId() })) replicaHint(peer);
      } catch (err) {
        log.info(`could not fetch chat ${conversationId}`, { error: err instanceof Error ? err.message : String(err) });
      } finally {
        fetching.delete(conversationId);
        done();
      }
    });
    drainFetches();
  });
}

const fetching = new Set<string>();
const fetchQueue: (() => Promise<void>)[] = [];
let fetchesRunning = 0;

function drainFetches(): void {
  while (fetchesRunning < FETCHES_AT_ONCE && fetchQueue.length) {
    const next = fetchQueue.shift()!;
    fetchesRunning++;
    void next().finally(() => {
      fetchesRunning--;
      drainFetches();
    });
  }
}

/**
 * Events this secondary only keeps a copy of (its primary's chats) don't go back to the primary: it has them. Its own
 * chats' events still go there — the primary's app shows them.
 */
function echoToPrimary(peer: string, event: ServerEvent): boolean {
  const pid = isSecondary() ? primaryRunnerId() : null;
  if (!pid || controllerOf(pid) !== peer) return false;
  const chat = chatOf(event);
  return !!chat && get<{ runner_id: string | null }>("SELECT runner_id FROM conversations WHERE id = ?", chat)?.runner_id === pid;
}

const controllers = new Map<string, string | null>();

/** The controller entry (link_controllers) of a paired computer, by its key. */
function controllerOf(runnerId: string): string | null {
  if (controllers.has(runnerId)) return controllers.get(runnerId)!;
  const key = runnerRow(runnerId)?.public_key;
  let found: string | null = null;
  if (key) {
    for (const c of all<{ id: string; public_key: string }>("SELECT id, public_key FROM link_controllers")) {
      try {
        if (canonicalKey(c.public_key) === canonicalKey(key)) found = c.id;
      } catch {
        /* a damaged row never matches */
      }
    }
  }
  controllers.set(runnerId, found);
  return found;
}

function chatOf(event: ServerEvent): string | null {
  switch (event.type) {
    case "conversation.updated":
      return event.conversation.id;
    case "message.created":
    case "message.updated":
      return event.message.conversationId;
    case "run.started":
    case "run.paused":
    case "run.finished":
      return event.run.conversationId;
    case "run.delta":
    case "run.activity":
      return get<{ conversation_id: string }>("SELECT conversation_id FROM runs WHERE id = ?", event.runId)?.conversation_id ?? null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Late ticks after a sleep                                             */
/* ------------------------------------------------------------------ */

let wakeTimer: ReturnType<typeof setInterval> | null = null;
let lastBeat = Date.now();
let wokeAt = Date.now();

/** A Mac that slept fires the timers it missed at once: those ticks wait until the group's copies are in. */
function startWakeWatch(): void {
  lastBeat = Date.now();
  wakeTimer ??= setInterval(() => {
    const t = Date.now();
    if (t - lastBeat > WAKE_GAP_MS) wokeAt = t;
    lastBeat = t;
  }, 5_000);
  wakeTimer.unref?.();
}

function stopWakeWatch(): void {
  if (wakeTimer) clearInterval(wakeTimer);
  wakeTimer = null;
}

/**
 * A primary that just started: the shared work (schedules, the board) and the chats its stop cut off wait until every
 * computer of its group that comes online within a short while has been pulled — one may have stood in meanwhile and
 * done some of it already.
 */
export async function groupSettled(): Promise<void> {
  if (!isPrimary() || !deviceRows().length) return;
  const start = Date.now();
  for (;;) {
    const waiting = deviceRows().filter((d) => {
      const up = linkUpAt.get(d.id);
      // One that doesn't connect within a short while is away; one that did is waited for until it handed back.
      if (!up) return Date.now() - start < START_SETTLE_MS;
      return (arrivedAt.get(d.id) ?? 0) < up && Date.now() - start < START_SETTLE_MS + HAND_BACK_WAIT_MS + 20_000;
    });
    if (!waiting.length) return;
    await sleep(500);
  }
}

/**
 * Before a late automation tick on the primary: every computer of the group that is (or comes) online within a short
 * while has been pulled since its link came up, so a run another one made while this one slept is known.
 */
async function settled(): Promise<void> {
  if (!isPrimary()) return;
  const end = Math.max(wokeAt + SETTLE_MS, Date.now() + 2_000);
  for (;;) {
    const waiting = deviceRows().filter((d) => {
      const up = linkUpAt.get(d.id);
      if (!up) return Date.now() < wokeAt + SETTLE_MS;
      return (arrivedAt.get(d.id) ?? 0) < up;
    });
    if (!waiting.length || Date.now() > end) return;
    await sleep(500);
  }
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
interface GroupSettings {
  failover: boolean;
  failoverMinutes: number;
  standInEnabled: boolean;
  standInMinutes: number;
  browserSignIns: BrowserSignIns;
}

function groupSettings(): GroupSettings {
  return { ...failoverSettings(), ...standInSettings(), browserSignIns: browserSignIns() };
}

/** What a secondary's Settings → Devices shows of the group (GET /api/link/devices/list). */
export function groupForSecondary(): { devices: GroupDevice[] } & GroupSettings {
  return { devices: primaryView(), ...groupSettings() };
}

/** A secondary keeps the primary's group settings for while it is away (written quietly: no event of its own). */
function keepGroupSettings(remote: Partial<GroupSettings>): void {
  const put = (key: string, value: string | undefined) => {
    if (value !== undefined && getMeta(key) !== value) setMeta(key, value);
  };
  put(FAILOVER_META, remote.failover === undefined ? undefined : remote.failover ? "1" : "0");
  put(FAILOVER_MINUTES_META, remote.failoverMinutes === undefined ? undefined : String(remote.failoverMinutes));
  put("link.group.standIn", remote.standInEnabled === undefined ? undefined : remote.standInEnabled ? "1" : "0");
  put("link.group.standInMinutes", remote.standInMinutes === undefined ? undefined : String(remote.standInMinutes));
  put("link.group.browserSignIns", remote.browserSignIns);
}

/** The group's settings, on the primary. */
export function setGroupSettings(input: Partial<GroupSettings>): void {
  if (input.failover !== undefined || input.failoverMinutes !== undefined) setFailover({ failover: input.failover, failoverMinutes: input.failoverMinutes });
  if (input.standInEnabled !== undefined || input.standInMinutes !== undefined) setStandInSettings({ standInEnabled: input.standInEnabled, standInMinutes: input.standInMinutes });
  if (input.browserSignIns !== undefined) setBrowserSignIns(input.browserSignIns);
  emitGroupSoon();
}

/** The same computer paired twice: a runner from an older setup on the computer this device runs on. */
function runnerTwin(device: { machineId: string | null | undefined; hostname: string | null }): string | null {
  const host = (h: string | null | undefined) => (h ?? "").toLowerCase().replace(/\.local$/, "");
  for (const r of listRunners()) {
    if (r.kind === "device") continue;
    const info = runnerInfoOf(r.id);
    if (device.machineId && info?.machineId) {
      if (info.machineId === device.machineId) return r.id;
      continue;
    }
    if (device.hostname && host(r.hostname) === host(device.hostname)) return r.id;
  }
  return null;
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
    standingIn: false,
    fullDiskAccess: runnerInfo().fullDiskAccess ?? null,
    runnerTwin: runnerTwin({ machineId: runnerInfo().machineId, hostname: runnerInfo().hostname }),
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
        standingIn: false,
        fullDiskAccess: runnerInfoOf(r.id)?.fullDiskAccess ?? null,
        runnerTwin: runnerTwin({ machineId: runnerInfoOf(r.id)?.machineId, hostname: r.hostname }),
      }),
    );
  return [self, ...others];
}

export async function deviceGroup(): Promise<DeviceGroup> {
  const role = groupRole();
  const defaultRunOn = getMeta(DEFAULT_RUN_META);
  const base = {
    port: linkServerPort(),
    defaultRunOn: role ? defaultRunOn : null,
    ...groupSettings(),
    standIn: standInState(),
    pendingChanges: role ? pendingChanges() : 0,
  };
  if (!role) return { ...base, role: null, primaryName: null, primaryOnline: false, primaryError: null, selfId: null, devices: [] };
  if (role === "primary") {
    return { ...base, role, primaryName: computerName(), primaryOnline: true, primaryError: null, selfId: null, devices: primaryView() };
  }
  const selfId = getMeta(SELF_META);
  let devices: GroupDevice[] | null = null;
  if (forwarding()) {
    try {
      const remote = await primaryLink().json<{ devices: GroupDevice[] } & Partial<GroupSettings>>("GET", "/api/link/devices/list", undefined, { timeoutMs: 10_000 });
      // The primary is called what this computer calls it (its row here can be renamed).
      devices = remote.devices.map((d) => ({ ...d, self: d.id !== null && d.id === selfId, ...(d.id === null ? { name: primaryName() } : {}) }));
      keepGroupSettings(remote);
      Object.assign(base, groupSettings());
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
        conversations: pid ? (get<{ c: number }>("SELECT COUNT(*) AS c FROM conversations WHERE runner_id = ?", pid)?.c ?? 0) : 0,
        standingIn: false,
        fullDiskAccess: pid ? (runnerInfoOf(pid)?.fullDiskAccess ?? null) : null,
        runnerTwin: null,
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
        standingIn: standingIn(),
        fullDiskAccess: runnerInfo().fullDiskAccess ?? null,
        runnerTwin: null,
      },
    ];
  }
  devices = devices.map((d) => (d.self ? { ...d, standingIn: standingIn() } : d));
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
  // GODMODE_FAILOVER_MS: tests don't wait minutes. A computer that said goodbye isn't coming back soon.
  const wait = goneNow.has(id) ? 0 : Number(process.env.GODMODE_FAILOVER_MS) || settings.failoverMinutes * 60_000;
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

/**
 * This secondary starts standing in for its primary (standIn.ts decided): the chats that were working there continue
 * here from a recap, and automations that came due since it went run once.
 */
async function takeOver(t: TakeOver): Promise<void> {
  const pid = primaryRunnerId();
  const chats = pid
    ? all<{ id: string; runner_state: string | null }>("SELECT id, runner_state FROM conversations WHERE runner_id = ? AND archived = 0", pid).filter((c) => {
        const state = parseJson<Partial<RunnerChatState> | null>(c.runner_state, null);
        return !!state?.running || !!state?.paused || !!state?.followup;
      })
    : [];
  let continued = 0;
  for (const chat of chats) {
    try {
      await continueHere(chat.id, { resume: true });
      continued++;
    } catch (err) {
      log.warn(`could not continue chat ${chat.id} here`, err instanceof Error ? err.message : err);
    }
  }
  const missed = await runMissedSince(t.lostAt).catch(() => 0);
  audit("system", "device.stand_in", pid, { primary: primaryName(), chats: continued, automations: missed });
  const extra = [continued ? `${continued === 1 ? "1 chat that was working" : `${continued} chats that were working`} continue${continued === 1 ? "s" : ""} here` : "", missed ? `${missed === 1 ? "1 automation" : `${missed} automations`} that came due ran` : ""].filter(Boolean);
  notify(
    "info",
    `${computerName()} stands in for ${primaryName()}`,
    `${primaryName()} is away, so automations, the board and your phone work here now${extra.length ? `; ${extra.join(", ")}` : ""}. What changes here goes back once it's there again.`,
    "/settings/devices",
  );
}

/**
 * A chat of the primary continues on this secondary while the primary is away: it moves here with what this computer
 * has of it (the agent picks up from a recap), and goes back as this computer's chat when the primary returns.
 */
async function continueHere(conversationId: string, opts: { resume: boolean }): Promise<void> {
  const owner = runnerOfConversation(conversationId);
  if (!owner) return;
  const state = parseJson<Partial<RunnerChatState> | null>(get<{ runner_state: string | null }>("SELECT runner_state FROM conversations WHERE id = ?", conversationId)?.runner_state, null);
  const from = deviceName(owner);
  const here = computerName();
  await moveChatHere(conversationId);
  if (opts.resume && (state?.running || state?.paused)) {
    await sendMessage(conversationId, { content: `Continued on ${here}`, prompt: continuePrompt(from, here, []), marker: marker(from, here, true), trigger: "chat" });
  } else if (opts.resume) {
    addMessage({ conversationId, role: "system", content: "", blocks: marker(from, here, false) });
  }
}

/**
 * Over the link: chats of this computer that `peer` took over while this one was away live there now. What still
 * works here in them stops; the messages stay, and from now on this computer mirrors them from there.
 */
export async function releaseChatsTo(peer: string, ids: string[]): Promise<{ released: number }> {
  const name = deviceName(peer);
  let released = 0;
  for (const id of ids) {
    const row = get<{ runner_id: string | null }>("SELECT runner_id FROM conversations WHERE id = ?", id);
    if (!row || row.runner_id !== null) continue;
    const reason = `Stopped: ${name} continued this chat while this computer was away`;
    const active = activeRunForConversation(id);
    if (active) {
      await cancelRun(active, reason, { byHuman: true }).catch(() => undefined);
      await waitForRun(active, STOP_WAIT_MS).catch(() => undefined);
    }
    const paused = pauseOf(id);
    if (paused) await cancelRun(paused.run_id, reason, { byHuman: true }).catch(() => undefined);
    cancelFollowup(id);
    clearQueue(id);
    const state: RunnerChatState = { running: false, paused: null, followup: null };
    sql("UPDATE conversations SET runner_id = ?, runner_state = ?, working_directory = NULL, computer_target = NULL, updated_at = ? WHERE id = ?", peer, JSON.stringify(state), now(), id);
    // It lives there now: an older plan of this computer to hand it back there is done with.
    forgetRelease(peer, id);
    emitConversationUpdated(id);
    released++;
    void fetchChatFrom(peer, id);
  }
  if (released) audit("controller", "device.chats.released", peer, { to: name, chats: released });
  return { released };
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
        keepPreJoinLocal(id);
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
    if (primaryId) forgetPeer(primaryId);
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
  forgetStandIn();
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
    if (pid) forgetPeer(pid);
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
  forgetPeer(id);
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
      if (row) forgetPeer(row.id);
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
  if (isSecondary()) {
    // While the primary is away a chat of it can continue here (it goes back as this computer's chat afterwards).
    const owner = runnerOfConversation(conversationId);
    if ((input.to ?? null) === null && owner && owner === primaryRunnerId() && !primaryOnline()) {
      await continueHere(conversationId, { resume: !!input.force });
      return getConversationSummary(conversationId);
    }
    throw new HttpError(409, "Chats move between computers on the primary.", "not_primary");
  }
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

/* ------------------------------------------------------------------ */
/* An old runner on a computer of the group                             */
/* ------------------------------------------------------------------ */

/** Switches the runner's background service off there, a moment after the answer left. */
const UNINSTALL_SCRIPT = [
  `plist="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"`,
  `[ -f "$plist" ] || { echo "not installed"; exit 0; }`,
  `bin=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$plist")`,
  `nohup /bin/sh -c "sleep 2; '$bin' runner uninstall" >/dev/null 2>&1 &`,
  "echo uninstalling",
].join("\n");

/**
 * A computer of the group also runs an old runner (it was a runner before it joined with the app): its chats move to the
 * app on that computer, the runner's service is switched off there, and the pairing goes. Busy chats keep it waiting.
 */
export async function retireRunner(runnerId: string): Promise<RetireRunnerResult> {
  if (isSecondary()) return primaryLink().json<RetireRunnerResult>("POST", "/api/devices/retire-runner", { runnerId }, { timeoutMs: 10 * 60_000 });
  const runner = runnerRow(runnerId);
  if (!runner || runner.kind === "device") throw new HttpError(404, "Runner not found", "not_found");
  const twin = deviceRows().find((d) => runnerTwin({ machineId: runnerInfoOf(d.id)?.machineId, hostname: runnerRow(d.id)?.hostname ?? null }) === runnerId);
  if (!twin) throw new HttpError(409, `${runner.name} doesn't run the Godmode app of your group, so its chats have nowhere to go.`, "no_twin");
  link(twin.id).assertOnline();
  const chats = all<{ id: string; title: string }>("SELECT id, title FROM conversations WHERE runner_id = ?", runnerId);
  const working = chats.filter((c) => busy(c.id, runnerId));
  if (working.length) {
    throw new HttpError(409, `${working.length === 1 ? `“${working[0]!.title}” is` : `${working.length} chats are`} still working on the runner. Try again once ${working.length === 1 ? "it's" : "they're"} done.`, "runner_busy");
  }
  let moved = 0;
  for (const chat of chats) {
    await moveChat(chat.id, { to: twin.id, force: false });
    moved++;
  }
  let uninstalled = false;
  try {
    const res = await runnerExec(runnerId, UNINSTALL_SCRIPT, 30);
    uninstalled = res.code === 0;
  } catch (err) {
    log.info("could not switch the runner's service off", { error: err instanceof Error ? err.message : String(err) });
  }
  await removeRunner(runnerId);
  audit("user", "device.retire_runner", runnerId, { name: runner.name, moved, uninstalled });
  emitGroupSoon();
  return { moved, uninstalled };
}
