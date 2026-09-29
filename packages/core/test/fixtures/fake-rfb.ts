/**
 * A tiny RFB (VNC) server for tests: protocol 3.8 (announced as Apple's 3.889 with a user name), VNC password or Apple
 * Remote Desktop authentication (with `username`, like macOS Screen Sharing), a `width × height` framebuffer with a
 * known pattern (sent raw, BGRX), and a log of the pointer and key events clients send.
 */
import { createDecipheriv, createDiffieHellman, createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { vncAuthResponse } from "../../src/vm/vnc";

/** RFC 2409 group 2 (1024-bit MODP), generator 2 — what macOS Screen Sharing uses. */
const MODP_1024 = Buffer.from(
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
    "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF",
  "hex",
);

export interface RfbEvent {
  type: "pointer" | "key";
  x?: number;
  y?: number;
  buttons?: number;
  key?: number;
  down?: boolean;
}

export interface FakeRfb {
  port: number;
  events: RfbEvent[];
  /** Pixel (x, y) of the pattern as [r, g, b]. */
  pixel: (x: number, y: number) => [number, number, number];
  close: () => Promise<void>;
}

export function pattern(x: number, y: number): [number, number, number] {
  return [(x * 4) & 0xff, (y * 4) & 0xff, (x + y) & 0xff];
}

export async function startFakeRfb(opts: { password: string; username?: string; width?: number; height?: number; onEvent?: (e: RfbEvent) => void }): Promise<FakeRfb> {
  const width = opts.width ?? 64;
  const height = opts.height ?? 48;
  const events: RfbEvent[] = [];
  const record = (e: RfbEvent) => {
    events.push(e);
    opts.onEvent?.(e);
  };
  const server: Server = createServer((socket: Socket) => {
    let buf = Buffer.alloc(0);
    let stage: "version" | "security" | "auth" | "ard" | "init" | "messages" = "version";
    const challenge = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff));
    const dh = createDiffieHellman(MODP_1024, Buffer.from([0, 2]));
    const refuse = (reason: string) => {
      const text = Buffer.from(reason);
      const out = Buffer.alloc(8 + text.length);
      out.writeUInt32BE(1, 0);
      out.writeUInt32BE(text.length, 4);
      text.copy(out, 8);
      socket.end(out);
    };
    socket.write(opts.username ? "RFB 003.889\n" : "RFB 003.008\n");
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === "version") {
          if (buf.length < 12) return;
          buf = buf.subarray(12);
          // macOS Screen Sharing offers Apple authentication (30); plain servers None (1) and VNC auth (2).
          socket.write(opts.username ? Buffer.from([2, 30, 35]) : Buffer.from([2, 1, 2]));
          stage = "security";
        } else if (stage === "security") {
          if (buf.length < 1) return;
          const type = buf[0];
          buf = buf.subarray(1);
          if (type === 2) {
            socket.write(challenge);
            stage = "auth";
          } else if (type === 30) {
            dh.generateKeys();
            const head = Buffer.alloc(4);
            head.writeUInt16BE(2, 0);
            head.writeUInt16BE(MODP_1024.length, 2);
            const pub = dh.getPublicKey();
            socket.write(Buffer.concat([head, MODP_1024, Buffer.concat([Buffer.alloc(MODP_1024.length - pub.length), pub])]));
            stage = "ard";
          } else {
            socket.write(Buffer.from([0, 0, 0, 0]));
            stage = "init";
          }
        } else if (stage === "ard") {
          if (buf.length < 128 + MODP_1024.length) return;
          const encrypted = buf.subarray(0, 128);
          const clientKey = buf.subarray(128, 128 + MODP_1024.length);
          buf = buf.subarray(128 + MODP_1024.length);
          let secret = dh.computeSecret(clientKey);
          if (secret.length < MODP_1024.length) secret = Buffer.concat([Buffer.alloc(MODP_1024.length - secret.length), secret]);
          const decipher = createDecipheriv("aes-128-ecb", createHash("md5").update(secret).digest(), null);
          decipher.setAutoPadding(false);
          const creds = Buffer.concat([decipher.update(encrypted), decipher.final()]);
          const cstr = (b: Buffer) => b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)).toString("utf8");
          if (cstr(creds.subarray(0, 64)) !== opts.username || cstr(creds.subarray(64)) !== opts.password) {
            refuse("Authentication failed");
            return;
          }
          socket.write(Buffer.from([0, 0, 0, 0]));
          stage = "init";
        } else if (stage === "auth") {
          if (buf.length < 16) return;
          const ok = buf.subarray(0, 16).equals(vncAuthResponse(challenge, opts.password));
          buf = buf.subarray(16);
          if (!ok) {
            refuse("Authentication failed");
            return;
          }
          socket.write(Buffer.from([0, 0, 0, 0]));
          stage = "init";
        } else if (stage === "init") {
          if (buf.length < 1) return;
          buf = buf.subarray(1); // shared flag
          const name = Buffer.from("Fake VM");
          const init = Buffer.alloc(24 + name.length);
          init.writeUInt16BE(width, 0);
          init.writeUInt16BE(height, 2);
          init[4] = 32;
          init[5] = 24;
          init.writeUInt32BE(name.length, 20);
          name.copy(init, 24);
          socket.write(init);
          stage = "messages";
        } else {
          if (buf.length < 1) return;
          const type = buf[0];
          const need = type === 0 ? 20 : type === 2 ? (buf.length >= 4 ? 4 + buf.readUInt16BE(2) * 4 : 4) : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6 : 1;
          if (buf.length < need) return;
          const msg = buf.subarray(0, need);
          buf = buf.subarray(need);
          if (type === 3) {
            const header = Buffer.alloc(4 + 12);
            header[0] = 0;
            header.writeUInt16BE(1, 2);
            header.writeUInt16BE(0, 4);
            header.writeUInt16BE(0, 6);
            header.writeUInt16BE(width, 8);
            header.writeUInt16BE(height, 10);
            header.writeInt32BE(0, 12);
            const pixels = Buffer.alloc(width * height * 4);
            for (let y = 0; y < height; y++)
              for (let x = 0; x < width; x++) {
                const [r, g, b] = pattern(x, y);
                const i = (y * width + x) * 4;
                pixels[i] = b;
                pixels[i + 1] = g;
                pixels[i + 2] = r;
              }
            socket.write(Buffer.concat([header, pixels]));
          } else if (type === 4) {
            record({ type: "key", down: msg[1] === 1, key: msg.readUInt32BE(4) });
          } else if (type === 5) {
            record({ type: "pointer", buttons: msg[1], x: msg.readUInt16BE(2), y: msg.readUInt16BE(4) });
          }
        }
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    events,
    pixel: pattern,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
