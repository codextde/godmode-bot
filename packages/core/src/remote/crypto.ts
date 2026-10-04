/**
 * Cryptography of the link between Godmode and a runner.
 *
 *  identity   every installation has one static X25519 key pair; a runner's public key is pinned when it is paired
 *  handshake  each connection adds an ephemeral pair per side; the Diffie-Hellman results (while pairing: two of them
 *             plus the one-time secret) go through HKDF-SHA256 into one AES-256-GCM key per direction
 *  frames     counter (8 bytes BE) ‖ ciphertext ‖ tag (16); nonce = 4 zero bytes ‖ counter
 *
 * Everything here is a pure function — no I/O, no state — so each step can be tested on its own. The state machine that
 * uses it is channel.ts.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";

/** An X25519 key pair; both halves are the raw 32 bytes as base64url. */
export interface LinkIdentity {
  publicKey: string;
  privateKey: string;
}

export type LinkMode = "session" | "pair";
/** Who sends a frame: `c2r` controller → runner, `r2c` runner → controller. Each direction has its own key. */
export type LinkDirection = "c2r" | "r2c";

export interface SessionKeys {
  c2r: Buffer;
  r2c: Buffer;
}

export const KEY_BYTES = 32;
/** Most plaintext one frame carries (kind byte and stream header included). */
export const MAX_FRAME = 1024 * 1024;
const COUNTER_BYTES = 8;
const TAG_BYTES = 16;
/** What a frame adds to its plaintext: the counter in front, the GCM tag behind. */
export const FRAME_OVERHEAD = COUNTER_BYTES + TAG_BYTES;
/**
 * Frames one direction of a connection may carry. Counters are JS numbers and exact only up to 2^53 - 1; a counter
 * that repeats would repeat a nonce, so the link stops before that can happen.
 */
export const MAX_FRAMES = Number.MAX_SAFE_INTEGER;
/** A pairing secret shorter than this could be guessed. */
export const MIN_SECRET_BYTES = 16;
const MAX_SECRET_CHARS = 512;

const PROTOCOL_TAG = Buffer.from("GMLINK1", "utf8");
const HKDF_INFO = Buffer.from("godmode link v1", "utf8");
/** The direction is authenticated with every frame, so a frame can't be played back to the side that sent it. */
const AAD: Record<LinkDirection, Buffer> = {
  c2r: Buffer.concat([PROTOCOL_TAG, Buffer.from([0x01])]),
  r2c: Buffer.concat([PROTOCOL_TAG, Buffer.from([0x02])]),
};
const JWK = { kty: "OKP", crv: "X25519" } as const;
/** X25519's base point (u = 9): multiplying a private key with it gives the public key. */
const BASE_POINT = Buffer.concat([Buffer.from([9]), Buffer.alloc(KEY_BYTES - 1)]).toString("base64url");

/** Bytes behind unpadded base64url. Strict, because `Buffer.from` skips what it can't read and both ends must see the same bytes. */
export function fromBase64url(text: unknown): Buffer {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error("Not base64url");
  return Buffer.from(text, "base64url");
}

/** The raw 32 bytes of a key that travelled as base64url. */
export function decodeKey(key: unknown): Buffer {
  const raw = fromBase64url(key);
  if (raw.length !== KEY_BYTES) throw new Error("Not an X25519 key");
  return raw;
}

export function isKey(key: unknown): key is string {
  try {
    decodeKey(key);
    return true;
  } catch {
    return false;
  }
}

/** A key in the one spelling its bytes have, so the same key is always stored and compared as the same text. */
export function canonicalKey(key: unknown): string {
  return decodeKey(key).toString("base64url");
}

/** The pre-shared key behind a pairing secret. */
export function decodeSecret(secret: unknown): Buffer {
  if (typeof secret !== "string" || secret.length > MAX_SECRET_CHARS) throw new Error("Not a pairing secret");
  const psk = fromBase64url(secret);
  if (psk.length < MIN_SECRET_BYTES) throw new Error("Pairing secret too short");
  return psk;
}

/** Compares without telling through timing where two values differ. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function generateKeyPair(): LinkIdentity {
  const jwk = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.d) throw new Error("Couldn't create an X25519 key");
  return { publicKey: jwk.x, privateKey: jwk.d };
}

/**
 * X25519 of our private key and their public key. An all-zero result means the other side sent a point that makes the
 * secret the same for everyone; it is refused so every key that is derived depends on both sides.
 */
export function dh(own: LinkIdentity, theirKey: string): Buffer {
  const privateKey = createPrivateKey({ key: { ...JWK, x: canonicalKey(own.publicKey), d: canonicalKey(own.privateKey) }, format: "jwk" });
  const publicKey = createPublicKey({ key: { ...JWK, x: canonicalKey(theirKey) }, format: "jwk" });
  const shared = diffieHellman({ privateKey, publicKey });
  let bits = 0;
  for (const byte of shared) bits |= byte;
  if (shared.length !== KEY_BYTES || bits === 0) throw new Error("Weak X25519 key");
  return shared;
}

/** Whether the two halves belong together: a damaged key file would otherwise only show as handshakes that fail. */
export function isKeyPair(identity: LinkIdentity): boolean {
  try {
    return safeEqual(dh(identity, BASE_POINT), decodeKey(identity.publicKey));
  } catch {
    return false;
  }
}

/** Short form of a public key for people to compare: the first 6 bytes of its SHA-256, "3F2A 91C0 7B4E". */
export function fingerprint(publicKey: string): string {
  const hex = createHash("sha256").update(decodeKey(publicKey)).digest("hex").slice(0, 12).toUpperCase();
  return `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 12)}`;
}

/**
 * What a controller calls itself in the unencrypted hello of a session: the SHA-256 of its public key (base64url). The
 * runner finds the pinned key by it; the key itself is never sent.
 */
export function controllerLookupId(publicKey: string): string {
  return createHash("sha256").update(decodeKey(publicKey)).digest("base64url");
}

/**
 * th = SHA-256("GMLINK1" ‖ mode ‖ C.e ‖ R.e ‖ R.s ‖ bound). `bound` is the controller's static key in a session and the
 * pairing id while pairing: the keys only match when both sides mean the same connection between the same two parties.
 */
export function transcriptHash(mode: LinkMode, initiatorEphemeral: string, responderEphemeral: string, responderStatic: string, bound: string): Buffer {
  return createHash("sha256")
    .update(PROTOCOL_TAG)
    .update(mode, "utf8")
    .update(decodeKey(initiatorEphemeral))
    .update(decodeKey(responderEphemeral))
    .update(decodeKey(responderStatic))
    .update(mode === "session" ? decodeKey(bound) : Buffer.from(bound, "utf8"))
    .digest();
}

/**
 * okm = HKDF-SHA256(ikm, salt = th, info = "godmode link v1", 64 bytes); kC2R = okm[0..32], kR2C = okm[32..64]. The keys
 * come back as two buffers of their own so the channel can wipe them when it closes.
 */
export function deriveKeys(ikmParts: readonly Uint8Array[], th: Uint8Array): SessionKeys {
  const ikm = Buffer.concat(ikmParts);
  // A view on the ArrayBuffer hkdfSync returns, not a copy: wiping it below wipes the only other place the keys are in.
  const okm = Buffer.from(hkdfSync("sha256", ikm, th, HKDF_INFO, 2 * KEY_BYTES));
  const keys = { c2r: Buffer.from(okm.subarray(0, KEY_BYTES)), r2c: Buffer.from(okm.subarray(KEY_BYTES)) };
  ikm.fill(0);
  okm.fill(0);
  return keys;
}

interface InitiatorSide {
  /** C.e */
  ephemeral: LinkIdentity;
  /** R.e, from the runner's hello. */
  responderEphemeral: string;
  /** R.s, the key that was pinned (or came with the pairing code): a runner without its private half gets other keys. */
  responderStatic: string;
}
export type InitiatorHandshake = InitiatorSide &
  ({ mode: "session"; /** C.s */ identity: LinkIdentity } | { mode: "pair"; pairingId: string; psk: Uint8Array });

interface ResponderSide {
  /** R.s */
  identity: LinkIdentity;
  /** R.e */
  ephemeral: LinkIdentity;
  /** C.e, from the controller's hello. */
  initiatorEphemeral: string;
}
export type ResponderHandshake = ResponderSide &
  ({ mode: "session"; /** C.s, as pinned when it paired. */ controllerKey: string } | { mode: "pair"; pairingId: string; psk: Uint8Array });

/**
 * The controller's side of the key agreement.
 *  session: ikm = DH(C.e, R.e) ‖ DH(C.e, R.s) ‖ DH(C.s, R.e) — forward secrecy plus both static keys
 *  pair:    ikm = DH(C.e, R.e) ‖ DH(C.e, R.s) ‖ psk          — the runner's static key plus the one-time secret
 */
export function initiatorKeys(h: InitiatorHandshake): SessionKeys {
  const parts: Buffer[] = [];
  try {
    parts.push(dh(h.ephemeral, h.responderEphemeral), dh(h.ephemeral, h.responderStatic));
    parts.push(h.mode === "session" ? dh(h.identity, h.responderEphemeral) : Buffer.from(h.psk));
    const bound = h.mode === "session" ? h.identity.publicKey : h.pairingId;
    return deriveKeys(parts, transcriptHash(h.mode, h.ephemeral.publicKey, h.responderEphemeral, h.responderStatic, bound));
  } finally {
    for (const part of parts) part.fill(0);
  }
}

/** The runner's side of the same agreement: the same three values, computed from the other halves. */
export function responderKeys(h: ResponderHandshake): SessionKeys {
  const parts: Buffer[] = [];
  try {
    parts.push(dh(h.ephemeral, h.initiatorEphemeral), dh(h.identity, h.initiatorEphemeral));
    parts.push(h.mode === "session" ? dh(h.ephemeral, h.controllerKey) : Buffer.from(h.psk));
    const bound = h.mode === "session" ? h.controllerKey : h.pairingId;
    return deriveKeys(parts, transcriptHash(h.mode, h.initiatorEphemeral, h.ephemeral.publicKey, h.identity.publicKey, bound));
  } finally {
    for (const part of parts) part.fill(0);
  }
}

function counterBytes(counter: number): Buffer {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter >= MAX_FRAMES) throw new RangeError("Frame counter out of range");
  const bytes = Buffer.alloc(COUNTER_BYTES);
  bytes.writeBigUInt64BE(BigInt(counter));
  return bytes;
}

function nonce(counter: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(4), counter]);
}

/** One transport message: counter ‖ ciphertext ‖ tag. The plaintext is the given parts in order (at most MAX_FRAME bytes). */
export function sealFrame(key: Uint8Array, direction: LinkDirection, counter: number, plaintext: readonly Uint8Array[]): Buffer {
  let size = 0;
  for (const part of plaintext) size += part.byteLength;
  if (size > MAX_FRAME) throw new RangeError("Frame too large");
  const head = counterBytes(counter);
  const cipher = createCipheriv("aes-256-gcm", key, nonce(head), { authTagLength: TAG_BYTES });
  cipher.setAAD(AAD[direction]);
  const out = [head];
  for (const part of plaintext) out.push(cipher.update(part));
  out.push(cipher.final(), cipher.getAuthTag());
  return Buffer.concat(out);
}

/**
 * The plaintext of a frame. `counter` is the one the receiver expects: a frame that carries another (a replay, one that
 * got lost before it, two that swapped places) is refused before anything is decrypted, and the expected value — never
 * the one in the frame — is what the nonce is built from. Throws on any frame that isn't exactly what the sender sealed.
 */
export function openFrame(key: Uint8Array, direction: LinkDirection, counter: number, frame: Uint8Array): Buffer {
  const data = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (data.length < FRAME_OVERHEAD || data.length > MAX_FRAME + FRAME_OVERHEAD) throw new Error("Frame has an impossible size");
  const head = counterBytes(counter);
  if (!data.subarray(0, COUNTER_BYTES).equals(head)) throw new Error("Frame out of order");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce(head), { authTagLength: TAG_BYTES });
  decipher.setAAD(AAD[direction]);
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  const body = decipher.update(data.subarray(COUNTER_BYTES, data.length - TAG_BYTES));
  // final() is what checks the tag; nothing of `body` leaves this function before it has passed.
  const rest = decipher.final();
  return rest.length ? Buffer.concat([body, rest]) : body;
}
