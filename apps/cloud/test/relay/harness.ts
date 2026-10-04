/**
 * Test harness for the relay: the custom server on a free port with a stand-in for Next, a fake computer speaking the
 * link protocol over a real WebSocket, and helpers for browser/phone clients and database fixtures.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import {
  CLOUD_CHUNK,
  CLOUD_PROTOCOL,
  CloudCredit,
  CloudFrame,
  CloudWindow,
  cloudBearer,
  cloudFrameJson,
  decodeCloudFrame,
  decodeCloudWindow,
  encodeCloudFrame,
  encodeCloudWindow,
  type CloudFrameData,
  type CloudFrameType,
  type CloudHello,
  type CloudReqHead,
  type CloudWelcome,
  type CloudWsClose,
  type CloudWsOpen,
} from "@godmode/shared";
import { createSession } from "@/server/auth/sessions";
import { newId, randomToken, sha256 } from "@/server/crypto";
import { db, devices, users } from "@/server/db";
import { registerRelayHub } from "@/server/relay-bridge";
import { bootstrapData } from "@/server/setup";
import { createCloudServer, type CloudServer } from "../../server/app";
import type { HubTimings } from "../../server/relay/hub";

/* ------------------------------------------------------------------ */
/* Dashboard build                                                      */
/* ------------------------------------------------------------------ */

// Must be set before the first config() call of the test file (config is cached).
const uiRoot = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), "godmode-cloud-ui-"));
export const UI_DIR = path.join(uiRoot, "dist-cloud");
process.env.GODMODE_UI_DIR = UI_DIR;

export const INDEX_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><script type="module" src="/ui/assets/app-1a2b.js"></script></head><body><div id="root"></div></body></html>';

export function writeUiBuild(index: string | null = INDEX_HTML): void {
  mkdirSync(path.join(UI_DIR, "assets"), { recursive: true });
  writeFileSync(path.join(UI_DIR, "assets/app-1a2b.js"), "console.log('app');");
  writeFileSync(path.join(UI_DIR, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(path.join(UI_DIR, "version.json"), JSON.stringify({ version: "9.8.7" }));
  writeFileSync(path.join(uiRoot, "secret.txt"), "outside the build");
  if (index !== null) writeFileSync(path.join(UI_DIR, "index.html"), index);
}

export const PUBLIC_URL = "http://localhost:3210";

/* ------------------------------------------------------------------ */
/* Server                                                               */
/* ------------------------------------------------------------------ */

export interface Running extends CloudServer {
  port: number;
}

export async function startCloud(timings?: HubTimings): Promise<Running> {
  const cloud = createCloudServer({
    dev: false,
    version: "1.2.3",
    timings,
    nextHandler: (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ next: true, url: req.url, peer: req.headers["x-godmode-peer"] ?? null }));
    },
  });
  await new Promise<void>((resolve) => cloud.server.listen(0, "127.0.0.1", resolve));
  return { ...cloud, port: (cloud.server.address() as AddressInfo).port };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

export interface TestUser {
  id: string;
  email: string;
  cookie: string;
  token: string;
}

export async function makeUser(email: string, roleId = "role_member"): Promise<TestUser> {
  const id = newId("usr");
  await db.insert(users).values({ id, email, name: email.split("@")[0]!, roleId });
  const { token } = await createSession(id, { ip: null, userAgent: null });
  return { id, email, token, cookie: `gmc_session=${token}` };
}

export interface TestDevice {
  id: string;
  secret: string;
  bearer: string;
}

export async function makeDevice(userId: string, patch: Partial<typeof devices.$inferInsert> = {}): Promise<TestDevice> {
  const id = newId("dvc");
  const secret = `gml_${randomToken(32)}`;
  await db.insert(devices).values({ id, userId, name: "Studio Mac", instanceId: `gm_${id}`, secretHash: sha256(secret), ...patch });
  return { id, secret, bearer: cloudBearer(id, secret) };
}

/** Roles, settings rows, plans; and the hub registered again (truncateAll clears shared state). */
export async function baseline(cloud?: Running): Promise<void> {
  await bootstrapData();
  if (cloud) registerRelayHub(cloud.hub);
}

/* ------------------------------------------------------------------ */
/* Waiting                                                              */
/* ------------------------------------------------------------------ */

export async function until<T>(check: () => T | undefined | null | false, timeoutMs = 5_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Fake computer                                                        */
/* ------------------------------------------------------------------ */

export interface FakeRequest {
  id: number;
  head: CloudReqHead;
  chunks: Buffer[];
  received: number;
  ended: boolean;
  aborted: boolean;
  /** Credit for our response body. */
  window: CloudWindow;
  credit: CloudCredit;
}

export interface FakeSocket {
  id: number;
  open: CloudWsOpen;
  messages: { binary: boolean; data: Buffer }[];
  closed: CloudWsClose | null;
  aborted: boolean;
  granted: number;
}

export class FakeComputer {
  readonly frames: CloudFrameData[] = [];
  readonly requests = new Map<number, FakeRequest>();
  readonly sockets = new Map<number, FakeSocket>();
  welcome: CloudWelcome | null = null;
  closeEvent: { code: number; reason: string } | null = null;
  /** Grant request-body credit as soon as bytes arrive. Off: the test grants by hand. */
  autoGrant = true;
  /** Called on every ReqHead. */
  onRequest: ((req: FakeRequest) => void) | null = null;
  /** Called on every WsOpen; default: accept. */
  onSocket: ((sock: FakeSocket) => void) | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const frame = decodeCloudFrame(new Uint8Array(data));
      if (!frame) return;
      const copy = { ...frame, payload: new Uint8Array(frame.payload) };
      this.frames.push(copy);
      this.handle(copy);
    });
    ws.on("close", (code, reason) => {
      this.closeEvent = { code, reason: reason.toString() };
    });
    ws.on("error", () => {});
  }

  static async dial(port: number, authorization: string | null, headers: Record<string, string> = {}): Promise<FakeComputer> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/v1/connect`, {
      headers: { ...(authorization ? { authorization } : {}), ...headers },
    });
    const computer = new FakeComputer(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("close", () => resolve());
    });
    return computer;
  }

  /** Dials, says Hello and waits for Welcome. */
  static async connect(port: number, device: TestDevice, hello: Partial<CloudHello> = {}): Promise<FakeComputer> {
    const computer = await FakeComputer.dial(port, `Bearer ${device.bearer}`);
    computer.hello(hello);
    await until(() => computer.welcome || computer.closeEvent, 5_000, "Welcome");
    if (!computer.welcome) throw new Error(`Link refused: ${JSON.stringify(computer.closeEvent)}`);
    return computer;
  }

  hello(patch: Partial<CloudHello> = {}): void {
    this.send(CloudFrame.Hello, 0, {
      protocol: CLOUD_PROTOCOL,
      version: "0.1.0",
      instanceId: "gm_test",
      name: "Studio Mac",
      platform: "darwin",
      browserAccess: true,
      phoneAccess: true,
      ...patch,
    });
  }

  send(type: CloudFrameType, stream: number, payload?: Uint8Array | string | object | null): void {
    this.ws.send(encodeCloudFrame(type, stream, payload));
  }

  async closed(): Promise<{ code: number; reason: string }> {
    return until(() => this.closeEvent, 5_000, "link close");
  }

  framesOf(type: number, stream?: number): CloudFrameData[] {
    return this.frames.filter((f) => f.type === type && (stream === undefined || f.stream === stream));
  }

  async nextRequest(timeoutMs = 5_000): Promise<FakeRequest> {
    const seen = new Set(this.requests.keys());
    return until(() => [...this.requests.values()].find((r) => !seen.has(r.id)), timeoutMs, "ReqHead");
  }

  async request(index = 0): Promise<FakeRequest> {
    return until(() => [...this.requests.values()][index], 5_000, "ReqHead");
  }

  async socket(index = 0): Promise<FakeSocket> {
    return until(() => [...this.sockets.values()][index], 5_000, "WsOpen");
  }

  /** ResHead, the body in windowed chunks, ResEnd. */
  async respond(req: FakeRequest, status: number, headers: [string, string][] = [], body: Buffer | string = ""): Promise<void> {
    this.send(CloudFrame.ResHead, req.id, { status, headers });
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    for (let offset = 0; offset < bytes.byteLength; offset += CLOUD_CHUNK) {
      const part = bytes.subarray(offset, offset + CLOUD_CHUNK);
      await req.window.take(part.byteLength);
      this.send(CloudFrame.ResBody, req.id, part);
    }
    this.send(CloudFrame.ResEnd, req.id);
  }

  grant(req: FakeRequest, bytes: number): void {
    this.ws.send(encodeCloudWindow(req.id, bytes));
  }

  private handle(frame: CloudFrameData): void {
    switch (frame.type) {
      case CloudFrame.Welcome:
        this.welcome = cloudFrameJson<CloudWelcome>(frame);
        return;
      case CloudFrame.Ping:
        this.send(CloudFrame.Pong, 0);
        return;
      case CloudFrame.ReqHead: {
        const req: FakeRequest = {
          id: frame.stream,
          head: cloudFrameJson<CloudReqHead>(frame)!,
          chunks: [],
          received: 0,
          ended: false,
          aborted: false,
          window: new CloudWindow(),
          credit: new CloudCredit(),
        };
        this.requests.set(req.id, req);
        this.onRequest?.(req);
        return;
      }
      case CloudFrame.ReqBody: {
        const req = this.requests.get(frame.stream);
        if (!req) return;
        req.chunks.push(Buffer.from(frame.payload));
        req.received += frame.payload.byteLength;
        if (this.autoGrant) {
          const grant = req.credit.consumed(frame.payload.byteLength);
          if (grant) this.grant(req, grant);
        }
        return;
      }
      case CloudFrame.ReqEnd: {
        const req = this.requests.get(frame.stream);
        if (req) req.ended = true;
        return;
      }
      case CloudFrame.Window: {
        this.requests.get(frame.stream)?.window.grant(decodeCloudWindow(frame));
        const sock = this.sockets.get(frame.stream);
        if (sock) sock.granted += decodeCloudWindow(frame);
        return;
      }
      case CloudFrame.Abort: {
        const req = this.requests.get(frame.stream);
        if (req) {
          req.aborted = true;
          req.window.close();
        }
        const sock = this.sockets.get(frame.stream);
        if (sock) sock.aborted = true;
        return;
      }
      case CloudFrame.WsOpen: {
        const sock: FakeSocket = { id: frame.stream, open: cloudFrameJson<CloudWsOpen>(frame)!, messages: [], closed: null, aborted: false, granted: 0 };
        this.sockets.set(sock.id, sock);
        if (this.onSocket) this.onSocket(sock);
        else this.send(CloudFrame.WsAccept, sock.id);
        return;
      }
      case CloudFrame.WsText:
      case CloudFrame.WsBinary: {
        this.sockets.get(frame.stream)?.messages.push({ binary: frame.type === CloudFrame.WsBinary, data: Buffer.from(frame.payload) });
        return;
      }
      case CloudFrame.WsClose: {
        const sock = this.sockets.get(frame.stream);
        if (sock) sock.closed = cloudFrameJson<CloudWsClose>(frame);
        return;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Clients                                                              */
/* ------------------------------------------------------------------ */

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: () => any;
}

export function call(
  port: number,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: Buffer | string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path: pathname, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data, text: data.toString(), json: () => JSON.parse(data.toString()) });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Headers a same-origin fetch() from the dashboard sends. */
export function browserHeaders(user: TestUser, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: user.cookie, origin: PUBLIC_URL, "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty", ...extra };
}

export function openClient(port: number, pathname: string, headers: Record<string, string>): Promise<{ ws: WebSocket; status: number | null }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers });
    ws.once("open", () => resolve({ ws, status: null }));
    ws.once("unexpected-response", (_req, res) => {
      resolve({ ws, status: res.statusCode ?? 0 });
      res.resume();
    });
    ws.on("error", () => resolve({ ws, status: -1 }));
  });
}
