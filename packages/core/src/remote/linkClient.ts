/**
 * The controller's end of the link to one runner: dials it (each known address in turn), keeps the connection up
 * (reconnects with backoff, pings), and carries requests into the runner's API and the runner's events back.
 *
 *   C → R  { t: "req", id, method, path, headers?, body?: streamId }    body as a binary stream sent just before
 *   R → C  { t: "res", id, status, headers, body?: streamId }
 *   C → R  { t: "client", event }                                       what a UI sends on /api/ws
 *   R → C  { t: "event", data } | { t: "event", body: streamId }        what a UI receives on /api/ws
 *   C ↔ R  { t: "ping", at } / { t: "pong", at }
 */
import type { ClientEvent, RunnerInfo, RunnerPairingCode, ServerEvent } from "@godmode/shared";
import { logger } from "../log";
import { HttpError } from "../util";
import { LinkError, SecureChannel, type LinkIdentity, type Transport } from "./channel";

const log = logger("link");

const OPEN_TIMEOUT_MS = 2_500;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const PING_EVERY_MS = 20_000;
const PONG_TIMEOUT_MS = 45_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A runner on another link version is tried again this rarely (it needs an update, not a retry). */
const MISMATCH_RETRY_MS = 5 * 60_000;
const UNKNOWN_RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_PENDING_BODIES = 32;
/** Bytes of finished bodies held for a message that hasn't named them yet: a runner can't make this computer hoard more. */
const MAX_PENDING_BYTES = 512 * 1024 * 1024;

export type LinkStateName = "online" | "connecting" | "offline" | "update_required";

export interface LinkState {
  state: LinkStateName;
  /** Why it isn't online, in words for people; null when online or simply not yet connected. */
  error: string | null;
  address: string | null;
  info: RunnerInfo | null;
  latencyMs: number | null;
}

export interface LinkResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface Pending {
  resolve(res: LinkResponse): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** What each failure means to someone looking at the runner. */
function describe(err: unknown, name: string): string {
  if (err instanceof LinkError) {
    switch (err.code) {
      case "protocol_mismatch":
        return `${name} runs another version of Godmode. Update Godmode on both computers.`;
      case "unknown_controller":
        return `${name} doesn't know this computer anymore. Remove it here and pair it again.`;
      case "pairing_invalid":
        return "That pairing code isn't valid anymore. Make a new one on the runner with `godmode runner pair`.";
      case "bad_frame":
        return `The connection to ${name} couldn't be verified. If this keeps happening, pair it again.`;
      case "handshake_timeout":
        return `${name} took too long to answer.`;
    }
  }
  return `Can't reach ${name}. Is it switched on, awake and on the same network?`;
}

/** `host` as it goes into a URL (IPv6 in brackets). */
function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

type Early = { json: unknown } | { streamId: number; bytes: Uint8Array };

interface Opened {
  ws: WebSocket;
  channel: SecureChannel<RunnerInfo>;
  info: RunnerInfo;
  /** What the runner sent between `ready` and the owner taking over, in order. */
  early: Early[];
}

interface Dialed extends Opened {
  address: string;
}

/**
 * Open a WebSocket to one address and run the handshake. Rejects with a LinkError (handshake refused) or a plain Error
 * (couldn't connect). The close code 4000 carries the reason a runner refused after the hellos.
 */
function dialOne(address: string, port: number, start: (t: Transport) => SecureChannel<RunnerInfo>): Promise<Opened> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let channel: SecureChannel<RunnerInfo> | null = null;
    const early: Early[] = [];
    const ws = new WebSocket(`ws://${urlHost(address)}:${port}/link`);
    ws.binaryType = "arraybuffer";
    const done = (err: Error | null, value?: Opened) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      if (err) {
        try {
          ws.close();
        } catch {
          /* not open */
        }
        reject(err);
      } else resolve(value!);
    };
    const openTimer = setTimeout(() => done(new Error("timeout")), OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(openTimer);
      const transport: Transport = {
        send: (data) => ws.send(typeof data === "string" ? data : (data as Uint8Array<ArrayBuffer>)),
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            /* closing already */
          }
        },
      };
      channel = start(transport);
      channel.onJson = (json) => early.push({ json });
      channel.onBinary = (streamId, bytes) => early.push({ streamId, bytes });
      channel.ready.then(
        (info) => done(null, { ws, channel: channel!, info, early }),
        (err: LinkError) => done(err),
      );
    };
    ws.onmessage = (ev) => channel?.receive(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
    ws.onerror = () => {
      if (!channel) done(new Error("unreachable"));
    };
    ws.onclose = (ev) => {
      // The runner refused after the hellos: the channel only knows "closed", the close reason says why.
      if (ev.code === 4000 && /^[a-z_]{1,40}$/.test(ev.reason)) done(new LinkError(ev.reason));
      else if (!channel) done(new Error("unreachable"));
      channel?.close();
    };
  });
}

/** Try each address in order; the first that completes the handshake wins. A refusal (not a network error) ends the search. */
async function dial(addresses: string[], port: number, start: (t: Transport) => SecureChannel<RunnerInfo>): Promise<Dialed> {
  let lastError: unknown = new Error("No address to dial");
  for (const address of addresses) {
    try {
      return { ...(await dialOne(address, port, start)), address };
    } catch (err) {
      lastError = err;
      // The runner answered and said no (or proved to be someone else): another address reaches the same runner.
      if (err instanceof LinkError && err.code !== "handshake_timeout" && err.code !== "closed") throw err;
    }
  }
  throw lastError;
}

export interface RemoteLinkOptions {
  identity: LinkIdentity;
  runnerKey: string;
  addresses: string[];
  port: number;
  /** For messages; the runner's name as this computer knows it. */
  name: string;
  /** What this computer calls itself towards the runner. */
  ownName: string;
  onEvent(event: ServerEvent): void;
  onState(state: LinkState): void;
}

export class RemoteLink {
  private opts: RemoteLinkOptions;
  private current: Dialed | null = null;
  private _state: LinkState = { state: "offline", error: null, address: null, info: null, latencyMs: null };
  private running = false;
  private connecting = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private backoff = BACKOFF_MIN_MS;
  private nextId = 1;
  private nextStream = 1;
  private pending = new Map<number, Pending>();
  private bodies = new Map<number, Uint8Array>();
  private bodyBytes = 0;

  constructor(opts: RemoteLinkOptions) {
    this.opts = opts;
  }

  get state(): LinkState {
    return this._state;
  }

  /** Addresses or port changed (the human edited them): reconnect with the new ones. */
  update(patch: Partial<Pick<RemoteLinkOptions, "addresses" | "port" | "name">>): void {
    this.opts = { ...this.opts, ...patch };
    if (this.running && (patch.addresses || patch.port)) this.reconnect();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.drop(null);
    this.setState({ state: "offline", error: null, address: null, latencyMs: null });
  }

  /** Try now instead of waiting for the next retry. */
  reconnect(): void {
    if (!this.running) return this.start();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.backoff = BACKOFF_MIN_MS;
    this.drop(null);
    void this.connect();
  }

  private setState(patch: Partial<LinkState>) {
    this._state = { ...this._state, ...patch };
    try {
      this.opts.onState(this._state);
    } catch (err) {
      log.warn("link state listener failed", err);
    }
  }

  private async connect(): Promise<void> {
    if (!this.running || this.connecting || this.current) return;
    this.connecting = true;
    this.setState({ state: "connecting" });
    try {
      const dialed = await dial(this.opts.addresses, this.opts.port, (t) =>
        SecureChannel.initiator(t, { identity: this.opts.identity, remoteKey: this.opts.runnerKey, mode: "session", name: this.opts.ownName, handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS }),
      );
      this.connecting = false;
      if (!this.running) {
        dialed.channel.close();
        return;
      }
      this.attach(dialed);
    } catch (err) {
      this.connecting = false;
      if (!this.running) return;
      const mismatch = err instanceof LinkError && err.code === "protocol_mismatch";
      const unknown = err instanceof LinkError && err.code === "unknown_controller";
      this.setState({ state: mismatch ? "update_required" : "offline", error: describe(err, this.opts.name), address: null, latencyMs: null });
      this.scheduleRetry(mismatch ? MISMATCH_RETRY_MS : unknown ? UNKNOWN_RETRY_MS : undefined);
    }
  }

  private scheduleRetry(delay?: number) {
    if (!this.running || this.retryTimer) return;
    const wait = delay ?? this.backoff;
    if (delay === undefined) this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, wait);
    this.retryTimer.unref?.();
  }

  private attach(dialed: Dialed) {
    this.current = dialed;
    this.backoff = BACKOFF_MIN_MS;
    const { channel, ws } = dialed;
    channel.onJson = (m) => this.onMessage(m);
    channel.onBinary = (streamId, bytes) => this.keepBody(streamId, bytes);
    channel.onClose = (err) => {
      if (this.current?.channel !== channel) return;
      this.drop(err);
      if (this.running) {
        this.setState({ state: "offline", error: describe(err, this.opts.name), latencyMs: null });
        this.scheduleRetry();
      }
    };
    ws.onclose = () => channel.close();
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
    this.pingTimer.unref?.();
    this.setState({ state: "online", error: null, address: dialed.address, info: dialed.info, latencyMs: null });
    log.info("connected to runner", { name: this.opts.name, address: dialed.address });
    for (const m of dialed.early.splice(0)) {
      if ("json" in m) this.onMessage(m.json);
      else this.keepBody(m.streamId, m.bytes);
    }
    this.ping();
  }

  private keepBody(streamId: number, bytes: Uint8Array) {
    this.takeBody(streamId);
    this.bodies.set(streamId, bytes);
    this.bodyBytes += bytes.byteLength;
    while (this.bodies.size > MAX_PENDING_BODIES || this.bodyBytes > MAX_PENDING_BYTES) this.takeBody(this.bodies.keys().next().value!);
  }

  private takeBody(streamId: number): Uint8Array | undefined {
    const bytes = this.bodies.get(streamId);
    if (bytes) {
      this.bodies.delete(streamId);
      this.bodyBytes -= bytes.byteLength;
    }
    return bytes;
  }

  /** Close the current connection and fail what waits on it. */
  private drop(err: LinkError | null) {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const current = this.current;
    this.current = null;
    this.bodies.clear();
    this.bodyBytes = 0;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.offlineError());
      this.pending.delete(id);
    }
    if (current) {
      current.channel.onClose = () => {};
      current.channel.close();
      if (err) log.info("runner link closed", { name: this.opts.name, code: err.code });
    }
  }

  private ping() {
    const current = this.current;
    if (!current) return;
    if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) {
      log.info("runner stopped answering", { name: this.opts.name });
      current.channel.close();
      return;
    }
    try {
      current.channel.sendJson({ t: "ping", at: Date.now() });
    } catch {
      /* onClose follows */
    }
  }

  private onMessage(message: unknown) {
    if (!message || typeof message !== "object") return;
    const m = message as Record<string, unknown>;
    switch (m.t) {
      case "pong":
        this.lastPong = Date.now();
        if (typeof m.at === "number") this.setState({ latencyMs: Math.max(0, Date.now() - m.at) });
        return;
      case "res": {
        const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
        if (!p) return;
        this.pending.delete(m.id as number);
        clearTimeout(p.timer);
        let body: Uint8Array = new Uint8Array(0);
        if (typeof m.body === "number") body = this.takeBody(m.body) ?? body;
        const headers: Record<string, string> = {};
        if (m.headers && typeof m.headers === "object") {
          for (const [k, v] of Object.entries(m.headers as Record<string, unknown>)) if (typeof v === "string") headers[k.toLowerCase()] = v;
        }
        p.resolve({ status: typeof m.status === "number" ? m.status : 502, headers, body });
        return;
      }
      case "event": {
        let text: string | null = null;
        if (typeof m.data === "string") text = m.data;
        else if (typeof m.body === "number") {
          const bytes = this.takeBody(m.body);
          if (bytes) text = Buffer.from(bytes).toString("utf8");
        }
        if (!text) return;
        let event: unknown;
        try {
          event = JSON.parse(text);
        } catch {
          return;
        }
        if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") return;
        try {
          this.opts.onEvent(event as ServerEvent);
        } catch (err) {
          log.warn("runner event handler failed", err);
        }
        return;
      }
    }
  }

  private offlineError(): HttpError {
    return new HttpError(409, this._state.error && this._state.state !== "online" ? this._state.error : `${this.opts.name} is offline — the chat continues when it's back.`, "runner_offline");
  }

  assertOnline(): void {
    if (!this.current || this._state.state !== "online") throw this.offlineError();
  }

  /** A request into the runner's API. Throws `runner_offline` when the link is down. */
  request(
    method: string,
    path: string,
    opts: { body?: Uint8Array | string; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<LinkResponse> {
    // A promise either way, so callers that await it see `runner_offline` the same way as a dropped request.
    if (!this.current || this._state.state !== "online") return Promise.reject(this.offlineError());
    const current = this.current;
    const id = this.nextId++;
    return new Promise<LinkResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HttpError(504, `${this.opts.name} didn't answer in time.`, "runner_timeout"));
      }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        let bodyId: number | undefined;
        if (opts.body !== undefined && (typeof opts.body === "string" ? opts.body.length : opts.body.byteLength)) {
          bodyId = this.nextStream++;
          current.channel.sendBinary(bodyId, typeof opts.body === "string" ? Buffer.from(opts.body, "utf8") : opts.body);
        }
        current.channel.sendJson({ t: "req", id, method, path, ...(opts.headers ? { headers: opts.headers } : {}), ...(bodyId ? { body: bodyId } : {}) });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof LinkError && err.code === "too_large" ? new HttpError(413, "That is too large to send to the runner.", "too_large") : this.offlineError());
      }
    });
  }

  /** JSON in, JSON out. A non-2xx answer becomes an HttpError carrying the runner's message and code. */
  async json<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    const res = await this.request(method, path, {
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      timeoutMs: opts.timeoutMs,
    });
    const text = Buffer.from(res.body).toString("utf8");
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const err = (parsed ?? {}) as { error?: unknown; code?: unknown; details?: unknown };
      throw new HttpError(res.status, typeof err.error === "string" ? err.error : `${this.opts.name} answered ${res.status}.`, typeof err.code === "string" ? err.code : undefined, err.details);
    }
    return parsed as T;
  }

  /** What a UI would send on /api/ws (live view subscriptions). Dropped while offline. */
  sendClientEvent(event: ClientEvent): void {
    try {
      this.current?.channel.sendJson({ t: "client", event });
    } catch {
      /* offline: re-sent after reconnecting by whoever tracks subscriptions */
    }
  }

  /**
   * Pair with a runner from its pairing code: a `pair` handshake that registers this computer's key with the runner.
   * Resolves with what the runner says about itself and the address that worked; the connection is closed again.
   */
  static async pair(opts: { identity: LinkIdentity; code: RunnerPairingCode; name: string }): Promise<{ info: RunnerInfo; address: string }> {
    const { identity, code, name } = opts;
    if (code.exp * 1000 <= Date.now()) throw new HttpError(400, "That pairing code has expired. Make a new one on the runner with `godmode runner pair`.", "pairing_expired");
    try {
      const dialed = await dial(code.addresses, code.port, (t) =>
        SecureChannel.initiator(t, { identity, remoteKey: code.key, mode: "pair", pairingId: code.id, secret: code.secret, name, handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS }),
      );
      dialed.channel.close();
      return { info: dialed.info, address: dialed.address };
    } catch (err) {
      throw new HttpError(err instanceof LinkError ? 400 : 502, describe(err, code.name), err instanceof LinkError ? err.code : "runner_unreachable");
    }
  }
}
