/**
 * Minimal Pusher Channels client (protocol 7) for one private channel: connect, authorize the channel, deliver its
 * events, keep the connection alive (ping/pong) and reconnect with backoff. Used for Composio's realtime trigger feed.
 * https://pusher.com/docs/channels/library_auth_reference/pusher-websockets-protocol/
 */
import { logger } from "../log";

const log = logger("pusher");

const PONG_TIMEOUT_MS = 30_000;
const MAX_ACTIVITY_TIMEOUT_MS = 120_000;
const MAX_BACKOFF_MS = 60_000;

export type PusherStatus = "connecting" | "connected" | "error" | "closed";

export interface PusherOptions {
  key: string;
  cluster: string;
  /** Private channel to subscribe to, e.g. "private-<project>_triggers". */
  channel: string;
  /** Signature for the private channel ("<key>:<signature>"), from the app's auth endpoint. */
  authorize: (socketId: string, channel: string) => Promise<string>;
  onEvent: (event: string, data: unknown) => void;
  onStatus: (status: PusherStatus, message?: string) => void;
  /** Tests: a different endpoint / WebSocket implementation. */
  url?: string;
  WebSocketImpl?: new (url: string) => WebSocket;
}

function decode(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class PusherConnection {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private activityTimeoutMs = MAX_ACTIVITY_TIMEOUT_MS;
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: PusherOptions) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  /** Closed for good: by `close()`, or by the server with a code that forbids reconnecting. */
  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000);
    } catch {
      /* already closed */
    }
    this.opts.onStatus("closed");
  }

  get url(): string {
    return (
      this.opts.url ??
      `wss://ws-${encodeURIComponent(this.opts.cluster)}.pusher.com/app/${encodeURIComponent(this.opts.key)}?protocol=7&client=godmode&version=1.0.0&flash=false`
    );
  }

  private connect() {
    if (this.closed) return;
    this.opts.onStatus("connecting");
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(this.url);
    } catch (err) {
      this.opts.onStatus("error", err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.onClose(ev.code, ev.reason);
    };
    ws.onerror = () => {
      /* a close event follows */
    };
  }

  private send(event: string, data: unknown) {
    try {
      this.ws?.send(JSON.stringify({ event, data }));
    } catch (err) {
      log.debug("send failed", err);
    }
  }

  private onMessage(raw: string) {
    this.armActivityTimer();
    let msg: { event?: string; channel?: string; data?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const data = decode(msg.data);
    switch (msg.event) {
      case "pusher:connection_established": {
        const info = (data ?? {}) as { socket_id?: string; activity_timeout?: number };
        if (typeof info.activity_timeout === "number" && info.activity_timeout > 0) {
          this.activityTimeoutMs = Math.min(info.activity_timeout * 1000, MAX_ACTIVITY_TIMEOUT_MS);
        }
        this.armActivityTimer();
        if (info.socket_id) void this.subscribe(info.socket_id);
        return;
      }
      case "pusher:ping":
        this.send("pusher:pong", {});
        return;
      case "pusher:pong":
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      case "pusher_internal:subscription_succeeded":
        this.attempts = 0;
        this.opts.onStatus("connected");
        return;
      case "pusher:subscription_error": {
        const info = (data ?? {}) as { error?: string; status?: number };
        this.opts.onStatus("error", `The realtime channel was refused${info.status ? ` (HTTP ${info.status})` : ""}${info.error ? `: ${info.error}` : ""}`);
        this.ws?.close(4100);
        return;
      }
      case "pusher:error": {
        const info = (data ?? {}) as { code?: number; message?: string };
        log.warn(`pusher error ${info.code ?? ""}: ${info.message ?? ""}`);
        return;
      }
      default:
        if (msg.event && msg.channel === this.opts.channel) this.opts.onEvent(msg.event, data);
    }
  }

  private async subscribe(socketId: string) {
    try {
      const auth = await this.opts.authorize(socketId, this.opts.channel);
      if (this.closed) return;
      this.send("pusher:subscribe", { channel: this.opts.channel, auth });
    } catch (err) {
      this.opts.onStatus("error", err instanceof Error ? err.message : String(err));
      this.ws?.close(4100);
    }
  }

  private onClose(code: number, reason: string) {
    this.clearTimers();
    this.ws = null;
    if (this.closed) return;
    // 4000–4099: Pusher says don't retry with the same settings (bad key, app disabled, over quota).
    if (code >= 4000 && code < 4100) {
      this.closed = true;
      this.opts.onStatus("error", `The realtime service closed the connection (${code}${reason ? `: ${reason}` : ""})`);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.attempts, MAX_BACKOFF_MS) + Math.floor(Math.random() * 500);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** After a quiet period, ping; without a pong the connection is dead and is replaced. */
  private armActivityTimer() {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => {
      this.send("pusher:ping", {});
      this.pongTimer = setTimeout(() => {
        log.info("no pong from pusher, reconnecting");
        const ws = this.ws;
        this.ws = null;
        this.clearTimers();
        try {
          ws?.close(4201);
        } catch {
          /* already closed */
        }
        this.scheduleReconnect();
      }, PONG_TIMEOUT_MS);
      this.pongTimer.unref?.();
    }, this.activityTimeoutMs);
    this.activityTimer.unref?.();
  }

  private clearTimers() {
    for (const t of [this.activityTimer, this.pongTimer, this.reconnectTimer]) if (t) clearTimeout(t);
    this.activityTimer = this.pongTimer = this.reconnectTimer = null;
  }
}
