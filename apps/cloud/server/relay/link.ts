/**
 * One computer's link: a WebSocket carrying many streams (packages/shared/src/cloud.ts has the framing rules). A Link
 * object owns its stream table; frames are only ever delivered to streams that were opened on this very object, so a
 * replaced or dropped socket can never answer someone else's request.
 *
 * Everything the computer sends is untrusted. The message handler never lets an exception out: a broken or abusive
 * frame closes this link with Protocol, a bug of ours while handling one with 1011 (the computer just reconnects), and
 * the rest of the process is left alone.
 */
import { randomInt } from "node:crypto";
import type { RawData, WebSocket } from "ws";
import {
  CLOUD_DEAD_MS,
  CLOUD_MOBILE_STREAMS_MAX,
  CLOUD_PING_MS,
  CLOUD_PROTOCOL,
  CLOUD_STREAMS_MAX,
  CloudClose,
  CloudFrame,
  cloudFrameJson,
  decodeCloudFrame,
  encodeCloudFrame,
  type CloudAccessRole,
  type CloudAccount,
  type CloudChannel,
  type CloudFrameData,
  type CloudHello,
  type CloudNotice,
} from "@godmode/shared";
import type { RelayLinkInfo } from "@/server/relay-bridge";
import { truncateUtf8 } from "./respond";

/** Bytes queued on the link's socket before body pumps wait for it to drain. Twice this closes the link. */
export const LINK_BUFFER_MAX = 8 * 1024 * 1024;
/**
 * WebSocket bytes from the computer not yet granted back, over all of one link's sockets. Each socket may run up to
 * CLOUD_WS_BACKLOG_MAX ahead; this bounds what one computer can make the cloud hold however many sockets it has.
 */
export const LINK_WS_UNGRANTED_MAX = 64 * 1024 * 1024;
const HELLO_MS = 10_000;
const TICK_MS = 5_000;
/** A later Hello updates the computer's record at most this often; the newest one wins. */
export const HELLO_UPDATE_MS = 10_000;
/** More Hellos than this in a minute is a computer gone wrong. */
const HELLOS_PER_MINUTE = 10;
const NOT_READING = "The computer is not reading.";

/** The computer broke the protocol; the link is closed with CloudClose.Protocol. */
export class ProtocolError extends Error {}

/** Who is behind a cloud-channel stream, for the relay's re-check every minute. */
export interface StreamSession {
  token: string;
  userId: string;
  deviceId: string;
  role: CloudAccessRole;
}

export interface RelayStream {
  readonly kind: "http" | "ws";
  readonly channel: CloudChannel;
  readonly session: StreamSession | null;
  /** A frame for this stream from the computer. Throwing ProtocolError closes the link. */
  onFrame(frame: CloudFrameData): void;
  /** The link is gone: fail the client. Must not send frames. */
  linkClosed(): void;
  /** The person's access ended while the stream was open. */
  revoke(): void;
  /** Every 30 s: lets client sockets notice a dead peer. */
  heartbeat?(): void;
}

export interface LinkHooks {
  /** First valid Hello: register the link and send Welcome. A rejection closes the link with 1011. */
  welcome(link: Link, hello: CloudHello): Promise<void>;
  /** A later Hello: the computer's name or access switches changed. */
  update(link: Link, hello: CloudHello): void;
  closed(link: Link): void;
}

export interface LinkIdentity {
  deviceId: string;
  userId: string;
  account: CloudAccount;
  ip: string | null;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.trim().slice(0, max) : null;
}

/** The Hello payload, checked field by field; null when anything is missing or of the wrong type. */
function parseHello(frame: CloudFrameData): CloudHello | null {
  const raw = cloudFrameJson<Record<string, unknown>>(frame);
  if (!raw || typeof raw.protocol !== "number") return null;
  const version = str(raw.version, 40);
  const instanceId = str(raw.instanceId, 200);
  const name = str(raw.name, 80);
  const platform = str(raw.platform, 40);
  if (version === null || instanceId === null || name === null || platform === null) return null;
  if (typeof raw.browserAccess !== "boolean" || typeof raw.phoneAccess !== "boolean") return null;
  return { protocol: raw.protocol, version, instanceId, name, platform, browserAccess: raw.browserAccess, phoneAccess: raw.phoneAccess };
}

export class Link {
  readonly deviceId: string;
  readonly userId: string;
  readonly account: CloudAccount;
  readonly ip: string | null;
  readonly connectedAt = new Date();
  version = "";
  closed = false;
  /** Traffic since the last usage flush. */
  private unflushed = { bytesIn: 0, bytesOut: 0, requests: 0 };
  readonly totals = { bytesIn: 0, bytesOut: 0 };
  private readonly streams = new Map<number, RelayStream>();
  private mobileStreams = 0;
  private sockets = 0;
  // A random start makes a stale id from an earlier link of the same computer meaningless here.
  private nextId = 1 + randomInt(2 ** 30);
  private queued = 0;
  /** WebSocket payload bytes the computer sent beyond the credit it got back, summed over this link's sockets. */
  wsUngranted = 0;
  private drainWaiters: (() => void)[] = [];
  private lastIn = Date.now();
  private lastOut = Date.now();
  private hello: "waiting" | "pending" | "done" = "waiting";
  /** The newest Hello not applied yet (sent while Welcome was pending, or within HELLO_UPDATE_MS of the last update). */
  private latestHello: CloudHello | null = null;
  private lastUpdate = 0;
  private updateTimer: NodeJS.Timeout | null = null;
  private hellos = { count: 0, since: Date.now() };
  private readonly helloTimer: NodeJS.Timeout;
  private readonly tickTimer: NodeJS.Timeout;

  constructor(
    private readonly ws: WebSocket,
    identity: LinkIdentity,
    private readonly hooks: LinkHooks,
  ) {
    this.deviceId = identity.deviceId;
    this.userId = identity.userId;
    this.account = identity.account;
    this.ip = identity.ip;
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", () => this.teardown());
    ws.on("error", (err) => console.warn(`[relay] link ${this.deviceId}: ${err.message}`));
    this.helloTimer = setTimeout(() => this.close(CloudClose.Protocol, "No Hello received."), HELLO_MS);
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  get welcomed(): boolean {
    return this.hello === "done" && !this.closed;
  }

  get streamCount(): number {
    return this.streams.size - this.sockets;
  }

  get socketCount(): number {
    return this.sockets;
  }

  /** Bytes handed to the socket that it has not written out yet. */
  get backlog(): number {
    return this.queued;
  }

  send(frame: Uint8Array): boolean {
    if (this.closed) return false;
    const n = frame.byteLength;
    // Pumps wait at LINK_BUFFER_MAX; only a computer that stopped reading gets this far.
    if (this.queued + n > 2 * LINK_BUFFER_MAX) {
      this.close(CloudClose.Protocol, NOT_READING);
      return false;
    }
    this.queued += n;
    this.lastOut = Date.now();
    try {
      this.ws.send(frame, { binary: true }, () => {
        this.queued -= n;
        if (this.queued <= LINK_BUFFER_MAX) this.wake();
      });
      return true;
    } catch {
      this.queued -= n;
      return false;
    }
  }

  /** Resolves once the socket has room again (or the link closed). */
  drained(): Promise<void> {
    if (this.closed || this.queued <= LINK_BUFFER_MAX) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private wake(): void {
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

  /** Opens a stream; null when the link is closed or the stream caps are reached. */
  open<S extends RelayStream>(channel: CloudChannel, kind: "http" | "ws", make: (id: number) => S): S | null {
    if (!this.welcomed || this.streams.size >= CLOUD_STREAMS_MAX) return null;
    if (channel === "mobile" && this.mobileStreams >= CLOUD_MOBILE_STREAMS_MAX) return null;
    let id = this.nextId;
    while (this.streams.has(id)) id = id >= 0xffffffff ? 1 : id + 1;
    this.nextId = id >= 0xffffffff ? 1 : id + 1;
    const stream = make(id);
    this.streams.set(id, stream);
    if (channel === "mobile") this.mobileStreams++;
    if (kind === "ws") this.sockets++;
    return stream;
  }

  /** The stream is over: frames for its id are ignored from now on. */
  end(id: number): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    if (stream.channel === "mobile") this.mobileStreams--;
    if (stream.kind === "ws") this.sockets--;
  }

  streamList(): RelayStream[] {
    return [...this.streams.values()];
  }

  count(bytesIn: number, bytesOut: number, requests: number): void {
    this.unflushed.bytesIn += bytesIn;
    this.unflushed.bytesOut += bytesOut;
    this.unflushed.requests += requests;
    this.totals.bytesIn += bytesIn;
    this.totals.bytesOut += bytesOut;
  }

  /** Hands over the traffic since the last call, for recordUsage. */
  takeUsage(): { bytesIn: number; bytesOut: number; requests: number } {
    const usage = this.unflushed;
    this.unflushed = { bytesIn: 0, bytesOut: 0, requests: 0 };
    return usage;
  }

  notify(notice: CloudNotice): void {
    if (this.welcomed) this.send(encodeCloudFrame(CloudFrame.Notice, 0, notice));
  }

  info(): RelayLinkInfo {
    return {
      deviceId: this.deviceId,
      userId: this.userId,
      connectedAt: this.connectedAt.toISOString(),
      ip: this.ip,
      version: this.version,
      streams: this.streamCount,
      sockets: this.sockets,
      bytesIn: this.totals.bytesIn,
      bytesOut: this.totals.bytesOut,
    };
  }

  /** Closes the link with a code the computer understands. Open streams fail at once. */
  close(code: number, reason: string): void {
    if (this.closed) return;
    try {
      this.ws.close(code, truncateUtf8(reason));
    } catch {
      this.ws.terminate();
    }
    // A peer that never completes the close handshake must not keep the socket.
    setTimeout(() => this.ws.terminate(), 5_000).unref();
    this.teardown();
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    try {
      if (!isBinary) throw new ProtocolError("Text message on the link.");
      const frame = decodeCloudFrame(toBuffer(data));
      if (!frame) throw new ProtocolError("Undecodable frame.");
      this.lastIn = Date.now();
      this.handle(frame);
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.close(CloudClose.Protocol, err.message);
        return;
      }
      // Our own bug: the computer must not back off for minutes and be told to update.
      console.error(`[relay] link ${this.deviceId}: error while handling a frame:`, err);
      this.close(1011, "Internal error.");
    }
  }

  private handle(frame: CloudFrameData): void {
    switch (frame.type) {
      case CloudFrame.Ping:
        // Every Pong is queued behind what the computer has not read: pinging without reading would pile them up.
        if (this.queued > LINK_BUFFER_MAX) throw new ProtocolError(NOT_READING);
        this.send(encodeCloudFrame(CloudFrame.Pong, 0));
        return;
      case CloudFrame.Pong:
        return;
      case CloudFrame.Hello:
        this.onHello(frame);
        return;
      case CloudFrame.ResHead:
      case CloudFrame.ResBody:
      case CloudFrame.ResEnd:
      case CloudFrame.Abort:
      case CloudFrame.Window:
      case CloudFrame.WsAccept:
      case CloudFrame.WsReject:
      case CloudFrame.WsText:
      case CloudFrame.WsBinary:
      case CloudFrame.WsClose: {
        if (this.hello === "waiting") throw new ProtocolError("Stream frame before Hello.");
        // Frames for streams that are over cross on the wire; they are not an error.
        this.streams.get(frame.stream)?.onFrame(frame);
        return;
      }
      default:
        throw new ProtocolError(`Frame type ${frame.type} is not allowed from a computer.`);
    }
  }

  private onHello(frame: CloudFrameData): void {
    const hello = parseHello(frame);
    if (!hello) throw new ProtocolError("Malformed Hello.");
    if (hello.protocol !== CLOUD_PROTOCOL) {
      this.close(CloudClose.Protocol, "This Godmode and the cloud don't speak the same version.");
      return;
    }
    const now = Date.now();
    if (now - this.hellos.since >= 60_000) this.hellos = { count: 0, since: now };
    if (++this.hellos.count > HELLOS_PER_MINUTE) throw new ProtocolError("Too many Hello frames.");
    this.version = hello.version;
    if (this.hello !== "waiting") {
      // Only the newest counts: applied once welcomed, then at most every HELLO_UPDATE_MS.
      this.latestHello = hello;
      this.applyHello();
      return;
    }
    this.hello = "pending";
    clearTimeout(this.helloTimer);
    this.hooks.welcome(this, hello).then(
      () => this.applyHello(),
      (err: unknown) => {
        console.error(`[relay] link ${this.deviceId}: could not welcome:`, err);
        this.close(1011, "Internal error.");
      },
    );
  }

  /** Hands the newest Hello to hooks.update, now or when HELLO_UPDATE_MS have passed since the last one. */
  private applyHello(): void {
    if (!this.welcomed || !this.latestHello || this.updateTimer) return;
    const wait = this.lastUpdate + HELLO_UPDATE_MS - Date.now();
    if (wait > 0) {
      this.updateTimer = setTimeout(() => {
        this.updateTimer = null;
        this.applyHello();
      }, wait);
      return;
    }
    const hello = this.latestHello;
    this.latestHello = null;
    this.lastUpdate = Date.now();
    this.hooks.update(this, hello);
  }

  /** Called by the hub right before it registers the link and sends Welcome; streams may open from now on. */
  markWelcomed(): void {
    if (!this.closed) this.hello = "done";
  }

  private tick(): void {
    const now = Date.now();
    if (now - this.lastIn > CLOUD_DEAD_MS) {
      this.ws.terminate();
      this.teardown();
      return;
    }
    if (now - this.lastOut >= CLOUD_PING_MS) this.send(encodeCloudFrame(CloudFrame.Ping, 0));
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    clearInterval(this.tickTimer);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    const streams = [...this.streams.values()];
    this.streams.clear();
    this.mobileStreams = 0;
    this.sockets = 0;
    for (const stream of streams) {
      try {
        stream.linkClosed();
      } catch (err) {
        console.error(`[relay] link ${this.deviceId}: error while failing a stream:`, err);
      }
    }
    this.wake();
    this.hooks.closed(this);
  }
}
