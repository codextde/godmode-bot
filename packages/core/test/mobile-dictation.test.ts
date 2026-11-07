import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePairingLink, type DictationStatus, type MobilePairingOffer, type MobilePairResult } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { websocketHandler } from "../src/server/ws";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { mobileUrls, startMobileAccess, stopMobileAccess } from "../src/mobile/access";
import { deviceMayCall } from "../src/mobile/scope";
import { setTailscaleOverride } from "../src/mobile/tailscale";
import * as vault from "../src/vault/vault";

let dataDir: string;
let app: ReturnType<typeof createApp>;
let token: string;
let base: string;

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-mobile-dictation-"));
  loadConfig({ dataDir, token: "mobile-dictation-token" });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  vault.lock();
  await vault.setup("correct horse battery staple", false);
  app = createApp();
  token = getAccessToken();
  setTailscaleOverride({ installed: true, running: true, ip: "127.0.0.1", dnsName: "localhost", tailnet: "me@example.com", detail: null });
  updateSettings({ mobile: { enabled: false, port: 0 } });
  startMobileAccess({ app, websocket: websocketHandler });
});

afterAll(() => {
  stopMobileAccess();
  setTailscaleOverride(null);
  vault.lock();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

async function pair(): Promise<string> {
  const res = await app.request("http://127.0.0.1/api/mobile/pairing", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(201);
  const payload = parsePairingLink(((await res.json()) as MobilePairingOffer).link)!;
  base = mobileUrls()[1]!;
  const claimed = await fetch(`${base}/api/mobile/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: payload.code, name: "Dictating iPhone", platform: "ios" }),
  });
  expect(claimed.status).toBe(201);
  return ((await claimed.json()) as MobilePairResult).token;
}

test("a phone asks whether the computer writes its recordings down, and nothing more of voice", () => {
  expect(deviceMayCall("GET", "/api/voice/dictation")).toBe(true);
  expect(deviceMayCall("POST", "/api/voice/transcribe")).toBe(true);
  for (const [method, path] of [
    ["POST", "/api/voice/dictation"],
    ["PUT", "/api/voice/dictation"],
    ["GET", "/api/voice/dictation/x"],
    ["GET", "/api/voice/transcribe"],
    ["GET", "/api/voice/hex"],
    ["POST", "/api/voice/hex/prepare"],
    ["POST", "/api/voice/speak"],
  ] as const) {
    expect(deviceMayCall(method, path)).toBe(false);
  }
});

test("the phone learns up front which recordings the computer writes down", async () => {
  const device = await pair();
  const status = async () => {
    const res = await fetch(`${base}/api/voice/dictation`, { headers: { authorization: `Bearer ${device}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as DictationStatus;
  };

  // The desktop's default: its window's own speech recognition, which a phone can't use.
  expect(await status()).toEqual({ provider: "browser", ready: false, formats: ["wav", "m4a"] });
  updateSettings({ voice: { sttProvider: "openai" } });
  expect((await status()).ready).toBe(false);
  vault.setAppSecret("openai_api_key", "sk-test");
  expect(await status()).toEqual({ provider: "openai", ready: true, formats: ["wav", "m4a"] });
  updateSettings({ voice: { sttProvider: "browser" } });
  expect((await status()).ready).toBe(true);
  vault.setAppSecret("openai_api_key", null);

  // Hex reads WAV only, and only once it is there with its model.
  updateSettings({ voice: { sttProvider: "hex", hexPath: join(dataDir, "missing", "Hex.app") } });
  expect(await status()).toEqual({ provider: "hex", ready: false, formats: ["wav"] });

  // What the phone then uploads anyway is refused before it is read.
  const form = new FormData();
  form.set("audio", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "speech.wav");
  const dictated = await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { authorization: `Bearer ${device}` }, body: form });
  expect(dictated.status).toBe(400);
  expect(((await dictated.json()) as { code: string }).code).toBe("voice_not_set_up");
});
