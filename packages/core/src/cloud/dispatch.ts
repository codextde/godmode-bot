/**
 * Serves the streams of one cloud link connection in-process: relayed HTTP requests go to the Hono app, relayed
 * WebSockets to the hub in server/ws.ts through virtual sockets. Everything here belongs to one connection object:
 * when its socket closes every stream is torn down and whatever a handler produces later is discarded, so an answer
 * can never reach a request of a later link that happens to reuse the stream id.
 */
import {
  CLOUD_BODY_MAX,
  CLOUD_CHUNK,
  CLOUD_FRAME_HEADER,
  CLOUD_MOBILE_STREAMS_MAX,
  CLOUD_STREAMS_MAX,
  CLOUD_WINDOW,
  CLOUD_WS_BACKLOG_MAX,
  CLOUD_WS_CLIENT_MESSAGE_MAX,
  CLOUD_WS_MESSAGE_MAX,
  CloudCredit,
  CloudErrorCode,
  CloudFrame,
  CloudWindow,
  cloudFrameJson,
  cloudFrameText,
  decodeCloudWindow,
  encodeCloudFrame,
  encodeCloudWindow,
  type CloudAbort,
  type CloudChannel,
  type CloudFrameData,
  type CloudHeaders,
  type CloudRelayUser,
  type CloudReqHead,
  type CloudResHead,
  type CloudWsClose,
  type CloudWsOpen,
  type CloudWsReject,
} from "@godmode/shared";
import { logger } from "../log";
import { getSettings } from "../services/settings";
import { newId } from "../util";
import type { CloudRelayEnv } from "../server/auth";
import type { HubSocket, WsData } from "../server/ws";
import { servePhoneRequest } from "../mobile/access";
import { authenticateDevice } from "../mobile/devices";
import { viewerMaySend } from "./scope";

const log = logger("cloud");

/** Largest ReqHead or WsOpen the computer reads, whatever the cloud allows. */
const HEAD_MAX = 64 * 1024;

export const BROWSER_ACCESS_OFF = "Browser access is turned off on this computer. Turn it on under Settings → Cloud.";
const PHONE_ACCESS_OFF = "This computer doesn't accept phones through Godmode Cloud right now.";

export interface CloudApp {
  fetch(request: Request, env: object): Response | Promise<Response>;
}

/** The parts of server/ws.ts's `websocketHandler` a relayed socket drives. */
export interface CloudHub {
  open(ws: HubSocket): void;
  message(ws: HubSocket, raw: string | Buffer): void;
  close(ws: HubSocket): void;
}

export interface CloudHandler {
  app: CloudApp;
  websocket: CloudHub;
}

/** The cloud broke the framing rules: the link is closed with CloudClose.Protocol. */
export class CloudProtocolError extends Error {}

export interface ConnectionOptions {
  handler: CloudHandler;
  /** Writes one frame to this connection's socket, and to no other. */
  send(frame: Uint8Array<ArrayBuffer>): void;
  /** A cloud user reached this computer (audit log and the daily notice). */
  onCloudUse?(user: CloudRelayUser, ip: string | null): void;
}

interface HttpStream {
  id: number;
  channel: CloudChannel;
  abort: AbortController;
  body: RequestBody | null;
  /** Credit for response body bytes. */
  window: CloudWindow;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  answered: boolean;
  over: boolean;
}

/**
 * A relayed request body. ReqBody payloads wait here (never more than CLOUD_WINDOW, the cloud's credit) and the Request
 * pulls them one at a time. Credit goes back only for bytes the handler has taken, so a handler that reads late holds
 * the cloud back instead of piling the body up in memory, and never waits for bytes the cloud has no credit to send.
 */
class RequestBody {
  private queue: Uint8Array[] = [];
  private ended = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private readonly credit = new CloudCredit();
  private ungranted = 0;
  received = 0;
  readonly stream: ReadableStream<Uint8Array>;

  constructor(grant: (bytes: number) => void) {
    this.stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (!this.queue.length && !this.ended && !this.failure) await new Promise<void>((resolve) => (this.wake = resolve));
          if (this.failure) {
            controller.error(this.failure);
            return;
          }
          const chunk = this.queue.shift();
          if (!chunk) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          const credit = this.credit.consumed(chunk.byteLength);
          if (credit) {
            this.ungranted -= credit;
            grant(credit);
          }
        },
        cancel: () => this.fail(new Error("The request body was not read.")),
      },
      { highWaterMark: 0 },
    );
  }

  /** False when the cloud sent more than its credit allows. */
  push(chunk: Uint8Array): boolean {
    if (this.ended || this.failure) return true;
    this.received += chunk.byteLength;
    this.ungranted += chunk.byteLength;
    if (this.ungranted > CLOUD_WINDOW) return false;
    this.queue.push(chunk);
    this.poke();
    return true;
  }

  end() {
    this.ended = true;
    this.poke();
  }

  fail(err: Error) {
    if (this.failure) return;
    this.failure = err;
    this.queue = [];
    this.poke();
  }

  private poke() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

/**
 * A browser's or phone's WebSocket relayed through the link, as the hub sees it. Bytes sent count as buffered until the
 * cloud acknowledges them with Window (once it wrote them to the client), so the hub skips live frames for a slow
 * client; far behind, the socket closes itself with 1013.
 */
class VirtualSocket implements HubSocket {
  private unacked = 0;
  private closed = false;

  constructor(
    private readonly conn: CloudConnection,
    private readonly hub: CloudHub,
    readonly stream: number,
    readonly channel: CloudChannel,
    private readonly viewer: boolean,
    readonly data: WsData,
  ) {}

  send(message: string): number {
    if (this.closed) return 0;
    const frame = encodeCloudFrame(CloudFrame.WsText, this.stream, message);
    const bytes = frame.byteLength - CLOUD_FRAME_HEADER;
    if (bytes > CLOUD_WS_MESSAGE_MAX) return 0;
    if (this.unacked + bytes > CLOUD_WS_BACKLOG_MAX) {
      this.close(1013, "The connection is too slow.");
      return 0;
    }
    this.unacked += bytes;
    this.conn.write(frame);
    return bytes;
  }

  getBufferedAmount(): number {
    return this.unacked;
  }

  acknowledge(bytes: number) {
    this.unacked = Math.max(0, this.unacked - bytes);
  }

  /** Closed by the hub or this computer: tell the cloud. Idempotent. */
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.conn.write(encodeCloudFrame(CloudFrame.WsClose, this.stream, { code, reason } satisfies CloudWsClose));
    this.end();
  }

  /** Closed by the cloud, or the link went away: nothing to tell. Idempotent. */
  drop() {
    if (this.closed) return;
    this.closed = true;
    this.end();
  }

  receive(frame: CloudFrameData) {
    if (this.closed) return;
    if (frame.payload.byteLength > CLOUD_WS_CLIENT_MESSAGE_MAX) {
      this.close(1009, "Message too big.");
      return;
    }
    const raw = frame.type === CloudFrame.WsText ? cloudFrameText(frame) : Buffer.from(frame.payload);
    if (this.viewer && !viewerMaySend(typeof raw === "string" ? raw : raw.toString("utf8"))) return;
    this.hub.message(this, raw);
  }

  private end() {
    this.conn.forget(this);
    this.hub.close(this);
  }
}

function header(headers: CloudHeaders, name: string): string | null {
  return headers.find(([n]) => n.toLowerCase() === name)?.[1] ?? null;
}

function validHeaders(value: unknown): value is CloudHeaders {
  return Array.isArray(value) && value.length <= 256 && value.every((h) => Array.isArray(h) && h.length === 2 && typeof h[0] === "string" && typeof h[1] === "string");
}

function validUser(value: unknown): value is CloudRelayUser {
  const u = value as CloudRelayUser | null;
  return !!u && typeof u === "object" && typeof u.id === "string" && typeof u.email === "string" && ["owner", "operator", "viewer"].includes(u.role);
}

function validChannel(head: { channel?: unknown; user?: unknown }): boolean {
  return head.channel === "mobile" || (head.channel === "cloud" && validUser(head.user));
}

function relayedIp(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, 100) : null;
}

export class CloudConnection {
  private readonly streams = new Map<number, HttpStream>();
  private readonly sockets = new Map<number, VirtualSocket>();
  private closed = false;

  constructor(private readonly opts: ConnectionOptions) {}

  /** One frame of a stream (id ≠ 0). Throws CloudProtocolError when the cloud broke the framing rules. */
  handle(frame: CloudFrameData): void {
    if (this.closed) return;
    const id = frame.stream;
    switch (frame.type) {
      case CloudFrame.ReqHead:
        this.onReqHead(frame);
        return;
      case CloudFrame.WsOpen:
        this.onWsOpen(frame);
        return;
      case CloudFrame.ReqBody: {
        const s = this.streams.get(id);
        if (!s?.body) return;
        if (!s.body.push(frame.payload.slice())) throw new CloudProtocolError("The cloud sent more request body than its window allows.");
        if (s.body.received > CLOUD_BODY_MAX) this.refuseBody(s);
        return;
      }
      case CloudFrame.ReqEnd:
        this.streams.get(id)?.body?.end();
        return;
      case CloudFrame.Window: {
        const bytes = decodeCloudWindow(frame);
        this.streams.get(id)?.window.grant(bytes);
        this.sockets.get(id)?.acknowledge(bytes);
        return;
      }
      case CloudFrame.Abort: {
        const s = this.streams.get(id);
        if (s) this.teardown(s, true);
        // On a WebSocket stream Abort counts as WsClose 1011.
        this.sockets.get(id)?.drop();
        return;
      }
      case CloudFrame.WsText:
      case CloudFrame.WsBinary:
        this.sockets.get(id)?.receive(frame);
        return;
      case CloudFrame.WsClose:
        this.sockets.get(id)?.drop();
        return;
      default:
        throw new CloudProtocolError(`Unexpected frame type ${frame.type}.`);
    }
  }

  /** The link socket is gone: every stream and socket of this connection ends; later output is discarded. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.streams.values()]) this.teardown(s, true);
    for (const socket of [...this.sockets.values()]) socket.drop();
  }

  /** Close the relayed sockets of one channel, telling the cloud (access was turned off on this computer). */
  closeSockets(channel: CloudChannel, code: number, reason: string) {
    for (const socket of [...this.sockets.values()]) if (socket.channel === channel) socket.close(code, reason);
  }

  /** Open streams and sockets (tests and diagnostics). */
  get size(): { streams: number; sockets: number } {
    return { streams: this.streams.size, sockets: this.sockets.size };
  }

  write(frame: Uint8Array<ArrayBuffer>) {
    if (!this.closed) this.opts.send(frame);
  }

  forget(socket: VirtualSocket) {
    if (this.sockets.get(socket.stream) === socket) this.sockets.delete(socket.stream);
  }

  private isOpen(id: number): boolean {
    return this.streams.has(id) || this.sockets.has(id);
  }

  /** More open than the limits allow, counting `adding` that are about to open. */
  private busy(channel: CloudChannel, adding: number): boolean {
    if (this.streams.size + this.sockets.size + adding > CLOUD_STREAMS_MAX) return true;
    if (channel !== "mobile") return false;
    let mobile = adding;
    for (const s of this.streams.values()) if (s.channel === "mobile") mobile++;
    for (const s of this.sockets.values()) if (s.channel === "mobile") mobile++;
    return mobile > CLOUD_MOBILE_STREAMS_MAX;
  }

  /* ---------------------------------------------------------------- */
  /* HTTP                                                              */
  /* ---------------------------------------------------------------- */

  private onReqHead(frame: CloudFrameData) {
    const id = frame.stream;
    if (id === 0 || this.isOpen(id)) throw new CloudProtocolError("ReqHead for a stream that is already open.");
    const s: HttpStream = { id, channel: "cloud", abort: new AbortController(), body: null, window: new CloudWindow(), reader: null, answered: false, over: false };
    this.streams.set(id, s);
    if (frame.payload.byteLength > HEAD_MAX) {
      this.answer(s, 431, "The request headers are too large.", "bad_request");
      return;
    }
    const head = cloudFrameJson<CloudReqHead>(frame);
    if (!head || typeof head.method !== "string" || typeof head.path !== "string" || typeof head.hasBody !== "boolean" || !validHeaders(head.headers) || !validChannel(head)) {
      this.streams.delete(id);
      throw new CloudProtocolError("ReqHead can't be read.");
    }
    s.channel = head.channel;
    void this.serve(s, head);
  }

  private async serve(s: HttpStream, head: CloudReqHead) {
    const settings = getSettings();
    if (head.channel === "mobile" && !(settings.mobile.enabled && settings.cloud.phoneAccess)) {
      return this.answer(s, 503, PHONE_ACCESS_OFF, CloudErrorCode.DeviceOffline);
    }
    if (head.channel === "cloud" && !settings.cloud.browserAccess) return this.answer(s, 403, BROWSER_ACCESS_OFF, CloudErrorCode.CloudForbidden);
    if (this.busy(head.channel, 0)) return this.answer(s, 429, "Too many requests at once. Try again in a moment.", CloudErrorCode.RateLimited, [["retry-after", "1"]]);
    if (!head.path.startsWith("/api/")) return this.answer(s, 404, "Not found", "not_found");
    const method = head.method.toUpperCase();
    const hasBody = head.hasBody && method !== "GET" && method !== "HEAD";
    if (Number(header(head.headers, "content-length") ?? 0) > CLOUD_BODY_MAX) {
      return this.answer(s, 413, "The upload is too large to send through Godmode Cloud.", CloudErrorCode.BodyTooLarge);
    }
    const ip = relayedIp(head.ip);
    let req: Request;
    try {
      const headers = new Headers();
      for (const [name, value] of head.headers) {
        const lower = name.toLowerCase();
        // Who is asking comes from the channel, never from a cookie or (for browsers) a bearer token.
        if (lower === "cookie" || lower === "host" || (head.channel === "cloud" && lower === "authorization")) continue;
        headers.append(name, value);
      }
      if (hasBody) s.body = new RequestBody((bytes) => this.send(s, encodeCloudWindow(s.id, bytes)));
      req = new Request(`http://cloud.link${head.path}`, { method, headers, body: s.body?.stream ?? null, signal: s.abort.signal, duplex: "half" } as RequestInit);
    } catch {
      return this.answer(s, 400, "This request can't be read.", "bad_request");
    }
    const user = head.channel === "cloud" ? head.user : null;
    if (user) this.opts.onCloudUse?.(user, ip);
    const env: CloudRelayEnv = { channel: head.channel, cloud: { user, ip } };
    let res: Response;
    try {
      res = await (head.channel === "mobile" ? servePhoneRequest(this.opts.handler.app, req, env) : this.opts.handler.app.fetch(req, env));
    } catch (err) {
      if (!s.over) log.warn("relayed request failed", err);
      return this.abort(s, "The computer could not answer.");
    }
    await this.respond(s, res, method === "HEAD");
  }

  private async respond(s: HttpStream, res: Response, head: boolean) {
    if (s.over) {
      void res.body?.cancel().catch(() => {});
      return;
    }
    s.answered = true;
    this.send(s, encodeCloudFrame(CloudFrame.ResHead, s.id, { status: res.status, headers: [...res.headers] } satisfies CloudResHead));
    if (!res.body || head) {
      void res.body?.cancel().catch(() => {});
      return this.end(s);
    }
    const reader = res.body.getReader();
    s.reader = reader;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (s.over) return;
        for (let offset = 0; offset < value.byteLength; offset += CLOUD_CHUNK) {
          const piece = value.subarray(offset, offset + CLOUD_CHUNK);
          await s.window.take(piece.byteLength);
          if (s.over) return;
          this.send(s, encodeCloudFrame(CloudFrame.ResBody, s.id, piece));
        }
      }
      this.end(s);
    } catch (err) {
      if (s.over) return;
      log.warn("relayed response failed", err);
      this.abort(s, "The computer could not finish the answer.");
    }
  }

  /** A short JSON answer from dispatch itself (refusals, limits). */
  private answer(s: HttpStream, status: number, error: string, code: string, extra: CloudHeaders = []) {
    if (s.over) return;
    s.answered = true;
    const headers: CloudHeaders = [["content-type", "application/json"], ...extra];
    this.send(s, encodeCloudFrame(CloudFrame.ResHead, s.id, { status, headers } satisfies CloudResHead));
    this.send(s, encodeCloudFrame(CloudFrame.ResBody, s.id, { error, code }));
    this.end(s);
  }

  private refuseBody(s: HttpStream) {
    const message = "The upload is too large to send through Godmode Cloud.";
    if (s.answered) this.abort(s, message);
    else {
      // The handler may still be waiting for the rest; it ends with an error that is discarded.
      s.abort.abort();
      this.answer(s, 413, message, CloudErrorCode.BodyTooLarge);
    }
  }

  private end(s: HttpStream) {
    this.send(s, encodeCloudFrame(CloudFrame.ResEnd, s.id));
    this.teardown(s, false);
  }

  private abort(s: HttpStream, reason: string) {
    this.send(s, encodeCloudFrame(CloudFrame.Abort, s.id, { reason } satisfies CloudAbort));
    this.teardown(s, true);
  }

  private teardown(s: HttpStream, interrupted: boolean) {
    if (s.over) return;
    s.over = true;
    if (this.streams.get(s.id) === s) this.streams.delete(s.id);
    s.window.close();
    s.body?.fail(new Error("The request ended."));
    if (interrupted) {
      s.abort.abort();
      void s.reader?.cancel().catch(() => {});
    }
  }

  private send(s: HttpStream, frame: Uint8Array<ArrayBuffer>) {
    if (!s.over) this.write(frame);
  }

  /* ---------------------------------------------------------------- */
  /* WebSockets                                                        */
  /* ---------------------------------------------------------------- */

  private onWsOpen(frame: CloudFrameData) {
    const id = frame.stream;
    if (id === 0 || this.isOpen(id)) throw new CloudProtocolError("WsOpen for a stream that is already open.");
    if (frame.payload.byteLength > HEAD_MAX) return this.reject(id, 431, "The request headers are too large.");
    const open = cloudFrameJson<CloudWsOpen>(frame);
    if (!open || typeof open.path !== "string" || !validHeaders(open.headers) || !validChannel(open)) throw new CloudProtocolError("WsOpen can't be read.");
    const settings = getSettings();
    if (open.path !== "/api/ws") return this.reject(id, 404, "Not found");
    if (open.channel === "mobile" && !(settings.mobile.enabled && settings.cloud.phoneAccess)) return this.reject(id, 503, PHONE_ACCESS_OFF);
    if (open.channel === "cloud" && !settings.cloud.browserAccess) return this.reject(id, 403, BROWSER_ACCESS_OFF);
    if (this.busy(open.channel, 1)) return this.reject(id, 429, "Too many connections at once.");
    const ip = relayedIp(open.ip);
    let data: WsData;
    if (open.channel === "mobile") {
      const auth = header(open.headers, "authorization") ?? "";
      const device = auth.startsWith("Bearer ") ? authenticateDevice(auth.slice(7).trim(), ip ?? undefined) : null;
      if (!device) return this.reject(id, 401, "Unauthorized");
      data = { id: newId("ws"), subscriptions: new Set(), auth: "device", deviceId: device.id };
    } else {
      data = { id: newId("ws"), subscriptions: new Set(), auth: "cloud" };
      this.opts.onCloudUse?.(open.user!, ip);
    }
    const viewer = open.channel === "cloud" && open.user!.role === "viewer";
    const socket = new VirtualSocket(this, this.opts.handler.websocket, id, open.channel, viewer, data);
    this.sockets.set(id, socket);
    // The hub greets a socket as soon as it opens: the cloud must know it was accepted first.
    this.write(encodeCloudFrame(CloudFrame.WsAccept, id));
    this.opts.handler.websocket.open(socket);
  }

  private reject(id: number, status: number, message: string) {
    this.write(encodeCloudFrame(CloudFrame.WsReject, id, { status, message } satisfies CloudWsReject));
  }
}
