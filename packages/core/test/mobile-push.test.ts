import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePairingLink, type AppNotification, type MobileDevice, type MobilePairingOffer, type MobilePairResult, type MobileSession, type MobileStatus } from "@godmode/shared";
import { ensureDefaultAgent } from "../src/agents/service";
import { loadConfig } from "../src/config";
import { closeDb, get, openDb, run } from "../src/db";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { websocketHandler } from "../src/server/ws";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { notify } from "../src/services/notifications";
import { applyRunnerEvent } from "../src/remote/mirror";
import { mobileUrls, startMobileAccess, stopMobileAccess } from "../src/mobile/access";
import { deviceBodyKeys, deviceMayCall } from "../src/mobile/scope";
import { setTailscaleOverride } from "../src/mobile/tailscale";
import { EXPO_RECEIPTS_URL, EXPO_SEND_URL, checkReceipts, pushMessages, pushNotification, setPushFetch, startPush, stopPush, type PushMessage } from "../src/mobile/push";

let dataDir: string;
let app: ReturnType<typeof createApp>;
let token: string;
let base: string;

const TAILNET = { installed: true, running: true, ip: "127.0.0.1", dnsName: "localhost", tailnet: "me@example.com", detail: null };
const IOS_TOKEN = "ExponentPushToken[ios-aaaaaaaaaaaaaaaa]";
const ANDROID_TOKEN = "ExponentPushToken[android-bbbbbbbbbbbb]";

interface Call {
  url: string;
  body: unknown;
}
let calls: Call[] = [];
let answer: (call: Call, n: number) => Response | Promise<Response> = () => Response.json({ data: [] });

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-mobile-push-"));
  loadConfig({ dataDir, token: "mobile-push-token" });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  app = createApp();
  token = getAccessToken();
  setTailscaleOverride(TAILNET);
  updateSettings({ mobile: { enabled: false, port: 0 } });
  startMobileAccess({ app, websocket: websocketHandler });
  setPushFetch(async (url, init) => {
    const call = { url, body: JSON.parse(String(init.body)) };
    calls.push(call);
    return answer(call, calls.length);
  }, 5);
  startPush();
});

afterAll(() => {
  stopPush();
  setPushFetch(null);
  stopMobileAccess();
  setTailscaleOverride(null);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  calls = [];
  answer = () => Response.json({ data: [] });
});

function desktop(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return app.request(`http://127.0.0.1${path}`, { ...init, headers });
}

function phone(path: string, bearer: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

async function pair(name: string, platform: "ios" | "android" = "ios"): Promise<MobilePairResult> {
  const offer = (await (await desktop("/api/mobile/pairing", { method: "POST" })).json()) as MobilePairingOffer;
  base ??= mobileUrls()[1]!;
  const { code } = parsePairingLink(offer.link)!;
  const res = await fetch(`${base}/api/mobile/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, platform }) });
  expect(res.status).toBe(201);
  return (await res.json()) as MobilePairResult;
}

const register = (bearer: string, pushToken: string, platform = "ios") =>
  phone("/api/mobile/me/push", bearer, { method: "POST", body: JSON.stringify({ token: pushToken, platform }) });

const sent = (): PushMessage[] => calls.filter((c) => c.url === EXPO_SEND_URL).flatMap((c) => c.body as PushMessage[]);

/** Waits until the fire-and-forget sends of `notify` answered. */
async function settle() {
  for (let i = 0; i < 20; i++) await Bun.sleep(5);
}

function clearTokens() {
  run("UPDATE mobile_devices SET push_token = NULL");
}

describe("push notifications", () => {
  test("phones may switch their own notifications on and off, nothing next to it", () => {
    expect(deviceMayCall("POST", "/api/mobile/me/push")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/mobile/me/push")).toBe(true);
    expect(deviceBodyKeys("POST", "/api/mobile/me/push")).toEqual(["token", "platform"]);
    expect(deviceMayCall("GET", "/api/mobile/me/push")).toBe(false);
    expect(deviceMayCall("PUT", "/api/mobile/me/push")).toBe(false);
    expect(deviceMayCall("POST", "/api/mobile/me/push/test")).toBe(false);
    expect(deviceMayCall("POST", "/api/mobile/devices/dev_1/push")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/mobile/devices/dev_1/push")).toBe(false);
  });

  test("a phone registers its Expo token; answers only say whether it gets notifications", async () => {
    const { token: device, device: paired } = await pair("Push iPhone");
    expect(paired.push).toBe(false);

    const on = await register(device, IOS_TOKEN);
    expect(on.status).toBe(200);
    const session = (await on.json()) as MobileSession;
    expect(session.device.push).toBe(true);

    const me = await (await phone("/api/mobile/me", device)).text();
    expect(me).toContain('"push":true');
    expect(me).not.toContain("ExponentPushToken");
    const list = await (await desktop("/api/mobile")).text();
    expect(list).not.toContain("ExponentPushToken");
    const devices = ((JSON.parse(list) as MobileStatus).devices ?? []) as MobileDevice[];
    expect(devices.find((d) => d.id === paired.id)?.push).toBe(true);

    const off = await phone("/api/mobile/me/push", device, { method: "DELETE" });
    expect(off.status).toBe(200);
    expect(((await off.json()) as MobileSession).device.push).toBe(false);
  });

  test("refuses what isn't an Expo token, other fields and callers that aren't phones", async () => {
    const { token: device } = await pair("Picky");
    expect((await register(device, "not-a-token")).status).toBe(400);
    expect((await register(device, IOS_TOKEN, "windows")).status).toBe(400);
    const extra = await phone("/api/mobile/me/push", device, { method: "POST", body: JSON.stringify({ token: IOS_TOKEN, platform: "ios", deviceId: "dev_other" }) });
    expect(extra.status).toBe(403);
    const fromDesktop = await desktop("/api/mobile/me/push", { method: "POST", body: JSON.stringify({ token: IOS_TOKEN, platform: "ios" }) });
    expect(fromDesktop.status).toBe(400);
  });

  test("a token another phone had moves to the phone that registers it", async () => {
    clearTokens();
    const a = await pair("Old install");
    const b = await pair("New install");
    await register(a.token, IOS_TOKEN);
    await register(b.token, IOS_TOKEN);
    expect(get<{ c: number }>("SELECT COUNT(*) AS c FROM mobile_devices WHERE push_token = ?", IOS_TOKEN)?.c).toBe(1);
    expect(get<{ id: string }>("SELECT id FROM mobile_devices WHERE push_token = ?", IOS_TOKEN)?.id).toBe(b.device.id);
  });

  test("what the desktop notifies about goes to every phone with notifications on", async () => {
    clearTokens();
    const ios = await pair("iPhone", "ios");
    const android = await pair("Pixel", "android");
    await register(ios.token, IOS_TOKEN);
    await register(android.token, ANDROID_TOKEN, "android");
    calls = [];
    answer = () => Response.json({ data: [{ status: "ok", id: "r1" }, { status: "ok", id: "r2" }] });

    notify("question", "Mia asks: Which venue?", "Berlin · Munich", "/chat/cnv_push1");
    await settle();
    const messages = sent();
    expect(messages).toHaveLength(2);
    const toIos = messages.find((m) => m.to === IOS_TOKEN)!;
    const toAndroid = messages.find((m) => m.to === ANDROID_TOKEN)!;
    expect(toIos).toMatchObject({ title: "Mia asks: Which venue?", body: "Berlin · Munich", sound: "default", priority: "high", threadId: "chat:cnv_push1" });
    expect(toIos.data).toMatchObject({ kind: "question", url: "/chat/cnv_push1" });
    expect(toIos.collapseId).toBe(toIos.data.id);
    expect(typeof toIos.badge).toBe("number");
    expect(toIos.channelId).toBeUndefined();
    expect(toAndroid.channelId).toBe("default");
    expect(toAndroid.badge).toBeUndefined();
  });

  test("short text, a neutral one for private chats, threads per chat or task", async () => {
    const n: AppNotification = { id: "ntf_1", kind: "success", title: "t".repeat(400), body: `a\n\n${"b".repeat(1000)}`, link: "/tasks?task=tsk_9", read: false, createdAt: new Date().toISOString() };
    const [m] = pushMessages(n, [{ platform: "ios", token: IOS_TOKEN }], 3);
    expect(m!.title.length).toBeLessThanOrEqual(120);
    expect(m!.body.length).toBeLessThanOrEqual(240);
    expect(m!.body.startsWith("a b")).toBe(true);
    expect(m!.threadId).toBe("task:tsk_9");
    expect(m!.badge).toBe(3);
    expect(m!.priority).toBe("default");

    const agent = await ensureDefaultAgent();
    run("INSERT INTO conversations (id, agent_id, title, private, created_at, updated_at) VALUES ('cnv_private', ?, 'Secret plans', 1, datetime('now'), datetime('now'))", agent.id);
    const [p] = pushMessages({ ...n, kind: "question", title: "Mia asks: the PIN?", body: "1234", link: "/chat/cnv_private" }, [{ platform: "ios", token: IOS_TOKEN }], 0);
    expect(p!.title).not.toContain("PIN");
    expect(p!.body).toBe("");
    expect(p!.data.url).toBe("/chat/cnv_private");
  });

  test("sends in batches of 100", async () => {
    clearTokens();
    for (let i = 0; i < 150; i++) {
      run(
        "INSERT INTO mobile_devices (id, name, platform, token_hash, created_at, push_token) VALUES (?, ?, 'ios', ?, datetime('now'), ?)",
        `dev_bulk${i}`,
        `Bulk ${i}`,
        `hash_bulk${i}`,
        `ExponentPushToken[bulk-${String(i).padStart(10, "0")}]`,
      );
    }
    await pushNotification({ id: "ntf_bulk", kind: "info", title: "Hello", body: "", link: null, read: false, createdAt: new Date().toISOString() });
    const sends = calls.filter((c) => c.url === EXPO_SEND_URL);
    expect(sends.map((c) => (c.body as unknown[]).length)).toEqual([100, 50]);
    run("DELETE FROM mobile_devices WHERE id LIKE 'dev_bulk%'");
  });

  test("tries once more when Expo or the network fails, not for a refused request", async () => {
    clearTokens();
    const { token: device } = await pair("Retry");
    await register(device, IOS_TOKEN);
    const n: AppNotification = { id: "ntf_retry", kind: "error", title: "“Daily KPIs” failed", body: "", link: "/chat/cnv_x", read: false, createdAt: new Date().toISOString() };

    calls = [];
    answer = (_c, i) => (i === 1 ? new Response("busy", { status: 503 }) : Response.json({ data: [{ status: "ok", id: "r" }] }));
    await pushNotification(n);
    expect(calls).toHaveLength(2);

    calls = [];
    answer = () => {
      throw new Error("timed out");
    };
    await pushNotification(n);
    expect(calls).toHaveLength(2);

    calls = [];
    answer = () => Response.json({ errors: [{ code: "VALIDATION_ERROR" }] }, { status: 400 });
    await pushNotification(n);
    expect(calls).toHaveLength(1);
  });

  test("drops the token of a phone the app is gone from, in the ticket or the receipt", async () => {
    clearTokens();
    const ios = await pair("Gone", "ios");
    const android = await pair("Stays", "android");
    await register(ios.token, IOS_TOKEN);
    await register(android.token, ANDROID_TOKEN, "android");
    const n: AppNotification = { id: "ntf_gone", kind: "success", title: "Mia replied", body: "", link: null, read: false, createdAt: new Date().toISOString() };

    answer = (call) => {
      const batch = call.body as PushMessage[];
      return Response.json({
        data: batch.map((m) => (m.to === IOS_TOKEN ? { status: "error", message: `"${IOS_TOKEN}" is not a registered push notification recipient`, details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "rcpt_android" })),
      });
    };
    await pushNotification(n);
    expect(get<{ push_token: string | null }>("SELECT push_token FROM mobile_devices WHERE id = ?", ios.device.id)?.push_token).toBeNull();
    expect(get<{ push_token: string | null }>("SELECT push_token FROM mobile_devices WHERE id = ?", android.device.id)?.push_token).toBe(ANDROID_TOKEN);

    calls = [];
    answer = () => Response.json({ data: { rcpt_android: { status: "error", details: { error: "DeviceNotRegistered" } } } });
    await checkReceipts();
    expect(calls.map((c) => c.url)).toEqual([EXPO_RECEIPTS_URL]);
    expect((calls[0]!.body as { ids: string[] }).ids).toContain("rcpt_android");
    expect(get<{ push_token: string | null }>("SELECT push_token FROM mobile_devices WHERE id = ?", android.device.id)?.push_token).toBeNull();
  });

  test("a group computer's notifications are its own to push; a runner's are pushed here", async () => {
    clearTokens();
    const { token: device } = await pair("Group phone");
    await register(device, IOS_TOKEN);
    for (const [id, kind] of [
      ["run_group", "device"],
      ["run_plain", "runner"],
    ]) {
      run(
        "INSERT INTO runners (id, name, hostname, public_key, addresses, port, kind, created_at, updated_at) VALUES (?, ?, '', ?, '[]', 1, ?, datetime('now'), datetime('now'))",
        id,
        id,
        `key_${id}`,
        kind,
      );
    }
    calls = [];
    const event = (id: string) => ({ type: "notification", notification: { id, kind: "success", title: "Done", body: "", link: null, read: false, createdAt: new Date().toISOString() } });
    applyRunnerEvent("run_group", event("ntf_fromgroup") as never);
    applyRunnerEvent("run_plain", event("ntf_fromrunner") as never);
    await settle();
    expect(sent().map((m) => m.data.id)).toEqual(["ntf_fromrunner"]);
  });

  test("nothing goes out while phone access is off", async () => {
    clearTokens();
    const { token: device } = await pair("Off");
    await register(device, IOS_TOKEN);
    updateSettings({ mobile: { enabled: false } });
    try {
      calls = [];
      await pushNotification({ id: "ntf_off", kind: "info", title: "Hi", body: "", link: null, read: false, createdAt: new Date().toISOString() });
      expect(calls).toHaveLength(0);
    } finally {
      updateSettings({ mobile: { enabled: true } });
    }
  });
});
