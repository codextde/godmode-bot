import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodePairingLink,
  isPhoneUrlAllowed,
  parsePairingLink,
  type MobilePairingOffer,
  type MobilePairResult,
  type MobileSession,
  type MobileStatus,
  type ServerEvent,
} from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { websocketHandler } from "../src/server/ws";
import { bus } from "../src/events/bus";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { mobileUrls, refreshMobileAccess, startMobileAccess, stopMobileAccess } from "../src/mobile/access";
import { PAIRING_TTL_MS } from "../src/mobile/devices";
import { deviceMayCall } from "../src/mobile/scope";
import { parseTailscaleStatus, setTailscaleOverride } from "../src/mobile/tailscale";

let dataDir: string;
let app: ReturnType<typeof createApp>;
let token: string;
let base: string;

const TAILNET = { installed: true, running: true, ip: "127.0.0.1", dnsName: "localhost", tailnet: "me@example.com", detail: null };

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-mobile-"));
  loadConfig({ dataDir, token: "mobile-test-token" });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  app = createApp();
  token = getAccessToken();
  setTailscaleOverride(TAILNET);
  updateSettings({ mobile: { enabled: false, port: 0 } });
  startMobileAccess({ app, websocket: websocketHandler });
});

afterAll(() => {
  stopMobileAccess();
  setTailscaleOverride(null);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

function desktop(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return app.request(`http://127.0.0.1${path}`, { ...init, headers });
}

function phone(path: string, init: RequestInit & { bearer?: string; host?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  if (init.host) headers.set("host", init.host);
  return fetch(`${base}${path}`, { ...init, headers });
}

async function pair(name = "Daniel's iPhone"): Promise<MobilePairResult> {
  const res = await desktop("/api/mobile/pairing", { method: "POST" });
  expect(res.status).toBe(201);
  const offer = (await res.json()) as MobilePairingOffer;
  const payload = parsePairingLink(offer.link)!;
  const claimed = await phone("/api/mobile/pair", { method: "POST", body: JSON.stringify({ code: payload.code, name, platform: "ios", model: "iPhone 17 Pro" }) });
  expect(claimed.status).toBe(201);
  return (await claimed.json()) as MobilePairResult;
}

describe("pairing links", () => {
  test("round-trip, including names that aren't ASCII", () => {
    const payload = { v: 1 as const, id: "gm_1", name: "MacBook von Jürgen 🚀", urls: ["http://mac.tail1.ts.net:7787", "http://100.64.0.1:7787"], code: "abc_DEF-123", exp: 1_900_000_000 };
    const link = encodePairingLink(payload);
    expect(link.startsWith("godmode://pair?d=")).toBe(true);
    expect(parsePairingLink(link)).toEqual(payload);
    expect(parsePairingLink(`  ${link}\n`)).toEqual(payload);
    expect(parsePairingLink(link.slice(link.indexOf("=") + 1))).toEqual(payload);
  });

  test("only send the phone's key to Tailscale addresses or over https", () => {
    expect(isPhoneUrlAllowed("http://macbook.tail1234.ts.net:7787")).toBe(true);
    expect(isPhoneUrlAllowed("http://100.107.229.102:7787")).toBe(true);
    expect(isPhoneUrlAllowed("https://gateway.example.com")).toBe(true);
    expect(isPhoneUrlAllowed("http://192.168.1.10:7787")).toBe(false);
    expect(isPhoneUrlAllowed("http://100.128.0.1:7787")).toBe(false);
    expect(isPhoneUrlAllowed("http://evil.example.com:7787")).toBe(false);
    expect(isPhoneUrlAllowed("http://ts.net.evil.com")).toBe(false);
    expect(isPhoneUrlAllowed("https://user:pw@gateway.example.com")).toBe(false);
  });

  test("reject other codes", () => {
    expect(parsePairingLink("https://example.com/#abc")).toBeNull();
    expect(parsePairingLink("godmode://pair?d=not-json")).toBeNull();
    expect(parsePairingLink("godmode://settings?d=abc")).toBeNull();
    const bad = encodePairingLink({ v: 1, id: "x", name: "x", urls: ["javascript:alert(1)"], code: "c", exp: 1 });
    expect(parsePairingLink(bad)).toBeNull();
  });
});

describe("tailscale status", () => {
  test("reads the CLI's JSON", () => {
    const status = parseTailscaleStatus({
      BackendState: "Running",
      Self: { DNSName: "macbook.tailb8ef5.ts.net.", TailscaleIPs: ["100.107.229.102", "fd7a:115c:a1e0::1"], UserID: 7 },
      User: { "7": { LoginName: "daniel@example.com" } },
    });
    expect(status).toEqual({ installed: true, running: true, ip: "100.107.229.102", dnsName: "macbook.tailb8ef5.ts.net", tailnet: "daniel@example.com", detail: null });
  });

  test("explains why it can't be used", () => {
    expect(parseTailscaleStatus({ BackendState: "NeedsLogin" })).toMatchObject({ running: false, ip: null, detail: "Sign in to Tailscale on this computer." });
    expect(parseTailscaleStatus({ BackendState: "Stopped", Self: { TailscaleIPs: ["100.100.1.1"] } }).running).toBe(false);
  });
});

describe("device scope", () => {
  test("opens what the app uses and nothing else", () => {
    expect(deviceMayCall("GET", "/api/conversations")).toBe(true);
    expect(deviceMayCall("POST", "/api/conversations/conv_1/messages")).toBe(true);
    expect(deviceMayCall("POST", "/api/runs/run_1/cancel")).toBe(true);
    expect(deviceMayCall("GET", "/api/vms/vm_1/screenshot")).toBe(true);
    expect(deviceMayCall("POST", "/api/vms/vm_1/start")).toBe(true);
    expect(deviceMayCall("POST", "/api/vms/vm_1/exec")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/vms/vm_1")).toBe(false);
    expect(deviceMayCall("GET", "/api/credentials")).toBe(false);
    expect(deviceMayCall("POST", "/api/credentials/c1/reveal")).toBe(false);
    expect(deviceMayCall("GET", "/api/totp/codes")).toBe(false);
    expect(deviceMayCall("PUT", "/api/settings")).toBe(false);
    expect(deviceMayCall("POST", "/api/backup/export")).toBe(false);
    expect(deviceMayCall("GET", "/api/mobile")).toBe(false);
    expect(deviceMayCall("POST", "/api/mobile/pairing")).toBe(false);
    expect(deviceMayCall("GET", "/api/agents/a1/file")).toBe(false);
    expect(deviceMayCall("GET", "/api/folders")).toBe(false);
  });
});

describe("phone access", () => {
  test("is off until a phone is paired, and a QR code turns it on", async () => {
    const status = (await (await desktop("/api/mobile")).json()) as MobileStatus;
    expect(status.enabled).toBe(false);
    expect(status.urls).toEqual([]);

    const res = await desktop("/api/mobile/pairing", { method: "POST" });
    expect(res.status).toBe(201);
    const offer = (await res.json()) as MobilePairingOffer;
    expect(offer.urls.length).toBe(2);
    expect(offer.urls[0]).toMatch(/^http:\/\/localhost:\d+$/);
    base = mobileUrls()[1]!;
    const payload = parsePairingLink(offer.link)!;
    expect(payload.urls).toEqual(offer.urls);
    expect(payload.exp * 1000).toBeGreaterThan(Date.now());

    const after = (await (await desktop("/api/mobile")).json()) as MobileStatus;
    expect(after.enabled).toBe(true);
    expect(after.error).toBeNull();
  });

  test("the code works once and gives the phone its own token", async () => {
    const events: ServerEvent[] = [];
    const off = bus.on((e) => events.push(e));
    const offer = (await (await desktop("/api/mobile/pairing", { method: "POST" })).json()) as MobilePairingOffer;
    const { code } = parsePairingLink(offer.link)!;
    const body = JSON.stringify({ code, name: "Pixel", platform: "android" });
    const first = await phone("/api/mobile/pair", { method: "POST", body });
    expect(first.status).toBe(201);
    const result = (await first.json()) as MobilePairResult;
    expect(result.token.startsWith("gmd_")).toBe(true);
    expect(result.device).toMatchObject({ name: "Pixel", platform: "android", lastAddress: "127.0.0.1" });
    expect(events.some((e) => e.type === "mobile.paired" && e.device.id === result.device.id)).toBe(true);
    off();

    const again = await phone("/api/mobile/pair", { method: "POST", body });
    expect(again.status).toBe(401);
    expect(((await again.json()) as { code: string }).code).toBe("pairing_invalid");

    const me = await phone("/api/mobile/me", { bearer: result.token });
    expect(me.status).toBe(200);
    const session = (await me.json()) as MobileSession;
    expect(session.device.id).toBe(result.device.id);
    expect(session.instance.id).toBe(parsePairingLink(offer.link)!.id);
  });

  test("an expired code is refused", async () => {
    const offer = (await (await desktop("/api/mobile/pairing", { method: "POST" })).json()) as MobilePairingOffer;
    const { code } = parsePairingLink(offer.link)!;
    setSystemTime(new Date(Date.now() + PAIRING_TTL_MS + 1000));
    try {
      const res = await phone("/api/mobile/pair", { method: "POST", body: JSON.stringify({ code, name: "Late", platform: "ios" }) });
      expect(res.status).toBe(401);
    } finally {
      setSystemTime();
    }
  });

  test("phones only reach what the app needs", async () => {
    const { token: device } = await pair();
    expect((await phone("/api/conversations", { bearer: device })).status).toBe(200);
    expect((await phone("/api/agents", { bearer: device })).status).toBe(200);
    const secrets = await phone("/api/vault/secrets", { bearer: device });
    expect(secrets.status).toBe(403);
    expect(((await secrets.json()) as { code: string }).code).toBe("device_forbidden");
    expect((await phone("/api/mobile", { bearer: device })).status).toBe(403);
    expect((await phone("/api/mobile/pairing", { bearer: device, method: "POST" })).status).toBe(403);
    // Device tokens only work on the phones' listener.
    expect((await app.request("http://127.0.0.1/api/conversations", { headers: { authorization: `Bearer ${device}` } })).status).toBe(401);
  });

  test("phones can't widen what a chat or an automation may do", async () => {
    const { token: device } = await pair("Scoped");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });
    const widen = await phone("/api/conversations/cnv_missing", json("PATCH", { workingDirectory: "/" }));
    expect(widen.status).toBe(403);
    expect(((await widen.json()) as { code: string }).code).toBe("device_forbidden");
    expect((await phone("/api/conversations/cnv_missing", json("PATCH", { pinned: true }))).status).toBe(404);
    expect((await phone("/api/chat", json("POST", { content: "hi", computerTarget: { kind: "desktop" } }))).status).toBe(403);
    expect((await phone("/api/routines/rtn_missing", json("PATCH", { prompt: "rm -rf" }))).status).toBe(403);
    const screen = await phone("/api/computer/input", json("POST", { view: "display:1", event: { type: "click", x: 1, y: 1 } }));
    expect(screen.status).toBe(403);
    expect(((await screen.json()) as { error: string }).error).toMatch(/shared in a chat/);
  });

  test("the phones' listener refuses everything but paired phones", async () => {
    expect((await phone("/api/conversations", { bearer: token })).status).toBe(401);
    expect((await phone("/api/conversations")).status).toBe(401);
    expect((await phone("/api/conversations", { bearer: "gmd_forged-token-value-000000000000" })).status).toBe(401);
    expect((await phone("/api/auth/status")).status).toBe(404);
    expect((await phone("/api/%61uth/status")).status).toBe(404);
    expect((await phone("/api/%61uth/token", { method: "POST", body: JSON.stringify({ token }) })).status).toBe(404);
    expect((await phone("/")).status).toBe(404);
    expect((await phone("/mcp")).status).toBe(404);
    expect((await phone("/api/health", { host: "evil.example.com" })).status).toBe(403);
    const health = await phone("/api/health");
    expect(health.status).toBe(200);
    expect(((await health.json()) as { instance: string }).instance).toMatch(/^gm_/);
  });

  test("streams events to the phone and cuts it off when it is removed", async () => {
    const { token: device, device: info } = await pair("Removable");
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/ws`, { headers: { authorization: `Bearer ${device}` } } as never);
    const messages: ServerEvent[] = [];
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("message", (e) => {
        messages.push(JSON.parse(String(e.data)));
        resolve();
      });
      ws.addEventListener("error", () => reject(new Error("socket error")));
    });
    expect(messages[0]?.type).toBe("hello");

    ws.send(JSON.stringify({ type: "conversation.subscribe", conversationId: "conv_open" }));
    await Bun.sleep(30);
    const delta = (conversationId: string): ServerEvent => ({ type: "run.delta", runId: "run_1", conversationId, messageId: "msg_1", blocks: [{ type: "text", text: conversationId }] });
    bus.emit(delta("conv_elsewhere"));
    bus.emit(delta("conv_open"));
    await Bun.sleep(50);
    const deltas = messages.filter((m) => m.type === "run.delta") as Extract<ServerEvent, { type: "run.delta" }>[];
    expect(deltas.map((d) => d.conversationId)).toEqual(["conv_open"]);

    const status = (await (await desktop("/api/mobile")).json()) as MobileStatus;
    expect(status.devices.find((d) => d.id === info.id)?.online).toBe(true);

    expect((await desktop(`/api/mobile/devices/${info.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await closed).toBe(4003);
    expect((await phone("/api/conversations", { bearer: device })).status).toBe(401);
  });

  test("a phone can unpair itself", async () => {
    const { token: device } = await pair("Leaving");
    expect((await phone("/api/mobile/me", { bearer: device, method: "DELETE" })).status).toBe(200);
    expect((await phone("/api/mobile/me", { bearer: device })).status).toBe(401);
  });

  test("turning phone access off stops the listener and voids the code", async () => {
    const offer = (await (await desktop("/api/mobile/pairing", { method: "POST" })).json()) as MobilePairingOffer;
    const res = await desktop("/api/mobile", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    const late = await app.request("http://127.0.0.1/api/mobile/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: parsePairingLink(offer.link)!.code, name: "Late", platform: "ios" }),
    });
    expect(late.status).toBe(401);
    const status = (await res.json()) as MobileStatus;
    expect(status.enabled).toBe(false);
    expect(status.urls).toEqual([]);
    await expect(fetch(`${base}/api/health`)).rejects.toThrow();

    setTailscaleOverride({ installed: true, running: false, ip: null, dnsName: null, tailnet: null, detail: "Sign in to Tailscale on this computer." });
    const refused = await desktop("/api/mobile/pairing", { method: "POST" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("Sign in to Tailscale on this computer.");
    setTailscaleOverride(TAILNET);
    await refreshMobileAccess();
  });
});
