/** The VNC client (vm/vnc.ts) against a fake RFB server, and the raster helpers that turn its framebuffer into PNGs. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import { inflateSync } from "node:zlib";
import { imageSize } from "../src/computer/image";
import { encodePng, fromBgrx, scaleDown } from "../src/vm/raster";
import { VncClient, VncError, keysymFor, needsShift, vncAuthResponse } from "../src/vm/vnc";
import { startFakeRfb, type FakeRfb } from "./fixtures/fake-rfb";

let rfb: FakeRfb;

beforeAll(async () => {
  rfb = await startFakeRfb({ password: "s3cret-pw", width: 64, height: 48 });
});

afterAll(async () => {
  await rfb.close();
});

describe("VNC authentication", () => {
  test("DES with the bit-reversed password as key", () => {
    const challenge = Buffer.from("0123456789abcdef");
    // "a" = 0b01100001 → reversed 0b10000110; the rest of the 8-byte key is zero.
    const key = Buffer.from([0x86, 0, 0, 0, 0, 0, 0, 0]);
    const cipher = createCipheriv("des-ecb", key, null);
    cipher.setAutoPadding(false);
    expect(vncAuthResponse(challenge, "a")).toEqual(Buffer.concat([cipher.update(challenge), cipher.final()]));
    // Only the first 8 characters count.
    expect(vncAuthResponse(challenge, "abcdefghXYZ")).toEqual(vncAuthResponse(challenge, "abcdefgh"));
  });

  test("a wrong password is refused", async () => {
    await expect(VncClient.connect({ host: "127.0.0.1", port: rfb.port, password: "nope" })).rejects.toBeInstanceOf(VncError);
  });
});

describe("VNC session", () => {
  let client: VncClient;

  beforeAll(async () => {
    client = await VncClient.connect({ host: "127.0.0.1", port: rfb.port, password: "s3cret-pw" });
  });

  afterAll(() => client.close());

  test("reads the screen", async () => {
    expect([client.width, client.height, client.name]).toEqual([64, 48, "Fake VM"]);
    await client.refresh();
    const raster = fromBgrx(client.framebuffer, client.width, { x: 0, y: 0, width: 64, height: 48 });
    for (const [x, y] of [
      [0, 0],
      [10, 5],
      [63, 47],
    ] as const) {
      const i = (y * 64 + x) * 4;
      expect([raster.data[i], raster.data[i + 1], raster.data[i + 2]]).toEqual(rfb.pixel(x, y));
    }
  });

  test("sends pointer and key events", async () => {
    const before = rfb.events.length;
    client.pointer(12, 34, 1);
    client.pointer(12, 34, 0);
    client.pointer(999, -5, 0); // clamped to the screen
    client.key(keysymFor("enter")!, true);
    client.key(keysymFor("enter")!, false);
    await Bun.sleep(100);
    expect(rfb.events.slice(before)).toEqual([
      { type: "pointer", buttons: 1, x: 12, y: 34 },
      { type: "pointer", buttons: 0, x: 12, y: 34 },
      { type: "pointer", buttons: 0, x: 63, y: 0 },
      { type: "key", down: true, key: 0xff0d },
      { type: "key", down: false, key: 0xff0d },
    ]);
  });
});

describe("macOS Screen Sharing (Apple authentication)", () => {
  test("logs in with the guest user, refuses a wrong password", async () => {
    const apple = await startFakeRfb({ username: "admin", password: "admin", width: 32, height: 16 });
    try {
      const c = await VncClient.connect({ host: "127.0.0.1", port: apple.port, username: "admin", password: "admin" });
      expect([c.width, c.height]).toEqual([32, 16]);
      await c.refresh();
      c.close();
      await expect(VncClient.connect({ host: "127.0.0.1", port: apple.port, username: "admin", password: "wrong" })).rejects.toThrow("Authentication failed");
      // Without a user name there's no way in: Screen Sharing doesn't offer VNC passwords here.
      await expect(VncClient.connect({ host: "127.0.0.1", port: apple.port, password: "admin" })).rejects.toThrow("user name is needed");
    } finally {
      await apple.close();
    }
  });
});

describe("keysyms", () => {
  test("named keys, characters, function keys, unicode", () => {
    expect(keysymFor("enter")).toBe(0xff0d);
    expect(keysymFor("cmd")).toBe(0xffeb);
    expect(keysymFor("f5")).toBe(0xffc2);
    expect(keysymFor("a")).toBe(0x61);
    expect(keysymFor("ä")).toBe(0xe4);
    expect(keysymFor("€")).toBe(0x010020ac);
    expect(keysymFor("nope")).toBeNull();
    expect(needsShift("A")).toBe(true);
    expect(needsShift("?")).toBe(true);
    expect(needsShift("a")).toBe(false);
  });
});

describe("raster", () => {
  test("scales down by averaging and encodes a valid PNG", () => {
    const fb = new Uint8Array(4 * 2 * 4);
    // A 4×2 BGRX image: left half white, right half black.
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) fb.set([255, 255, 255, 0], (y * 4 + x) * 4);
    const rgba = fromBgrx(fb, 4, { x: 0, y: 0, width: 4, height: 2 });
    const half = scaleDown(rgba, 2, 1);
    expect([...half.data]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
    const png = encodePng(half);
    expect(imageSize(png.toString("base64"))).toEqual({ width: 2, height: 1, mime: "image/png" });
    // IDAT holds filter byte + RGB per row.
    const idatStart = png.indexOf(Buffer.from("IDAT")) + 4;
    const idatLen = png.readUInt32BE(idatStart - 8);
    expect([...inflateSync(png.subarray(idatStart, idatStart + idatLen))]).toEqual([0, 255, 255, 255, 0, 0, 0]);
  });

  test("the Up filter round-trips", () => {
    const img = { width: 3, height: 3, data: new Uint8Array(3 * 3 * 4).map((_, i) => (i * 29) & 0xff) };
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    const png = encodePng(img, 1);
    const idatStart = png.indexOf(Buffer.from("IDAT")) + 4;
    const raw = inflateSync(png.subarray(idatStart, idatStart + png.readUInt32BE(idatStart - 8)));
    const stride = 3 * 3 + 1;
    const rows: number[][] = [];
    for (let y = 0; y < 3; y++) {
      const filter = raw[y * stride]!;
      const row = [...raw.subarray(y * stride + 1, (y + 1) * stride)];
      rows.push(filter === 2 ? row.map((v, i) => (v + rows[y - 1]![i]!) & 0xff) : row);
    }
    const expected = [...img.data].filter((_, i) => i % 4 !== 3);
    expect(rows.flat()).toEqual(expected);
  });
});
