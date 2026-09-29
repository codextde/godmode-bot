/**
 * A small RFB (VNC, RFC 6143) client for a VM's screen — macOS Screen Sharing in the guest (Apple Remote Desktop
 * authentication with the guest login) or any VNC server with a VNC password: a shared session (the human's Screen
 * Sharing stays connected), raw 32-bit framebuffer updates and pointer/key events. Screen Sharing is a system service,
 * so nothing needs Screen Recording or Accessibility permissions inside the guest.
 */
import { createCipheriv, createDiffieHellman, createHash, randomBytes } from "node:crypto";
import { Socket, connect } from "node:net";

const RAW = 0;
const DESKTOP_SIZE = -223;
const CONNECT_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 15_000;

export class VncError extends Error {}

/** Buffered reads of exact byte counts from the socket (chunks are joined only when a read needs them). */
class Reader {
  private chunks: Buffer[] = [];
  private length = 0;
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private error: Error | null = null;

  push(data: Buffer) {
    this.chunks.push(data);
    this.length += data.length;
    this.flush();
  }

  fail(err: Error) {
    this.error = err;
    if (this.waiter) {
      this.waiter.reject(err);
      this.waiter = null;
    }
  }

  read(n: number): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
      this.flush();
    });
  }

  private flush() {
    if (!this.waiter || this.length < this.waiter.n) return;
    const { n, resolve } = this.waiter;
    this.waiter = null;
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.length);
    const out = Buffer.from(all.subarray(0, n));
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    resolve(out);
  }
}

/** VNC authentication: DES-encrypt the challenge with the password, each key byte bit-reversed. */
export function vncAuthResponse(challenge: Buffer, password: string): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, "latin1").copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) {
    let b = key[i]!;
    let r = 0;
    for (let j = 0; j < 8; j++) {
      r = (r << 1) | (b & 1);
      b >>= 1;
    }
    key[i] = r;
  }
  const cipher = createCipheriv("des-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

/**
 * Apple Remote Desktop authentication (security type 30): Diffie-Hellman with the server's parameters, then the user
 * name and password (64 bytes each, NUL-terminated, random padding) AES-128-ECB-encrypted with MD5(shared secret).
 */
export function ardAuthResponse(params: { generator: number; prime: Buffer; serverKey: Buffer }, username: string, password: string): Buffer {
  const keyLength = params.prime.length;
  const g = Buffer.alloc(2);
  g.writeUInt16BE(params.generator);
  const dh = createDiffieHellman(params.prime, g);
  dh.generateKeys();
  const pad = (b: Buffer) => (b.length >= keyLength ? b : Buffer.concat([Buffer.alloc(keyLength - b.length), b]));
  const secret = pad(dh.computeSecret(params.serverKey));
  const creds = randomBytes(128);
  const user = Buffer.from(username, "utf8").subarray(0, 63);
  const pass = Buffer.from(password, "utf8").subarray(0, 63);
  user.copy(creds, 0);
  creds[user.length] = 0;
  pass.copy(creds, 64);
  creds[64 + pass.length] = 0;
  const cipher = createCipheriv("aes-128-ecb", createHash("md5").update(secret).digest(), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(creds), cipher.final(), pad(dh.getPublicKey())]);
}

export interface VncCredentials {
  host: string;
  port: number;
  /** With a user name: Apple Remote Desktop authentication (macOS Screen Sharing); without: a VNC password. */
  username?: string;
  password: string;
}

export class VncClient {
  width = 0;
  height = 0;
  name = "";
  /** BGRX, `width × height × 4`. */
  framebuffer = new Uint8Array(0);
  private reader = new Reader();
  private closed = false;
  private pendingUpdate: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private buttons = 0;
  /** Bumped on every screen size change (DesktopSize). */
  private sizeGeneration = 0;
  private refreshQueue: Promise<void> = Promise.resolve();

  private constructor(private socket: Socket) {
    socket.on("data", (d: Buffer) => this.reader.push(d));
    socket.on("error", (err) => this.shutdown(err));
    socket.on("close", () => this.shutdown(new VncError("The VM's screen connection closed")));
  }

  get alive(): boolean {
    return !this.closed;
  }

  static async connect(opts: VncCredentials): Promise<VncClient> {
    const socket = connect({ host: opts.host, port: opts.port });
    socket.setNoDelay(true);
    const client = new VncClient(socket);
    const timer = setTimeout(() => client.shutdown(new VncError("Timed out connecting to the VM's screen")), CONNECT_TIMEOUT_MS);
    try {
      await client.handshake(opts);
    } catch (err) {
      client.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    void client.loop();
    return client;
  }

  private async handshake({ username, password }: VncCredentials) {
    const r = this.reader;
    const version = (await r.read(12)).toString("latin1");
    const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(version);
    if (!m) throw new VncError(`Not a VNC server (${JSON.stringify(version)})`);
    // Apple's servers announce odd minors (3.889); anything from 3.8 on speaks 3.8.
    const serverMinor = Number(m[2]);
    const minor = Number(m[1]) > 3 || serverMinor >= 8 ? 8 : serverMinor === 7 ? 7 : 3;
    this.socket.write(`RFB 003.00${minor}\n`);
    let type: number;
    if (minor >= 7) {
      const count = (await r.read(1))[0]!;
      if (count === 0) throw new VncError(await this.reason());
      const types = [...(await r.read(count))];
      type = username && types.includes(30) ? 30 : types.includes(2) ? 2 : types.includes(1) ? 1 : -1;
      if (type < 0) throw new VncError(`Unsupported VNC security types ${types.join(",")}${username ? "" : " (a user name is needed for macOS Screen Sharing)"}`);
      this.socket.write(Buffer.from([type]));
    } else {
      type = (await r.read(4)).readUInt32BE(0);
      if (type === 0) throw new VncError(await this.reason());
    }
    if (type === 2) {
      const challenge = await r.read(16);
      this.socket.write(vncAuthResponse(challenge, password));
    } else if (type === 30) {
      const head = await r.read(4);
      const keyLength = head.readUInt16BE(2);
      if (keyLength < 16 || keyLength > 1024) throw new VncError(`Unexpected Apple authentication key length ${keyLength}`);
      const prime = await r.read(keyLength);
      const serverKey = await r.read(keyLength);
      this.socket.write(ardAuthResponse({ generator: head.readUInt16BE(0), prime, serverKey }, username ?? "", password));
    }
    if (type !== 1 || minor >= 8) {
      const result = (await r.read(4)).readUInt32BE(0);
      if (result !== 0) throw new VncError(minor >= 8 ? `VNC login failed: ${await this.reason()}` : "VNC login failed");
    }
    // ClientInit: shared — keep other viewers (Screen Sharing) connected.
    this.socket.write(Buffer.from([1]));
    const init = await r.read(24);
    this.resize(init.readUInt16BE(0), init.readUInt16BE(2));
    this.name = (await r.read(init.readUInt32BE(20))).toString("utf8");
    // 32 bpp, depth 24, little endian, true colour, 8 bits per channel: memory order B, G, R, X.
    const fmt = Buffer.alloc(20);
    fmt[0] = 0; // SetPixelFormat
    fmt[4] = 32;
    fmt[5] = 24;
    fmt[6] = 0;
    fmt[7] = 1;
    fmt.writeUInt16BE(255, 8);
    fmt.writeUInt16BE(255, 10);
    fmt.writeUInt16BE(255, 12);
    fmt[14] = 16;
    fmt[15] = 8;
    fmt[16] = 0;
    const enc = Buffer.alloc(4 + 8);
    enc[0] = 2; // SetEncodings
    enc.writeUInt16BE(2, 2);
    enc.writeInt32BE(RAW, 4);
    enc.writeInt32BE(DESKTOP_SIZE, 8);
    this.socket.write(Buffer.concat([fmt, enc]));
  }

  private async reason(): Promise<string> {
    const len = (await this.reader.read(4)).readUInt32BE(0);
    return (await this.reader.read(Math.min(len, 4096))).toString("utf8");
  }

  private resize(width: number, height: number) {
    if (width !== this.width || height !== this.height) this.sizeGeneration++;
    this.width = width;
    this.height = height;
    this.framebuffer = new Uint8Array(width * height * 4);
  }

  /** Server messages until the connection closes. */
  private async loop() {
    const r = this.reader;
    try {
      for (;;) {
        const type = (await r.read(1))[0]!;
        if (type === 0) {
          const head = await r.read(3);
          const rects = head.readUInt16BE(1);
          for (let i = 0; i < rects; i++) {
            const h = await r.read(12);
            const x = h.readUInt16BE(0);
            const y = h.readUInt16BE(2);
            const w = h.readUInt16BE(4);
            const hh = h.readUInt16BE(6);
            const encoding = h.readInt32BE(8);
            if (encoding === RAW) {
              const data = await r.read(w * hh * 4);
              for (let row = 0; row < hh; row++) {
                if (y + row >= this.height) break;
                const n = Math.min(w, this.width - x) * 4;
                if (n > 0) this.framebuffer.set(data.subarray(row * w * 4, row * w * 4 + n), ((y + row) * this.width + x) * 4);
              }
            } else if (encoding === DESKTOP_SIZE) {
              this.resize(w, hh);
            } else {
              throw new VncError(`Unexpected VNC encoding ${encoding}`);
            }
          }
          const done = this.pendingUpdate.splice(0);
          for (const p of done) p.resolve();
        } else if (type === 1) {
          const head = await r.read(5);
          await r.read(head.readUInt16BE(3) * 6);
        } else if (type === 2) {
          // Bell
        } else if (type === 3) {
          const head = await r.read(7);
          await r.read(head.readUInt32BE(3));
        } else {
          throw new VncError(`Unknown VNC message ${type}`);
        }
      }
    } catch (err) {
      this.shutdown(err instanceof Error ? err : new VncError(String(err)));
    }
  }

  /**
   * Ask for the whole screen and wait until it arrived. Refreshes run one after another (each waits for an update sent
   * after its request), and a size change during one asks again — its pixels arrive in the next update.
   */
  refresh(): Promise<void> {
    const p = this.refreshQueue.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const generation = this.sizeGeneration;
        await this.requestFullUpdate();
        if (this.sizeGeneration === generation) return;
      }
    });
    this.refreshQueue = p.catch(() => undefined);
    return p;
  }

  private async requestFullUpdate(): Promise<void> {
    if (this.closed) throw new VncError("The VM's screen connection is closed");
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new VncError("The VM's screen did not answer")), UPDATE_TIMEOUT_MS);
      this.pendingUpdate.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    const req = Buffer.alloc(10);
    req[0] = 3;
    req[1] = 0; // not incremental: the full screen
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(0, 4);
    req.writeUInt16BE(this.width, 6);
    req.writeUInt16BE(this.height, 8);
    this.socket.write(req);
    await done;
  }

  /** Move the pointer with `buttons` held (bit 0 left, 1 middle, 2 right, 3/4 wheel up/down, 5/6 wheel left/right). */
  pointer(x: number, y: number, buttons = this.buttons) {
    this.buttons = buttons & 0b111;
    const msg = Buffer.alloc(6);
    msg[0] = 5;
    msg[1] = buttons;
    msg.writeUInt16BE(Math.max(0, Math.min(this.width - 1, Math.round(x))), 2);
    msg.writeUInt16BE(Math.max(0, Math.min(this.height - 1, Math.round(y))), 4);
    this.write(msg);
  }

  key(keysym: number, down: boolean) {
    const msg = Buffer.alloc(8);
    msg[0] = 4;
    msg[1] = down ? 1 : 0;
    msg.writeUInt32BE(keysym >>> 0, 4);
    this.write(msg);
  }

  private write(buf: Buffer) {
    if (this.closed) throw new VncError("The VM's screen connection is closed");
    this.socket.write(buf);
  }

  private shutdown(err: Error) {
    if (this.closed) return;
    this.closed = true;
    this.reader.fail(err);
    for (const p of this.pendingUpdate.splice(0)) p.reject(err);
    this.socket.destroy();
  }

  close() {
    this.shutdown(new VncError("closed"));
  }
}

/* ------------------------------------------------------------------ */
/* Keys                                                                 */
/* ------------------------------------------------------------------ */

/** X11 keysyms for the canonical key names of computer/keys.ts. */
const NAMED: Record<string, number> = {
  enter: 0xff0d,
  kpenter: 0xff8d,
  tab: 0xff09,
  space: 0x20,
  backspace: 0xff08,
  delete: 0xffff,
  escape: 0xff1b,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  insert: 0xff63,
  capslock: 0xffe5,
  volumeup: 0x1008ff13,
  volumedown: 0x1008ff11,
  mute: 0x1008ff12,
  cmd: 0xffeb,
  ctrl: 0xffe3,
  alt: 0xffe9,
  shift: 0xffe1,
  fn: 0xffed,
};

export const MODIFIER_KEYSYMS: Record<string, number> = { cmd: 0xffeb, ctrl: 0xffe3, alt: 0xffe9, shift: 0xffe1, fn: 0xffed };

/** Keysym of a canonical key name or a single character (Latin-1 directly, other Unicode as 0x01000000 + code point). */
export function keysymFor(key: string): number | null {
  const named = NAMED[key];
  if (named) return named;
  const m = /^f(\d{1,2})$/.exec(key);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 35) return 0xffbe + Number(m[1]) - 1;
  const chars = [...key];
  if (chars.length !== 1) return null;
  const cp = chars[0]!.codePointAt(0)!;
  if (cp === 0x0a || cp === 0x0d) return 0xff0d;
  if (cp === 0x09) return 0xff09;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 + cp;
}

/** Characters typed with shift on a US keyboard (the VNC server maps keysyms to key codes without adding shift). */
export function needsShift(ch: string): boolean {
  return /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/.test(ch);
}
