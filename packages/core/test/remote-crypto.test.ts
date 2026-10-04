import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINK_PROTOCOL, type RunnerInfo } from "@godmode/shared";
import { loadConfig, VERSION } from "../src/config";
import {
  LinkError,
  MAX_FRAME,
  MAX_STREAM,
  SecureChannel,
  type InitiatorOptions,
  type LinkPeer,
  type ResponderOptions,
  type Transport,
} from "../src/remote/channel";
import {
  FRAME_OVERHEAD,
  MAX_FRAMES,
  canonicalKey,
  decodeKey,
  decodeSecret,
  dh,
  generateKeyPair,
  initiatorKeys,
  isKeyPair,
  openFrame,
  responderKeys,
  sealFrame,
  type LinkIdentity,
} from "../src/remote/crypto";
import { LINK_KEY_FILE, controllerLookupId, fingerprint, loadIdentity } from "../src/remote/identity";

type Message = string | Uint8Array;
type Side = "controller" | "runner";

const CONTROLLER = generateKeyPair();
const RUNNER = generateKeyPair();
const STRANGER = generateKeyPair();
const SECRET = randomBytes(32).toString("base64url");
const PAIRING = "pair_7Qx2LmT9";
const NAME = "Daniels MacBook Pro";
const INFO: RunnerInfo = {
  name: "Büro Mac mini",
  hostname: "mac-mini-buero",
  platform: "darwin",
  arch: "arm64",
  version: "0.1.0",
  protocol: LINK_PROTOCOL,
  vault: { initialized: true, unlocked: false },
  configDigest: null,
  activeRuns: 0,
};

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "godmode-link-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Lets everything that is on its way arrive. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const raw = (key: string) => Buffer.from(key, "base64url");
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest();

/**
 * Section 5 of the spec written out with node:crypto alone. The implementation is held against this, so a change to the
 * transcript, the key derivation or the frame layout can't pass by being wrong on both ends in the same way.
 */
function specDh(own: LinkIdentity, theirs: string): Buffer {
  return diffieHellman({
    privateKey: createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: own.publicKey, d: own.privateKey }, format: "jwk" }),
    publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: theirs }, format: "jwk" }),
  });
}

function specKeys(mode: "session" | "pair", ikm: Buffer[], ce: string, re: string, rs: string, bound: Buffer) {
  const th = sha256(Buffer.concat([Buffer.from("GMLINK1"), Buffer.from(mode), raw(ce), raw(re), raw(rs), bound]));
  const okm = Buffer.from(hkdfSync("sha256", Buffer.concat(ikm), th, "godmode link v1", 64));
  return { c2r: okm.subarray(0, 32), r2c: okm.subarray(32, 64) };
}

function specSeal(key: Buffer, direction: 0x01 | 0x02, counter: number, plain: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeBigUInt64BE(BigInt(counter));
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.concat([Buffer.alloc(4), head]));
  cipher.setAAD(Buffer.concat([Buffer.from("GMLINK1"), Buffer.from([direction])]));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([head, body, cipher.getAuthTag()]);
}

function specOpen(key: Buffer, direction: 0x01 | 0x02, counter: number, frame: Message): Buffer {
  const data = Buffer.from(frame as Uint8Array);
  expect(Number(data.readBigUInt64BE(0))).toBe(counter);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.concat([Buffer.alloc(4), data.subarray(0, 8)]));
  decipher.setAAD(Buffer.concat([Buffer.from("GMLINK1"), Buffer.from([direction])]));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(8, data.length - 16)), decipher.final()]);
}

const jsonPlain = (value: unknown) => Buffer.concat([Buffer.from([0x01]), Buffer.from(JSON.stringify(value), "utf8")]);

function chunkPlain(streamId: number, last: boolean, bytes: Uint8Array): Buffer {
  const head = Buffer.alloc(6);
  head[0] = 0x02;
  head.writeUInt32BE(streamId, 1);
  head[5] = last ? 1 : 0;
  return Buffer.concat([head, bytes]);
}

/** One end of a connection for a test that plays the other end by hand. */
function recorder() {
  const sent: Message[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const transport: Transport = {
    send: (data) => void sent.push(typeof data === "string" ? data : new Uint8Array(data)),
    close: (code, reason) => void closes.push({ code, reason }),
  };
  return { sent, closes, transport };
}

/**
 * Two transports back to back, standing in for a socket: what one side sends arrives at the other a moment later, in
 * order, and closing one end closes the other. `tamper` is the network in between.
 */
class Wire {
  readonly ends: Record<Side, SecureChannel | null> = { controller: null, runner: null };
  readonly sent: { from: Side; data: Message }[] = [];
  readonly closes: { by: Side; code?: number; reason?: string }[] = [];
  /** What arrives for one message that was sent: the place to change, drop, repeat or reorder it. */
  tamper: (from: Side, data: Message) => Message[] = (_from, data) => [data];

  transport(side: Side): Transport {
    const other: Side = side === "controller" ? "runner" : "controller";
    return {
      send: (data) => {
        const copy = typeof data === "string" ? data : new Uint8Array(data);
        this.sent.push({ from: side, data: copy });
        for (const out of this.tamper(side, copy)) queueMicrotask(() => this.ends[other]?.receive(out));
      },
      close: (code, reason) => {
        this.closes.push({ by: side, code, reason });
        queueMicrotask(() => this.ends[other]?.close());
      },
    };
  }

  /** The encrypted frames one side sent, in order. */
  frames(from: Side): Buffer[] {
    return this.sent.filter((m) => m.from === from && typeof m.data !== "string").map((m) => Buffer.from(m.data as Uint8Array));
  }
}

/** What the runner's database is to the channel: the controllers it knows, the pairing that is open, who paired. */
function runnerSide(identity: LinkIdentity = RUNNER) {
  const controllers = new Map<string, string>();
  const pairings = new Map<string, string>();
  const paired: { key: string; name: string }[] = [];
  const options: ResponderOptions = {
    identity,
    lookupController: (id) => controllers.get(id) ?? null,
    lookupPairing: (id) => pairings.get(id) ?? null,
    onPaired: (key, name) => {
      paired.push({ key, name });
      controllers.set(controllerLookupId(key), key);
      pairings.clear();
    },
    info: () => INFO,
  };
  return { controllers, pairings, paired, options, know: (key: string) => void controllers.set(controllerLookupId(key), key) };
}

interface Linked {
  wire: Wire;
  controller: SecureChannel<RunnerInfo>;
  runner: SecureChannel<LinkPeer>;
}

function link(initiator: InitiatorOptions, responder: ResponderOptions, wire = new Wire()): Linked {
  const runner = SecureChannel.responder(wire.transport("runner"), responder);
  wire.ends.runner = runner;
  const controller = SecureChannel.initiator(wire.transport("controller"), initiator);
  wire.ends.controller = controller;
  return { wire, controller, runner };
}

const SESSION: InitiatorOptions = { identity: CONTROLLER, remoteKey: RUNNER.publicKey, mode: "session", name: NAME };
const PAIR: InitiatorOptions = { identity: CONTROLLER, remoteKey: RUNNER.publicKey, mode: "pair", pairingId: PAIRING, secret: SECRET, name: NAME };

/** A controller the runner knows, connected and through the handshake. */
async function session(): Promise<Linked> {
  const world = runnerSide();
  world.know(CONTROLLER.publicKey);
  const linked = link(SESSION, world.options);
  await Promise.all([linked.controller.ready, linked.runner.ready]);
  return linked;
}

/** How a handshake ended: "ready", or the code it failed with. */
function outcome(channel: SecureChannel): Promise<string> {
  return channel.ready.then(
    () => "ready",
    (err: unknown) => (err instanceof LinkError ? err.code : `not a LinkError: ${String(err)}`),
  );
}

function listen(channel: SecureChannel) {
  const json: unknown[] = [];
  const binary: { streamId: number; bytes: Uint8Array }[] = [];
  const closed: (string | null)[] = [];
  channel.onJson = (value) => void json.push(value);
  channel.onBinary = (streamId, bytes) => void binary.push({ streamId, bytes });
  channel.onClose = (err) => void closed.push(err ? err.code : null);
  return { json, binary, closed };
}

/** Plays the controller of a session by hand against a real runner end and hands back the keys it derived. */
async function controllerByHand() {
  const world = runnerSide();
  world.know(CONTROLLER.publicKey);
  const wire = recorder();
  const runner = SecureChannel.responder(wire.transport, world.options);
  const seen = listen(runner);
  const ce = generateKeyPair();
  runner.receive(JSON.stringify({ t: "hello", v: 1, mode: "session", e: ce.publicKey, id: sha256(raw(CONTROLLER.publicKey)).toString("base64url") }));
  const hello = JSON.parse(wire.sent[0] as string) as { t: string; v: number; e: string };
  const ikm = [specDh(ce, hello.e), specDh(ce, RUNNER.publicKey), specDh(CONTROLLER, hello.e)];
  const keys = specKeys("session", ikm, ce.publicKey, hello.e, RUNNER.publicKey, raw(CONTROLLER.publicKey));
  let counter = 0;
  const send = (plain: Uint8Array) => runner.receive(specSeal(keys.c2r, 0x01, counter++, plain));
  send(jsonPlain({ t: "auth", name: "By hand", version: "9.9.9" }));
  const peer = await runner.ready;
  return { runner, seen, wire, hello, keys, send, peer };
}

describe("link key", () => {
  test("a new installation gets a link key only its owner can read", () => {
    const dir = join(root, "fresh", "data");
    const identity = loadIdentity(dir);

    expect(readdirSync(dir)).toEqual([LINK_KEY_FILE]);
    expect(statSync(join(dir, LINK_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, LINK_KEY_FILE), "utf8"))).toEqual(identity);
    expect(raw(identity.publicKey)).toHaveLength(32);
    expect(raw(identity.privateKey)).toHaveLength(32);
    expect(isKeyPair(identity)).toBe(true);
    expect(identity.publicKey).not.toBe(loadIdentity(join(root, "another")).publicKey);
  });

  test("the key stays the same once it exists, and the data dir of the running core is the default place", () => {
    const dataDir = join(root, "configured");
    loadConfig({ dataDir });
    const identity = loadIdentity();

    expect(loadIdentity()).toEqual(identity);
    expect(loadIdentity(dataDir)).toEqual(identity);
    expect(JSON.parse(readFileSync(join(dataDir, LINK_KEY_FILE), "utf8"))).toEqual(identity);
  });

  test("a key file others could read is locked down when it is loaded", () => {
    const dir = join(root, "loose");
    const identity = loadIdentity(dir);
    chmodSync(join(dir, LINK_KEY_FILE), 0o644);

    expect(loadIdentity(dir)).toEqual(identity);
    expect(statSync(join(dir, LINK_KEY_FILE)).mode & 0o777).toBe(0o600);
  });

  test("a damaged key file is reported, never silently replaced by a new key", () => {
    const dir = join(root, "damaged");
    const file = join(dir, LINK_KEY_FILE);
    const identity = loadIdentity(dir);
    const broken = [
      "not json",
      "{}",
      JSON.stringify({ publicKey: identity.publicKey }),
      JSON.stringify({ publicKey: STRANGER.publicKey, privateKey: identity.privateKey }),
      JSON.stringify({ publicKey: identity.publicKey, privateKey: identity.privateKey.slice(2) }),
    ];
    for (const content of broken) {
      writeFileSync(file, content);
      expect(() => loadIdentity(dir)).toThrow("damaged");
      expect(readFileSync(file, "utf8")).toBe(content);
    }
  });

  test("processes that need the key at the same moment end up with the same one", async () => {
    const dir = join(root, "race");
    const module = JSON.stringify(join(import.meta.dir, "../src/remote/identity.ts"));
    const script = `import { loadIdentity } from ${module}; process.stdout.write(loadIdentity(${JSON.stringify(dir)}).publicKey);`;
    const keys = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
        const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return out.trim() || `failed: ${err}`;
      }),
    );

    expect(new Set(keys)).toEqual(new Set([loadIdentity(dir).publicKey]));
    expect(readdirSync(dir)).toEqual([LINK_KEY_FILE]);
  });

  test("the fingerprint is the first six bytes of the key's SHA-256, in groups of four", () => {
    const expected = sha256(raw(RUNNER.publicKey)).subarray(0, 6).toString("hex").toUpperCase();

    expect(fingerprint(RUNNER.publicKey)).toMatch(/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
    expect(fingerprint(RUNNER.publicKey).replaceAll(" ", "")).toBe(expected);
    expect(fingerprint(Buffer.alloc(32, 1).toString("base64url"))).toBe("72CD 6E84 22C4");
    expect(fingerprint(RUNNER.publicKey)).not.toBe(fingerprint(CONTROLLER.publicKey));
  });

  test("a controller is looked up by the SHA-256 of its key, not by the key", () => {
    expect(controllerLookupId(CONTROLLER.publicKey)).toBe(sha256(raw(CONTROLLER.publicKey)).toString("base64url"));
    expect(controllerLookupId(CONTROLLER.publicKey)).not.toContain(CONTROLLER.publicKey);
    expect(() => controllerLookupId("not a key")).toThrow();
  });
});

describe("key agreement and frames", () => {
  const ALICE = {
    privateKey: Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex").toString("base64url"),
    publicKey: Buffer.from("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "hex").toString("base64url"),
  };
  const BOB = {
    privateKey: Buffer.from("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb", "hex").toString("base64url"),
    publicKey: Buffer.from("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f", "hex").toString("base64url"),
  };

  test("X25519 gives the shared secret of the RFC 7748 example", () => {
    const shared = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

    expect(dh(ALICE, BOB.publicKey).toString("hex")).toBe(shared);
    expect(dh(BOB, ALICE.publicKey).toString("hex")).toBe(shared);
    expect(isKeyPair(ALICE)).toBe(true);
    expect(isKeyPair({ publicKey: BOB.publicKey, privateKey: ALICE.privateKey })).toBe(false);
  });

  test("keys that would make the secret predictable, or aren't 32 bytes, are refused", () => {
    const weak = [
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0100000000000000000000000000000000000000000000000000000000000000",
      "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ];
    for (const hex of weak) expect(() => dh(ALICE, Buffer.from(hex, "hex").toString("base64url"))).toThrow();

    const short = randomBytes(31).toString("base64url");
    const long = randomBytes(33).toString("base64url");
    for (const bad of ["", "abc", short, long, `${BOB.publicKey}=`, BOB.publicKey.replace(/.$/, "!")]) {
      expect(() => decodeKey(bad)).toThrow();
      expect(() => dh(ALICE, bad)).toThrow();
    }
    expect(() => decodeKey(undefined)).toThrow();
    expect(canonicalKey(BOB.publicKey)).toBe(BOB.publicKey);
    expect(() => decodeSecret(randomBytes(8).toString("base64url"))).toThrow();
    expect(decodeSecret(SECRET)).toEqual(raw(SECRET));
  });

  test("both sides derive the keys the spec describes, a different one for each direction", () => {
    const ce = generateKeyPair();
    const re = generateKeyPair();

    const session = specKeys(
      "session",
      [specDh(ce, re.publicKey), specDh(ce, RUNNER.publicKey), specDh(CONTROLLER, re.publicKey)],
      ce.publicKey,
      re.publicKey,
      RUNNER.publicKey,
      raw(CONTROLLER.publicKey),
    );
    const toRunner = { ephemeral: ce, responderEphemeral: re.publicKey, responderStatic: RUNNER.publicKey };
    const toController = { ephemeral: re, identity: RUNNER, initiatorEphemeral: ce.publicKey };
    expect(initiatorKeys({ ...toRunner, mode: "session", identity: CONTROLLER })).toEqual(session);
    expect(responderKeys({ ...toController, mode: "session", controllerKey: CONTROLLER.publicKey })).toEqual(session);
    expect(session.c2r.equals(session.r2c)).toBe(false);

    const psk = raw(SECRET);
    const pairIkm = [specDh(ce, re.publicKey), specDh(ce, RUNNER.publicKey), psk];
    const pair = specKeys("pair", pairIkm, ce.publicKey, re.publicKey, RUNNER.publicKey, Buffer.from(PAIRING));
    expect(initiatorKeys({ ...toRunner, mode: "pair", pairingId: PAIRING, psk })).toEqual(pair);
    expect(responderKeys({ ...toController, mode: "pair", pairingId: PAIRING, psk })).toEqual(pair);
    expect(psk.equals(raw(SECRET))).toBe(true);
    expect(pair.c2r.equals(session.c2r)).toBe(false);

    // Every input counts: another secret, pairing id, runner key or controller key gives other keys.
    const other = (keys: { c2r: Buffer }) => expect(keys.c2r.equals(pair.c2r) || keys.c2r.equals(session.c2r)).toBe(false);
    other(initiatorKeys({ ...toRunner, mode: "pair", pairingId: PAIRING, psk: randomBytes(32) }));
    other(initiatorKeys({ ...toRunner, mode: "pair", pairingId: "pair_other", psk }));
    other(initiatorKeys({ ...toRunner, responderStatic: STRANGER.publicKey, mode: "pair", pairingId: PAIRING, psk }));
    other(initiatorKeys({ ...toRunner, mode: "session", identity: STRANGER }));
    other(responderKeys({ ...toController, mode: "session", controllerKey: STRANGER.publicKey }));
  });

  test("a frame is counter, ciphertext and tag, and opens only as the frame it was sealed as", () => {
    const key = randomBytes(32);
    const plain = Buffer.from("\u0001{\"t\":\"ping\"}");
    const frame = sealFrame(key, "c2r", 5, [plain.subarray(0, 3), plain.subarray(3)]);

    expect(frame).toHaveLength(plain.length + FRAME_OVERHEAD);
    expect(frame.subarray(0, 8).toString("hex")).toBe("0000000000000005");
    expect(frame.equals(specSeal(key, 0x01, 5, plain))).toBe(true);
    expect(specOpen(key, 0x01, 5, frame).equals(plain)).toBe(true);
    expect(openFrame(key, "c2r", 5, frame).equals(plain)).toBe(true);
    expect(openFrame(key, "r2c", 0, specSeal(key, 0x02, 0, plain)).equals(plain)).toBe(true);

    expect(() => openFrame(key, "c2r", 4, frame)).toThrow();
    expect(() => openFrame(key, "c2r", 6, frame)).toThrow();
    expect(() => openFrame(key, "r2c", 5, frame)).toThrow();
    expect(() => openFrame(randomBytes(32), "c2r", 5, frame)).toThrow();
    expect(() => openFrame(key, "c2r", 5, frame.subarray(0, frame.length - 1))).toThrow();
    expect(() => openFrame(key, "c2r", 5, frame.subarray(0, 23))).toThrow();
    expect(() => openFrame(Buffer.alloc(0), "c2r", 5, frame)).toThrow();
    for (let bit = 0; bit < frame.length * 8; bit++) {
      const changed = Buffer.from(frame);
      changed[bit >> 3] ^= 1 << (bit & 7);
      expect(() => openFrame(key, "c2r", 5, changed)).toThrow();
    }
  });

  test("a frame carries at most MAX_FRAME of plaintext, when sealing and when opening", () => {
    const key = randomBytes(32);
    const full = randomBytes(MAX_FRAME);
    const frame = sealFrame(key, "r2c", 0, [full]);

    expect(MAX_FRAME).toBe(1024 * 1024);
    expect(openFrame(key, "r2c", 0, frame).equals(full)).toBe(true);
    expect(() => sealFrame(key, "r2c", 0, [full, Buffer.alloc(1)])).toThrow(RangeError);
    // A frame the spec's own cipher would accept is still refused once it is one byte too long.
    expect(() => openFrame(key, "r2c", 0, specSeal(key, 0x02, 0, Buffer.concat([full, Buffer.alloc(1)])))).toThrow("size");
  });

  test("a counter never goes past 2^53 - 1, where numbers stop being exact", () => {
    const key = randomBytes(32);
    const last = MAX_FRAMES - 1;

    expect(MAX_FRAMES).toBe(2 ** 53 - 1);
    expect(openFrame(key, "c2r", last, sealFrame(key, "c2r", last, [Buffer.from("x")])).toString()).toBe("x");
    expect(sealFrame(key, "c2r", last, []).subarray(0, 8).toString("hex")).toBe("001ffffffffffffe");
    for (const counter of [MAX_FRAMES, MAX_FRAMES + 1, -1, 1.5, Number.NaN]) {
      expect(() => sealFrame(key, "c2r", counter, [])).toThrow(RangeError);
      expect(() => openFrame(key, "c2r", counter, Buffer.alloc(24))).toThrow(RangeError);
    }
  });
});

describe("secure channel", () => {
  test("after a session handshake both sides exchange JSON and binary of every size", async () => {
    const { wire, controller, runner } = await session();
    const atRunner = listen(runner);
    const atController = listen(controller);

    expect(await controller.ready).toEqual(INFO);
    expect(await runner.ready).toEqual({ controllerKey: CONTROLLER.publicKey, name: NAME, version: VERSION });

    const payloads = [new Uint8Array(0), Uint8Array.of(7), randomBytes(MAX_FRAME), randomBytes(5 * 1024 * 1024)];
    controller.sendJson({ t: "req", id: 1, method: "GET", path: "/api/agents?q=grüße" });
    runner.sendJson({ t: "res", id: 1, status: 200 });
    payloads.forEach((bytes, i) => {
      controller.sendBinary(i, bytes);
      runner.sendBinary(100 + i, bytes);
    });
    controller.sendJson(["after", "the", "streams"]);
    runner.sendJson(null);
    await flush();

    expect(atRunner.json).toEqual([{ t: "req", id: 1, method: "GET", path: "/api/agents?q=grüße" }, ["after", "the", "streams"]]);
    expect(atController.json).toEqual([{ t: "res", id: 1, status: 200 }, null]);
    expect(atRunner.binary.map((b) => b.streamId)).toEqual([0, 1, 2, 3]);
    expect(atController.binary.map((b) => b.streamId)).toEqual([100, 101, 102, 103]);
    payloads.forEach((bytes, i) => {
      expect(Buffer.from(atRunner.binary[i].bytes).equals(bytes)).toBe(true);
      expect(Buffer.from(atController.binary[i].bytes).equals(bytes)).toBe(true);
    });
    // 1 + 1 + 2 + 6 frames for the four streams: nothing on the transport is larger than one frame.
    expect(wire.frames("controller")).toHaveLength(1 + 1 + 10 + 1);
    expect(Math.max(...wire.sent.map((m) => m.data.length))).toBe(MAX_FRAME + FRAME_OVERHEAD);
    expect(atRunner.closed).toEqual([]);
    expect(atController.closed).toEqual([]);
  });

  test("a controller written from the spec alone gets through the handshake and is understood", async () => {
    const { runner, seen, wire, hello, keys, send, peer } = await controllerByHand();

    expect(hello).toEqual({ t: "hello", v: LINK_PROTOCOL, e: expect.any(String) });
    expect(peer).toEqual({ controllerKey: CONTROLLER.publicKey, name: "By hand", version: "9.9.9" });
    const ready = specOpen(keys.r2c, 0x02, 0, wire.sent[1]);
    expect(ready[0]).toBe(0x01);
    expect(JSON.parse(ready.subarray(1).toString("utf8"))).toEqual({ t: "ready", info: INFO });

    // Two streams whose chunks alternate come out as two streams.
    send(jsonPlain({ hello: "wörld" }));
    send(chunkPlain(5, false, Buffer.from("ab")));
    send(chunkPlain(6, true, Buffer.from("xyz")));
    send(chunkPlain(5, true, Buffer.from("cd")));
    expect(seen.json).toEqual([{ hello: "wörld" }]);
    expect(seen.binary.map((b) => [b.streamId, Buffer.from(b.bytes).toString()])).toEqual([
      [6, "xyz"],
      [5, "abcd"],
    ]);

    runner.sendBinary(9, Buffer.from("pong"));
    const chunk = specOpen(keys.r2c, 0x02, 1, wire.sent[2]);
    expect([...chunk.subarray(0, 6)]).toEqual([0x02, 0, 0, 0, 9, 0x01]);
    expect(chunk.subarray(6).toString()).toBe("pong");
    expect(seen.closed).toEqual([]);
  });

  test("a runner written from the spec alone is accepted, one without the pinned key is not", async () => {
    const answer = (identity: LinkIdentity) => {
      const wire = recorder();
      const controller = SecureChannel.initiator(wire.transport, SESSION);
      const hello = JSON.parse(wire.sent[0] as string) as Record<string, unknown> & { e: string };
      const re = generateKeyPair();
      const ikm = [specDh(re, hello.e), specDh(identity, hello.e), specDh(re, CONTROLLER.publicKey)];
      const keys = specKeys("session", ikm, hello.e, re.publicKey, RUNNER.publicKey, raw(CONTROLLER.publicKey));
      controller.receive(JSON.stringify({ t: "hello", v: LINK_PROTOCOL, e: re.publicKey }));
      return { wire, controller, hello, keys };
    };

    const real = answer(RUNNER);
    const id = sha256(raw(CONTROLLER.publicKey)).toString("base64url");
    expect(real.hello).toEqual({ t: "hello", v: LINK_PROTOCOL, mode: "session", e: expect.any(String), id });
    const auth = specOpen(real.keys.c2r, 0x01, 0, real.wire.sent[1]);
    expect(auth[0]).toBe(0x01);
    expect(JSON.parse(auth.subarray(1).toString("utf8"))).toEqual({ t: "auth", name: NAME, version: VERSION });
    real.controller.receive(specSeal(real.keys.r2c, 0x02, 0, jsonPlain({ t: "ready", info: INFO })));
    expect(await real.controller.ready).toEqual(INFO);

    // Whoever answers in the runner's place can't know DH(C.e, R.s), so nothing it seals opens at the controller.
    const fake = answer(STRANGER);
    fake.controller.receive(specSeal(fake.keys.r2c, 0x02, 0, jsonPlain({ t: "ready", info: INFO })));
    expect(await outcome(fake.controller)).toBe("bad_frame");
    expect(fake.wire.closes).toEqual([{ code: 4000, reason: "bad_frame" }]);
  });

  test("pairing registers the controller, and the same secret can't be used a second time", async () => {
    const world = runnerSide();
    world.pairings.set(PAIRING, SECRET);
    const wire = new Wire();
    let sentBeforeStored = -1;
    const stored = world.options.onPaired;
    world.options.onPaired = (key, name) => {
      sentBeforeStored = wire.sent.filter((m) => m.from === "runner").length;
      stored(key, name);
    };

    const first = link(PAIR, world.options, wire);
    expect(await first.controller.ready).toEqual(INFO);
    expect(await first.runner.ready).toEqual({ controllerKey: CONTROLLER.publicKey, name: NAME, version: VERSION });
    expect(world.paired).toEqual([{ key: CONTROLLER.publicKey, name: NAME }]);
    // The runner had only said hello when the controller was stored: `ready` came after.
    expect(sentBeforeStored).toBe(1);

    // The same code again, from another computer and from the same one.
    for (const identity of [STRANGER, CONTROLLER]) {
      const again = link({ ...PAIR, identity }, world.options);
      expect(await outcome(again.controller)).toBe("pairing_invalid");
      expect(await outcome(again.runner)).toBe("pairing_invalid");
    }
    expect(world.paired).toHaveLength(1);

    // The controller that paired gets in with its key from now on; the other one doesn't.
    const known = link(SESSION, world.options);
    expect(await known.controller.ready).toEqual(INFO);
    expect(await outcome(link({ ...SESSION, identity: STRANGER }, world.options).controller)).toBe("unknown_controller");
  });

  test("pairing refuses a controller key that could never open a session, and keeps the code for a real one", async () => {
    const world = runnerSide();
    world.pairings.set(PAIRING, SECRET);
    // In pair mode the controller's own key isn't part of the key agreement, so any 32 bytes reach the runner.
    const zero = { publicKey: Buffer.alloc(32).toString("base64url"), privateKey: CONTROLLER.privateKey };
    const bad = link({ ...PAIR, identity: zero }, world.options);
    expect(await outcome(bad.runner)).toBe("bad_frame");
    expect(world.paired).toEqual([]);
    const good = link(PAIR, world.options);
    expect(await good.controller.ready).toEqual(INFO);
    expect(world.paired).toEqual([{ key: CONTROLLER.publicKey, name: NAME }]);
  });

  test("two controllers that start pairing with one code at the same moment: only the first is stored", async () => {
    const world = runnerSide();
    world.pairings.set(PAIRING, SECRET);
    const first = link(PAIR, world.options);
    const second = link({ ...PAIR, identity: STRANGER }, world.options);

    expect(await outcome(first.controller)).toBe("ready");
    expect(await outcome(second.runner)).toBe("pairing_invalid");
    expect(await outcome(second.controller)).toBe("closed");
    expect(world.paired).toEqual([{ key: CONTROLLER.publicKey, name: NAME }]);
  });

  test("a wrong pairing secret is refused and pairs nothing", async () => {
    const world = runnerSide();
    world.pairings.set(PAIRING, SECRET);
    const { wire, controller, runner } = link({ ...PAIR, secret: randomBytes(32).toString("base64url") }, world.options);

    expect(await outcome(runner)).toBe("pairing_invalid");
    // The runner can't tell the controller why in a way the controller could trust: it closes, with the code as reason.
    expect(await outcome(controller)).toBe("closed");
    expect(wire.closes[0]).toEqual({ by: "runner", code: 4000, reason: "pairing_invalid" });
    expect(wire.sent.filter((m) => m.from === "runner")).toHaveLength(1);
    expect(world.paired).toEqual([]);

    // The right secret still works afterwards.
    expect(await outcome(link(PAIR, world.options).controller)).toBe("ready");
  });

  test("an unknown or expired pairing id is refused", async () => {
    const world = runnerSide();
    world.pairings.set("pair_other", SECRET);
    const { wire, controller, runner } = link(PAIR, world.options);

    expect(await outcome(controller)).toBe("pairing_invalid");
    expect(await outcome(runner)).toBe("pairing_invalid");
    expect(JSON.parse(wire.sent[1].data as string)).toEqual({ t: "error", code: "pairing_invalid", message: expect.any(String) });
    expect(wire.sent).toHaveLength(2);
    expect(world.paired).toEqual([]);
  });

  test("a pairing code whose key or secret isn't one is refused before anything is sent", async () => {
    const world = runnerSide();
    world.pairings.set(PAIRING, SECRET);
    for (const broken of [{ remoteKey: "bm90IGEga2V5" }, { secret: "c2hvcnQ" }, { secret: "not base64url!" }]) {
      const { wire, controller } = link({ ...PAIR, ...broken }, world.options);
      const seen = listen(controller);
      expect(await outcome(controller)).toBe("pairing_invalid");
      expect(seen.closed).toEqual(["pairing_invalid"]);
      expect(wire.sent).toEqual([]);
    }
    // A secret the runner itself can't use never becomes a key.
    world.pairings.set(PAIRING, "c2hvcnQ");
    expect(await outcome(link({ ...PAIR, secret: "c2hvcnQtc2hvcnQtc2hvcnQtc2hvcnQ" }, world.options).runner)).toBe("pairing_invalid");
  });

  test("a controller the runner doesn't know is refused", async () => {
    const world = runnerSide();
    world.know(STRANGER.publicKey);
    const { wire, controller, runner } = link(SESSION, world.options);

    expect(await outcome(controller)).toBe("unknown_controller");
    expect(await outcome(runner)).toBe("unknown_controller");
    expect(JSON.parse(wire.sent[1].data as string)).toEqual({ t: "error", code: "unknown_controller", message: expect.any(String) });

    // A lookup that hands out some other controller's key for the id is not believed either.
    world.options.lookupController = () => STRANGER.publicKey;
    expect(await outcome(link(SESSION, world.options).runner)).toBe("unknown_controller");
  });

  test("a controller that claims a known controller's id without its private key doesn't get in", async () => {
    const world = runnerSide();
    world.know(CONTROLLER.publicKey);
    const impostor = { publicKey: CONTROLLER.publicKey, privateKey: STRANGER.privateKey };
    const { wire, controller, runner } = link({ ...SESSION, identity: impostor }, world.options);
    const seen = listen(runner);

    expect(await outcome(runner)).toBe("bad_frame");
    expect(await outcome(controller)).toBe("closed");
    expect(seen.closed).toEqual(["bad_frame"]);
    expect(wire.frames("runner")).toEqual([]);
  });

  test("a controller that pinned another runner's key can't connect", async () => {
    const world = runnerSide();
    world.know(CONTROLLER.publicKey);
    const { wire, controller, runner } = link({ ...SESSION, remoteKey: STRANGER.publicKey }, world.options);

    expect(await outcome(runner)).toBe("bad_frame");
    expect(await outcome(controller)).toBe("closed");
    expect(wire.closes[0]).toEqual({ by: "runner", code: 4000, reason: "bad_frame" });
    // The runner never produced `ready`: the controller's first frame didn't open.
    expect(wire.frames("runner")).toEqual([]);

    // The same while pairing: the code named another runner's key.
    world.pairings.set(PAIRING, SECRET);
    const pairing = link({ ...PAIR, remoteKey: STRANGER.publicKey }, world.options);
    expect(await outcome(pairing.runner)).toBe("pairing_invalid");
    expect(await outcome(pairing.controller)).toBe("closed");
    expect(world.paired).toEqual([]);
  });

  test("different link versions are refused, whichever side is the newer one", async () => {
    const world = runnerSide();
    world.know(CONTROLLER.publicKey);
    const otherVersion = (side: Side) => {
      const wire = new Wire();
      wire.tamper = (from, data) => [from === side && typeof data === "string" ? JSON.stringify({ ...JSON.parse(data), v: LINK_PROTOCOL + 1 }) : data];
      return link(SESSION, world.options, wire);
    };

    const newController = otherVersion("controller");
    expect(await outcome(newController.runner)).toBe("protocol_mismatch");
    expect(await outcome(newController.controller)).toBe("protocol_mismatch");
    expect(JSON.parse(newController.wire.sent[1].data as string)).toEqual({ t: "error", code: "protocol_mismatch", message: expect.any(String) });

    const newRunner = otherVersion("runner");
    expect(await outcome(newRunner.controller)).toBe("protocol_mismatch");
    expect(newRunner.wire.frames("controller")).toEqual([]);
  });

  test("a single flipped bit closes the channel, wherever in the frame it is", async () => {
    for (const where of ["counter", "ciphertext", "tag"] as const) {
      const { wire, controller, runner } = await session();
      const atRunner = listen(runner);
      const atController = listen(controller);
      wire.tamper = (from, data) => {
        if (from !== "controller" || typeof data === "string") return [data];
        const changed = new Uint8Array(data);
        changed[where === "counter" ? 7 : where === "ciphertext" ? 8 : changed.length - 1] ^= 1;
        return [changed];
      };
      controller.sendJson({ transfer: 100, to: "alice" });
      await flush();

      expect(atRunner.json).toEqual([]);
      expect(atRunner.closed).toEqual(["bad_frame"]);
      expect(atController.closed).toEqual([null]);
      expect(() => runner.sendJson({})).toThrow(LinkError);
      expect(() => controller.sendJson({})).toThrow(LinkError);
    }
  });

  test("a replayed frame closes the channel", async () => {
    const { wire, controller, runner } = await session();
    const seen = listen(runner);
    wire.tamper = (from, data) => (from === "controller" ? [data, data] : [data]);
    controller.sendJson({ transfer: 100, to: "alice" });
    await flush();

    expect(seen.json).toEqual([{ transfer: 100, to: "alice" }]);
    expect(seen.closed).toEqual(["bad_frame"]);
  });

  test("frames that swap places close the channel", async () => {
    const { wire, controller, runner } = await session();
    const seen = listen(runner);
    let held: Message | null = null;
    wire.tamper = (from, data) => {
      if (from !== "controller") return [data];
      if (held === null) {
        held = data;
        return [];
      }
      return [data, held];
    };
    controller.sendJson({ step: 1 });
    controller.sendJson({ step: 2 });
    await flush();

    expect(seen.json).toEqual([]);
    expect(seen.closed).toEqual(["bad_frame"]);
  });

  test("a frame that got lost closes the channel when the next one arrives", async () => {
    const { wire, controller, runner } = await session();
    const seen = listen(runner);
    let dropped = false;
    wire.tamper = (from, data) => {
      if (from !== "controller" || dropped) return [data];
      dropped = true;
      return [];
    };
    controller.sendJson({ step: 1 });
    controller.sendJson({ step: 2 });
    await flush();

    expect(seen.json).toEqual([]);
    expect(seen.closed).toEqual(["bad_frame"]);
  });

  test("a frame sent back to its sender closes the channel", async () => {
    const { wire, controller } = await session();
    const seen = listen(controller);
    controller.sendJson({ t: "ping" });
    // Counter 1 in both directions: only the key and the direction byte stand between this frame and being accepted.
    controller.receive(wire.frames("controller")[1]);

    expect(seen.json).toEqual([]);
    expect(seen.closed).toEqual(["bad_frame"]);
  });

  test("unencrypted data after the handshake closes the channel", async () => {
    const { runner } = await session();
    const seen = listen(runner);
    runner.receive(JSON.stringify({ t: "req", id: 1, method: "GET", path: "/api/vault" }));

    expect(seen.json).toEqual([]);
    expect(seen.closed).toEqual(["bad_frame"]);
  });

  test("what isn't a hello is refused before any key is derived", async () => {
    const world = runnerSide();
    world.know(CONTROLLER.publicKey);
    const hello = { t: "hello", v: LINK_PROTOCOL, mode: "session", e: generateKeyPair().publicKey, id: controllerLookupId(CONTROLLER.publicKey) };
    const garbage: Message[] = [
      randomBytes(64),
      "not json",
      "[]",
      JSON.stringify({ ...hello, t: "auth" }),
      JSON.stringify({ ...hello, mode: "admin" }),
      JSON.stringify({ ...hello, e: "AAAA" }),
      JSON.stringify({ ...hello, e: Buffer.alloc(32).toString("base64url") }),
      JSON.stringify({ ...hello, id: 7 }),
      JSON.stringify({ ...hello, pad: "x".repeat(5000) }),
    ];
    for (const first of garbage) {
      const wire = recorder();
      const runner = SecureChannel.responder(wire.transport, world.options);
      runner.receive(first);
      expect(await outcome(runner)).toBe("bad_frame");
      expect(wire.sent.map((m) => JSON.parse(m as string))).toEqual([{ t: "error", code: "bad_frame", message: expect.any(String) }]);
      expect(wire.closes).toEqual([{ code: 4000, reason: "bad_frame" }]);
    }

    // The controller is as strict with what answers its hello, and takes no text from an error it can't verify.
    for (const [answer, code] of [
      [randomBytes(64), "bad_frame"],
      [JSON.stringify({ t: "hello", v: LINK_PROTOCOL, e: "AAAA" }), "bad_frame"],
      [JSON.stringify({ t: "error", code: "Visit evil.example to fix this", message: "x" }), "bad_frame"],
      [JSON.stringify({ t: "error", code: "unknown_controller", message: "Visit evil.example to fix this" }), "unknown_controller"],
    ] as const) {
      const wire = recorder();
      const controller = SecureChannel.initiator(wire.transport, SESSION);
      controller.receive(answer);
      const err = await controller.ready.catch((e: unknown) => e as LinkError);
      expect(err).toBeInstanceOf(LinkError);
      expect((err as LinkError).code).toBe(code);
      expect((err as LinkError).message).not.toContain("evil.example");
      expect(wire.sent).toHaveLength(1);
    }
  });

  test("every session has its own keys: the same message never looks the same twice", async () => {
    const message = { t: "req", id: 1, method: "GET", path: "/api/agents" };
    const a = await session();
    const b = await session();
    for (const { controller, runner } of [a, b]) {
      controller.sendJson(message);
      runner.sendJson(message);
    }
    const [authA, sentA] = a.wire.frames("controller");
    const [authB, sentB] = b.wire.frames("controller");
    const [, backA] = a.wire.frames("runner");

    expect(sentA).toHaveLength(sentB.length);
    expect(sentA.subarray(0, 8).equals(sentB.subarray(0, 8))).toBe(true);
    expect(sentA.subarray(8).equals(sentB.subarray(8))).toBe(false);
    expect(authA.subarray(8).equals(authB.subarray(8))).toBe(false);
    // Within one session each direction has its own key, too.
    expect(backA.subarray(0, 8).equals(sentA.subarray(0, 8))).toBe(true);
    expect(backA.subarray(8).equals(sentA.subarray(8))).toBe(false);
    expect(JSON.parse(a.wire.sent[0].data as string).e).not.toBe(JSON.parse(b.wire.sent[0].data as string).e);
    expect(JSON.parse(a.wire.sent[1].data as string).e).not.toBe(JSON.parse(b.wire.sent[1].data as string).e);
  });

  test("nothing is readable on the wire after the two hellos", async () => {
    const world = runnerSide();
    world.pairings.set(PAIRING, SECRET);
    const { wire, controller, runner } = link(PAIR, world.options);
    await Promise.all([controller.ready, runner.ready]);
    controller.sendJson({ t: "req", id: 1, method: "POST", path: "/api/credentials", note: "the password is hunter2-hunter2" });
    runner.sendJson({ t: "event", data: "top secret reply" });
    controller.sendBinary(1, Buffer.from("attack at dawn ".repeat(1000)));
    await flush();

    const [first, second, ...frames] = wire.sent;
    expect(JSON.parse(first.data as string)).toEqual({ t: "hello", v: LINK_PROTOCOL, mode: "pair", e: expect.any(String), id: PAIRING });
    expect(JSON.parse(second.data as string)).toEqual({ t: "hello", v: LINK_PROTOCOL, e: expect.any(String) });
    expect(frames).toHaveLength(5);
    expect(frames.every((m) => typeof m.data !== "string")).toBe(true);

    const onTheWire = frames.map((m) => Buffer.from(m.data as Uint8Array).toString("latin1")).join("\n");
    const said = ["hunter2", "top secret reply", "attack at dawn"];
    const handshake = ['{"t":', '"auth"', '"ready"', NAME, CONTROLLER.publicKey, INFO.hostname, `${VERSION}"`, SECRET];
    for (const text of [...said, ...handshake]) expect(onTheWire).not.toContain(text);

    // The hellos give away neither the secret nor who is pairing; a session's hello names the controller only by a hash.
    const hellos = `${first.data}\n${second.data}\n${(await session()).wire.sent[0].data}`;
    for (const text of [SECRET, NAME, CONTROLLER.publicKey, CONTROLLER.privateKey, RUNNER.publicKey]) expect(hellos).not.toContain(text);
  });

  test("a handshake that never finishes is closed after the timeout", async () => {
    const world = runnerSide();
    world.know(CONTROLLER.publicKey);

    // Someone connects and says nothing.
    const silent = recorder();
    const idle = SecureChannel.responder(silent.transport, { ...world.options, handshakeTimeoutMs: 20 });
    const idleSeen = listen(idle);
    expect(await outcome(idle)).toBe("handshake_timeout");
    expect(idleSeen.closed).toEqual(["handshake_timeout"]);
    expect(silent.closes).toEqual([{ code: 4000, reason: "handshake_timeout" }]);

    // Someone says hello and never proves who they are.
    const half = recorder();
    const stalled = SecureChannel.responder(half.transport, { ...world.options, handshakeTimeoutMs: 20 });
    const hello = { t: "hello", v: LINK_PROTOCOL, mode: "session", e: generateKeyPair().publicKey, id: controllerLookupId(CONTROLLER.publicKey) };
    stalled.receive(JSON.stringify(hello));
    expect(await outcome(stalled)).toBe("handshake_timeout");
    expect(half.sent).toHaveLength(1);
    expect(half.closes).toEqual([{ code: 4000, reason: "handshake_timeout" }]);
    // What arrives after that is ignored.
    stalled.receive(randomBytes(40));
    expect(half.closes).toHaveLength(1);

    // A runner that never answers doesn't keep the controller waiting either.
    const unanswered = SecureChannel.initiator(recorder().transport, { ...SESSION, handshakeTimeoutMs: 20 });
    expect(await outcome(unanswered)).toBe("handshake_timeout");
  });

  test("a finished handshake is not cut off when the timeout passes", async () => {
    const world = runnerSide();
    world.know(CONTROLLER.publicKey);
    const { controller, runner } = link({ ...SESSION, handshakeTimeoutMs: 20 }, { ...world.options, handshakeTimeoutMs: 20 });
    await Promise.all([controller.ready, runner.ready]);
    const seen = listen(runner);
    await sleep(60);
    controller.sendJson({ still: "here" });
    await flush();

    expect(seen.json).toEqual([{ still: "here" }]);
    expect(seen.closed).toEqual([]);
  });

  test("a stream of more than 256 MiB closes the channel", async () => {
    const { seen, send } = await controllerByHand();
    const chunk = chunkPlain(1, false, Buffer.alloc(MAX_FRAME - 6, 0x61));
    const fitting = Math.floor(MAX_STREAM / (MAX_FRAME - 6));

    expect(MAX_STREAM).toBe(256 * 1024 * 1024);
    for (let i = 0; i < fitting; i++) send(chunk);
    expect(seen.closed).toEqual([]);
    send(chunk);
    expect(seen.closed).toEqual(["bad_frame"]);
    expect(seen.binary).toEqual([]);
  });

  test("a flood of empty or one-byte chunks closes the channel before it can fill the memory", async () => {
    // A chunk the receiver has to keep counts as at least 4 KiB of the 256 MiB, however little it carries.
    const fitting = MAX_STREAM / 4096;

    for (const bytes of [Buffer.alloc(0), Buffer.from("a")]) {
      const { runner, seen, send } = await controllerByHand();
      const chunk = chunkPlain(7, false, bytes);
      for (let i = 0; i < fitting; i++) send(chunk);
      expect(seen.closed).toEqual([]);
      send(chunk);
      expect(seen.closed).toEqual(["bad_frame"]);
      expect(seen.binary).toEqual([]);
      // Nothing of the flood is held once the channel is closed.
      expect((runner as unknown as { streams: Map<number, unknown> }).streams.size).toBe(0);
    }
  });

  test("a stream in tiny chunks that stays inside the limit arrives whole, and what it held is free again", async () => {
    const { seen, send } = await controllerByHand();
    const fitting = MAX_STREAM / 4096;

    for (let i = 0; i < fitting - 1; i++) send(chunkPlain(7, false, Buffer.from("a")));
    // The last chunk isn't kept, so it counts as the bytes it has: exactly the 4 KiB that are still free.
    send(chunkPlain(7, true, Buffer.alloc(4096, 0x62)));
    expect(seen.closed).toEqual([]);
    expect(seen.binary.map((b) => b.streamId)).toEqual([7]);
    expect(Buffer.from(seen.binary[0].bytes).equals(Buffer.concat([Buffer.alloc(fitting - 1, 0x61), Buffer.alloc(4096, 0x62)]))).toBe(true);

    // The next stream gets as far as the first one could have, and its last chunk has to fit as well.
    for (let i = 0; i < fitting; i++) send(chunkPlain(8, false, Buffer.alloc(0)));
    expect(seen.closed).toEqual([]);
    send(chunkPlain(8, true, Buffer.from("c")));
    expect(seen.closed).toEqual(["bad_frame"]);
    expect(seen.binary).toHaveLength(1);
  });

  test("a message too large for one frame is refused without dropping the link", async () => {
    const { controller, runner } = await session();
    const seen = listen(runner);
    const tooLarge = () => controller.sendJson("x".repeat(MAX_FRAME - 2));

    expect(tooLarge).toThrow(LinkError);
    expect(tooLarge).toThrow("too large");
    expect(() => controller.sendBinary(-1, Buffer.alloc(1))).toThrow(RangeError);
    expect(() => controller.sendBinary(2 ** 32, Buffer.alloc(1))).toThrow(RangeError);
    // One byte less fills a frame exactly and goes through.
    controller.sendJson("x".repeat(MAX_FRAME - 3));
    await flush();

    expect(seen.json).toEqual(["x".repeat(MAX_FRAME - 3)]);
    expect(seen.closed).toEqual([]);
  });

  test("a channel that has used up its counters closes instead of sending", async () => {
    const { wire, controller } = await session();
    const seen = listen(controller);
    const before = wire.sent.length;
    (controller as unknown as { sent: number }).sent = MAX_FRAMES;

    expect(() => controller.sendJson({ one: "more" })).toThrow(LinkError);
    expect(wire.sent).toHaveLength(before);
    expect(seen.closed).toEqual(["closed"]);
  });

  test("closing wipes the keys, tells the owner once and closes the other end", async () => {
    const { wire, controller, runner } = await session();
    const atController = listen(controller);
    const atRunner = listen(runner);
    const internals = controller as unknown as { sendKey: Buffer; recvKey: Buffer };
    const keys = [internals.sendKey, internals.recvKey];
    expect(keys.every((key) => key.length === 32 && key.some((byte) => byte !== 0))).toBe(true);

    controller.close();
    controller.close();
    await flush();

    expect(keys.every((key) => key.every((byte) => byte === 0))).toBe(true);
    expect(internals.sendKey).toHaveLength(0);
    expect(internals.recvKey).toHaveLength(0);
    expect(atController.closed).toEqual([null]);
    expect(atRunner.closed).toEqual([null]);
    expect(wire.closes[0]).toEqual({ by: "controller", code: 1000, reason: "closed" });
    const err = (() => {
      try {
        controller.sendJson({});
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(LinkError);
    expect((err as LinkError).code).toBe("closed");
    expect(() => controller.sendBinary(1, Buffer.alloc(1))).toThrow(LinkError);
  });

  test("a channel closed before the handshake is done rejects with `closed`, and can't send before it is ready", async () => {
    const world = runnerSide();
    const runner = SecureChannel.responder(recorder().transport, world.options);
    const seen = listen(runner);

    expect(() => runner.sendJson({})).toThrow("isn't ready");
    runner.close();
    expect(await outcome(runner)).toBe("closed");
    expect(seen.closed).toEqual([null]);
  });

  test("an error in the owner's message handler is the owner's: the link stays up", async () => {
    const { wire, controller, runner } = await session();
    const seen = listen(runner);
    wire.tamper = (from, data) => (from === "controller" ? [] : [data]);
    controller.sendJson({ n: 1 });
    controller.sendJson({ n: 2 });
    const [, first, second] = wire.frames("controller");
    runner.onJson = () => {
      throw new Error("handler failed");
    };

    expect(() => runner.receive(first)).toThrow("handler failed");
    const later: unknown[] = [];
    runner.onJson = (value) => void later.push(value);
    runner.receive(second);
    expect(later).toEqual([{ n: 2 }]);
    expect(seen.closed).toEqual([]);
  });

  test("when the runner's own lookup or storing fails, the handshake ends without telling the other side why", async () => {
    const world = runnerSide();
    world.pairings.set(PAIRING, SECRET);
    world.options.onPaired = () => {
      throw new Error("disk is full at /Users/someone/.godmode-runner");
    };
    const pairing = link(PAIR, world.options);
    const err = await pairing.runner.ready.catch((e: unknown) => e as LinkError);
    expect((err as LinkError).code).toBe("internal");
    expect(((err as LinkError).cause as Error).message).toContain("disk is full");
    expect(await outcome(pairing.controller)).toBe("closed");
    expect(pairing.wire.frames("runner")).toEqual([]);

    world.options.lookupController = () => {
      throw new Error("database is locked at /Users/someone/.godmode-runner");
    };
    const lookup = link(SESSION, world.options);
    expect(await outcome(lookup.runner)).toBe("internal");
    expect(await outcome(lookup.controller)).toBe("internal");
    expect(lookup.wire.sent[1].data as string).not.toContain("someone");
  });
});
