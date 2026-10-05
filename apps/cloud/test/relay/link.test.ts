import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { CloudClose, CloudFrame, cloudBearer, encodeCloudFrame } from "@godmode/shared";
import { SYSTEM } from "@/server/audit";
import { resetConfig } from "@/server/config";
import { closeDb, db, devices, users } from "@/server/db";
import { relayHub } from "@/server/relay-bridge";
import { writeSettings } from "@/server/settings";
import { createCloudServer } from "../../server/app";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import { FakeComputer, baseline, makeDevice, makeUser, sleep, startCloud, until, type Running, type TestDevice, type TestUser } from "./harness";

let cloud: Running;
let owner: TestUser;
let device: TestDevice;

beforeAll(resetDatabase);
afterAll(closeDatabase);

beforeEach(async () => {
  await truncateAll();
  cloud = await startCloud();
  await baseline(cloud);
  owner = await makeUser("owner@example.com", "role_owner");
  device = await makeDevice(owner.id);
});

afterEach(async () => {
  await cloud.close();
});

describe("connect", () => {
  test("valid credentials: Hello is answered with Welcome and the device record is updated", async () => {
    const computer = await FakeComputer.connect(cloud.port, device, { name: "Renamed Mac", version: "2.0.0", phoneAccess: false });
    expect(computer.welcome).toMatchObject({
      deviceId: device.id,
      account: { email: "owner@example.com" },
      publicUrl: "http://localhost:3210",
      limits: { maxBodyBytes: 64 * 1024 * 1024 },
    });
    expect(computer.welcome!.plan.id).toBe("unlimited");
    const [row] = await db.select().from(devices).where(eq(devices.id, device.id));
    expect(row).toMatchObject({ name: "Renamed Mac", appVersion: "2.0.0", phoneAccess: false, lastIp: "127.0.0.1" });
    expect(row!.lastSeenAt).not.toBeNull();
    expect(relayHub().isOnline(device.id)).toBe(true);
    expect(relayHub().info(device.id)).toMatchObject({ deviceId: device.id, userId: owner.id, version: "2.0.0" });
    computer.ws.close();
  });

  test("a wrong secret and an unknown computer are BadCredential (4401)", async () => {
    const wrong = await FakeComputer.dial(cloud.port, `Bearer ${cloudBearer(device.id, "gml_wrong")}`);
    expect((await wrong.closed()).code).toBe(CloudClose.BadCredential);
    const unknown = await FakeComputer.dial(cloud.port, `Bearer ${cloudBearer("dvc_AAAAAAAAAAAAAAAA", device.secret)}`);
    expect((await unknown.closed()).code).toBe(CloudClose.BadCredential);
  });

  test("missing or malformed credentials are a protocol error, not BadCredential", async () => {
    const none = await FakeComputer.dial(cloud.port, null);
    expect((await none.closed()).code).toBe(CloudClose.Protocol);
    const garbage = await FakeComputer.dial(cloud.port, "Bearer not-a-device");
    expect((await garbage.closed()).code).toBe(CloudClose.Protocol);
  });

  test("an internal error while checking closes with 1011 so the computer keeps its link", async () => {
    const real = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = "postgres://127.0.0.1:1/unreachable_test";
      await closeDb();
      resetConfig();
      const computer = await FakeComputer.dial(cloud.port, `Bearer ${device.bearer}`);
      expect((await computer.closed()).code).toBe(1011);
    } finally {
      process.env.DATABASE_URL = real;
      await closeDb();
      resetConfig();
    }
  });

  test("a turned-off computer, a suspended owner and a disabled relay are Disabled (4403)", async () => {
    await db.update(devices).set({ status: "disabled" }).where(eq(devices.id, device.id));
    expect((await (await FakeComputer.dial(cloud.port, `Bearer ${device.bearer}`)).closed()).code).toBe(CloudClose.Disabled);

    await db.update(devices).set({ status: "active" }).where(eq(devices.id, device.id));
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, owner.id));
    expect((await (await FakeComputer.dial(cloud.port, `Bearer ${device.bearer}`)).closed()).code).toBe(CloudClose.Disabled);

    await db.update(users).set({ status: "active" }).where(eq(users.id, owner.id));
    await writeSettings("relay", { enabled: false }, SYSTEM);
    expect((await (await FakeComputer.dial(cloud.port, `Bearer ${device.bearer}`)).closed()).code).toBe(CloudClose.Disabled);
  });

  test("a computer beyond the plan's allowance is PlanRequired (4402)", async () => {
    await writeSettings("billing", { enabled: true, stripeSecretKey: "sk_test_fake" }, SYSTEM);
    const member = await makeUser("member@example.com");
    const first = await makeDevice(member.id);
    await sleep(5);
    const second = await makeDevice(member.id);
    // The free plan includes one computer: the older one stays allowed.
    const ok = await FakeComputer.connect(cloud.port, first);
    const refused = await FakeComputer.dial(cloud.port, `Bearer ${second.bearer}`);
    expect((await refused.closed()).code).toBe(CloudClose.PlanRequired);
    ok.ws.close();
  });

  test("20 failed logins from one address lock it out with RateLimited (4429)", async () => {
    const headers = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < 20; i++) {
      const c = await FakeComputer.dial(cloud.port, `Bearer ${cloudBearer(device.id, "gml_wrong")}`, headers);
      expect((await c.closed()).code).toBe(CloudClose.BadCredential);
    }
    const locked = await FakeComputer.dial(cloud.port, `Bearer ${device.bearer}`, headers);
    expect((await locked.closed()).code).toBe(CloudClose.RateLimited);
    // Another address is not affected.
    const other = await FakeComputer.connect(cloud.port, device);
    other.ws.close();
  });

  test("Hello with another protocol version closes with Protocol", async () => {
    const computer = await FakeComputer.dial(cloud.port, `Bearer ${device.bearer}`);
    computer.hello({ protocol: 99 });
    expect((await computer.closed()).code).toBe(CloudClose.Protocol);
  });
});

describe("one link per computer", () => {
  test("a second connection replaces the first with Replaced (4409)", async () => {
    const first = await FakeComputer.connect(cloud.port, device);
    const second = await FakeComputer.connect(cloud.port, device);
    expect((await first.closed()).code).toBe(CloudClose.Replaced);
    expect(second.closeEvent).toBeNull();
    expect(relayHub().isOnline(device.id)).toBe(true);
    second.ws.close();
  });

  test("an older socket that says Hello late does not push out the newer link", async () => {
    const older = await FakeComputer.dial(cloud.port, `Bearer ${device.bearer}`);
    await sleep(5);
    const newer = await FakeComputer.connect(cloud.port, device);
    older.hello();
    expect((await older.closed()).code).toBe(CloudClose.Replaced);
    expect(older.welcome).toBeNull();
    expect(newer.closeEvent).toBeNull();
    expect(relayHub().isOnline(device.id)).toBe(true);
    newer.ws.close();
  });

  test("a link is only registered after a valid Hello", async () => {
    const live = await FakeComputer.connect(cloud.port, device);
    const silent = await FakeComputer.dial(cloud.port, `Bearer ${device.bearer}`);
    await sleep(100);
    expect(live.closeEvent).toBeNull();
    expect(silent.closeEvent).toBeNull();
    live.ws.close();
    silent.ws.close();
  });
});

describe("frames", () => {
  test("a text message, an undecodable frame and a cloud-only frame type close the link with Protocol", async () => {
    const text = await FakeComputer.connect(cloud.port, device);
    text.ws.send("hello");
    expect((await text.closed()).code).toBe(CloudClose.Protocol);

    const short = await FakeComputer.connect(cloud.port, device);
    short.ws.send(new Uint8Array([1, 2]));
    expect((await short.closed()).code).toBe(CloudClose.Protocol);

    const wrong = await FakeComputer.connect(cloud.port, device);
    wrong.send(CloudFrame.ReqHead, 5, { method: "GET" });
    expect((await wrong.closed()).code).toBe(CloudClose.Protocol);

    const malformed = await FakeComputer.connect(cloud.port, device);
    malformed.ws.send(encodeCloudFrame(CloudFrame.Hello, 0, "{not json"));
    expect((await malformed.closed()).code).toBe(CloudClose.Protocol);
  });

  test("Ping is answered with Pong; frames for unknown streams are ignored", async () => {
    const computer = await FakeComputer.connect(cloud.port, device);
    computer.send(CloudFrame.ResBody, 12345, new Uint8Array([1, 2, 3]));
    computer.send(CloudFrame.Ping, 0);
    await until(() => computer.framesOf(CloudFrame.Pong).length > 0, 2_000, "Pong");
    expect(computer.closeEvent).toBeNull();
    computer.ws.close();
  });

  test("a second Hello sent before Welcome is applied right after it", async () => {
    const computer = await FakeComputer.dial(cloud.port, `Bearer ${device.bearer}`);
    computer.hello({ name: "First", browserAccess: false });
    computer.hello({ name: "Second", browserAccess: true });
    await until(() => computer.welcome, 5_000, "Welcome");
    await vi.waitFor(async () => {
      const [row] = await db.select().from(devices).where(eq(devices.id, device.id));
      expect(row).toMatchObject({ name: "Second", browserAccess: true });
    });
    expect(computer.framesOf(CloudFrame.Welcome)).toHaveLength(1);
    computer.ws.close();
  });

  test("a second Hello updates the record without an answer", async () => {
    const computer = await FakeComputer.connect(cloud.port, device);
    computer.hello({ name: "Kitchen Mac", browserAccess: false });
    await sleep(150);
    const [row] = await db.select().from(devices).where(eq(devices.id, device.id));
    expect(row).toMatchObject({ name: "Kitchen Mac", browserAccess: false });
    expect(computer.framesOf(CloudFrame.Welcome)).toHaveLength(1);
    computer.ws.close();
  });
});

describe("hub API", () => {
  test("notify, notifyUser and disconnect reach the computer", async () => {
    const computer = await FakeComputer.connect(cloud.port, device);
    relayHub().notify(device.id, { type: "billing" });
    relayHub().notifyUser(owner.id, { type: "account", account: { email: "new@example.com", name: null } });
    await until(() => computer.framesOf(CloudFrame.Notice).length === 2, 2_000, "Notice frames");
    expect(relayHub().stats()).toMatchObject({ links: 1, streams: 0, sockets: 0 });
    expect(relayHub().online().map((l) => l.deviceId)).toEqual([device.id]);
    relayHub().disconnect(device.id, CloudClose.BadCredential, "Removed");
    expect((await computer.closed()).code).toBe(CloudClose.BadCredential);
    expect(relayHub().isOnline(device.id)).toBe(false);
  });

  test("a plan notice closes computers the new plan no longer includes", async () => {
    await writeSettings("billing", { enabled: true, stripeSecretKey: "sk_test_fake" }, SYSTEM);
    const member = await makeUser("member@example.com");
    const older = await makeDevice(member.id);
    const computer = await FakeComputer.connect(cloud.port, older);
    await sleep(5);
    // A second computer appears (e.g. linked while the plan allowed more); the oldest one keeps its link.
    const newer = await makeDevice(member.id);
    await db.update(devices).set({ createdAt: new Date(Date.now() - 3_600_000) }).where(eq(devices.id, newer.id));
    relayHub().notifyUser(member.id, { type: "plan", plan: computer.welcome!.plan });
    expect((await computer.closed()).code).toBe(CloudClose.PlanRequired);
  });

  test("stream ids start at a random value on every link", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const computer = await FakeComputer.connect(cloud.port, device);
      const res = fetch(`http://127.0.0.1:${cloud.port}/gw/${device.id}/api/health`);
      const req = await computer.request();
      ids.push(req.id);
      await computer.respond(req, 200, [["content-type", "application/json"]], "{}");
      await res;
      computer.ws.close();
      await until(() => !relayHub().isOnline(device.id), 2_000, "link gone");
    }
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(2 ** 30);
    }
    expect(new Set(ids).size).toBe(3);
  });

  test("the minute check closes links of removed and turned-off computers", async () => {
    await cloud.close();
    cloud = await startCloud({ revalidateMs: 100 });
    await baseline(cloud);
    const computer = await FakeComputer.connect(cloud.port, device);
    await db.update(devices).set({ status: "disabled" }).where(eq(devices.id, device.id));
    expect((await computer.closed()).code).toBe(CloudClose.Disabled);

    const other = await makeDevice(owner.id);
    const second = await FakeComputer.connect(cloud.port, other);
    await db.delete(devices).where(eq(devices.id, other.id));
    expect((await second.closed()).code).toBe(CloudClose.BadCredential);
  });

  test("closing the server closes links with 1001", async () => {
    const computer = await FakeComputer.connect(cloud.port, device);
    await cloud.close();
    expect((await computer.closed()).code).toBe(1001);
    cloud = await startCloud();
  });

  test("an unknown upgrade path is refused and the socket closed", async () => {
    const upgrade = (port: number, path: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      return new Promise<number | "untouched">((resolve) => {
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("error", () => resolve(-1));
        setTimeout(() => {
          resolve("untouched");
          ws.terminate();
        }, 300);
      });
    };
    expect(await upgrade(cloud.port, "/somewhere")).toBe(404);
    expect(await upgrade(cloud.port, "/_next/webpack-hmr")).toBe(404);
    // In development /_next/ belongs to Next's HMR listener; the relay leaves it alone.
    const dev = createCloudServer({ dev: true, nextHandler: () => {} });
    await new Promise<void>((resolve) => dev.server.listen(0, "127.0.0.1", resolve));
    const port = (dev.server.address() as AddressInfo).port;
    expect(await upgrade(port, "/_next/webpack-hmr")).toBe("untouched");
    expect(await upgrade(port, "/elsewhere")).toBe(404);
    await dev.close();
  });
});
