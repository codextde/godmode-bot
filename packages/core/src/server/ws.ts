import type { ServerWebSocket } from "bun";
import { browserView, type ClientEvent, type RunDelta, type ServerEvent } from "@godmode/shared";
import { timedSync } from "../diagnostics/slow";
import { bus } from "../events/bus";
import { VERSION } from "../config";
import { logger } from "../log";
import { setDeviceSocketHooks } from "../mobile/devices";
import { deviceMayUseView } from "../mobile/scope";

const log = logger("ws");

export interface WsData {
  id: string;
  subscriptions: Set<string>;
  /** Subscriptions that only watch — they don't keep an idle browser running. */
  passive?: Set<string>;
  /** How the socket authenticated; cookie sessions are closed when sessions are revoked, phones when removed. */
  auth?: "token" | "session" | "device";
  /** The paired phone (auth "device"). */
  deviceId?: string;
  /** Phones: conversations whose streaming replies (`run.delta`) they want. */
  conversations?: Set<string>;
  /** The client applies `run.delta` patches (it said `deltas.patch`); the others get the whole block list. */
  patches?: boolean;
}

const clients = new Set<ServerWebSocket<WsData>>();
/** Live view subscribers per view (`browserView`: a profile's active tab, or one chat's tab). */
const browserSubscribers = new Map<string, number>();
const browserWatchers = new Map<string, number>();
const browserViews = new Map<string, BrowserViewRef>();

export interface BrowserViewRef {
  profileId: string;
  conversationId: string | null;
}

const computerSubscribers = new Map<string, number>();

/** Events a newly connected UI needs to catch up on (e.g. what running agents are doing right now). */
let welcomeEvents: () => ServerEvent[] = () => [];
/** More of them from elsewhere (what runs on runners are doing). */
const moreWelcomeEvents: (() => ServerEvent[])[] = [];

export function setWelcomeEvents(fn: () => ServerEvent[]) {
  welcomeEvents = fn;
}

/** The whole in-flight message of running runs (all, one run's, or one conversation's), as `run.delta` events. */
let runSnapshots: (want: { runId?: string; conversationId?: string }) => RunDelta[] = () => [];

export function setRunSnapshots(fn: typeof runSnapshots) {
  runSnapshots = fn;
}

export function addWelcomeEvents(fn: () => ServerEvent[]) {
  moreWelcomeEvents.push(fn);
}

/**
 * Live views that are a runner's, not this computer's: a runner chat's browser tab and `runner:` screen views. Each
 * handler answers whether the view was a remote one (and took care of it); otherwise the local live view starts.
 */
let remoteBrowser: ((view: BrowserViewRef, subscribed: boolean, passive: boolean) => boolean) | null = null;
let remoteComputer: ((view: string, subscribed: boolean) => void) | null = null;

export function setRemoteViewHandlers(handlers: {
  browser: (view: BrowserViewRef, subscribed: boolean, passive: boolean) => boolean;
  computer: (view: string, subscribed: boolean) => void;
}) {
  remoteBrowser = handlers.browser;
  remoteComputer = handlers.computer;
}

/** Hooks invoked when the first/last UI subscribes to a browser live view. */
let onBrowserSubscribe: ((view: BrowserViewRef, subscribed: boolean) => void) | null = null;
/** Hooks invoked when the first/last UI subscribes to a computer live view. */
let onComputerSubscribe: ((view: string, subscribed: boolean) => void) | null = null;

export function setComputerSubscriptionHandler(fn: (view: string, subscribed: boolean) => void) {
  onComputerSubscribe = fn;
}

export function hasComputerSubscribers(view: string): boolean {
  return (computerSubscribers.get(view) ?? 0) > 0;
}

/** Views someone is watching right now. */
export function subscribedComputerViews(): string[] {
  return [...computerSubscribers.keys()];
}

export function setBrowserSubscriptionHandler(fn: (view: BrowserViewRef, subscribed: boolean) => void) {
  onBrowserSubscribe = fn;
}

/** Someone subscribed to a live view of the profile (with `conversationId`: to that chat's). */
export function hasBrowserSubscribers(profileId: string, conversationId?: string): boolean {
  return anyView(browserSubscribers, profileId, conversationId);
}

/** A non-passive viewer is watching the profile's (or the chat's) live view, so it counts as in use. */
export function hasBrowserWatchers(profileId: string, conversationId?: string): boolean {
  return anyView(browserWatchers, profileId, conversationId);
}

/** Live views of the profile someone subscribed to. */
export function subscribedBrowserViews(profileId: string): BrowserViewRef[] {
  return [...browserSubscribers.keys()].map((key) => browserViews.get(key)!).filter((v) => v?.profileId === profileId);
}

function anyView(counts: Map<string, number>, profileId: string, conversationId?: string): boolean {
  if (conversationId) return (counts.get(browserView(profileId, conversationId)) ?? 0) > 0;
  for (const key of counts.keys()) if (browserViews.get(key)?.profileId === profileId) return true;
  return false;
}

function bump(counts: Map<string, number>, key: string, by: number): number {
  const next = Math.max(0, (counts.get(key) ?? 0) + by);
  if (next) counts.set(key, next);
  else counts.delete(key);
  return next;
}

function send(ws: ServerWebSocket<WsData>, event: ServerEvent) {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    /* ignore */
  }
}

bus.on((event) => {
  if (event.type === "browser.frame") {
    const key = `browser:${browserView(event.profileId, event.conversationId)}`;
    for (const ws of clients) if (ws.data.subscriptions.has(key)) send(ws, event);
    return;
  }
  if (event.type === "computer.frame" || event.type === "computer.action") {
    const payload = JSON.stringify(event);
    for (const ws of clients) {
      if (!ws.data.subscriptions.has(`computer:${event.view}`)) continue;
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
    return;
  }
  if (event.type === "run.delta") return sendDelta(event);
  if (event.type === "run.finished" || event.type === "run.paused") forgetWhole(event.run.id);
  const payload = timedSync(`send ${event.type}`, () => JSON.stringify(event));
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      /* ignore */
    }
  }
});

/** Streaming replies are frequent; phones only get them for the chats they have open. */
function wantsDeltas(ws: ServerWebSocket<WsData>, conversationId: string): boolean {
  return ws.data.auth !== "device" || !!ws.data.conversations?.has(conversationId);
}

/**
 * How often a client that doesn't apply patches gets the whole block list of a run: often enough for text to stream,
 * and once a second when the list has grown heavy (screenshots).
 */
const WHOLE_EVERY_MS = 200;
const WHOLE_HEAVY_EVERY_MS = 1000;
const WHOLE_HEAVY_BYTES = 1_000_000;
const whole = new Map<string, { at: number; every: number; timer: ReturnType<typeof setTimeout> | null }>();

function forgetWhole(runId: string) {
  const w = whole.get(runId);
  if (w?.timer) clearTimeout(w.timer);
  whole.delete(runId);
}

/** The run's whole block list to the clients that don't apply patches (megabytes in a long run: see WHOLE_EVERY_MS). */
function sendWhole(runId: string) {
  const w = whole.get(runId) ?? { at: 0, every: WHOLE_EVERY_MS, timer: null };
  whole.set(runId, w);
  if (w.timer) return;
  const wait = w.at + w.every - Date.now();
  if (wait > 0) {
    w.timer = setTimeout(() => {
      w.timer = null;
      sendWhole(runId);
    }, wait);
    return;
  }
  const snapshot = runSnapshots({ runId })[0];
  if (!snapshot) return forgetWhole(runId);
  w.at = Date.now();
  const payload = timedSync("send run delta (whole list)", () => JSON.stringify(snapshot));
  w.every = payload.length > WHOLE_HEAVY_BYTES ? WHOLE_HEAVY_EVERY_MS : WHOLE_EVERY_MS;
  for (const ws of clients) {
    if (ws.data.patches || !wantsDeltas(ws, snapshot.conversationId)) continue;
    try {
      ws.send(payload);
    } catch {
      /* ignore */
    }
  }
}

function sendDelta(event: RunDelta) {
  let payload: string | null = null;
  let others = false;
  for (const ws of clients) {
    if (!wantsDeltas(ws, event.conversationId)) continue;
    // A delta that carries the whole list suits every client.
    if (!ws.data.patches && !event.blocks) {
      others = true;
      continue;
    }
    payload ??= JSON.stringify(event);
    try {
      ws.send(payload);
    } catch {
      /* ignore */
    }
  }
  if (others) sendWhole(event.runId);
}

const MAX_CONVERSATIONS_PER_SOCKET = 20;

function deviceOnline(deviceId: string): boolean {
  for (const ws of clients) if (ws.data.deviceId === deviceId) return true;
  return false;
}

setDeviceSocketHooks({
  online: deviceOnline,
  revoked: (deviceId) => {
    for (const ws of clients) {
      if (ws.data.deviceId !== deviceId) continue;
      try {
        ws.close(4003, "Phone removed");
      } catch {
        /* already closing */
      }
    }
  },
});

const ID = /^[\w-]{1,100}$/;

function changeSubscription(ws: ServerWebSocket<WsData>, ref: BrowserViewRef, subscribe: boolean, passive = false) {
  if (!ID.test(ref.profileId) || (ref.conversationId !== null && !ID.test(ref.conversationId))) return;
  const view = browserView(ref.profileId, ref.conversationId);
  const key = `browser:${view}`;
  const has = ws.data.subscriptions.has(key);
  const wasWatching = has && !ws.data.passive?.has(key);
  const watching = subscribe && !passive;
  if (subscribe) browserViews.set(view, ref);
  if (wasWatching !== watching) bump(browserWatchers, view, watching ? 1 : -1);
  if (subscribe && passive) (ws.data.passive ??= new Set()).add(key);
  else ws.data.passive?.delete(key);

  if (subscribe === has) return;
  if (subscribe) ws.data.subscriptions.add(key);
  else ws.data.subscriptions.delete(key);
  const count = bump(browserSubscribers, view, subscribe ? 1 : -1);
  if (!count && !browserWatchers.has(view)) browserViews.delete(view);
  if ((subscribe && count === 1) || (!subscribe && count === 0)) {
    if (!remoteBrowser?.(ref, subscribe, passive)) onBrowserSubscribe?.(ref, subscribe);
  }
}

/** Views are "display:<id>", "window:<pid>:<id>" or "tab:<profile>:<target>", a runner's prefixed with "runner:<id>:" — keep keys bounded. */
function validView(view: unknown): view is string {
  return typeof view === "string" && view.length > 0 && view.length <= 300 && /^(runner:[A-Za-z0-9_-]{1,100}:)?(display|window|tab):/.test(view);
}

function changeComputerSubscription(ws: ServerWebSocket<WsData>, view: string, subscribe: boolean) {
  const key = `computer:${view}`;
  const has = ws.data.subscriptions.has(key);
  if (subscribe === has) return;
  if (subscribe) ws.data.subscriptions.add(key);
  else ws.data.subscriptions.delete(key);
  const count = bump(computerSubscribers, view, subscribe ? 1 : -1);
  if ((subscribe && count === 1) || (!subscribe && count === 0)) {
    // A runner's screen is never this computer's to capture, whether or not a runner handles it.
    if (view.startsWith("runner:")) remoteComputer?.(view, subscribe);
    else onComputerSubscribe?.(view, subscribe);
  }
}

export const websocketHandler = {
  open(ws: ServerWebSocket<WsData>) {
    const wasOnline = ws.data.deviceId ? deviceOnline(ws.data.deviceId) : true;
    clients.add(ws);
    const welcome = welcomeEvents();
    // The runs active right now: the app drops whatever else it still shows as live (they ended while it was away).
    const activeRunIds = welcome.flatMap((e) => (e.type === "run.started" ? [e.run.id] : []));
    send(ws, { type: "hello", version: VERSION, serverTime: new Date().toISOString(), activeRunIds });
    for (const event of welcome) send(ws, event);
    // What runs have written so far: the stored message lags behind, and later deltas only say what changed.
    if (ws.data.auth !== "device") for (const event of runSnapshots({})) send(ws, event);
    for (const more of moreWelcomeEvents) {
      try {
        for (const event of more()) send(ws, event);
      } catch (err) {
        log.warn("welcome events failed", err);
      }
    }
    if (!wasOnline) bus.changed("mobile");
  },
  message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    let msg: ClientEvent;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
    } catch {
      return;
    }
    switch (msg.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "browser.subscribe":
        changeSubscription(ws, { profileId: msg.profileId, conversationId: msg.conversationId ?? null }, true, msg.passive === true);
        break;
      case "browser.unsubscribe":
        changeSubscription(ws, { profileId: msg.profileId, conversationId: msg.conversationId ?? null }, false);
        break;
      case "computer.subscribe":
        if (validView(msg.view) && (ws.data.auth !== "device" || deviceMayUseView(msg.view))) changeComputerSubscription(ws, msg.view, true);
        break;
      case "computer.unsubscribe":
        if (validView(msg.view)) changeComputerSubscription(ws, msg.view, false);
        break;
      case "conversation.subscribe":
        if (typeof msg.conversationId !== "string" || msg.conversationId.length > 100) break;
        ws.data.conversations ??= new Set();
        if (ws.data.conversations.size < MAX_CONVERSATIONS_PER_SOCKET) ws.data.conversations.add(msg.conversationId);
        if (ws.data.conversations.has(msg.conversationId)) for (const event of runSnapshots({ conversationId: msg.conversationId })) send(ws, event);
        break;
      case "conversation.unsubscribe":
        if (typeof msg.conversationId === "string") ws.data.conversations?.delete(msg.conversationId);
        break;
      case "deltas.patch":
        ws.data.patches = true;
        break;
      case "run.resync":
        if (typeof msg.runId !== "string" || msg.runId.length > 100) break;
        for (const event of runSnapshots({ runId: msg.runId })) if (wantsDeltas(ws, event.conversationId)) send(ws, event);
        break;
    }
  },
  close(ws: ServerWebSocket<WsData>) {
    for (const key of [...ws.data.subscriptions]) {
      const view = key.startsWith("browser:") ? browserViews.get(key.slice(8)) : undefined;
      if (view) changeSubscription(ws, view, false);
      else if (key.startsWith("computer:")) changeComputerSubscription(ws, key.slice(9), false);
    }
    clients.delete(ws);
    if (ws.data.deviceId && !deviceOnline(ws.data.deviceId)) bus.changed("mobile");
  },
  error(_ws: ServerWebSocket<WsData>, err: Error) {
    log.warn("websocket error", err);
  },
};

/** Close every socket that authenticated with a session cookie (sessions were revoked). */
export function closeSessionSockets(): number {
  let closed = 0;
  for (const ws of clients) {
    if (ws.data.auth !== "session") continue;
    try {
      ws.close(4001, "Session ended");
    } catch {
      /* already closing */
    }
    clients.delete(ws);
    closed++;
  }
  return closed;
}

export function clientCount() {
  return clients.size;
}
