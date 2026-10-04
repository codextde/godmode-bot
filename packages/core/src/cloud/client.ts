/**
 * The cloud link: one outbound WebSocket to the cloud this computer is linked to, carrying every relayed request and
 * socket (framing in @godmode/shared cloud.ts). Hello, then Welcome; a Ping when nothing was sent for a while; a link
 * that went quiet is replaced; reconnects back off depending on why the cloud closed the link.
 */
import {
  CLOUD_CONNECT_PATH,
  CLOUD_DEAD_MS,
  CLOUD_PING_MS,
  CloudClose,
  CloudFrame,
  cloudBearer,
  cloudFrameJson,
  decodeCloudFrame,
  encodeCloudFrame,
  type CloudFrameData,
  type CloudHello,
  type CloudNotice,
  type CloudWelcome,
} from "@godmode/shared";
import { logger } from "../log";
import { CloudConnection, CloudProtocolError, type CloudHandler, type ConnectionOptions } from "./dispatch";

const log = logger("cloud");

const WELCOME_TIMEOUT_MS = 10_000;
const TICK_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const SLOW_RETRY_MS = 5 * 60_000;
const RATE_LIMITED_RETRY_MS = 60_000;
const REPLACED_RETRY_MS = 30_000;

export const VERSION_MISMATCH = "This Godmode and the cloud don't speak the same version. Update Godmode.";
export const LINK_REPLACED = "Another Godmode is connected with this link.";
export const LINK_REVOKED = "Godmode Cloud no longer knows this computer. Link it again to reconnect.";
const UNREACHABLE = "Godmode Cloud can't be reached right now.";

/** Bun's client WebSocket takes headers as a second argument; the DOM typings don't know that. */
export type CloudWebSocketCtor = new (url: string, options: { headers: Record<string, string> }) => WebSocket;

export type CloudClientState = "connecting" | "online" | "offline" | "blocked" | "revoked";

const FIXED_DELAY_CODES = new Set<number>([CloudClose.Protocol, CloudClose.PlanRequired, CloudClose.Disabled, CloudClose.RateLimited]);

/** How long to wait before dialing again after the link closed with `code`. */
export function retryDelay(code: number, attempts: number, replaced: number): number {
  switch (code) {
    case CloudClose.Protocol:
    case CloudClose.PlanRequired:
    case CloudClose.Disabled:
      return SLOW_RETRY_MS;
    case CloudClose.RateLimited:
      return RATE_LIMITED_RETRY_MS;
    case CloudClose.Replaced:
      return Math.min(REPLACED_RETRY_MS * 2 ** replaced, SLOW_RETRY_MS);
    default:
      return Math.min(1000 * 2 ** attempts, MAX_BACKOFF_MS);
  }
}

export interface CloudClientOptions {
  /** The cloud's origin. */
  url: string;
  deviceId: string;
  secret: string;
  handler: CloudHandler;
  hello(): CloudHello;
  onWelcome(welcome: CloudWelcome): void;
  onNotice(notice: CloudNotice): void;
  onState(state: CloudClientState, error: string | null): void;
  onCloudUse?: ConnectionOptions["onCloudUse"];
  /** Tests: another WebSocket implementation. */
  WebSocketImpl?: CloudWebSocketCtor;
}

/** A cloud reason worth showing when it is a sentence; otherwise ours. */
function sentence(reason: string, fallback: string): string {
  const text = reason.trim();
  return text.length > 10 && text.length <= 300 && text.endsWith(".") ? text : fallback;
}

export class CloudClient {
  private ws: WebSocket | null = null;
  private conn: CloudConnection | null = null;
  private stopped = true;
  private state: CloudClientState | null = null;
  private attempts = 0;
  private replaced = 0;
  private welcomedAt = 0;
  private lastSent = 0;
  private lastReceived = 0;
  private helloSent = "";
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: CloudClientOptions) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tickTimer.unref?.();
    this.dial();
  }

  /** Close the link for good: every relayed request and socket ends at once. */
  stop() {
    this.stopped = true;
    for (const t of [this.retryTimer, this.tickTimer]) if (t) clearTimeout(t);
    this.retryTimer = this.tickTimer = null;
    const ws = this.ws;
    this.detach();
    try {
      ws?.close(1000, "Link stopped");
    } catch {
      /* already closed */
    }
  }

  get online(): boolean {
    return this.welcomedAt > 0 && this.ws !== null;
  }

  /** The current connection (tests and diagnostics). */
  get connection(): CloudConnection | null {
    return this.conn;
  }

  /**
   * Send Hello again when what it says changed (name, access switches); the cloud updates its record. Not before
   * Welcome: the cloud only takes one Hello until then, and a change in between is sent once Welcome arrives.
   */
  refreshHello() {
    const ws = this.ws;
    if (ws && ws.readyState === 1 && this.welcomedAt && JSON.stringify(this.opts.hello()) !== this.helloSent) this.sendHello(ws);
  }

  closeSockets(channel: "cloud" | "mobile", code: number, reason: string) {
    this.conn?.closeSockets(channel, code, reason);
  }

  private setState(state: CloudClientState, error: string | null) {
    if (this.state === state && state !== "offline" && state !== "blocked") return;
    this.state = state;
    this.opts.onState(state, error);
  }

  private dial() {
    this.retryTimer = null;
    if (this.stopped) return;
    if (this.state !== "offline" && this.state !== "blocked") this.setState("connecting", null);
    const Impl = this.opts.WebSocketImpl ?? (WebSocket as unknown as CloudWebSocketCtor);
    const url = `${this.opts.url.replace(/^http/, "ws")}${CLOUD_CONNECT_PATH}`;
    let ws: WebSocket;
    try {
      ws = new Impl(url, { headers: { authorization: `Bearer ${cloudBearer(this.opts.deviceId, this.opts.secret)}` } });
    } catch (err) {
      log.warn("could not dial the cloud", err);
      this.setState("offline", UNREACHABLE);
      this.schedule(1006);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.welcomedAt = 0;
    this.lastSent = this.lastReceived = Date.now();
    this.conn = new CloudConnection({ handler: this.opts.handler, send: (frame) => this.write(ws, frame), onCloudUse: this.opts.onCloudUse });
    this.welcomeTimer = setTimeout(() => {
      if (this.ws !== ws || this.welcomedAt) return;
      log.info("no welcome from the cloud, dialing again");
      this.abandon(ws, 1000, "No welcome");
      this.setState("offline", UNREACHABLE);
      this.schedule(1006);
    }, WELCOME_TIMEOUT_MS);
    this.welcomeTimer.unref?.();
    ws.onopen = () => {
      if (this.ws === ws) this.sendHello(ws);
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.receive(ws, ev.data);
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.onClose(ev.code, ev.reason ?? "");
    };
    ws.onerror = () => {
      /* a close event follows */
    };
  }

  private write(ws: WebSocket, frame: Uint8Array<ArrayBuffer>) {
    if (this.ws !== ws || ws.readyState !== 1) return;
    try {
      ws.send(frame);
      this.lastSent = Date.now();
    } catch (err) {
      log.debug("cloud send failed", err);
    }
  }

  private sendHello(ws: WebSocket) {
    const hello = this.opts.hello();
    this.helloSent = JSON.stringify(hello);
    this.write(ws, encodeCloudFrame(CloudFrame.Hello, 0, hello));
  }

  private receive(ws: WebSocket, data: unknown) {
    this.lastReceived = Date.now();
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    const frame = bytes ? decodeCloudFrame(bytes) : null;
    if (!frame) return this.protocolError(ws, "The cloud sent a message that is not a frame.");
    try {
      if (frame.stream === 0) this.linkFrame(ws, frame);
      else this.conn?.handle(frame);
    } catch (err) {
      if (err instanceof CloudProtocolError) this.protocolError(ws, err.message);
      else log.warn("cloud frame failed", err);
    }
  }

  private linkFrame(ws: WebSocket, frame: CloudFrameData) {
    switch (frame.type) {
      case CloudFrame.Ping:
        this.write(ws, encodeCloudFrame(CloudFrame.Pong, 0));
        return;
      case CloudFrame.Pong:
        return;
      case CloudFrame.Welcome: {
        const welcome = cloudFrameJson<CloudWelcome>(frame);
        if (!welcome || typeof welcome.deviceId !== "string") throw new CloudProtocolError("Welcome can't be read.");
        if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
        this.welcomeTimer = null;
        this.welcomedAt = Date.now();
        this.attempts = 0;
        this.opts.onWelcome(welcome);
        this.setState("online", null);
        this.refreshHello();
        return;
      }
      case CloudFrame.Notice: {
        const notice = cloudFrameJson<CloudNotice>(frame);
        if (notice) this.opts.onNotice(notice);
        return;
      }
      default:
        throw new CloudProtocolError(`Unexpected link frame ${frame.type}.`);
    }
  }

  private onClose(code: number, reason: string) {
    const onlineFor = this.welcomedAt ? Date.now() - this.welcomedAt : 0;
    this.detach();
    if (this.stopped) return;
    log.info("cloud link closed", { code, reason: reason.slice(0, 200) });
    switch (code) {
      case CloudClose.BadCredential:
        this.stopped = true;
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.tickTimer = null;
        this.setState("revoked", LINK_REVOKED);
        return;
      case CloudClose.PlanRequired:
        this.setState("blocked", sentence(reason, "Your Godmode Cloud plan doesn't include this computer right now."));
        break;
      case CloudClose.Disabled:
        this.setState("blocked", sentence(reason, "This computer is turned off in Godmode Cloud."));
        break;
      case CloudClose.Replaced:
        // Two computers sharing one link would take turns forever; a link that held for a while starts over.
        if (onlineFor > 2 * SLOW_RETRY_MS) this.replaced = 0;
        this.setState("offline", LINK_REPLACED);
        break;
      case CloudClose.RateLimited:
        this.setState("offline", "Godmode Cloud asked this computer to wait a minute before connecting again.");
        break;
      case CloudClose.Protocol:
        this.setState("offline", VERSION_MISMATCH);
        break;
      default:
        this.setState("offline", UNREACHABLE);
    }
    this.schedule(code);
  }

  private protocolError(ws: WebSocket, message: string) {
    log.warn("cloud link protocol error", { message });
    this.abandon(ws, CloudClose.Protocol, "Protocol error");
    this.setState("offline", VERSION_MISMATCH);
    this.schedule(CloudClose.Protocol);
  }

  private schedule(code: number) {
    if (this.stopped || this.retryTimer) return;
    const delay = retryDelay(code, this.attempts, this.replaced);
    if (code === CloudClose.Replaced) this.replaced++;
    else if (!FIXED_DELAY_CODES.has(code)) this.attempts++;
    const jitter = Math.floor(Math.random() * Math.min(1000, delay / 4));
    this.retryTimer = setTimeout(() => this.dial(), delay + jitter);
    this.retryTimer.unref?.();
  }

  /** Nothing arrived for too long: replace the link. Nothing sent for a while: ping. */
  private tick() {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    const t = Date.now();
    if (t - this.lastReceived > CLOUD_DEAD_MS) {
      log.info("the cloud link went quiet, dialing again");
      this.abandon(ws, 1000, "No answer");
      this.setState("offline", UNREACHABLE);
      this.schedule(1006);
      return;
    }
    if (t - this.lastSent >= CLOUD_PING_MS) this.write(ws, encodeCloudFrame(CloudFrame.Ping, 0));
  }

  /** Stop using this socket now; its later events are ignored. */
  private abandon(ws: WebSocket, code: number, reason: string) {
    this.detach();
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  private detach() {
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
    this.ws = null;
    this.welcomedAt = 0;
    const conn = this.conn;
    this.conn = null;
    conn?.close();
  }
}
