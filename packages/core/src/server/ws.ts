import type { ServerWebSocket } from "bun";
import { browserView, type ClientEvent, type ServerEvent } from "@godmode/shared";
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

export function setWelcomeEvents(fn: () => ServerEvent[]) {
  welcomeEvents = fn;
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
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    // Streaming replies are large and frequent; phones only get them for the chats they have open.
    if (event.type === "run.delta" && ws.data.auth === "device" && !ws.data.conversations?.has(event.conversationId)) continue;
    try {
      ws.send(payload);
    } catch {
      /* ignore */
    }
  }
});

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
  if ((subscribe && count === 1) || (!subscribe && count === 0)) onBrowserSubscribe?.(ref, subscribe);
}

/** Views are "display:<id>", "window:<pid>:<id>" or "tab:<profile>:<target>" — keep keys bounded. */
function validView(view: unknown): view is string {
  return typeof view === "string" && view.length > 0 && view.length <= 300 && /^(display|window|tab):/.test(view);
}

function changeComputerSubscription(ws: ServerWebSocket<WsData>, view: string, subscribe: boolean) {
  const key = `computer:${view}`;
  const has = ws.data.subscriptions.has(key);
  if (subscribe === has) return;
  if (subscribe) ws.data.subscriptions.add(key);
  else ws.data.subscriptions.delete(key);
  const count = bump(computerSubscribers, view, subscribe ? 1 : -1);
  if ((subscribe && count === 1) || (!subscribe && count === 0)) onComputerSubscribe?.(view, subscribe);
}

export const websocketHandler = {
  open(ws: ServerWebSocket<WsData>) {
    const wasOnline = ws.data.deviceId ? deviceOnline(ws.data.deviceId) : true;
    clients.add(ws);
    send(ws, { type: "hello", version: VERSION, serverTime: new Date().toISOString() });
    for (const event of welcomeEvents()) send(ws, event);
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
        break;
      case "conversation.unsubscribe":
        if (typeof msg.conversationId === "string") ws.data.conversations?.delete(msg.conversationId);
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
