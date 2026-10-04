import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CLOUD_CHUNK, CLOUD_WINDOW, CloudClose, CloudFrame } from "@godmode/shared";
import { SYSTEM } from "@/server/audit";
import { db, deviceAccess, sessions, usageDaily } from "@/server/db";
import { writeSettings } from "@/server/settings";
import { closeDatabase, resetDatabase, truncateAll } from "../helpers/db";
import {
  FakeComputer,
  PUBLIC_URL,
  baseline,
  browserHeaders,
  call,
  makeDevice,
  makeUser,
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
  computer.ws.terminate();
  await cloud.close();
});

const api = (path: string) => `/d/${device.id}${path}`;
const gw = (path: string) => `/gw/${device.id}${path}`;

function rawRequest(method: string, path: string, headers: Record<string, string>): ReturnType<typeof httpRequest> {
  const req = httpRequest({ host: "127.0.0.1", port: cloud.port, method, path, headers, agent: false });
  req.on("error", () => {});
  return req;
}

function responseOf(req: ReturnType<typeof httpRequest>): Promise<IncomingMessage> {
  return new Promise((resolve) => req.on("response", resolve));
}

describe("relayed requests", () => {
  test("GET reaches the computer with a filtered head and the answer comes back", async () => {
    computer.onRequest = (req) =>
      void computer.respond(req, 200, [["Content-Type", "application/json; charset=utf-8"]], JSON.stringify({ hello: "world" }));
    const res = await call(cloud.port, "GET", api("/api/conversations?limit=5"), browserHeaders(owner, { authorization: "Bearer gm_local", "x-trace": "1" }));
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ hello: "world" });
    const req = await computer.request();
    expect(req.head).toMatchObject({
      method: "GET",
      path: "/api/conversations?limit=5",
      channel: "cloud",
      user: { id: owner.id, email: owner.email, role: "owner" },
      ip: "127.0.0.1",
      hasBody: false,
    });
    const names = req.head.headers.map(([name]) => name);
    expect(names).toContain("x-trace");
    for (const dropped of ["cookie", "origin", "host", "authorization", "sec-fetch-site", "sec-fetch-dest", "connection"]) {
      expect(names).not.toContain(dropped);
    }
  });

  test("a multi-megabyte POST is forwarded only as far as the computer grants credit", async () => {
    computer.autoGrant = false;
    const upload = randomBytes(8 * 1024 * 1024);
    const req = rawRequest("POST", api("/api/files"), browserHeaders(owner, { "content-type": "application/octet-stream" }));
    const response = responseOf(req);
    req.end(upload);
    const head = await computer.request();
    expect(head.head.hasBody).toBe(true);
    // Client chunks are cut to fit; a part that does not fit the rest of the credit waits for more.
    await until(() => head.received > CLOUD_WINDOW - CLOUD_CHUNK, 5_000, "first window");
    await sleep(300);
    expect(head.received).toBeLessThanOrEqual(CLOUD_WINDOW);
    const stalled = head.received;
    await sleep(200);
    expect(head.received).toBe(stalled);
    computer.autoGrant = true;
    computer.grant(head, head.received);
    await until(() => head.ended, 10_000, "ReqEnd");
    expect(Buffer.concat(head.chunks).equals(upload)).toBe(true);
    expect(Math.max(...head.chunks.map((c) => c.byteLength))).toBeLessThanOrEqual(CLOUD_CHUNK);

    const download = randomBytes(3 * 1024 * 1024 + 17);
    const responding = computer.respond(head, 201, [["content-type", "application/octet-stream"], ["content-length", String(download.byteLength)]], download);
    const res = await response;
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    await responding;
    expect(res.statusCode).toBe(201);
    expect(Buffer.concat(chunks).equals(download)).toBe(true);
  });

  test("a slow client keeps the computer's response bounded by the window", async () => {
    const total = 48 * 1024 * 1024;
    let sent = 0;
    computer.onRequest = (req) => {
      void (async () => {
        computer.send(CloudFrame.ResHead, req.id, { status: 200, headers: [["content-type", "application/octet-stream"]] });
        const chunk = Buffer.alloc(CLOUD_CHUNK, 7);
        try {
          while (sent < total) {
            await req.window.take(CLOUD_CHUNK);
            computer.send(CloudFrame.ResBody, req.id, chunk);
            sent += CLOUD_CHUNK;
          }
          computer.send(CloudFrame.ResEnd, req.id);
        } catch {
          // aborted
        }
      })();
    };
    const req = rawRequest("GET", api("/api/big"), browserHeaders(owner));
    req.end();
    const res = await responseOf(req);
    res.pause();
    await sleep(1_000);
    const whileStalled = sent;
    await sleep(500);
    // The computer is stuck waiting for credit: it produced a bounded amount, not the whole body.
    expect(sent).toBe(whileStalled);
    expect(sent).toBeLessThan(total / 2);
    let received = 0;
    res.on("data", (c: Buffer) => (received += c.byteLength));
    res.resume();
    await new Promise((resolve) => res.on("end", resolve));
    expect(received).toBe(total);
  });

  test("a refused upload releases the client at once", async () => {
    computer.autoGrant = false;
    computer.onRequest = (req) =>
      void computer.respond(req, 403, [["content-type", "application/json"]], JSON.stringify({ error: "No", code: "forbidden" }));
    const req = rawRequest("POST", api("/api/upload"), browserHeaders(owner, { "content-type": "application/octet-stream" }));
    const started = Date.now();
    const sent = new Promise((resolve) => req.on("finish", resolve));
    req.end(Buffer.alloc(16 * 1024 * 1024));
    const res = await responseOf(req);
    expect(res.statusCode).toBe(403);
    expect(Date.now() - started).toBeLessThan(3_000);
    res.resume();
    // The rest of the upload is read and dropped, so the client finishes sending instead of hanging.
    await sent;
    const head = await computer.request();
    expect(head.received).toBeLessThanOrEqual(CLOUD_WINDOW);
  });

  test("a client that goes away reaches the computer as Abort", async () => {
    const req = rawRequest("GET", api("/api/slow"), browserHeaders(owner));
    req.end();
    const head = await computer.request();
    req.destroy();
    await until(() => head.aborted, 3_000, "Abort");
    expect(computer.framesOf(CloudFrame.Abort, head.id)).toHaveLength(1);
  });

  test("HEAD and 204 answers end cleanly", async () => {
    computer.onRequest = (req) => void computer.respond(req, req.head.method === "HEAD" ? 200 : 204, [["content-length", "42"]]);
    const head = await call(cloud.port, "HEAD", api("/api/thing"), browserHeaders(owner));
    expect(head.status).toBe(200);
    expect(head.body.byteLength).toBe(0);
    const empty = await call(cloud.port, "DELETE", api("/api/thing"), browserHeaders(owner));
    expect(empty.status).toBe(204);
  });

  test("usage is recorded for the owner", async () => {
    computer.onRequest = (req) => void computer.respond(req, 200, [], "x".repeat(1000));
    await call(cloud.port, "POST", api("/api/echo"), browserHeaders(owner, { "content-type": "text/plain" }), "y".repeat(500));
    await cloud.hub.flushUsage();
    const [row] = await db.select().from(usageDaily).where(eq(usageDaily.deviceId, device.id));
    expect(row).toMatchObject({ userId: owner.id, bytesIn: 500, bytesOut: 1000, requests: 1 });
  });
});

describe("responses from the computer", () => {
  test("only allow-listed headers pass; security headers are forced", async () => {
    computer.onRequest = (req) =>
      void computer.respond(
        req,
        200,
        [
          ["Content-Type", "text/html"],
          ["Set-Cookie", "gmc_session=evil"],
          ["Location", "/d/other/api/x"],
          ["Clear-Site-Data", '"*"'],
          ["WWW-Authenticate", "Basic"],
          ["Report-To", "{}"],
          ["Content-Security-Policy", "default-src *"],
          ["Cache-Control", "public, max-age=600"],
          ["Content-Disposition", 'attachment; filename="a.txt"'],
          ["ETag", '"v1"'],
          ["X-Custom", "1"],
        ],
        "<script>alert(1)</script>",
      );
    const res = await call(cloud.port, "GET", api("/api/file"), browserHeaders(owner));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="a.txt"');
    expect(res.headers.etag).toBe('"v1"');
    for (const name of ["set-cookie", "location", "clear-site-data", "www-authenticate", "report-to", "x-custom"]) {
      expect(res.headers[name]).toBeUndefined();
    }
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  test("the same rules hold on the phone gateway", async () => {
    computer.onRequest = (req) => void computer.respond(req, 200, [["content-type", "image/svg+xml"], ["set-cookie", "a=b"], ["cache-control", "no-store"]], "<svg/>");
    const res = await call(cloud.port, "GET", gw("/api/health"));
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["content-type"]).toBe("image/svg+xml");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
  });

  test("a redirect is answered 502 bad_response and the stream aborted", async () => {
    computer.onRequest = (req) => void computer.respond(req, 307, [["location", "/d/dvc_BBBBBBBBBBBBBBBB/api/agents"]]);
    const res = await call(cloud.port, "PUT", api("/api/agents/1"), browserHeaders(owner, { "content-type": "application/json" }), "{}");
    expect(res.status).toBe(502);
    expect(res.json()).toMatchObject({ code: "bad_response" });
    expect(res.headers.location).toBeUndefined();
    const req = await computer.request();
    await until(() => computer.framesOf(CloudFrame.Abort, req.id).length === 1, 2_000, "Abort");
  });

  test("invalid statuses and headers do not crash the process", async () => {
    for (const status of [99, 1000, 101, 200.5, -1, 304]) {
      computer.onRequest = (req) => computer.send(CloudFrame.ResHead, req.id, { status, headers: [] });
      const res = await call(cloud.port, "GET", api("/api/x"), browserHeaders(owner));
      expect(res.status).toBe(502);
      expect(res.json()).toMatchObject({ code: "bad_response" });
    }
    expect(computer.closeEvent).toBeNull();
    // A non-numeric status is a malformed head: the link closes with Protocol, the client gets 502.
    computer.onRequest = (req) => computer.send(CloudFrame.ResHead, req.id, { status: "abc", headers: [] });
    const malformed = await call(cloud.port, "GET", api("/api/x"), browserHeaders(owner));
    expect(malformed.status).toBe(502);
    await until(() => computer.closeEvent, 2_000, "protocol close");
    expect(computer.closeEvent!.code).toBe(CloudClose.Protocol);

    computer = await FakeComputer.connect(cloud.port, device);
    computer.onRequest = (req) =>
      void computer.respond(
        req,
        200,
        [
          ["content-type", "application/json"],
          ["bad name", "x"],
          ["content-disposition", "a\r\nset-cookie: x=y"],
          ["etag", "☃"],
          ["content-language", "x".repeat(9000)],
        ],
        "{}",
      );
    const res = await call(cloud.port, "GET", api("/api/x"), browserHeaders(owner));
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers["content-language"]).toBeUndefined();
    expect(computer.closeEvent).toBeNull();
  });

  test("a body longer than its content-length is cut off", async () => {
    computer.onRequest = (req) => void computer.respond(req, 200, [["content-length", "4"]], "too long");
    await expect(call(cloud.port, "GET", api("/api/x"), browserHeaders(owner))).rejects.toThrow();
  });

  test("ResBody beyond the window closes the link with Protocol", async () => {
    computer.onRequest = (req) => {
      computer.send(CloudFrame.ResHead, req.id, { status: 200, headers: [] });
      const chunk = Buffer.alloc(CLOUD_CHUNK);
      // Far more than one window at once, without waiting for credit.
      for (let i = 0; i < 512; i++) computer.send(CloudFrame.ResBody, req.id, chunk);
    };
    const req = rawRequest("GET", api("/api/x"), browserHeaders(owner));
    req.end();
    const res = await responseOf(req);
    res.pause();
    await until(() => computer.closeEvent, 3_000, "protocol close");
    expect(computer.closeEvent!.code).toBe(CloudClose.Protocol);
  });

  test("a dropped link fails open requests with 502 link_lost", async () => {
    const pending = call(cloud.port, "GET", api("/api/slow"), browserHeaders(owner));
    await computer.request();
    computer.ws.terminate();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(res.json()).toMatchObject({ code: "link_lost" });
  });

  test("Abort from the computer before its answer is a 502", async () => {
    computer.onRequest = (req) => computer.send(CloudFrame.Abort, req.id, { reason: "handler failed" });
    const res = await call(cloud.port, "GET", api("/api/x"), browserHeaders(owner));
    expect(res.status).toBe(502);
    expect(res.json()).toMatchObject({ code: "link_lost" });
  });
});

describe("browser access (/d)", () => {
  test("fetch metadata other than a same-origin fetch is refused without contacting the computer", async () => {
    const asDocument = await call(cloud.port, "GET", api("/api/x"), browserHeaders(owner, { "sec-fetch-dest": "document" }));
    expect(asDocument.status).toBe(403);
    const asScript = await call(cloud.port, "GET", api("/api/x"), browserHeaders(owner, { "sec-fetch-dest": "script" }));
    expect(asScript.status).toBe(403);
    const crossSite = await call(cloud.port, "GET", api("/api/x"), browserHeaders(owner, { "sec-fetch-site": "cross-site" }));
    expect(crossSite.status).toBe(403);
    expect(crossSite.json()).toMatchObject({ code: "cloud_forbidden" });
    expect(computer.requests.size).toBe(0);
  });

  test("unsafe methods need the dashboard's origin", async () => {
    const noOrigin = await call(cloud.port, "POST", api("/api/x"), { cookie: owner.cookie, "content-type": "application/json" }, "{}");
    expect(noOrigin.status).toBe(403);
    const foreign = await call(cloud.port, "POST", api("/api/x"), { cookie: owner.cookie, origin: "https://evil.example" }, "{}");
    expect(foreign.status).toBe(403);
    computer.onRequest = (req) => void computer.respond(req, 200, [], "ok");
    const fromDashboard = await call(cloud.port, "POST", api("/api/x"), { cookie: owner.cookie, origin: PUBLIC_URL }, "{}");
    expect(fromDashboard.status).toBe(200);
  });

  test("without a session the answer is 401 cloud_unauthorized", async () => {
    const none = await call(cloud.port, "GET", api("/api/x"), { "sec-fetch-dest": "empty" });
    expect(none.status).toBe(401);
    expect(none.json()).toMatchObject({ code: "cloud_unauthorized" });
    const bogus = await call(cloud.port, "GET", api("/api/x"), { cookie: "gmc_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    expect(bogus.status).toBe(401);
  });

  test("someone without access gets 404, as for a computer that does not exist", async () => {
    const stranger = await makeUser("stranger@example.com");
    const res = await call(cloud.port, "GET", api("/api/x"), browserHeaders(stranger));
    expect(res.status).toBe(404);
    expect(res.json()).toMatchObject({ code: "device_not_found" });
    const missing = await call(cloud.port, "GET", "/d/dvc_ZZZZZZZZZZZZZZZZ/api/x", browserHeaders(owner));
    expect(missing.status).toBe(404);
    const malformed = await call(cloud.port, "GET", "/d/not-a-device/api/x", browserHeaders(owner));
    expect(malformed.status).toBe(404);
  });

  test("viewers read but cannot write; operators can", async () => {
    const viewer = await makeUser("viewer@example.com");
    const operator = await makeUser("operator@example.com");
    await db.insert(deviceAccess).values([
      { deviceId: device.id, userId: viewer.id, role: "viewer" },
      { deviceId: device.id, userId: operator.id, role: "operator" },
    ]);
    computer.onRequest = (req) => void computer.respond(req, 200, [], "ok");
    const write = await call(cloud.port, "POST", api("/api/agents"), browserHeaders(viewer), "{}");
    expect(write.status).toBe(403);
    expect(write.json()).toMatchObject({ code: "cloud_forbidden", error: "You can look, but not change anything on this computer." });
    expect((await call(cloud.port, "GET", api("/api/agents"), browserHeaders(viewer))).status).toBe(200);
    expect((await call(cloud.port, "POST", api("/api/conversations/c1/files"), browserHeaders(viewer), "{}")).status).toBe(200);
    expect((await call(cloud.port, "POST", api("/api/agents"), browserHeaders(operator), "{}")).status).toBe(200);
    const roles = [...computer.requests.values()].map((r) => r.head.user?.role);
    expect(roles).toEqual(["viewer", "viewer", "operator"]);
  });

  test("a computer offline is 503 device_offline", async () => {
    computer.ws.close();
    await until(() => !cloud.hub.isOnline(device.id), 2_000, "offline");
    const res = await call(cloud.port, "GET", api("/api/x"), browserHeaders(owner));
    expect(res.status).toBe(503);
    expect(res.json()).toMatchObject({ code: "device_offline" });
  });

  test("browser access turned off on the computer is 403 with a sentence", async () => {
    computer.hello({ browserAccess: false });
    await sleep(150);
    const res = await call(cloud.port, "GET", api("/api/x"), browserHeaders(owner));
    expect(res.status).toBe(403);
    expect(res.json().error).toContain("Settings → Cloud");
  });

  test("a used-up relay allowance is 402 plan_limit", async () => {
    await writeSettings("billing", { enabled: true, stripeSecretKey: "sk_test_fake" }, SYSTEM);
    const member = await makeUser("member@example.com");
    const own = await makeDevice(member.id);
    const memberComputer = await FakeComputer.connect(cloud.port, own);
    const today = new Date().toISOString().slice(0, 10);
    await db.insert(usageDaily).values({ deviceId: own.id, userId: member.id, day: today, bytesIn: 2 * 1024 ** 3, bytesOut: 0, requests: 1 });
    const res = await call(cloud.port, "GET", `/d/${own.id}/api/x`, browserHeaders(member));
    expect(res.status).toBe(402);
    expect(res.json()).toMatchObject({ code: "plan_limit" });
    expect(res.json().error).toMatch(/GB/);
    memberComputer.ws.close();
  });

  test("bodies above the relay limit are 413", async () => {
    await writeSettings("relay", { maxBodyMb: 1 }, SYSTEM);
    const declared = rawRequest("POST", api("/api/upload"), browserHeaders(owner));
    const declaredResponse = responseOf(declared);
    declared.end(Buffer.alloc(2 * 1024 * 1024));
    expect((await declaredResponse).statusCode).toBe(413);
    expect(computer.requests.size).toBe(0);

    // Chunked: found out while streaming; the computer is told to stop.
    const req = rawRequest("POST", api("/api/upload"), browserHeaders(owner, { "transfer-encoding": "chunked" }));
    const response = responseOf(req);
    for (let i = 0; i < 24; i++) req.write(Buffer.alloc(100 * 1024));
    req.end();
    const res = await response;
    expect(res.statusCode).toBe(413);
    const head = await computer.request();
    await until(() => head.aborted, 2_000, "Abort");
  });

  test("the per-computer request limit answers 429", async () => {
    await writeSettings("relay", { requestsPerMinute: 2 }, SYSTEM);
    computer.onRequest = (req) => void computer.respond(req, 200, [], "ok");
    expect((await call(cloud.port, "GET", api("/api/a"), browserHeaders(owner))).status).toBe(200);
    expect((await call(cloud.port, "GET", api("/api/a"), browserHeaders(owner))).status).toBe(200);
    const limited = await call(cloud.port, "GET", api("/api/a"), browserHeaders(owner));
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  test("paths that leave /api are refused before the computer sees them", async () => {
    for (const path of ["/api/../../x", "/api/%2e%2e/%2e%2e/x", "/api/x%2f..%2f..%2fy", "/api/x%5c..", "/api"]) {
      const res = await call(cloud.port, "GET", api(path), browserHeaders(owner));
      expect(res.status, path).toBe(404);
    }
    expect(computer.requests.size).toBe(0);
    const bare = await call(cloud.port, "GET", `/d/${device.id}`, {});
    expect(bare.status).toBe(308);
    expect(bare.headers.location).toBe(`/d/${device.id}/`);
  });

  test("a session revoked while a request is open is cut within the re-check", async () => {
    await cloud.close();
    cloud = await startCloud({ revalidateMs: 100 });
    await baseline(cloud);
    computer = await FakeComputer.connect(cloud.port, device);
    const pending = call(cloud.port, "GET", api("/api/stream"), browserHeaders(owner));
    const req = await computer.request();
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, owner.id));
    const res = await pending;
    expect(res.status).toBe(403);
    expect(req.aborted || computer.framesOf(CloudFrame.Abort, req.id).length > 0).toBe(true);
  });

  test("a share removed while a request is open is cut", async () => {
    await cloud.close();
    cloud = await startCloud({ revalidateMs: 100 });
    await baseline(cloud);
    computer = await FakeComputer.connect(cloud.port, device);
    const operator = await makeUser("operator@example.com");
    await db.insert(deviceAccess).values({ deviceId: device.id, userId: operator.id, role: "operator" });
    const pending = call(cloud.port, "GET", api("/api/stream"), browserHeaders(operator));
    await computer.request();
    await db.delete(deviceAccess).where(eq(deviceAccess.userId, operator.id));
    expect((await pending).status).toBe(403);
  });
});

describe("phone gateway (/gw)", () => {
  const token = { authorization: "Bearer gmd_phone_token_123" };

  test("without a phone token only health and pairing pass", async () => {
    computer.onRequest = (req) => void computer.respond(req, 200, [["content-type", "application/json"]], "{}");
    expect((await call(cloud.port, "GET", gw("/api/health"))).status).toBe(200);
    expect((await call(cloud.port, "POST", gw("/api/mobile/pair"), { "content-type": "application/json" }, '{"code":"x"}')).status).toBe(200);
    const other = await call(cloud.port, "GET", gw("/api/conversations"));
    expect(other.status).toBe(404);
    const big = await call(cloud.port, "POST", gw("/api/mobile/pair"), { "content-type": "application/json" }, "x".repeat(20 * 1024));
    expect(big.status).toBe(413);
    expect([...computer.requests.values()].map((r) => r.head.path)).toEqual(["/api/health", "/api/mobile/pair"]);
  });

  test("with a token requests pass, the token is forwarded and cookies are not", async () => {
    computer.onRequest = (req) => void computer.respond(req, 200, [], "ok");
    const res = await call(cloud.port, "GET", gw("/api/conversations"), { ...token, cookie: owner.cookie });
    expect(res.status).toBe(200);
    const req = await computer.request();
    expect(req.head).toMatchObject({ channel: "mobile", user: null });
    expect(req.head.headers).toContainEqual(["authorization", "Bearer gmd_phone_token_123"]);
    expect(req.head.headers.map(([n]) => n)).not.toContain("cookie");
  });

  test("auth routes and paths outside /api are 404", async () => {
    for (const path of ["/api/auth/login", "/api/x/../auth/token", "/mcp", ""]) {
      const res = await call(cloud.port, "POST", gw(path), token, "{}");
      expect(res.status, path).toBe(404);
    }
    expect(computer.requests.size).toBe(0);
  });

  test("the cloud itself never answers 401 on /gw", async () => {
    const statuses: number[] = [];
    computer.ws.close();
    await until(() => !cloud.hub.isOnline(device.id), 2_000, "offline");
    statuses.push((await call(cloud.port, "GET", gw("/api/x"), token)).status);
    statuses.push((await call(cloud.port, "GET", gw("/api/x"), { authorization: "Bearer nope" })).status);
    statuses.push((await call(cloud.port, "GET", "/gw/dvc_ZZZZZZZZZZZZZZZZ/api/x", token)).status);
    await writeSettings("relay", { phoneGateway: false }, SYSTEM);
    statuses.push((await call(cloud.port, "GET", gw("/api/x"), token)).status);
    expect(statuses).toEqual([503, 404, 404, 503]);
    expect(statuses).not.toContain(401);
  });

  test("phone access turned off on the computer is 503, not 401", async () => {
    computer.hello({ phoneAccess: false });
    await sleep(150);
    const res = await call(cloud.port, "GET", gw("/api/x"), token);
    expect(res.status).toBe(503);
    expect(res.json()).toMatchObject({ code: "device_offline" });
  });

  test("20 answers of 401 lock the address out, and those requests cost no usage", async () => {
    computer.onRequest = (req) => void computer.respond(req, 401, [["content-type", "application/json"]], '{"code":"unauthorized"}');
    const from = { ...token, "x-forwarded-for": "198.51.100.7" };
    for (let i = 0; i < 20; i++) expect((await call(cloud.port, "GET", gw("/api/x"), from)).status).toBe(401);
    const locked = await call(cloud.port, "GET", gw("/api/x"), from);
    expect(locked.status).toBe(429);
    expect(computer.requests.size).toBe(20);
    // Another address still passes.
    expect((await call(cloud.port, "GET", gw("/api/x"), { ...token, "x-forwarded-for": "198.51.100.8" })).status).toBe(401);
    await cloud.hub.flushUsage();
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(usageDaily);
    expect(rows[0]!.n).toBe(0);
  });

  test("health checks and pairing without a phone token cost the owner no usage", async () => {
    computer.onRequest = (req) => void computer.respond(req, 200, [["content-type", "application/json"]], '{"ok":true}');
    expect((await call(cloud.port, "GET", gw("/api/health"))).status).toBe(200);
    expect((await call(cloud.port, "POST", gw("/api/mobile/pair"), { "content-type": "application/json" }, '{"code":"x"}')).status).toBe(200);
    await cloud.hub.flushUsage();
    expect(await db.select().from(usageDaily)).toEqual([]);
    expect((await call(cloud.port, "GET", gw("/api/conversations"), token)).status).toBe(200);
    await cloud.hub.flushUsage();
    const [row] = await db.select().from(usageDaily);
    expect(row).toMatchObject({ requests: 1, bytesOut: 11 });
  });

  test("an IPv6 address counts by its /64 for the 401 lock-out", async () => {
    computer.onRequest = (req) => void computer.respond(req, 401, [["content-type", "application/json"]], '{"code":"unauthorized"}');
    for (let i = 1; i <= 20; i++) {
      const from = { ...token, "x-forwarded-for": `2001:db8:1:2::${i.toString(16)}` };
      expect((await call(cloud.port, "GET", gw("/api/x"), from)).status).toBe(401);
    }
    expect((await call(cloud.port, "GET", gw("/api/x"), { ...token, "x-forwarded-for": "2001:db8:1:2:ffff:ffff:ffff:ffff" })).status).toBe(429);
    expect((await call(cloud.port, "GET", gw("/api/x"), { ...token, "x-forwarded-for": "2001:db8:1:3::1" })).status).toBe(401);
  });

  test("refusals on a keep-alive connection don't pile up close listeners", async () => {
    const sockets: Socket[] = [];
    cloud.server.on("connection", (socket: Socket) => sockets.push(socket));
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let i = 0; i < 15; i++) {
        const status = await new Promise<number>((resolve, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port: cloud.port, method: "POST", path: gw("/api/conversations"), agent, headers: { "content-type": "application/octet-stream" } },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode ?? 0));
            },
          );
          req.on("error", reject);
          req.end(Buffer.alloc(256 * 1024));
        });
        expect(status).toBe(404);
      }
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.listenerCount("close")).toBeLessThan(5);
    } finally {
      agent.destroy();
    }
  });

  test("at most 64 phone streams are open at once", async () => {
    const pending = Array.from({ length: 64 }, () => call(cloud.port, "GET", gw("/api/x"), token));
    await until(() => computer.requests.size === 64, 5_000, "64 streams");
    const extra = await call(cloud.port, "GET", gw("/api/x"), token);
    expect(extra.status).toBe(429);
    expect(extra.headers["retry-after"]).toBe("1");
    // Browser requests still have room.
    computer.onRequest = (req) => void computer.respond(req, 200, [], "ok");
    expect((await call(cloud.port, "GET", api("/api/y"), browserHeaders(owner))).status).toBe(200);
    for (const req of [...computer.requests.values()].slice(0, 64)) void computer.respond(req, 200, [], "ok");
    await Promise.all(pending);
  });
});
