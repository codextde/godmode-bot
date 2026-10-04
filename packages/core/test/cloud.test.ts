import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { Hono } from "hono";
import {
  CLOUD_CHUNK,
  CLOUD_WS_WINDOW,
  CloudClose,
  CloudCredit,
  CloudFrame,
  CloudWindow,
  cloudFrameJson,
  cloudFrameText,
  decodeCloudFrame,
  decodeCloudWindow,
  encodeCloudFrame,
  encodeCloudWindow,
  parsePairingLink,
  type CloudAbort,
  type CloudBilling,
  type CloudFrameData,
  type CloudHello,
  type CloudLinkPollResponse,
  type CloudLinkStartRequest,
  type CloudPlanSummary,
  type CloudRelayUser,
  type CloudReqHead,
  type CloudResHead,
  type CloudStatus,
  type CloudWelcome,
  type CloudWsClose,
  type CloudWsOpen,
  type CloudWsReject,
  type MobilePairingOffer,
  type MobilePairResult,
  type MobileSession,
  type MobileStatus,
  type ServerEvent,
} from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, get, getMeta, openDb } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { hasComputerSubscribers, websocketHandler } from "../src/server/ws";
import { getSettings, resetSettingsCache, updateSettings } from "../src/services/settings";
import { setTailscaleOverride } from "../src/mobile/tailscale";
import { claimPairing, createPairingOffer } from "../src/mobile/devices";
import { sha256 } from "../src/vault/crypto";
import { cloudLinkClient, cloudStatus, setCloudTransportOverride, startCloudLink, stopCloudLink } from "../src/cloud/link";
import { LINK_REPLACED, LINK_REVOKED, VERSION_MISMATCH, retryDelay, type CloudWebSocketCtor } from "../src/cloud/client";
import { BROWSER_ACCESS_OFF } from "../src/cloud/dispatch";
import { SECRETS_OFF } from "../src/cloud/scope";
import { saveLink, writeLinkSecret } from "../src/cloud/state";

const DEVICE_ID = "dvc_AbCdEfGh12345678";
const PLAN: CloudPlanSummary = { id: "plan_free", name: "Free", limits: { maxDevices: 1, relayGbPerMonth: 5, browserAccess: true, phoneGateway: true, sharing: false } };
const OWNER: CloudRelayUser = { id: "usr_owner", email: "owner@example.com", name: "Owner", role: "owner" };
const OPERATOR: CloudRelayUser = { id: "usr_operator", email: "operator@example.com", name: null, role: "operator" };
const VIEWER: CloudRelayUser = { id: "usr_viewer", email: "viewer@example.com", name: null, role: "viewer" };

async function until(cond: () => boolean, timeout = 5000, what = "condition") {
  const end = Date.now() + timeout;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

interface Reply {
  id: number;
  status: number;
  headers: [string, string][];
  chunks: Uint8Array[];
  types: number[];
  aborted: string | null;
  windows: number;
  text(): string;
  json(): unknown;
  as<T>(): T;
}

class FakeSocket {
  messages: { type: string; [key: string]: unknown }[] = [];
  types: number[] = [];
  accepted = false;
  rejected: CloudWsReject | null = null;
  closed: CloudWsClose | null = null;
  grant = true;
  private readonly credit = new CloudCredit(CLOUD_WS_WINDOW / 4);
  private unacked = 0;

  constructor(
    private readonly cloud: FakeCloud,
    readonly id: number,
  ) {}

  frame(f: CloudFrameData) {
    this.types.push(f.type);
    if (f.type === CloudFrame.WsAccept) this.accepted = true;
    if (f.type === CloudFrame.WsReject) this.rejected = cloudFrameJson<CloudWsReject>(f);
    if (f.type === CloudFrame.WsClose) this.closed = cloudFrameJson<CloudWsClose>(f);
    if (f.type === CloudFrame.WsText) {
      this.messages.push(JSON.parse(cloudFrameText(f)));
      this.unacked += f.payload.byteLength;
      if (this.grant) this.ack();
    }
  }

  /** Acknowledge what was written to the (imaginary) client. */
  ack() {
    const credit = this.credit.consumed(this.unacked);
    this.unacked = 0;
    if (credit) this.cloud.send(encodeCloudWindow(this.id, credit));
  }

  send(msg: unknown) {
    this.cloud.send(encodeCloudFrame(CloudFrame.WsText, this.id, typeof msg === "string" ? msg : JSON.stringify(msg)));
  }

  close(code = 1000, reason = "") {
    this.cloud.send(encodeCloudFrame(CloudFrame.WsClose, this.id, { code, reason }));
  }

  of(type: string) {
    return this.messages.filter((m) => m.type === type);
  }
}

/** A cloud as the computer sees it: the link and device APIs over HTTP, and the link WebSocket with the shared codec. */
class FakeCloud {
  readonly server: Server<{ auth: string | null }>;
  readonly url: string;
  link: ServerWebSocket<{ auth: string | null }> | null = null;
  connects = 0;
  auths: (string | null)[] = [];
  hellos: CloudHello[] = [];
  starts: CloudLinkStartRequest[] = [];
  polls: { requestId: string; auth: string | null }[] = [];
  pollAnswer: CloudLinkPollResponse = { status: "pending" };
  verifyUrl: string | null = null;
  deletes: (string | null)[] = [];
  billingAuths: (string | null)[] = [];
  /** Accept the next connections and close them right away with this code. */
  refuse: { code: number; reason: string } | null = null;
  private listeners = new Set<(frame: CloudFrameData) => void>();
  private nextId = 1000;

  constructor() {
    this.server = Bun.serve<{ auth: string | null }>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, srv) => this.http(req, srv),
      websocket: {
        open: (ws) => {
          this.connects++;
          this.auths.push(ws.data.auth);
          if (this.refuse) {
            ws.close(this.refuse.code, this.refuse.reason);
            return;
          }
          this.link = ws;
        },
        message: (ws, message) => {
          if (ws !== this.link || typeof message === "string") return;
          const frame = decodeCloudFrame(new Uint8Array(message));
          if (!frame) return;
          if (frame.type === CloudFrame.Hello) {
            this.hellos.push(cloudFrameJson<CloudHello>(frame)!);
            this.welcomeOnce(ws);
          }
          if (frame.type === CloudFrame.Ping) ws.send(encodeCloudFrame(CloudFrame.Pong, 0));
          for (const listener of [...this.listeners]) listener(frame);
        },
        close: (ws) => {
          if (ws === this.link) this.link = null;
        },
      },
    });
    this.url = `http://127.0.0.1:${this.server.port}`;
  }

  private welcomed = new WeakSet<object>();

  private welcomeOnce(ws: ServerWebSocket<{ auth: string | null }>) {
    if (this.welcomed.has(ws)) return;
    this.welcomed.add(ws);
    const welcome: CloudWelcome = {
      deviceId: DEVICE_ID,
      account: { email: "owner@example.com", name: "Owner" },
      plan: PLAN,
      publicUrl: this.url,
      limits: { maxBodyBytes: 1024 ** 3 },
      serverTime: new Date().toISOString(),
    };
    ws.send(encodeCloudFrame(CloudFrame.Welcome, 0, welcome));
  }

  private async http(req: Request, srv: Server<{ auth: string | null }>): Promise<Response | undefined> {
    const path = new URL(req.url).pathname;
    const auth = req.headers.get("authorization");
    if (path === "/relay/v1/connect") return srv.upgrade(req, { data: { auth } }) ? undefined : new Response("no", { status: 400 });
    if (path === "/api/link/v1/start") {
      this.starts.push((await req.json()) as CloudLinkStartRequest);
      return Response.json({
        requestId: "lnk_request1",
        userCode: "KQZM-7HPD",
        verifyUrl: this.verifyUrl ?? `${this.url}/link?code=KQZM-7HPD`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        interval: 1,
      });
    }
    if (path === "/api/link/v1/poll") {
      this.polls.push({ requestId: ((await req.json()) as { requestId: string }).requestId, auth });
      return Response.json(this.pollAnswer);
    }
    if (path === "/api/device/v1/billing" || path === "/api/device/v1/billing/cancel") {
      this.billingAuths.push(auth);
      return Response.json(billing(path.endsWith("cancel")));
    }
    if (path === "/api/device/v1/self" && req.method === "DELETE") {
      this.deletes.push(auth);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Not found", code: "not_found" }, { status: 404 });
  }

  on(listener: (frame: CloudFrameData) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(frame: Uint8Array) {
    this.link?.send(frame);
  }

  id(): number {
    return this.nextId++;
  }

  /** Relay one HTTP request and collect the computer's answer (granting response credit like a fast client). */
  request(head: Partial<CloudReqHead> & { path: string }, body?: Uint8Array | string, opts: { id?: number; timeout?: number } = {}): Promise<Reply> {
    const id = opts.id ?? this.id();
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const full: CloudReqHead = { method: "GET", headers: [], channel: "cloud", user: OWNER, ip: "203.0.113.7", hasBody: !!bytes, ...head };
    if (typeof body === "string" && !full.headers.some(([n]) => n === "content-type")) full.headers = [...full.headers, ["content-type", "application/json"]];
    const window = new CloudWindow();
    const credit = new CloudCredit();
    const reply: Reply = {
      id,
      status: 0,
      headers: [],
      chunks: [],
      types: [],
      aborted: null,
      windows: 0,
      text: () => Buffer.concat(reply.chunks).toString("utf8"),
      json: () => JSON.parse(reply.text()) as unknown,
      as: <T>() => JSON.parse(reply.text()) as T,
    };
    const done = new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        window.close();
        reject(new Error(`no answer for ${full.method} ${full.path}`));
      }, opts.timeout ?? 10_000);
      const finish = () => {
        clearTimeout(timer);
        off();
        window.close();
        resolve(reply);
      };
      const off = this.on((f) => {
        if (f.stream !== id) return;
        if (f.type === CloudFrame.Window) {
          reply.windows++;
          window.grant(decodeCloudWindow(f));
          return;
        }
        reply.types.push(f.type);
        if (f.type === CloudFrame.ResHead) {
          const h = cloudFrameJson<CloudResHead>(f)!;
          reply.status = h.status;
          reply.headers = h.headers;
        } else if (f.type === CloudFrame.ResBody) {
          reply.chunks.push(f.payload.slice());
          const grant = credit.consumed(f.payload.byteLength);
          if (grant) this.send(encodeCloudWindow(id, grant));
        } else if (f.type === CloudFrame.ResEnd) {
          finish();
        } else if (f.type === CloudFrame.Abort) {
          reply.aborted = cloudFrameJson<CloudAbort>(f)!.reason;
          finish();
        }
      });
    });
    this.send(encodeCloudFrame(CloudFrame.ReqHead, id, full));
    if (bytes) void this.pump(id, bytes, window);
    return done;
  }

  private async pump(id: number, body: Uint8Array, window: CloudWindow) {
    for (let offset = 0; offset < body.byteLength; offset += CLOUD_CHUNK) {
      const piece = body.subarray(offset, offset + CLOUD_CHUNK);
      try {
        await window.take(piece.byteLength);
      } catch {
        return; // the stream ended before the whole body was needed
      }
      this.send(encodeCloudFrame(CloudFrame.ReqBody, id, piece));
    }
    this.send(encodeCloudFrame(CloudFrame.ReqEnd, id));
  }

  async socket(open: Partial<CloudWsOpen> = {}): Promise<FakeSocket> {
    const id = this.id();
    const socket = new FakeSocket(this, id);
    const off = this.on((f) => {
      if (f.stream !== id) return;
      socket.frame(f);
      if (socket.closed || socket.rejected) off();
    });
    const full: CloudWsOpen = { path: "/api/ws", headers: [], channel: "cloud", user: OWNER, ip: "203.0.113.7", ...open };
    this.send(encodeCloudFrame(CloudFrame.WsOpen, id, full));
    await until(() => socket.accepted || !!socket.rejected, 5000, "WsAccept or WsReject");
    if (socket.accepted) await until(() => socket.of("hello").length > 0, 5000, "hello");
    return socket;
  }

  stop() {
    this.server.stop(true);
  }
}

function billing(cancelled: boolean): CloudBilling {
  const t = new Date().toISOString();
  return {
    billingEnabled: true,
    plan: PLAN,
    subscription: { status: "active", interval: "month", amount: 900, currency: "eur", currentPeriodEnd: t, cancelAtPeriodEnd: cancelled, trialEnd: null },
    usage: { periodStart: t, periodEnd: t, devices: { used: 1, limit: 1 }, relayBytes: { used: 10, limit: null }, requests: 3 },
    invoices: [],
    urls: { billing: "https://cloud.example.test/billing", devices: "https://cloud.example.test/devices", account: "https://cloud.example.test/account" },
  };
}

let dataDir: string;
let app: ReturnType<typeof createApp>;
let token: string;
let cloud: FakeCloud;
let streamCancelled = false;
let secret = "";

async function desktop<T = CloudStatus>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as T };
}

async function waitOnline() {
  await until(() => cloudStatus().state === "online" && !!cloud.link, 8000, "the link to be online");
}

/** Pause and resume the link: a fresh client dials at once (no backoff left over). */
async function redial() {
  cloud.refuse = null;
  expect((await desktop("PUT", "/api/cloud", { enabled: false })).data.state).toBe("paused");
  await desktop("PUT", "/api/cloud", { enabled: true });
  await waitOnline();
}

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-cloud-"));
  loadConfig({ dataDir, token: "cloud-test-token" });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  // Subscribing to a screen must not start a real capture in tests.
  updateSettings({ computer: { enabled: false } });
  setTailscaleOverride({ installed: false, running: false, ip: null, dnsName: null, tailnet: null, detail: "Tailscale isn't installed on this computer." });
  app = createApp();
  token = getAccessToken();
  cloud = new FakeCloud();

  // Test routes in front of the real app, for flow control and stream lifecycles.
  const relayed = new Hono();
  relayed.post("/api/test/echo", async (c) => {
    await Bun.sleep(100); // read late: the body must wait under the window, not deadlock
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json({ bytes: bytes.byteLength, sha256: sha256(bytes) });
  });
  relayed.get("/api/test/big", (c) => c.body(new Uint8Array(3 * 1024 * 1024).fill(7)));
  relayed.get("/api/test/empty", (c) => c.body(null, 204));
  relayed.get("/api/test/slow", async (c) => {
    await Bun.sleep(Number(c.req.query("ms") ?? 2000));
    return c.json({ slow: true });
  });
  relayed.get("/api/test/stream", () => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(20);
        controller.enqueue(new TextEncoder().encode(`tick ${n++}\n`));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    return new Response(body, { headers: { "content-type": "text/plain" } });
  });
  relayed.get("/api/test/broken", () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled++ === 0) controller.enqueue(new TextEncoder().encode("partial"));
        else controller.error(new Error("disk went away"));
      },
    });
    return new Response(body);
  });
  relayed.all("*", (c) => app.fetch(c.req.raw, c.env));
  startCloudLink({ app: relayed, websocket: websocketHandler });
});

afterAll(() => {
  stopCloudLink();
  setCloudTransportOverride(null);
  setTailscaleOverride(null);
  cloud.stop();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("linking", () => {
  test("an unlinked computer never dials and says so", async () => {
    const status = await desktop("GET", "/api/cloud");
    expect(status.status).toBe(200);
    expect(status.data).toMatchObject({ state: "unlinked", url: null, deviceId: null, pending: null, settings: { enabled: false, browserAccess: true, phoneAccess: true, allowSecrets: false } });
    expect(cloud.connects).toBe(0);
    const billing = await desktop<{ code: string }>("GET", "/api/cloud/billing");
    expect(billing.status).toBe(409);
    expect(billing.data.code).toBe("not_linked");
  });

  test("addresses must be https, except on this machine", async () => {
    const res = await desktop<{ error: string }>("POST", "/api/cloud/link", { url: "http://cloud.example.com" });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe("The cloud address must start with https://.");
  });

  test("an approval page on another site is refused", async () => {
    cloud.verifyUrl = "https://evil.example.com/link?code=KQZM-7HPD";
    const res = await desktop<{ error: string }>("POST", "/api/cloud/link", { url: cloud.url });
    expect(res.status).toBe(502);
    expect(res.data.error).toBe("The cloud sent an approval page on another site. Check the cloud address.");
    expect(cloudStatus().state).toBe("unlinked");
    cloud.verifyUrl = null;
  });

  test("start, poll, approve: the link is remembered and comes up with Hello, Welcome and the bearer", async () => {
    const started = await desktop("POST", "/api/cloud/link", { url: `${cloud.url}/some/path` });
    expect(started.status).toBe(200);
    expect(started.data).toMatchObject({ state: "linking", url: cloud.url, pending: { userCode: "KQZM-7HPD", verifyUrl: `${cloud.url}/link?code=KQZM-7HPD` } });
    const start = cloud.starts.at(-1)!;
    expect(start.instanceId).toMatch(/^gm_/);
    expect(start.secretHash).toMatch(/^[0-9a-f]{64}$/);

    await until(() => cloud.polls.length > 0, 5000, "a poll");
    const poll = cloud.polls[0]!;
    expect(poll.requestId).toBe("lnk_request1");
    secret = poll.auth!.slice("Bearer ".length);
    expect(secret.startsWith("gml_")).toBe(true);
    // Only the hash went to the cloud at start; the secret proves the poll.
    expect(sha256(secret)).toBe(start.secretHash);
    expect(cloudStatus().state).toBe("linking");

    cloud.pollAnswer = { status: "approved", deviceId: DEVICE_ID, account: { email: "owner@example.com", name: "Owner" } };
    await waitOnline();

    expect(getMeta("cloud.url")).toBe(cloud.url);
    expect(getMeta("cloud.device_id")).toBe(DEVICE_ID);
    expect(JSON.parse(getMeta("cloud.account")!)).toEqual({ email: "owner@example.com", name: "Owner" });
    expect(getMeta("cloud.linked_at")).toMatch(/^\d{4}-/);
    const file = join(dataDir, "cloud-link");
    expect(readFileSync(file, "utf8")).toBe(secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(getSettings().cloud.enabled).toBe(true);
    expect(JSON.stringify(getSettings())).not.toContain("gml_");
    expect(get<{ value: string }>("SELECT value FROM meta WHERE value LIKE '%gml_%'")).toBeNull();

    expect(cloud.auths.at(-1)).toBe(`Bearer ${DEVICE_ID}.${secret}`);
    expect(cloud.hellos[0]).toMatchObject({ protocol: 1, instanceId: start.instanceId, browserAccess: true, phoneAccess: false });

    const status = await desktop("GET", "/api/cloud");
    expect(status.data).toMatchObject({
      state: "online",
      url: cloud.url,
      deviceId: DEVICE_ID,
      account: { email: "owner@example.com", name: "Owner" },
      browserUrl: `${cloud.url}/d/${DEVICE_ID}/`,
      gatewayUrl: `${cloud.url}/gw/${DEVICE_ID}`,
      plan: PLAN,
      pending: null,
      error: null,
    });
    expect(status.data.connectedSince).toMatch(/^\d{4}-/);
    expect(get("SELECT id FROM audit_log WHERE action = 'cloud.link'")).not.toBeNull();
  });

  test("a second link is refused while linked", async () => {
    const res = await desktop<{ error: string }>("POST", "/api/cloud/link", { url: cloud.url });
    expect(res.status).toBe(409);
  });

  test("billing comes from the cloud with the device bearer", async () => {
    const res = await desktop<CloudBilling>("GET", "/api/cloud/billing");
    expect(res.status).toBe(200);
    expect(res.data.plan).toEqual(PLAN);
    expect(cloud.billingAuths.at(-1)).toBe(`Bearer ${DEVICE_ID}.${secret}`);
    const cancelled = await desktop<CloudBilling>("POST", "/api/cloud/billing/cancel");
    expect(cancelled.data.subscription?.cancelAtPeriodEnd).toBe(true);
  });
});

describe("relayed HTTP", () => {
  test("a GET and a POST with a JSON body", async () => {
    const boot = await cloud.request({ path: "/api/bootstrap" });
    expect(boot.status).toBe(200);
    expect(boot.as<{ settings: { cloud: unknown } }>().settings.cloud).toMatchObject({ enabled: true });
    expect(boot.types.filter((t) => t === CloudFrame.ResEnd)).toHaveLength(1);

    const created = await cloud.request({ method: "POST", path: "/api/workspaces" }, JSON.stringify({ name: "From the cloud" }));
    expect(created.status).toBe(200);
    expect(created.as<{ name: string }>().name).toBe("From the cloud");
  });

  test("the cloud channel is signed in without a token or cookie, and its use is announced once a day", async () => {
    const status = await cloud.request({ path: "/api/auth/status", headers: [["authorization", `Bearer ${token}`]] });
    expect(status.json()).toMatchObject({ authenticated: true });
    expect(get<{ actor: string }>("SELECT actor FROM audit_log WHERE action = 'cloud.use' AND target = 'usr_owner'")?.actor).toBe("cloud:owner@example.com");
    await cloud.request({ path: "/api/bootstrap" });
    expect(get<{ c: number }>("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'cloud.use' AND target = 'usr_owner'")?.c).toBe(1);
    expect(get<{ title: string }>("SELECT title FROM notifications WHERE title LIKE 'owner@example.com is controlling%'")?.title).toBe(
      `owner@example.com is controlling this computer through 127.0.0.1:${cloud.server.port}`,
    );
  });

  test("an 8 MiB upload whose handler reads 100 ms late arrives whole under the window", async () => {
    const body = new Uint8Array(8 * 1024 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = (i * 31) & 0xff;
    const reply = await cloud.request(
      { method: "POST", path: "/api/test/echo", headers: [["content-type", "application/octet-stream"], ["content-length", String(body.length)]] },
      body,
      { timeout: 20_000 },
    );
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual({ bytes: body.length, sha256: sha256(body) });
    expect(reply.windows).toBeGreaterThan(0);
  });

  test("responses are sliced to CLOUD_CHUNK under the window and end with exactly one ResEnd", async () => {
    const big = await cloud.request({ path: "/api/test/big" });
    expect(big.status).toBe(200);
    expect(big.chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(3 * 1024 * 1024);
    expect(Math.max(...big.chunks.map((c) => c.byteLength))).toBeLessThanOrEqual(CLOUD_CHUNK);
    expect(big.types.filter((t) => t === CloudFrame.ResEnd)).toHaveLength(1);
    expect(big.types.at(-1)).toBe(CloudFrame.ResEnd);

    const head = await cloud.request({ method: "HEAD", path: "/api/bootstrap" });
    expect(head.status).toBe(200);
    expect(head.types).toEqual([CloudFrame.ResHead, CloudFrame.ResEnd]);

    const empty = await cloud.request({ path: "/api/test/empty" });
    expect(empty.status).toBe(204);
    expect(empty.types).toEqual([CloudFrame.ResHead, CloudFrame.ResEnd]);
  });

  test("Abort from the cloud cancels the response; nothing more is sent for the stream", async () => {
    streamCancelled = false;
    const id = cloud.id();
    const types: number[] = [];
    const off = cloud.on((f) => {
      if (f.stream === id) types.push(f.type);
    });
    cloud.send(encodeCloudFrame(CloudFrame.ReqHead, id, { method: "GET", path: "/api/test/stream", headers: [], channel: "cloud", user: OWNER, ip: null, hasBody: false }));
    await until(() => types.includes(CloudFrame.ResBody), 5000, "the first chunk");
    cloud.send(encodeCloudFrame(CloudFrame.Abort, id, { reason: "The client left." }));
    await until(() => streamCancelled, 5000, "the response to be cancelled");
    const seen = types.length;
    await Bun.sleep(150);
    off();
    expect(types.length).toBe(seen);
    expect(types).not.toContain(CloudFrame.ResEnd);
    expect(cloudLinkClient()?.connection?.size.streams).toBe(0);
  });

  test("a response that fails half way ends with Abort, not ResEnd", async () => {
    const reply = await cloud.request({ path: "/api/test/broken" });
    expect(reply.status).toBe(200);
    expect(reply.aborted).toBe("The computer could not finish the answer.");
    expect(reply.types).not.toContain(CloudFrame.ResEnd);
  });

  test("only the API is relayed; sign-in and pairing are refused before any handler runs", async () => {
    expect((await cloud.request({ path: "/api/../mcp" })).status).toBe(404);
    const login = await cloud.request({ method: "POST", path: "/api/auth/login" }, JSON.stringify({ password: "guess" }));
    expect(login.status).toBe(403);
    expect(login.json()).toMatchObject({ code: "cloud_forbidden" });
    expect((await cloud.request({ method: "POST", path: "/api/auth/token" }, JSON.stringify({ token }))).status).toBe(403);
    expect((await cloud.request({ method: "POST", path: "/api/%61uth/token" }, JSON.stringify({ token }))).status).toBe(403);
    expect((await cloud.request({ method: "POST", path: "/api/mobile/pair" }, JSON.stringify({ code: "x".repeat(20), name: "x", platform: "ios" }))).status).toBe(403);
    expect(get("SELECT id FROM audit_log WHERE action = 'auth.login_failed'")).toBeNull();
  });
});

describe("cloud scope", () => {
  test("always refused, with a sentence", async () => {
    const reveal = await cloud.request({ method: "POST", path: "/api/files/reveal" }, JSON.stringify({ path: "/" }));
    expect(reveal.status).toBe(403);
    expect(reveal.json()).toEqual({ error: "This can only be done in Godmode on the computer itself, not through Godmode Cloud.", code: "cloud_forbidden" });
    const link = await cloud.request({ method: "DELETE", path: "/api/cloud/link" });
    expect(link.json()).toMatchObject({ error: "Linking and access switches are managed on the computer itself.", code: "cloud_forbidden" });
    expect((await cloud.request({ path: "/api/mobile" })).status).toBe(403);
    const settings = await cloud.request({ method: "PUT", path: "/api/settings" }, JSON.stringify({ cloud: { allowSecrets: true } }));
    expect(settings.json()).toMatchObject({ error: "These settings can only be changed in Godmode on the computer itself." });
    expect((await cloud.request({ method: "PUT", path: "/api/settings" }, JSON.stringify({ server: { remoteAccess: true } }))).status).toBe(403);
    expect(getSettings().cloud.allowSecrets).toBe(false);
    const name = await cloud.request({ method: "PUT", path: "/api/settings" }, JSON.stringify({ general: { userName: "Cloud" } }));
    expect(name.status).toBe(200);
  });

  test("secrets need allowSecrets, switched on the computer", async () => {
    const refused = await cloud.request({ path: "/api/vault/secrets" });
    expect(refused.status).toBe(403);
    expect(refused.json()).toEqual({ error: SECRETS_OFF, code: "cloud_forbidden" });
    const agent = await cloud.request({ method: "POST", path: "/api/agents" }, JSON.stringify({ name: "Sneaky", permissions: { secretAccess: "reveal" } }));
    expect(agent.json()).toMatchObject({ error: SECRETS_OFF });
    expect((await cloud.request({ method: "POST", path: "/api/ssh/test" }, JSON.stringify({ id: "ssh_1", host: "evil.example.com" }))).status).toBe(403);

    expect((await desktop("PUT", "/api/cloud", { allowSecrets: true })).data.settings.allowSecrets).toBe(true);
    expect((await cloud.request({ path: "/api/vault/secrets" })).status).toBe(200);
    // Viewers never get secrets.
    expect((await cloud.request({ path: "/api/vault/secrets", user: VIEWER })).status).toBe(403);
    await desktop("PUT", "/api/cloud", { allowSecrets: false });
    expect((await cloud.request({ path: "/api/vault/secrets" })).status).toBe(403);
  });

  test("viewers read and change nothing; cloud status and billing are for the owner", async () => {
    expect((await cloud.request({ path: "/api/workspaces", user: VIEWER })).status).toBe(200);
    const write = await cloud.request({ method: "POST", path: "/api/workspaces", user: VIEWER }, JSON.stringify({ name: "Nope" }));
    expect(write.status).toBe(403);
    expect(write.json()).toEqual({ error: "You can look, but not change anything on this computer.", code: "cloud_forbidden" });
    expect((await cloud.request({ path: "/api/computer/thumbnail?view=display:1", user: VIEWER })).status).toBe(403);
    expect((await cloud.request({ method: "POST", path: "/api/conversations/cnv_none/files", user: VIEWER }, JSON.stringify({ messages: [] }))).status).not.toBe(403);

    expect((await cloud.request({ path: "/api/cloud", user: OPERATOR })).status).toBe(403);
    expect((await cloud.request({ path: "/api/cloud/billing", user: OPERATOR })).status).toBe(403);
    const status = await cloud.request({ path: "/api/cloud" });
    expect(status.status).toBe(200);
    expect(status.as<CloudStatus>().state).toBe("online");
    expect((await cloud.request({ path: "/api/cloud/billing" })).status).toBe(200);
    expect((await cloud.request({ path: "/api/usage?days=7", user: VIEWER })).status).toBe(200);
  });

  test("browser access off: 403 with the sentence, sockets refused, Hello sent again", async () => {
    const before = cloud.hellos.length;
    await desktop("PUT", "/api/cloud", { browserAccess: false });
    await until(() => cloud.hellos.length > before, 3000, "a new Hello");
    expect(cloud.hellos.at(-1)?.browserAccess).toBe(false);
    const res = await cloud.request({ path: "/api/bootstrap" });
    expect(res.status).toBe(403);
    expect(res.json()).toEqual({ error: BROWSER_ACCESS_OFF, code: "cloud_forbidden" });
    const socket = await cloud.socket();
    expect(socket.rejected).toEqual({ status: 403, message: BROWSER_ACCESS_OFF });
    await desktop("PUT", "/api/cloud", { browserAccess: true });
    expect((await cloud.request({ path: "/api/bootstrap" })).status).toBe(200);
  });
});

describe("phones through the gateway", () => {
  let phoneToken = "";

  test("phone access off: 503 device_offline, never 401", async () => {
    updateSettings({ mobile: { enabled: false } });
    const off = await cloud.request({ path: "/api/conversations", channel: "mobile", user: null, headers: [["authorization", "Bearer gmd_whatever"]] });
    expect(off.status).toBe(503);
    expect(off.json()).toMatchObject({ code: "device_offline" });
    const socket = await cloud.socket({ channel: "mobile", user: null });
    expect(socket.rejected?.status).toBe(503);

    updateSettings({ mobile: { enabled: true } });
    await desktop("PUT", "/api/cloud", { phoneAccess: false });
    expect((await cloud.request({ path: "/api/conversations", channel: "mobile", user: null })).status).toBe(503);
    await desktop("PUT", "/api/cloud", { phoneAccess: true });
    await until(() => cloud.hellos.at(-1)?.phoneAccess === true, 3000, "Hello with phone access");
  });

  test("a paired phone's token works and gets the phone scope; health names the instance", async () => {
    const offer = createPairingOffer([]);
    const paired = claimPairing({ code: parsePairingLink(offer.link)!.code, name: "Pixel", platform: "android" }, "test");
    phoneToken = paired.token;
    const auth: [string, string][] = [["authorization", `Bearer ${phoneToken}`]];
    const list = await cloud.request({ path: "/api/conversations", channel: "mobile", user: null, headers: auth, ip: "198.51.100.4" });
    expect(list.status).toBe(200);
    const secrets = await cloud.request({ path: "/api/vault/secrets", channel: "mobile", user: null, headers: auth });
    expect(secrets.status).toBe(403);
    expect(secrets.json()).toMatchObject({ code: "device_forbidden" });
    const health = await cloud.request({ path: "/api/health", channel: "mobile", user: null });
    expect(health.json()).toEqual({ ok: true, name: "godmode-bot", instance: paired.instance.id });
    expect((await cloud.request({ path: "/api/auth/status", channel: "mobile", user: null })).status).toBe(404);
    // The core's own 401 (unknown token) is the one answer that means "unpaired".
    const forged = await cloud.request({ path: "/api/conversations", channel: "mobile", user: null, headers: [["authorization", "Bearer gmd_forged-token-value-00000000000"]] });
    expect(forged.status).toBe(401);
    expect(get<{ last_address: string }>("SELECT last_address FROM mobile_devices WHERE id = ?", paired.device.id)?.last_address).toBe("198.51.100.4");
  });

  test("phone sockets are device sockets: removing the phone closes them with 4003", async () => {
    const socket = await cloud.socket({ channel: "mobile", user: null, headers: [["authorization", `Bearer ${phoneToken}`]] });
    expect(socket.accepted).toBe(true);
    const status = await desktop<MobileStatus>("GET", "/api/mobile");
    const device = status.data.devices.find((d) => d.name === "Pixel")!;
    expect(device.online).toBe(true);
    await desktop("DELETE", `/api/mobile/devices/${device.id}`);
    await until(() => !!socket.closed, 3000, "WsClose");
    expect(socket.closed?.code).toBe(4003);
    const refused = await cloud.socket({ channel: "mobile", user: null, headers: [["authorization", `Bearer ${phoneToken}`]] });
    expect(refused.rejected?.status).toBe(401);
  });
});

describe("relayed WebSockets", () => {
  test("WsAccept comes before hello; ping is answered; WsClose from the cloud cleans up subscriptions", async () => {
    const socket = await cloud.socket();
    expect(socket.types[0]).toBe(CloudFrame.WsAccept);
    expect(socket.messages[0]?.type).toBe("hello");
    socket.send({ type: "ping" });
    await until(() => socket.of("pong").length === 1, 3000, "pong");

    socket.send({ type: "computer.subscribe", view: "display:41" });
    await until(() => hasComputerSubscribers("display:41"), 3000, "the subscription");
    socket.close(1000);
    await until(() => !hasComputerSubscribers("display:41"), 3000, "the subscription to end");
    expect(cloudLinkClient()?.connection?.size.sockets).toBe(0);
    // A late frame for the closed stream is ignored, and the link stays up.
    socket.send({ type: "ping" });
    await Bun.sleep(50);
    expect(cloudStatus().state).toBe("online");
  });

  test("closing from the computer sends WsClose once and runs the hub's close", async () => {
    const socket = await cloud.socket();
    socket.send({ type: "computer.subscribe", view: "display:42" });
    await until(() => hasComputerSubscribers("display:42"), 3000, "the subscription");
    await desktop("PUT", "/api/cloud", { browserAccess: false });
    await until(() => !!socket.closed, 3000, "WsClose");
    expect(socket.closed).toEqual({ code: 1008, reason: "Browser access was turned off on this computer." });
    expect(socket.types.filter((t) => t === CloudFrame.WsClose)).toHaveLength(1);
    expect(hasComputerSubscribers("display:42")).toBe(false);
    await desktop("PUT", "/api/cloud", { browserAccess: true });
  });

  test("viewers may only watch", async () => {
    const socket = await cloud.socket({ user: VIEWER });
    socket.send({ type: "computer.subscribe", view: "display:43" });
    socket.send({ type: "ping" });
    await until(() => socket.of("pong").length === 1, 3000, "pong");
    expect(hasComputerSubscribers("display:43")).toBe(false);
    socket.close();
  });

  test("live frames are skipped while the client is behind; other events still go out", async () => {
    const socket = await cloud.socket();
    socket.grant = false;
    socket.send({ type: "computer.subscribe", view: "display:44" });
    await until(() => hasComputerSubscribers("display:44"), 3000, "the subscription");
    await Bun.sleep(30);
    const frame = (n: number): ServerEvent => ({ type: "computer.frame", view: "display:44", data: `${n}`.padEnd(600_000, "x"), mime: "image/jpeg", width: 1, height: 1, label: "" });
    for (let n = 0; n < 6; n++) bus.emit(frame(n));
    bus.changed("workspaces");
    await until(() => socket.of("entity.changed").some((m) => m.entity === "workspaces"), 3000, "the entity event");
    // 4 × 600 KB passes the 2 MiB window; the rest waits for nobody.
    const pictures = () => socket.of("computer.frame").filter((m) => m.data !== "");
    expect(pictures()).toHaveLength(4);

    // Once the cloud acknowledges (a ping behind the Window frame proves it arrived), frames flow again.
    socket.ack();
    socket.send({ type: "ping" });
    await until(() => socket.of("pong").length === 1, 3000, "pong");
    bus.emit(frame(9));
    await until(() => pictures().length === 5, 3000, "frames to flow again");
    socket.close();
  });

  test("a client far behind is closed with 1013", async () => {
    const socket = await cloud.socket();
    socket.grant = false;
    const big = "y".repeat(4 * 1024 * 1024);
    for (let n = 0; n < 5; n++) bus.emit({ type: "run.delta", runId: "run_1", conversationId: "cnv_1", messageId: "msg_1", blocks: [{ type: "text", text: big }] });
    await until(() => !!socket.closed, 5000, "WsClose");
    expect(socket.closed?.code).toBe(1013);
  });
});

describe("link lifecycle", () => {
  test("a link drop ends the old streams; a reused stream id after the reconnect gets only its own answer", async () => {
    const id = cloud.id();
    const seen: number[] = [];
    cloud.send(encodeCloudFrame(CloudFrame.ReqHead, id, { method: "GET", path: "/api/test/slow?ms=2500", headers: [], channel: "cloud", user: OWNER, ip: null, hasBody: false }));
    const started = Date.now();
    await Bun.sleep(100);
    const connects = cloud.connects;
    cloud.link!.close(1011, "Restarting");
    await until(() => cloud.connects > connects && cloudStatus().state === "online", 8000, "the reconnect");
    const off = cloud.on((f) => {
      if (f.stream === id) seen.push(f.type);
    });
    const reply = await cloud.request({ path: "/api/health" }, undefined, { id });
    expect(reply.json()).toEqual({ ok: true, name: "godmode-bot" });
    const after = seen.length;
    await Bun.sleep(Math.max(0, 2500 - (Date.now() - started)) + 400);
    off();
    expect(seen.length).toBe(after);
    expect(seen.filter((t) => t === CloudFrame.ResHead)).toHaveLength(1);
  });

  test("backoff rules", () => {
    expect(retryDelay(1006, 0, 0)).toBe(1000);
    expect(retryDelay(1011, 3, 0)).toBe(8000);
    expect(retryDelay(1006, 10, 0)).toBe(60_000);
    expect(retryDelay(CloudClose.Replaced, 0, 0)).toBe(30_000);
    expect(retryDelay(CloudClose.Replaced, 0, 2)).toBe(120_000);
    expect(retryDelay(CloudClose.Replaced, 0, 9)).toBe(300_000);
    expect(retryDelay(CloudClose.RateLimited, 4, 0)).toBe(60_000);
    expect(retryDelay(CloudClose.PlanRequired, 0, 0)).toBe(300_000);
    expect(retryDelay(CloudClose.Disabled, 0, 0)).toBe(300_000);
    expect(retryDelay(CloudClose.Protocol, 0, 0)).toBe(300_000);
  });

  test("Replaced: offline with a sentence, and no quick redial", async () => {
    const connects = cloud.connects;
    cloud.link!.close(CloudClose.Replaced, "Replaced");
    await until(() => cloudStatus().state === "offline", 3000, "offline");
    expect(cloudStatus().error).toBe(LINK_REPLACED);
    await Bun.sleep(1500);
    expect(cloud.connects).toBe(connects);
    await redial();
  });

  test("a protocol mismatch says to update", async () => {
    cloud.link!.close(CloudClose.Protocol, "Protocol");
    await until(() => cloudStatus().state === "offline", 3000, "offline");
    expect(cloudStatus().error).toBe(VERSION_MISMATCH);
    await redial();
  });

  test("blocked by the plan or turned off in the cloud: retried slowly", async () => {
    const connects = cloud.connects;
    cloud.link!.close(CloudClose.PlanRequired, "");
    await until(() => cloudStatus().state === "blocked", 3000, "blocked");
    expect(cloudStatus().error).toBe("Your Godmode Cloud plan doesn't include this computer right now.");
    await Bun.sleep(1500);
    expect(cloud.connects).toBe(connects);
    await redial();

    cloud.link!.close(CloudClose.Disabled, "An administrator turned this computer off.");
    await until(() => cloudStatus().state === "blocked", 3000, "blocked");
    expect(cloudStatus().error).toBe("An administrator turned this computer off.");
    await redial();
  });

  test("revoked: stops dialing, remembers it, and can be linked again", async () => {
    const connects = cloud.connects;
    cloud.link!.close(CloudClose.BadCredential, "Removed");
    await until(() => cloudStatus().state === "revoked", 3000, "revoked");
    expect(cloudStatus().error).toBe(LINK_REVOKED);
    expect(getMeta("cloud.revoked")).toBe("1");
    await Bun.sleep(1500);
    expect(cloud.connects).toBe(connects);
    expect(cloudLinkClient()).toBeNull();

    cloud.pollAnswer = { status: "approved", deviceId: DEVICE_ID, account: { email: "owner@example.com", name: "Owner" } };
    expect((await desktop("POST", "/api/cloud/link", { url: cloud.url })).data.state).toBe("linking");
    await waitOnline();
    expect(getMeta("cloud.revoked")).toBeNull();
    secret = readFileSync(join(dataDir, "cloud-link"), "utf8");
  });

  test("unlinking closes every cloud socket at once and tells the cloud", async () => {
    const socket = await cloud.socket();
    socket.send({ type: "computer.subscribe", view: "display:45" });
    await until(() => hasComputerSubscribers("display:45"), 3000, "the subscription");
    const status = await desktop("DELETE", "/api/cloud/link");
    expect(status.data).toMatchObject({ state: "unlinked", url: null, deviceId: null });
    expect(hasComputerSubscribers("display:45")).toBe(false);
    await until(() => cloud.link === null, 3000, "the link to close");
    await until(() => cloud.deletes.length === 1, 3000, "DELETE self");
    expect(cloud.deletes[0]).toBe(`Bearer ${DEVICE_ID}.${secret}`);
    expect(existsSync(join(dataDir, "cloud-link"))).toBe(false);
    expect(getMeta("cloud.url")).toBeNull();
    expect(getSettings().cloud.enabled).toBe(false);
    expect(get("SELECT id FROM audit_log WHERE action = 'cloud.unlink'")).not.toBeNull();
  });
});

describe("pairing through the gateway", () => {
  test("the https gateway is in the QR code and pairing works without Tailscale while the link is online", async () => {
    const before = await desktop<{ error: string }>("POST", "/api/mobile/pairing");
    expect(before.status).toBe(409);

    // An https cloud, reached through the fake.
    const wsBase = cloud.url.replace("http", "ws");
    const Redirect = function (url: string, options: { headers: Record<string, string> }) {
      return new WebSocket(url.replace("wss://cloud.example.test", wsBase), options as never);
    } as unknown as CloudWebSocketCtor;
    setCloudTransportOverride({ WebSocket: Redirect });
    writeLinkSecret("gml_https-link-secret");
    saveLink({ url: "https://cloud.example.test", deviceId: DEVICE_ID, account: { email: "owner@example.com", name: null }, linkedAt: new Date().toISOString() });
    updateSettings({ cloud: { enabled: true } });
    await waitOnline();
    const gateway = `https://cloud.example.test/gw/${DEVICE_ID}`;

    const res = await desktop<MobilePairingOffer>("POST", "/api/mobile/pairing");
    expect(res.status).toBe(201);
    expect(res.data.urls).toEqual([gateway]);
    const payload = parsePairingLink(res.data.link)!;
    expect(payload.urls).toEqual([gateway]);
    const status = await desktop<{ error: string | null; urls: string[] }>("GET", "/api/mobile");
    expect(status.data.error).toBeNull();

    const paired = await cloud.request({ method: "POST", path: "/api/mobile/pair", channel: "mobile", user: null }, JSON.stringify({ code: payload.code, name: "iPhone", platform: "ios" }));
    expect(paired.status).toBe(201);
    const { token: device } = paired.as<MobilePairResult>();
    const me = await cloud.request({ path: "/api/mobile/me", channel: "mobile", user: null, headers: [["authorization", `Bearer ${device}`]] });
    expect(me.as<MobileSession>().urls).toEqual([gateway]);

    // Turning phone access off in the cloud section takes the gateway away again.
    await desktop("PUT", "/api/cloud", { phoneAccess: false });
    expect((await desktop<{ urls: string[] }>("GET", "/api/mobile")).data.urls).toEqual([]);
    await desktop("PUT", "/api/cloud", { phoneAccess: true });
  });
});
