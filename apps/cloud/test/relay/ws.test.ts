import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CLOUD_WS_WINDOW, CloudClose, CloudFrame, encodeCloudFrame } from "@godmode/shared";
import { db, deviceAccess, sessions, usageDaily } from "@/server/db";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import {
  FakeComputer,
  PUBLIC_URL,
  baseline,
  makeDevice,
  makeUser,
  openClient,
  sleep,
  startCloud,
  until,
  type Running,
  type TestDevice,
  type TestUser,
} from "./harness";

let cloud: Running;
let owner: TestUser;
let device: TestDevice;
let computer: FakeComputer;
const clients: WebSocket[] = [];

beforeAll(resetDatabase);
afterAll(closeDatabase);

beforeEach(async () => {
  await truncateAll();
  cloud = await startCloud();
  await baseline(cloud);
  owner = await makeUser("owner@example.com", "role_owner");
  device = await makeDevice(owner.id);
  computer = await FakeComputer.connect(cloud.port, device);
});

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  computer.ws.terminate();
  await cloud.close();
});

const browser = (user: TestUser, extra: Record<string, string> = {}) => ({ cookie: user.cookie, origin: PUBLIC_URL, ...extra });

interface Received {
  messages: { binary: boolean; data: Buffer }[];
  close: { code: number; reason: string } | null;
}

async function dashboardSocket(user: TestUser = owner, extra: Record<string, string> = {}, path = `/d/${device.id}/api/ws`) {
  const { ws, status } = await openClient(cloud.port, path, browser(user, extra));
  clients.push(ws);
  const got: Received = { messages: [], close: null };
  ws.on("message", (data: Buffer, isBinary: boolean) => got.messages.push({ binary: isBinary, data: Buffer.from(data) }));
  ws.on("close", (code, reason) => (got.close = { code, reason: reason.toString() }));
  return { ws, status, got };
}

describe("opening", () => {
  test("WsOpen carries the person and filtered headers; the client only opens after WsAccept", async () => {
    computer.onSocket = (sock) => setTimeout(() => computer.send(CloudFrame.WsAccept, sock.id), 200);
    const started = Date.now();
    const { status } = await dashboardSocket();
    expect(status).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    const sock = await computer.socket();
    expect(sock.open).toMatchObject({ path: "/api/ws", channel: "cloud", user: { id: owner.id, role: "owner" }, ip: "127.0.0.1" });
    const names = sock.open.headers.map(([n]) => n);
    for (const dropped of ["cookie", "origin", "sec-websocket-key", "sec-websocket-version", "upgrade", "connection", "host"]) {
      expect(names).not.toContain(dropped);
    }
  });

  test("the dashboard origin, a session and fetch metadata are required", async () => {
    expect((await openClient(cloud.port, `/d/${device.id}/api/ws`, { cookie: owner.cookie })).status).toBe(403);
    expect((await openClient(cloud.port, `/d/${device.id}/api/ws`, { cookie: owner.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await openClient(cloud.port, `/d/${device.id}/api/ws`, { origin: PUBLIC_URL })).status).toBe(401);
    expect((await openClient(cloud.port, `/d/${device.id}/api/ws`, browser(owner, { "sec-fetch-dest": "document" }))).status).toBe(403);
    const stranger = await makeUser("stranger@example.com");
    expect((await openClient(cloud.port, `/d/${device.id}/api/ws`, browser(stranger))).status).toBe(404);
    expect((await openClient(cloud.port, `/d/dvc_bad/api/ws`, browser(owner))).status).toBe(404);
    expect(computer.sockets.size).toBe(0);
  });

  test("WsReject becomes that HTTP status; a status outside 400-599 becomes 502", async () => {
    computer.onSocket = (sock) => computer.send(CloudFrame.WsReject, sock.id, { status: 403, message: "Browser access is off." });
    expect((await openClient(cloud.port, `/d/${device.id}/api/ws`, browser(owner))).status).toBe(403);
    computer.onSocket = (sock) => computer.send(CloudFrame.WsReject, sock.id, { status: 200, message: "?" });
    expect((await openClient(cloud.port, `/d/${device.id}/api/ws`, browser(owner))).status).toBe(502);
  });

  test("a computer that is offline is 503", async () => {
    computer.ws.close();
    await until(() => !cloud.hub.isOnline(device.id), 2_000, "offline");
    expect((await openClient(cloud.port, `/d/${device.id}/api/ws`, browser(owner))).status).toBe(503);
  });

  test("at most 32 sockets per computer", async () => {
    for (let i = 0; i < 32; i++) expect((await dashboardSocket()).status).toBeNull();
    expect((await openClient(cloud.port, `/d/${device.id}/api/ws`, browser(owner))).status).toBe(429);
  });
});

describe("messages", () => {
  test("text stays text and binary stays binary, both ways", async () => {
    const { ws, got } = await dashboardSocket();
    const sock = await computer.socket();
    computer.send(CloudFrame.WsText, sock.id, JSON.stringify({ type: "hello" }));
    computer.send(CloudFrame.WsBinary, sock.id, new Uint8Array([1, 2, 3]));
    await until(() => got.messages.length === 2, 2_000, "messages");
    expect(got.messages[0]).toEqual({ binary: false, data: Buffer.from('{"type":"hello"}') });
    expect(JSON.parse(got.messages[0]!.data.toString())).toEqual({ type: "hello" });
    expect(got.messages[1]).toEqual({ binary: true, data: Buffer.from([1, 2, 3]) });

    ws.send(JSON.stringify({ type: "ping" }));
    ws.send(Buffer.from([9, 8]), { binary: true });
    await until(() => sock.messages.length === 2, 2_000, "client messages");
    expect(sock.messages[0]).toEqual({ binary: false, data: Buffer.from('{"type":"ping"}') });
    expect(sock.messages[1]).toEqual({ binary: true, data: Buffer.from([9, 8]) });
  });

  test("the cloud grants Window credit for bytes written to the client", async () => {
    const { got } = await dashboardSocket();
    const sock = await computer.socket();
    const chunk = Buffer.alloc(64 * 1024, 1);
    for (let i = 0; i < 32; i++) computer.send(CloudFrame.WsBinary, sock.id, chunk);
    await until(() => got.messages.length === 32, 5_000, "2 MiB delivered");
    await until(() => sock.granted >= CLOUD_WINDOW_QUARTER * 3, 2_000, "grants");
    expect(sock.granted).toBeLessThanOrEqual(32 * chunk.byteLength);
    expect(computer.framesOf(CloudFrame.Window, sock.id).length).toBeGreaterThanOrEqual(3);
  });

  test("a computer may run ahead of a client that does not read up to the backlog limit, not beyond", async () => {
    const { ws } = await dashboardSocket();
    const sock = await computer.socket();
    ws.pause();
    const chunk = Buffer.alloc(1024 * 1024, 2);
    // Above CLOUD_WS_WINDOW the computer only skips live frames; everything else still goes out.
    for (let i = 0; i < 4; i++) computer.send(CloudFrame.WsBinary, sock.id, chunk);
    await sleep(200);
    expect(computer.closeEvent).toBeNull();
    // Past CLOUD_WS_BACKLOG_MAX it should have closed the socket (1013) itself; the cloud doesn't buffer the rest.
    for (let i = 0; i < 60; i++) computer.send(CloudFrame.WsBinary, sock.id, chunk);
    expect((await computer.closed()).code).toBe(CloudClose.Protocol);
    // Credit was only given for what actually reached the client.
    expect(sock.granted).toBeLessThan(64 * chunk.byteLength);
  });

  test("many sockets together cannot make the cloud hold more than the link's limit", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 3);
    const socks = [];
    for (let i = 0; i < 5; i++) {
      const { ws } = await dashboardSocket();
      ws.pause();
      socks.push(await computer.socket(i));
    }
    // 14 MiB each stays under the per-socket backlog limit; five of them pass the 64 MiB a link may hold.
    for (const sock of socks) for (let i = 0; i < 14; i++) computer.send(CloudFrame.WsBinary, sock.id, chunk);
    expect(await computer.closed()).toEqual({ code: CloudClose.Protocol, reason: "WebSocket messages beyond the link's limit." });
  });

  test("a client message above the size limit closes that socket", async () => {
    const { ws, got } = await dashboardSocket();
    const sock = await computer.socket();
    ws.send(Buffer.alloc(65 * 1024, 1), { binary: true });
    await until(() => got.close, 2_000, "client close");
    expect(got.close!.code).toBe(1009);
    await until(() => sock.closed, 2_000, "WsClose to the computer");
  });

  test("a viewer only gets its reads through", async () => {
    const viewer = await makeUser("viewer@example.com");
    await db.insert(deviceAccess).values({ deviceId: device.id, userId: viewer.id, role: "viewer" });
    const { ws } = await dashboardSocket(viewer);
    const sock = await computer.socket();
    expect(sock.open.user?.role).toBe("viewer");
    const sent = [
      { type: "ping" },
      { type: "agent.run", prompt: "rm -rf /" },
      { type: "browser.subscribe", profileId: "p1", passive: false },
      { type: "browser.subscribe", profileId: "p1", passive: true },
      { type: "computer.subscribe", view: "display:1" },
      { type: "conversation.subscribe", conversationId: "c1" },
    ];
    for (const message of sent) ws.send(JSON.stringify(message));
    ws.send(Buffer.from([1]), { binary: true });
    ws.send("not json");
    ws.send(JSON.stringify({ type: "conversation.unsubscribe", conversationId: "c1" }));
    await until(() => sock.messages.length === 5, 2_000, "viewer messages");
    await sleep(100);
    expect(sock.messages.map((m) => JSON.parse(m.data.toString()).type)).toEqual([
      "ping",
      "browser.subscribe",
      "computer.subscribe",
      "conversation.subscribe",
      "conversation.unsubscribe",
    ]);
  });
});

const CLOUD_WINDOW_QUARTER = CLOUD_WS_WINDOW / 4;

describe("closing", () => {
  test("close codes from the computer pass only when allowed; reasons are cut to 123 bytes", async () => {
    const cases: [number, number][] = [
      [4003, 4003],
      [1000, 1000],
      [1005, 1000],
      [1006, 1000],
      [999, 1000],
      [1015, 1000],
      [3000, 3000],
    ];
    for (const [sent, expected] of cases) {
      const { got } = await dashboardSocket();
      const sock = [...computer.sockets.values()].at(-1)!;
      await until(() => sock.id, 1_000);
      computer.send(CloudFrame.WsClose, sock.id, { code: sent, reason: "ü".repeat(100) });
      await until(() => got.close, 2_000, `close ${sent}`);
      expect(got.close!.code, String(sent)).toBe(expected);
      expect(Buffer.byteLength(got.close!.reason)).toBeLessThanOrEqual(123);
    }
    expect(computer.closeEvent).toBeNull();
  });

  test("the client's close reaches the computer; one without a code becomes 1000", async () => {
    const first = await dashboardSocket();
    const sock1 = await computer.socket(0);
    first.ws.close(4001, "bye");
    await until(() => sock1.closed, 2_000, "WsClose");
    expect(sock1.closed).toEqual({ code: 4001, reason: "bye" });

    const second = await dashboardSocket();
    const sock2 = await computer.socket(1);
    second.ws.close();
    await until(() => sock2.closed, 2_000, "WsClose");
    expect(sock2.closed!.code).toBe(1000);
  });

  test("Abort from the computer closes the client with 1011", async () => {
    const { got } = await dashboardSocket();
    const sock = await computer.socket();
    computer.send(CloudFrame.Abort, sock.id, { reason: "crashed" });
    await until(() => got.close, 2_000, "close");
    expect(got.close!.code).toBe(1011);
  });

  test("a dropped link closes relayed sockets with 1012", async () => {
    const { got } = await dashboardSocket();
    await computer.socket();
    computer.ws.terminate();
    await until(() => got.close, 2_000, "close");
    expect(got.close!.code).toBe(1012);
  });

  test("a computer that reads too slowly closes clients that keep sending with 1013", async () => {
    const { ws, got } = await dashboardSocket();
    await computer.socket();
    computer.ws.pause();
    const chunk = Buffer.alloc(60 * 1024, 3);
    for (let i = 0; i < 1024 && !got.close; i++) {
      ws.send(chunk, { binary: true });
      if (i % 32 === 0) await sleep(5);
    }
    await until(() => got.close, 10_000, "client close");
    expect(got.close!.code).toBe(1013);
    computer.ws.resume();
  });

  test("a revoked session ends its sockets at the next check", async () => {
    await cloud.close();
    cloud = await startCloud({ revalidateMs: 100 });
    await baseline(cloud);
    computer = await FakeComputer.connect(cloud.port, device);
    const { got } = await dashboardSocket();
    const sock = await computer.socket();
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, owner.id));
    await until(() => got.close, 3_000, "close");
    expect(got.close!.code).toBe(1008);
    await until(() => sock.closed, 2_000, "WsClose");
  });
});

describe("phone sockets (/gw)", () => {
  test("need a phone token, which is passed on; 4003 reaches the phone", async () => {
    expect((await openClient(cloud.port, `/gw/${device.id}/api/ws`, {})).status).toBe(404);
    const { ws, status } = await openClient(cloud.port, `/gw/${device.id}/api/ws`, { authorization: "Bearer gmd_phone" });
    clients.push(ws);
    expect(status).toBeNull();
    const sock = await computer.socket();
    expect(sock.open).toMatchObject({ channel: "mobile", user: null });
    expect(sock.open.headers).toContainEqual(["authorization", "Bearer gmd_phone"]);
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    computer.ws.send(encodeCloudFrame(CloudFrame.WsClose, sock.id, { code: 4003, reason: "Removed" }));
    expect(await closed).toBe(4003);
  });

  test("WsReject 401 counts toward the address's lock-out like a 401 answer, and costs no usage", async () => {
    computer.onSocket = (sock) => computer.send(CloudFrame.WsReject, sock.id, { status: 401, message: "Unknown phone" });
    const from = { authorization: "Bearer gmd_guess", "x-forwarded-for": "198.51.100.30" };
    const statuses: (number | null)[] = [];
    for (let i = 0; i < 25; i++) {
      const { ws, status } = await openClient(cloud.port, `/gw/${device.id}/api/ws`, from);
      clients.push(ws);
      statuses.push(status);
    }
    expect(statuses).toEqual([...Array<number>(20).fill(401), ...Array<number>(5).fill(429)]);
    expect(computer.sockets.size).toBe(20);
    await cloud.hub.flushUsage();
    const rows = await db.select().from(usageDaily);
    expect(rows.reduce((n, r) => n + r.requests, 0)).toBe(0);
  });

  test("a WsReject 401 from the computer is passed, the cloud never makes one up", async () => {
    computer.onSocket = (sock) => computer.send(CloudFrame.WsReject, sock.id, { status: 401, message: "Unknown phone" });
    expect((await openClient(cloud.port, `/gw/${device.id}/api/ws`, { authorization: "Bearer gmd_x" })).status).toBe(401);
    computer.ws.close();
    await until(() => !cloud.hub.isOnline(device.id), 2_000, "offline");
    expect((await openClient(cloud.port, `/gw/${device.id}/api/ws`, { authorization: "Bearer gmd_x" })).status).toBe(503);
  });
});
