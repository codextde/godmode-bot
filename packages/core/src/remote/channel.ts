/**
 * The encrypted link between Godmode (the controller, who dials) and a runner (who listens), on top of any transport
 * that carries whole messages — a WebSocket in production, two in-memory ends in a test.
 *
 *   C → R  { t: "hello", v, mode, e, id }                      plaintext
 *   R → C  { t: "hello", v, e }   or   { t: "error", code, message } and close
 *   C → R  frame 0: { t: "auth", name, key?, version }         encrypted from here on
 *   R → C  frame 0: { t: "ready", info }
 *
 * A side that can't decrypt the other's first frame closes: that is the key confirmation. After `ready` both sides send
 * JSON messages and binary streams as frames, and a frame that was changed, replayed, lost or reordered ends the link.
 * The key agreement and the frame cipher are in crypto.ts. This file is the state machine around them; it knows nothing
 * about sockets or the database (the runner's end gets what it needs through callbacks).
 */
import { hostname } from "node:os";
import { LINK_PROTOCOL, type RunnerInfo } from "@godmode/shared";
import { VERSION } from "../config";
import {
  MAX_FRAME,
  MAX_FRAMES,
  canonicalKey,
  controllerLookupId,
  decodeSecret,
  dh,
  generateKeyPair,
  initiatorKeys,
  isKey,
  openFrame,
  responderKeys,
  safeEqual,
  sealFrame,
  type LinkDirection,
  type LinkIdentity,
  type SessionKeys,
} from "./crypto";

export { MAX_FRAME };
export type { LinkIdentity };

/** A handshake that isn't done by then is closed: a socket that says nothing must not hold a place forever. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Most bytes one binary stream carries, and the most a receiver holds of streams that haven't ended yet. */
export const MAX_STREAM = 256 * 1024 * 1024;

const KIND_JSON = 0x01;
const KIND_BINARY = 0x02;
const FLAG_LAST = 0x01;
/** kind (1) ‖ stream id (u32 BE) ‖ flags (u8) in front of the bytes of a binary chunk. */
const STREAM_HEADER = 6;
const MAX_CHUNK = MAX_FRAME - STREAM_HEADER;
/**
 * What a chunk that has to be kept counts at least towards MAX_STREAM. Keeping one takes about a kilobyte besides its
 * bytes, so a flood of empty or tiny chunks would fill the memory while their bytes add up to next to nothing.
 * `sendBinary` fills every chunk but the last, so only a peer that cuts a stream into crumbs meets the limit sooner.
 */
const MIN_CHUNK_COST = 4096;
/** Streams a peer may leave unfinished at once. `sendBinary` never interleaves, so more than a few is an attack on memory. */
const MAX_OPEN_STREAMS = 64;
/** A hello is read from anyone who connects, before any key exists: it stays small. */
const MAX_HELLO = 4096;
const MAX_ID = 128;
const MAX_NAME = 200;
/** Close codes handed to the transport (WebSocket range): a normal close, and a failure with the LinkError code as reason. */
const CLOSE_NORMAL = 1000;
const CLOSE_FAILED = 4000;
const NO_KEY = Buffer.alloc(0);
const JSON_KIND = Buffer.from([KIND_JSON]);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Whatever carries the messages. `send` gets a string for the two hellos and bytes for every frame after them. */
export interface Transport {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type LinkErrorCode = "protocol_mismatch" | "unknown_controller" | "pairing_invalid" | "handshake_timeout" | "bad_frame" | "closed" | (string & {});

const MESSAGES: Record<string, string> = {
  protocol_mismatch: "This computer and the runner use different versions of the link. Update Godmode on both.",
  unknown_controller: "The runner doesn't know this computer. Pair it again.",
  pairing_invalid: "That pairing code isn't valid any more. Create a new one on the runner.",
  handshake_timeout: "The connection took too long to set up.",
  bad_frame: "The connection sent something that couldn't be verified.",
  closed: "The link is closed.",
  too_large: "That is too large to send over the link.",
  internal: "Something went wrong while connecting. Try again.",
};

export class LinkError extends Error {
  code: LinkErrorCode;

  constructor(code: LinkErrorCode, message?: string) {
    super(message ?? MESSAGES[code] ?? `The link failed (${code}).`);
    this.name = "LinkError";
    this.code = code;
  }
}

/** Who a runner's end is talking to once the handshake is done. */
export interface LinkPeer {
  /** The controller's static public key (base64url): the pinned one in a session, the one it registered while pairing. */
  controllerKey: string;
  name: string;
  /** Godmode version of the controller. */
  version: string;
}

export type InitiatorOptions = (
  | { identity: LinkIdentity; remoteKey: string; mode: "session"; /** What this computer calls itself; default: its hostname. */ name?: string }
  | { identity: LinkIdentity; remoteKey: string; mode: "pair"; pairingId: string; secret: string; name: string }
) & { handshakeTimeoutMs?: number };

export interface ResponderOptions {
  identity: LinkIdentity;
  /** The pinned public key of the controller with this lookup id (base64url SHA-256 of that key), or null. */
  lookupController(idHash: string): string | null;
  /** The secret of the pairing with this id while it is valid, or null. */
  lookupPairing(id: string): string | null;
  /** Store the controller and delete the pairing secret. The runner answers only after this has returned. */
  onPaired(controllerKey: string, name: string): void;
  info(): RunnerInfo;
  handshakeTimeoutMs?: number;
}

type Incoming = { json: unknown } | { streamId: number; bytes: Uint8Array };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHello(data: string | Uint8Array): Record<string, unknown> {
  if (typeof data !== "string" || data.length > MAX_HELLO) throw new LinkError("bad_frame");
  const hello: unknown = JSON.parse(data);
  if (!isRecord(hello)) throw new LinkError("bad_frame");
  return hello;
}

/**
 * The code of an unencrypted error. Anyone on the network could have written it, so only a well-formed code is taken
 * over; the text beside it is never shown.
 */
function wireCode(code: unknown): LinkErrorCode {
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "bad_frame";
}

function jsonFrame(value: unknown): Uint8Array[] {
  const text: string | undefined = JSON.stringify(value);
  return [JSON_KIND, Buffer.from(text ?? "null", "utf8")];
}

function sameText(a: string, b: string): boolean {
  return safeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** The pre-shared key behind a pairing secret; null when the text isn't one. */
function pskOf(secret: unknown): Buffer | null {
  try {
    return decodeSecret(secret);
  } catch {
    return null;
  }
}

/** A failure that is ours, not the peer's: what it was stays in `cause` and is never sent anywhere. */
function internal(err: unknown): LinkError {
  if (err instanceof LinkError) return err;
  const error = new LinkError("internal");
  error.cause = err;
  return error;
}

/** Runs one of the owner's callbacks; what it throws ends the handshake as our failure rather than as a bad frame. */
function ask<T>(callback: () => T): T {
  try {
    return callback();
  } catch (err) {
    throw internal(err);
  }
}

export class SecureChannel<R = RunnerInfo | LinkPeer> {
  /** The controller's end. The hello goes out right away, so the transport must be open. */
  static initiator(transport: Transport, opts: InitiatorOptions): SecureChannel<RunnerInfo> {
    const channel = new SecureChannel<RunnerInfo>(transport, "initiator", opts.handshakeTimeoutMs);
    try {
      channel.startInitiator(opts);
    } catch (err) {
      // Reported like every later failure, through `ready` and `onClose`, once the caller had the chance to listen.
      queueMicrotask(() => channel.fail(internal(err)));
    }
    return channel;
  }

  /** The runner's end: waits for the controller's hello. */
  static responder(transport: Transport, opts: ResponderOptions): SecureChannel<LinkPeer> {
    const channel = new SecureChannel<LinkPeer>(transport, "responder", opts.handshakeTimeoutMs);
    channel.startResponder(opts);
    return channel;
  }

  /**
   * Resolves when the handshake is done — on the controller with the runner's RunnerInfo, on the runner with who
   * connected. Rejects with a LinkError; when the channel is closed before it got that far, with code `closed`.
   */
  readonly ready: Promise<R>;
  onJson: (value: unknown) => void = () => {};
  onBinary: (streamId: number, bytes: Uint8Array) => void = () => {};
  /** Called once when the channel ends: with the reason, or null when `close()` was called. */
  onClose: (err: LinkError | null) => void = () => {};

  private readonly transport: Transport;
  private readonly side: "initiator" | "responder";
  private readonly sendDirection: LinkDirection;
  private readonly recvDirection: LinkDirection;
  private readonly timer: ReturnType<typeof setTimeout>;
  private settle!: { resolve(value: unknown): void; reject(err: LinkError): void };
  /** hello: waiting for the peer's hello · auth: keys derived, waiting for its first frame · open · closed */
  private state: "hello" | "auth" | "open" | "closed" = "hello";
  /** The handshake step that takes the peer's next message. */
  private step: (data: string | Uint8Array) => void = () => {};
  private psk: Buffer = NO_KEY;
  private sendKey: Buffer = NO_KEY;
  private recvKey: Buffer = NO_KEY;
  /** Frames sent and received so far = the counter of the next one in each direction. */
  private sent = 0;
  private received = 0;
  /** Streams that haven't ended: their chunks, the bytes in them, and what they count towards MAX_STREAM. */
  private readonly streams = new Map<number, { parts: Uint8Array[]; size: number; cost: number }>();
  /** The cost of all unfinished streams together. */
  private buffered = 0;

  private constructor(transport: Transport, side: "initiator" | "responder", timeoutMs: number = HANDSHAKE_TIMEOUT_MS) {
    this.transport = transport;
    this.side = side;
    this.sendDirection = side === "initiator" ? "c2r" : "r2c";
    this.recvDirection = side === "initiator" ? "r2c" : "c2r";
    this.ready = new Promise<R>((resolve, reject) => {
      this.settle = { resolve: resolve as (value: unknown) => void, reject };
    });
    // An owner that only listens to onClose must not get an unhandled rejection out of a failed handshake.
    this.ready.catch(() => {});
    this.timer = setTimeout(() => this.fail(new LinkError("handshake_timeout")), timeoutMs);
    this.timer.unref?.();
  }

  /** Feed every message the transport receives. */
  receive(data: string | Uint8Array): void {
    if (this.state === "closed") return;
    let message: Incoming | null = null;
    try {
      if (this.state === "open") message = this.read(data);
      else this.step(data);
    } catch (err) {
      this.fail(err instanceof LinkError ? err : new LinkError("bad_frame"));
      return;
    }
    // Outside the try: what the owner's handler throws is the owner's, not a reason to drop the link.
    if (!message) return;
    if ("json" in message) this.onJson(message.json);
    else this.onBinary(message.streamId, message.bytes);
  }

  /** One JSON message, at most MAX_FRAME - 1 bytes of UTF-8. Anything bigger travels as a binary stream. */
  sendJson(value: unknown): void {
    this.assertOpen();
    const frame = jsonFrame(value);
    if (frame[1].byteLength > MAX_FRAME - 1) throw new LinkError("too_large");
    this.push(frame);
  }

  /** Splits into ≤ MAX_FRAME chunks; the receiver gets one onBinary call per stream with the assembled bytes. */
  sendBinary(streamId: number, bytes: Uint8Array): void {
    this.assertOpen();
    if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffff_ffff) throw new RangeError("A stream id is an unsigned 32-bit number");
    if (bytes.byteLength > MAX_STREAM) throw new LinkError("too_large");
    let offset = 0;
    do {
      const chunk = bytes.subarray(offset, offset + MAX_CHUNK);
      offset += chunk.byteLength;
      const header = Buffer.alloc(STREAM_HEADER);
      header[0] = KIND_BINARY;
      header.writeUInt32BE(streamId, 1);
      header[STREAM_HEADER - 1] = offset >= bytes.byteLength ? FLAG_LAST : 0;
      this.push([header, chunk]);
    } while (offset < bytes.byteLength);
  }

  /** Ends the link from this side. Also what the owner calls when the transport closed underneath. */
  close(): void {
    this.shutdown(null);
  }

  private startInitiator(opts: InitiatorOptions): void {
    // What a pasted code or the runner's row carries is checked before anything goes out.
    if (!isKey(opts.remoteKey)) {
      throw new LinkError("pairing_invalid", opts.mode === "pair" ? undefined : "The key stored for this runner is damaged. Pair it again.");
    }
    if (opts.mode === "pair") {
      const psk = pskOf(opts.secret);
      if (!psk) throw new LinkError("pairing_invalid");
      this.psk = psk;
    }
    const responderStatic = canonicalKey(opts.remoteKey);
    const ephemeral = generateKeyPair();

    this.step = (data) => {
      const hello = readHello(data);
      if (hello.t === "error") throw new LinkError(wireCode(hello.code));
      if (hello.t !== "hello") throw new LinkError("bad_frame");
      if (hello.v !== LINK_PROTOCOL) throw new LinkError("protocol_mismatch");
      const shared = { ephemeral, responderEphemeral: canonicalKey(hello.e), responderStatic };
      this.useKeys(
        opts.mode === "pair"
          ? initiatorKeys({ ...shared, mode: "pair", pairingId: opts.pairingId, psk: this.psk })
          : initiatorKeys({ ...shared, mode: "session", identity: opts.identity }),
      );
      // Only the runner that owns the pinned key derived the same keys, so only it can produce a frame that opens here.
      this.step = (frame) => {
        const ready = this.openJson(frame);
        if (!isRecord(ready) || ready.t !== "ready" || !isRecord(ready.info)) throw new LinkError("bad_frame");
        this.opened();
        this.settle.resolve(ready.info);
      };
      const auth = { t: "auth", name: opts.name ?? hostname(), version: VERSION };
      this.write(jsonFrame(opts.mode === "pair" ? { ...auth, key: canonicalKey(opts.identity.publicKey) } : auth));
    };

    const id = opts.mode === "pair" ? opts.pairingId : controllerLookupId(opts.identity.publicKey);
    this.transmit(JSON.stringify({ t: "hello", v: LINK_PROTOCOL, mode: opts.mode, e: ephemeral.publicKey, id }));
  }

  private startResponder(opts: ResponderOptions): void {
    this.step = (data) => {
      const hello = readHello(data);
      if (hello.t !== "hello") throw new LinkError("bad_frame");
      // Checked before the rest: another version may shape the rest of its hello differently.
      if (hello.v !== LINK_PROTOCOL) throw new LinkError("protocol_mismatch");
      const { mode, id } = hello;
      if ((mode !== "session" && mode !== "pair") || typeof id !== "string" || id === "" || id.length > MAX_ID) throw new LinkError("bad_frame");
      const shared = { identity: opts.identity, ephemeral: generateKeyPair(), initiatorEphemeral: canonicalKey(hello.e) };
      const peer: LinkPeer = { controllerKey: "", name: "", version: "" };
      let secret = "";

      if (mode === "session") {
        const pinned = ask(() => opts.lookupController(id));
        // The id only helps to find the key: what was found has to be the key the id was made from.
        if (!isKey(pinned) || !sameText(controllerLookupId(pinned), id)) throw new LinkError("unknown_controller");
        peer.controllerKey = canonicalKey(pinned);
        this.useKeys(responderKeys({ ...shared, mode, controllerKey: peer.controllerKey }));
      } else {
        const current = ask(() => opts.lookupPairing(id));
        const psk = pskOf(current);
        if (current === null || !psk) throw new LinkError("pairing_invalid");
        secret = current;
        this.psk = psk;
        this.useKeys(responderKeys({ ...shared, mode, pairingId: id, psk }));
      }

      this.step = (frame) => {
        let auth: unknown;
        try {
          auth = this.openJson(frame);
        } catch {
          // The controller derived other keys, so it doesn't hold what it claimed to: its static key in a session, the
          // secret (or the runner key that came with the code) while pairing.
          throw new LinkError(mode === "pair" ? "pairing_invalid" : "bad_frame");
        }
        if (!isRecord(auth) || auth.t !== "auth" || typeof auth.name !== "string" || typeof auth.version !== "string") throw new LinkError("bad_frame");
        peer.name = auth.name.slice(0, MAX_NAME);
        peer.version = auth.version.slice(0, MAX_NAME);
        if (mode === "pair") {
          peer.controllerKey = canonicalKey(auth.key);
          // A key that makes every shared secret the same (zero, or another low-order point) could never open a session:
          // pairing it would only use the code up.
          dh(shared.ephemeral, peer.controllerKey);
          // One code pairs one controller: of two handshakes that started with the same secret, only the first finds it
          // still in place here.
          const current = ask(() => opts.lookupPairing(id));
          if (current === null || !sameText(current, secret)) throw new LinkError("pairing_invalid");
          ask(() => opts.onPaired(peer.controllerKey, peer.name));
        }
        const info = ask(() => opts.info());
        this.opened();
        this.write(jsonFrame({ t: "ready", info }));
        this.settle.resolve(peer);
      };
      this.transmit(JSON.stringify({ t: "hello", v: LINK_PROTOCOL, e: shared.ephemeral.publicKey }));
    };
  }

  /** From here on everything is encrypted. The state changes before anything is sent, so an answer that comes back at once finds it. */
  private useKeys(keys: SessionKeys): void {
    this.sendKey = this.side === "initiator" ? keys.c2r : keys.r2c;
    this.recvKey = this.side === "initiator" ? keys.r2c : keys.c2r;
    this.psk.fill(0);
    this.psk = NO_KEY;
    this.state = "auth";
  }

  private opened(): void {
    clearTimeout(this.timer);
    this.step = () => {};
    this.state = "open";
  }

  private assertOpen(): void {
    if (this.state !== "open") throw new LinkError("closed", this.state === "closed" ? undefined : "The link isn't ready yet.");
  }

  private transmit(data: string | Uint8Array): void {
    try {
      this.transport.send(data);
    } catch {
      throw new LinkError("closed", "The connection dropped.");
    }
  }

  /** Seals the next frame and sends it. */
  private write(plaintext: readonly Uint8Array[]): void {
    if (this.state !== "auth" && this.state !== "open") throw new LinkError("closed");
    // A counter can never be used twice with one key; past the last exact number the link ends instead.
    if (this.sent >= MAX_FRAMES) throw new LinkError("closed", "This connection has carried all the messages one connection may. Connect again.");
    const frame = sealFrame(this.sendKey, this.sendDirection, this.sent, plaintext);
    this.sent += 1;
    this.transmit(frame);
  }

  /** A frame of the open channel. One that can't go out leaves a hole in the counters, so the link ends with it. */
  private push(plaintext: readonly Uint8Array[]): void {
    try {
      this.write(plaintext);
    } catch (err) {
      const error = internal(err);
      this.fail(error);
      throw error;
    }
  }

  /** The plaintext of the next frame; throws unless it is exactly the frame that is expected. */
  private unseal(data: string | Uint8Array): Buffer {
    if (typeof data === "string") throw new LinkError("bad_frame");
    const plain = openFrame(this.recvKey, this.recvDirection, this.received, data);
    this.received += 1;
    return plain;
  }

  private openJson(data: string | Uint8Array): unknown {
    const plain = this.unseal(data);
    if (plain[0] !== KIND_JSON) throw new LinkError("bad_frame");
    return JSON.parse(utf8.decode(plain.subarray(1)));
  }

  /** A frame of the open channel: a JSON message, the last chunk of a stream (→ the assembled bytes) or a chunk to keep (→ null). */
  private read(data: string | Uint8Array): Incoming | null {
    const plain = this.unseal(data);
    if (plain[0] === KIND_JSON) return { json: JSON.parse(utf8.decode(plain.subarray(1))) };
    if (plain[0] !== KIND_BINARY || plain.length < STREAM_HEADER) throw new LinkError("bad_frame");
    const streamId = plain.readUInt32BE(1);
    const last = (plain[STREAM_HEADER - 1] & FLAG_LAST) !== 0;
    const bytes = plain.subarray(STREAM_HEADER);
    let stream = this.streams.get(streamId);
    if (!stream) {
      if (last) return { streamId, bytes };
      if (this.streams.size >= MAX_OPEN_STREAMS) throw new LinkError("bad_frame");
      stream = { parts: [], size: 0, cost: 0 };
      this.streams.set(streamId, stream);
    }
    // The last chunk isn't kept, it only has to fit. Every other one counts as what keeping it takes.
    const cost = last ? bytes.byteLength : Math.max(bytes.byteLength, MIN_CHUNK_COST);
    stream.parts.push(bytes);
    stream.size += bytes.byteLength;
    stream.cost += cost;
    this.buffered += cost;
    if (this.buffered > MAX_STREAM) throw new LinkError("bad_frame");
    if (!last) return null;
    this.streams.delete(streamId);
    this.buffered -= stream.cost;
    return { streamId, bytes: Buffer.concat(stream.parts, stream.size) };
  }

  private fail(err: LinkError): void {
    if (this.state === "closed") return;
    // Before keys exist the runner may say why it refuses. Afterwards nothing travels unencrypted: it just closes.
    if (this.side === "responder" && this.state === "hello") {
      try {
        this.transport.send(JSON.stringify({ t: "error", code: err.code, message: MESSAGES[err.code] ?? MESSAGES.closed }));
      } catch {
        /* the transport is gone already */
      }
    }
    this.shutdown(err);
  }

  private shutdown(err: LinkError | null): void {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.timer);
    this.step = () => {};
    // Wiped and then dropped: a key that is all zeros must never seal a frame.
    for (const key of [this.psk, this.sendKey, this.recvKey]) key.fill(0);
    this.psk = this.sendKey = this.recvKey = NO_KEY;
    this.streams.clear();
    this.buffered = 0;
    this.settle.reject(err ?? new LinkError("closed"));
    try {
      this.transport.close(err ? CLOSE_FAILED : CLOSE_NORMAL, err?.code ?? "closed");
    } catch {
      /* the transport is gone already */
    }
    this.onClose(err);
  }
}
