/**
 * WebSockets through the link: `/d/<id>/api/ws` (dashboard) and `/gw/<id>/api/ws` (phone).
 *
 * The client's upgrade is held until the computer accepts (WsAccept) or refuses (WsReject, answered as that HTTP
 * status), so a browser or phone only ever sees an open socket the computer agreed to. Messages keep their kind:
 * WsText is sent to the client as a text message, WsBinary as binary (ws sends a Buffer as binary unless told).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import {
  CLOUD_WS_BACKLOG_MAX,
  CLOUD_WS_WINDOW,
  CloudCredit,
  CloudFrame,
  cloudFrameJson,
  encodeCloudFrame,
  encodeCloudWindow,
  isPassableCloseCode,
  type CloudChannel,
  type CloudFrameData,
  type CloudWsOpen,
} from "@godmode/shared";
import { browserAccess, header, phoneAccess, type Grant } from "./access";
import { relayRequestHeaders } from "./http";
import type { RelayHub } from "./hub";
import { LINK_BUFFER_MAX, ProtocolError, type Link, type RelayStream } from "./link";
import { denial, rejectUpgrade, truncateUtf8 } from "./respond";

/** Relayed sockets one computer may have open at once. */
export const SOCKETS_PER_DEVICE = 32;
const ACCEPT_MS = 10_000;

/** What a viewer's dashboard may send: pings and subscriptions that only read. */
const VIEWER_MESSAGES = new Set([
  "ping",
  "conversation.subscribe",
  "conversation.unsubscribe",
  "browser.unsubscribe",
  "computer.subscribe",
  "computer.unsubscribe",
  "deltas.patch",
  "run.resync",
]);

function viewerMaySend(data: Buffer, isBinary: boolean): boolean {
  if (isBinary) return false;
  try {
    const message = JSON.parse(data.toString("utf8")) as { type?: unknown; passive?: unknown } | null;
    if (!message || typeof message !== "object") return false;
    if (message.type === "browser.subscribe") return message.passive === true;
    return typeof message.type === "string" && VIEWER_MESSAGES.has(message.type);
  } catch {
    return false;
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function rejectCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "cloud_forbidden";
  if (status === 503) return "device_offline";
  return "rejected";
}

class WsRelayStream implements RelayStream {
  readonly kind = "ws" as const;
  readonly channel: CloudChannel;
  readonly session: Grant["session"];
  private state: "opening" | "open" | "over" = "opening";
  private client: WebSocket | null = null;
  private readonly credit = new CloudCredit(CLOUD_WS_WINDOW / 4);
  private acceptTimer: NodeJS.Timeout | null = null;
  private alive = true;
  private readonly onRawClose = () => {
    if (this.state !== "opening") return;
    this.link.send(encodeCloudFrame(CloudFrame.Abort, this.id, { reason: "Client went away" }));
    this.finish();
  };

  constructor(
    private readonly link: Link,
    readonly id: number,
    private readonly server: WebSocketServer,
    private readonly req: IncomingMessage,
    private readonly socket: Duplex,
    private readonly head: Buffer,
    private readonly grant: Grant,
  ) {
    this.channel = grant.channel;
    this.session = grant.session;
  }

  start(): void {
    const open: CloudWsOpen = {
      path: "/api/ws",
      headers: relayRequestHeaders(this.req.rawHeaders, this.channel),
      channel: this.channel,
      user: this.grant.user,
      ip: this.grant.ip,
    };
    this.link.send(encodeCloudFrame(CloudFrame.WsOpen, this.id, open));
    this.socket.on("close", this.onRawClose);
    this.acceptTimer = setTimeout(() => {
      if (this.state !== "opening") return;
      this.link.send(encodeCloudFrame(CloudFrame.Abort, this.id, { reason: "No answer" }));
      rejectUpgrade(this.socket, denial(503, "device_offline", "The computer did not answer. Try again."));
      this.finish();
    }, ACCEPT_MS);
    if (this.socket.destroyed) this.onRawClose();
  }

  onFrame(frame: CloudFrameData): void {
    switch (frame.type) {
      case CloudFrame.WsAccept:
        return this.onAccept();
      case CloudFrame.WsReject:
        return this.onReject(frame);
      case CloudFrame.WsText:
      case CloudFrame.WsBinary:
        return this.toClient(frame);
      case CloudFrame.WsClose:
        return this.onComputerClose(frame);
      case CloudFrame.Abort:
        // Abort on a WebSocket stream counts as WsClose 1011.
        if (this.state === "opening") rejectUpgrade(this.socket, denial(502, "link_lost", "The computer refused the connection."));
        else this.closeClient(1011, "The computer ended the connection.");
        this.finish();
        return;
      default:
        throw new ProtocolError("HTTP frame on a WebSocket stream.");
    }
  }

  linkClosed(): void {
    if (this.state === "opening") rejectUpgrade(this.socket, denial(502, "link_lost", "The connection to the computer was lost. Try again."));
    else if (this.state === "open") this.closeClient(1012, "The computer's connection to the cloud was interrupted.");
    this.finish();
  }

  revoke(): void {
    if (this.state === "over") return;
    if (this.state === "opening") {
      this.link.send(encodeCloudFrame(CloudFrame.Abort, this.id, { reason: "Access ended" }));
      rejectUpgrade(this.socket, denial(403, "cloud_forbidden", "Your access to this computer ended."));
      this.finish();
      return;
    }
    this.endBoth(1008, "Your access to this computer ended.");
  }

  heartbeat(): void {
    const client = this.client;
    if (this.state !== "open" || !client) return;
    if (!this.alive) {
      client.terminate();
      return;
    }
    this.alive = false;
    try {
      client.ping();
    } catch {
      client.terminate();
    }
  }

  private onAccept(): void {
    if (this.state !== "opening") throw new ProtocolError("WsAccept on a socket that is not opening.");
    if (this.acceptTimer) clearTimeout(this.acceptTimer);
    this.socket.off("close", this.onRawClose);
    if (this.socket.destroyed) {
      this.link.send(encodeCloudFrame(CloudFrame.WsClose, this.id, { code: 1001, reason: "Client went away" }));
      this.finish();
      return;
    }
    this.state = "open";
    // Synchronous without verifyClient: the client exists before the computer's next frame is handled.
    this.server.handleUpgrade(this.req, this.socket, this.head, (client) => this.attach(client));
    if (!this.client) {
      // ws refused the handshake itself and has answered the client.
      this.link.send(encodeCloudFrame(CloudFrame.WsClose, this.id, { code: 1002, reason: "Handshake failed" }));
      this.finish();
    }
  }

  private onReject(frame: CloudFrameData): void {
    if (this.state !== "opening") throw new ProtocolError("WsReject on a socket that is not opening.");
    const reject = cloudFrameJson<{ status?: unknown; message?: unknown }>(frame);
    const raw = reject?.status;
    const status = typeof raw === "number" && Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 502;
    const message = typeof reject?.message === "string" ? reject.message.slice(0, 500) : "The computer refused the connection.";
    rejectUpgrade(this.socket, denial(status, rejectCode(status), message));
    this.finish();
  }

  private attach(client: WebSocket): void {
    this.client = client;
    client.on("message", (data, isBinary) => this.fromClient(data, isBinary));
    client.on("close", (code, reason) => this.onClientClose(code, reason));
    client.on("error", () => {});
    client.on("pong", () => {
      this.alive = true;
    });
  }

  private toClient(frame: CloudFrameData): void {
    if (this.state === "opening") throw new ProtocolError("Message before WsAccept.");
    const client = this.client;
    if (this.state !== "open" || !client) return;
    if (client.bufferedAmount > CLOUD_WS_BACKLOG_MAX) {
      this.endBoth(1013, "The connection is too slow to keep up.");
      return;
    }
    const n = frame.payload.byteLength;
    this.link.count(0, n, 0);
    client.send(frame.payload, { binary: frame.type === CloudFrame.WsBinary }, (err) => {
      if (err || this.state !== "open") return;
      const grant = this.credit.consumed(n);
      if (grant) this.link.send(encodeCloudWindow(this.id, grant));
    });
  }

  private fromClient(data: RawData, isBinary: boolean): void {
    try {
      if (this.state !== "open") return;
      // A computer that reads slowly must not make the cloud buffer every client's messages.
      if (this.link.backlog > LINK_BUFFER_MAX) {
        this.endBoth(1013, "The computer is busy. Reconnect in a moment.");
        return;
      }
      const bytes = toBuffer(data);
      if (this.session?.role === "viewer" && !viewerMaySend(bytes, isBinary)) return;
      this.link.count(bytes.byteLength, 0, 0);
      this.link.send(encodeCloudFrame(isBinary ? CloudFrame.WsBinary : CloudFrame.WsText, this.id, bytes));
    } catch (err) {
      console.error("[relay] error forwarding a client message:", err);
      this.endBoth(1011, "Internal error.");
    }
  }

  private onClientClose(code: number, reason: Buffer): void {
    if (this.state !== "open") return;
    this.link.send(
      encodeCloudFrame(CloudFrame.WsClose, this.id, { code: isPassableCloseCode(code) ? code : 1000, reason: truncateUtf8(reason.toString("utf8")) }),
    );
    this.finish();
  }

  private onComputerClose(frame: CloudFrameData): void {
    const close = cloudFrameJson<{ code?: unknown; reason?: unknown }>(frame);
    const code = typeof close?.code === "number" && isPassableCloseCode(close.code) ? close.code : 1000;
    const reason = typeof close?.reason === "string" ? truncateUtf8(close.reason) : "";
    if (this.state === "opening") rejectUpgrade(this.socket, denial(502, "link_lost", "The computer refused the connection."));
    else this.closeClient(code, reason);
    this.finish();
  }

  private closeClient(code: number, reason: string): void {
    const client = this.client;
    if (!client) return;
    try {
      client.close(code, truncateUtf8(reason));
    } catch {
      client.terminate();
    }
  }

  /** Ends the socket on both sides with the same code. */
  private endBoth(code: number, reason: string): void {
    if (this.state === "over") return;
    this.link.send(encodeCloudFrame(CloudFrame.WsClose, this.id, { code, reason }));
    this.closeClient(code, reason);
    this.finish();
  }

  private finish(): void {
    if (this.state === "over") return;
    this.state = "over";
    if (this.acceptTimer) clearTimeout(this.acceptTimer);
    this.socket.off("close", this.onRawClose);
    this.link.end(this.id);
    this.link.count(0, 0, 1);
  }
}

const WS_KEY = /^[+/0-9A-Za-z]{22}==$/;

export async function relayWebSocket(
  hub: RelayHub,
  server: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  channel: CloudChannel,
  deviceId: string,
  ip: string,
): Promise<void> {
  // A broken handshake is refused here rather than after the computer was asked.
  const version = header(req.headers, "sec-websocket-version");
  if (!WS_KEY.test(header(req.headers, "sec-websocket-key") ?? "") || (version !== "13" && version !== "8")) {
    return rejectUpgrade(socket, denial(400, "bad_request", "Not a WebSocket handshake."));
  }
  const result =
    channel === "cloud"
      ? await browserAccess(req, ip, deviceId, "/api/ws", "ws")
      : await phoneAccess(hub.gatewayUnauthorized, req, ip, deviceId, "/api/ws", "ws");
  if (!result.ok) return rejectUpgrade(socket, result.denial);
  if (socket.destroyed) return;
  const link = hub.link(deviceId);
  if (!link) return rejectUpgrade(socket, denial(503, "device_offline", "This computer is offline."));
  if (link.socketCount >= SOCKETS_PER_DEVICE) {
    return rejectUpgrade(socket, denial(429, "rate_limited", "Too many open connections to this computer.", 5_000));
  }
  const stream = link.open(channel, "ws", (id) => new WsRelayStream(link, id, server, req, socket, head, result.grant));
  if (!stream) return rejectUpgrade(socket, denial(429, "rate_limited", "This computer is busy. Try again in a moment.", 1_000));
  stream.start();
}
