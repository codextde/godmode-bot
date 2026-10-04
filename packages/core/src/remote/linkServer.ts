/**
 * The runner's end of the link: a listener on every interface that speaks only the encrypted link protocol.
 *
 *   GET /        → "godmode-runner" (lets people and scripts see that something is there)
 *   GET /link    → WebSocket; each one gets a SecureChannel responder
 *
 * A controller that completed the handshake is as trusted as the owner of this runner: its requests (`req`) go into
 * the runner's own API with the master token, and it gets the runner's events through a virtual WebSocket client
 * registered with the hub in server/ws.ts — exactly what a Godmode app on this computer would see. Nothing else is
 * reachable from the network: the API itself stays on loopback.
 */
import { hostname as osHostname, platform, arch } from "node:os";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Hono } from "hono";
import { LINK_PROTOCOL, RUNNER_DEFAULT_PORT, type ClientEvent, type RunnerInfo } from "@godmode/shared";
import { VERSION } from "../config";
import { all, get, getMeta, insert, run as sql, setMeta } from "../db";
import { logger } from "../log";
import { computerName } from "../mobile/devices";
import { listActiveRuns } from "../runner/runner";
import { getAccessToken } from "../server/auth";
import type { WsData } from "../server/ws";
import { audit } from "../services/audit";
import { newId, now } from "../util";
import * as vault from "../vault/vault";
import { LinkError, SecureChannel, type LinkPeer, type Transport } from "./channel";
import { canonicalKey, controllerLookupId } from "./crypto";
import { loadIdentity } from "./identity";
import { consumePairing, lookupPairing } from "./pairing";
import { appliedDigest } from "./snapshot";

const log = logger("link");

/** Ports tried after the configured one when it is taken. */
const PORT_TRIES = 20;
const HANDSHAKES_PER_MINUTE = 30;
/** Above this much unsent data, events that the next one replaces anyway (frames, streaming text) are dropped. */
const BACKPRESSURE_BYTES = 16 * 1024 * 1024;
/** Events larger than this go as a binary stream (a JSON frame holds at most 1 MiB). */
const STREAM_EVENT_BYTES = 256 * 1024;
/** Request bodies that arrived and wait for the request that names them. */
const MAX_PENDING_BODIES = 32;
const SUPERSEDED = ['{"type":"browser.frame"', '{"type":"computer.frame"', '{"type":"run.delta"'];
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
/** Headers a controller may set on a forwarded request; the rest (auth, cookies, host, origin, forwarding) are ours. */
const FORWARD_HEADERS = new Set(["content-type", "accept", "x-godmode-grant"]);
const RESPONSE_HEADERS = ["content-type", "content-disposition", "cache-control"];

interface Handler {
  app: Hono;
  websocket: WebSocketHandler<WsData>;
}

interface LinkSocketData {
  ip: string;
  channel: SecureChannel<LinkPeer> | null;
  link: Link | null;
}

/** One controller connected through a finished handshake. */
interface Link {
  id: string;
  controllerId: string;
  controllerKey: string;
  name: string;
  socket: ServerWebSocket<LinkSocketData>;
  channel: SecureChannel<LinkPeer>;
  /** What the hub sees: a socket authenticated with the master token. */
  client: VirtualClient;
  bodies: Map<number, Uint8Array>;
  nextStream: number;
}

interface VirtualClient {
  data: WsData;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
}

let handler: Handler | null = null;
let server: Server<LinkSocketData> | null = null;
let boundPort: number | null = null;
const links = new Set<Link>();
const attempts = new Map<string, { count: number; first: number }>();

/* ------------------------------------------------------------------ */
/* Controllers                                                          */
/* ------------------------------------------------------------------ */

interface ControllerRow {
  id: string;
  name: string;
  public_key: string;
  last_seen_at: string | null;
  last_address: string | null;
  created_at: string;
}

function lookupController(idHash: string): string | null {
  for (const row of all<{ public_key: string }>("SELECT public_key FROM link_controllers")) {
    try {
      if (controllerLookupId(row.public_key) === idHash) return row.public_key;
    } catch {
      /* a damaged row never matches */
    }
  }
  return null;
}

/** The handshake's `onPaired`: store the controller and use the code up, before the runner answers. */
function registerController(controllerKey: string, name: string): void {
  const key = canonicalKey(controllerKey);
  const existing = get<{ id: string }>("SELECT id FROM link_controllers WHERE public_key = ?", key);
  if (existing) sql("UPDATE link_controllers SET name = ? WHERE id = ?", name || "Godmode", existing.id);
  else insert("link_controllers", { id: newId("lctl"), name: name || "Godmode", public_key: key, created_at: now() });
  consumePairing();
  audit("controller", "runner.paired", existing?.id ?? null, { name });
  log.info("paired with a controller", { name });
}

export function runnerInfo(): RunnerInfo {
  const v = vault.status();
  return {
    name: computerName(),
    hostname: osHostname(),
    platform: platform(),
    arch: arch(),
    version: VERSION,
    protocol: LINK_PROTOCOL,
    vault: { initialized: v.initialized, unlocked: v.unlocked },
    configDigest: appliedDigest(),
    activeRuns: listActiveRuns().length,
  };
}

/** Paired controllers and whether they are connected now. */
export function linkStatus(): { port: number | null; controllers: { id: string; name: string; online: boolean; lastSeenAt: string | null }[] } {
  const online = new Set([...links].map((l) => l.controllerId));
  return {
    port: boundPort,
    controllers: all<ControllerRow>("SELECT * FROM link_controllers ORDER BY created_at").map((r) => ({
      id: r.id,
      name: r.name,
      online: online.has(r.id),
      lastSeenAt: r.last_seen_at,
    })),
  };
}

/** Forget a controller: its row goes and its link closes. */
export function forgetController(controllerId: string): void {
  sql("DELETE FROM link_controllers WHERE id = ?", controllerId);
  for (const link of [...links]) if (link.controllerId === controllerId) link.channel.close();
  audit("controller", "runner.forget", controllerId);
}

/* ------------------------------------------------------------------ */
/* Listener                                                             */
/* ------------------------------------------------------------------ */

function configuredPort(): number {
  const raw = getMeta("link.port");
  if (raw === null) return RUNNER_DEFAULT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : RUNNER_DEFAULT_PORT;
}

function allowHandshake(ip: string): boolean {
  const t = Date.now();
  if (attempts.size > 1000) for (const [k, v] of attempts) if (t - v.first > 60_000) attempts.delete(k);
  const entry = attempts.get(ip);
  if (!entry || t - entry.first > 60_000) {
    attempts.set(ip, { count: 1, first: t });
    return true;
  }
  return ++entry.count <= HANDSHAKES_PER_MINUTE;
}

/**
 * Start listening for controllers. The port is meta `link.port` (0 = any free port), else RUNNER_DEFAULT_PORT; when it
 * is taken the next ones are tried. The port actually bound is written back, so the runner stays where it was paired.
 */
export function startLinkServer(h: Handler): number | null {
  if (server) return boundPort;
  handler = h;
  const wanted = configuredPort();
  const candidates = wanted === 0 ? [0] : Array.from({ length: PORT_TRIES + 1 }, (_, i) => wanted + i).filter((p) => p <= 65535);
  let lastError: unknown = null;
  for (const port of candidates) {
    try {
      server = Bun.serve<LinkSocketData>({
        hostname: "0.0.0.0",
        port,
        idleTimeout: 60,
        fetch: (req, srv) => {
          const path = new URL(req.url).pathname;
          if (path === "/link") {
            const ip = srv.requestIP(req)?.address ?? "unknown";
            if (!allowHandshake(ip)) return new Response("Too many attempts", { status: 429 });
            const ok = srv.upgrade(req, { data: { ip, channel: null, link: null } });
            return ok ? undefined : new Response("Upgrade failed", { status: 400 });
          }
          if (path === "/" && req.method === "GET") return new Response("godmode-runner\n", { headers: { "content-type": "text/plain" } });
          return new Response("Not found", { status: 404 });
        },
        websocket: {
          maxPayloadLength: 2 * 1024 * 1024,
          backpressureLimit: 64 * 1024 * 1024,
          open: onOpen,
          message: (ws, data) => ws.data.channel?.receive(typeof data === "string" ? data : new Uint8Array(data)),
          close: (ws) => ws.data.channel?.close(),
        },
      });
      boundPort = server.port ?? port;
      setMeta("link.port", String(boundPort));
      log.info("listening for controllers", { port: boundPort });
      return boundPort;
    } catch (err) {
      lastError = err;
    }
  }
  log.error("could not listen for controllers", { error: lastError instanceof Error ? lastError.message : String(lastError) });
  return null;
}

export function stopLinkServer(): void {
  for (const link of [...links]) link.channel.close();
  server?.stop(true);
  server = null;
  boundPort = null;
  handler = null;
}

export function linkServerPort(): number | null {
  return boundPort;
}

function onOpen(ws: ServerWebSocket<LinkSocketData>) {
  const transport: Transport = {
    send: (data) => {
      ws.send(data);
    },
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        /* closing already */
      }
    },
  };
  const channel = SecureChannel.responder(transport, {
    identity: loadIdentity(),
    lookupController,
    lookupPairing,
    onPaired: registerController,
    info: runnerInfo,
  });
  ws.data.channel = channel;
  channel.ready.then(
    (peer) => onReady(ws, channel, peer),
    (err: LinkError) => {
      if (err.code !== "closed") log.info("handshake refused", { ip: ws.data.ip, code: err.code });
    },
  );
}

function onReady(ws: ServerWebSocket<LinkSocketData>, channel: SecureChannel<LinkPeer>, peer: LinkPeer) {
  const h = handler;
  const row = get<ControllerRow>("SELECT * FROM link_controllers WHERE public_key = ?", canonicalKey(peer.controllerKey));
  if (!h || !row) {
    channel.close();
    return;
  }
  // One link per controller: a new one (it reconnected) replaces what is left of the old one.
  for (const other of [...links]) if (other.controllerId === row.id) other.channel.close();
  sql("UPDATE link_controllers SET last_seen_at = ?, last_address = ?, name = ? WHERE id = ?", now(), ws.data.ip, peer.name || row.name, row.id);

  const link: Link = {
    id: newId("lnk"),
    controllerId: row.id,
    controllerKey: row.public_key,
    name: peer.name || row.name,
    socket: ws,
    channel,
    client: null as unknown as VirtualClient,
    bodies: new Map(),
    nextStream: 1,
  };
  link.client = {
    data: { id: newId("ws"), subscriptions: new Set(), auth: "token" },
    send: (payload) => sendEvent(link, payload),
    close: () => channel.close(),
  };
  ws.data.link = link;
  links.add(link);
  log.info("controller connected", { name: link.name, ip: ws.data.ip });

  channel.onJson = (message) => void onMessage(h, link, message);
  channel.onBinary = (streamId, bytes) => {
    link.bodies.set(streamId, bytes);
    if (link.bodies.size > MAX_PENDING_BODIES) link.bodies.delete(link.bodies.keys().next().value!);
  };
  channel.onClose = () => {
    links.delete(link);
    link.bodies.clear();
    try {
      h.websocket.close?.(link.client as never, 1000, "");
    } catch (err) {
      log.warn("could not unregister the link from the event hub", err);
    }
    log.info("controller disconnected", { name: link.name });
  };
  h.websocket.open?.(link.client as never);
}

/** An event of the hub, to the controller. Frames and streaming text are dropped while the link is backed up. */
function sendEvent(link: Link, payload: string) {
  try {
    if (link.socket.getBufferedAmount() > BACKPRESSURE_BYTES && SUPERSEDED.some((p) => payload.startsWith(p))) return;
    if (payload.length > STREAM_EVENT_BYTES) {
      const streamId = link.nextStream++;
      link.channel.sendBinary(streamId, Buffer.from(payload, "utf8"));
      link.channel.sendJson({ t: "event", body: streamId });
      return;
    }
    link.channel.sendJson({ t: "event", data: payload });
  } catch (err) {
    if (err instanceof LinkError && err.code === "too_large") log.warn("an event was too large for the link", { bytes: payload.length });
  }
}

async function onMessage(h: Handler, link: Link, message: unknown) {
  if (!message || typeof message !== "object") return;
  const m = message as Record<string, unknown>;
  try {
    switch (m.t) {
      case "ping":
        link.channel.sendJson({ t: "pong", at: m.at });
        return;
      case "client":
        if (m.event && typeof m.event === "object") h.websocket.message(link.client as never, JSON.stringify(m.event as ClientEvent));
        return;
      case "req":
        await answerRequest(h, link, m);
        return;
    }
  } catch (err) {
    if (!(err instanceof LinkError)) log.warn("link message failed", err);
  }
}

async function answerRequest(h: Handler, link: Link, m: Record<string, unknown>) {
  const id = m.id;
  if (typeof id !== "number") return;
  const respond = (status: number, headers: Record<string, string>, body: Uint8Array | null) => {
    let bodyId: number | undefined;
    if (body && body.byteLength) {
      bodyId = link.nextStream++;
      link.channel.sendBinary(bodyId, body);
    }
    link.channel.sendJson({ t: "res", id, status, headers, ...(bodyId ? { body: bodyId } : {}) });
  };
  const fail = (status: number, error: string, code: string) => respond(status, { "content-type": "application/json" }, Buffer.from(JSON.stringify({ error, code })));

  const method = typeof m.method === "string" ? m.method.toUpperCase() : "";
  const raw = typeof m.path === "string" ? m.path : "";
  // Checked as the router will see it: "/api/../api/auth/x" and "/api/%61uth/x" are the sign-in routes too.
  let path = "";
  try {
    if (raw.startsWith("/") && !raw.startsWith("//") && raw.length <= 8192) {
      const url = new URL(raw, "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.startsWith("/api/") && !decoded.startsWith("/api/auth/") && !decoded.includes("/../")) path = url.pathname + url.search;
    }
  } catch {
    path = "";
  }
  if (!ALLOWED_METHODS.has(method) || !path) return fail(400, "Not a request the runner takes", "bad_request");
  let body: Uint8Array | null = null;
  if (typeof m.body === "number") {
    body = link.bodies.get(m.body) ?? null;
    link.bodies.delete(m.body);
    if (!body) return fail(400, "The request's body didn't arrive", "bad_request");
  }
  const headers = new Headers();
  if (m.headers && typeof m.headers === "object") {
    for (const [k, v] of Object.entries(m.headers as Record<string, unknown>)) {
      if (typeof v === "string" && FORWARD_HEADERS.has(k.toLowerCase())) headers.set(k, v);
    }
  }
  headers.set("authorization", `Bearer ${getAccessToken()}`);
  const req = new Request(`http://127.0.0.1${path}`, { method, headers, body: body && method !== "GET" ? (body as Uint8Array<ArrayBuffer>) : undefined });
  let res: Response;
  try {
    res = await h.app.fetch(req, { server, channel: "runner-link", controllerId: link.controllerId });
  } catch (err) {
    log.warn("forwarded request failed", { path: path.split("?")[0], error: err instanceof Error ? err.message : String(err) });
    return fail(500, "The runner couldn't answer that.", "internal");
  }
  const out: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value) out[name] = value;
  }
  respond(res.status, out, new Uint8Array(await res.arrayBuffer()));
}
