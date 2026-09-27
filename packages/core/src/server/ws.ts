import type { ServerWebSocket } from "bun";
import type { ClientEvent, ServerEvent } from "@godmode/shared";
import { bus } from "../events/bus";
import { VERSION } from "../config";
import { logger } from "../log";

const log = logger("ws");

export interface WsData {
  id: string;
  subscriptions: Set<string>;
  /** Subscriptions that only watch — they don't keep an idle browser running. */
  passive?: Set<string>;
  /** How the socket authenticated; cookie sessions are closed when sessions are revoked. */
  auth?: "token" | "session";
}

const clients = new Set<ServerWebSocket<WsData>>();
const browserSubscribers = new Map<string, number>();
const browserWatchers = new Map<string, number>();

/** Hooks invoked when the first/last UI subscribes to a browser live view. */
let onBrowserSubscribe: ((profileId: string, subscribed: boolean) => void) | null = null;

export function setBrowserSubscriptionHandler(fn: (profileId: string, subscribed: boolean) => void) {
  onBrowserSubscribe = fn;
}

export function hasBrowserSubscribers(profileId: string): boolean {
  return (browserSubscribers.get(profileId) ?? 0) > 0;
}

/** A non-passive viewer is watching the live view, so the browser counts as in use. */
export function hasBrowserWatchers(profileId: string): boolean {
  return (browserWatchers.get(profileId) ?? 0) > 0;
}

function bump(counts: Map<string, number>, profileId: string, by: number): number {
  const next = Math.max(0, (counts.get(profileId) ?? 0) + by);
  if (next) counts.set(profileId, next);
  else counts.delete(profileId);
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
    for (const ws of clients) if (ws.data.subscriptions.has(`browser:${event.profileId}`)) send(ws, event);
    return;
  }
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      /* ignore */
    }
  }
});

function changeSubscription(ws: ServerWebSocket<WsData>, profileId: string, subscribe: boolean, passive = false) {
  const key = `browser:${profileId}`;
  const has = ws.data.subscriptions.has(key);
  const wasWatching = has && !ws.data.passive?.has(key);
  const watching = subscribe && !passive;
  if (wasWatching !== watching) bump(browserWatchers, profileId, watching ? 1 : -1);
  if (subscribe && passive) (ws.data.passive ??= new Set()).add(key);
  else ws.data.passive?.delete(key);

  if (subscribe === has) return;
  if (subscribe) ws.data.subscriptions.add(key);
  else ws.data.subscriptions.delete(key);
  const count = bump(browserSubscribers, profileId, subscribe ? 1 : -1);
  if ((subscribe && count === 1) || (!subscribe && count === 0)) onBrowserSubscribe?.(profileId, subscribe);
}

export const websocketHandler = {
  open(ws: ServerWebSocket<WsData>) {
    clients.add(ws);
    send(ws, { type: "hello", version: VERSION, serverTime: new Date().toISOString() });
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
        changeSubscription(ws, msg.profileId, true, msg.passive === true);
        break;
      case "browser.unsubscribe":
        changeSubscription(ws, msg.profileId, false);
        break;
    }
  },
  close(ws: ServerWebSocket<WsData>) {
    for (const key of ws.data.subscriptions) {
      if (key.startsWith("browser:")) changeSubscription(ws, key.slice(8), false);
    }
    clients.delete(ws);
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
