import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MobilePairResult } from "@godmode/shared";

const REVIEW_CODE = "review-code-for-the-app-store-0001";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { websocketHandler } from "../src/server/ws";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { mobileStatus, mobileUrls, refreshMobileAccess, startMobileAccess, stopMobileAccess } from "../src/mobile/access";
import { setTailscaleOverride } from "../src/mobile/tailscale";

let dataDir: string;
let base: string;

beforeAll(async () => {
  process.env.GODMODE_PHONE_URL = "https://review.example.com";
  process.env.GODMODE_PHONE_HOST = "127.0.0.1";
  process.env.GODMODE_REVIEW_PAIRING_CODE = REVIEW_CODE;
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-mobile-review-"));
  loadConfig({ dataDir, token: "mobile-review-token" });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  setTailscaleOverride({ installed: false, running: false, ip: null, dnsName: null, tailnet: null, detail: "Tailscale isn't installed." });
  updateSettings({ mobile: { enabled: true, port: 0 } });
  startMobileAccess({ app: createApp(), websocket: websocketHandler });
  await refreshMobileAccess();
  const status = await mobileStatus();
  base = `http://127.0.0.1:${status.port}`;
});

afterAll(() => {
  delete process.env.GODMODE_PHONE_URL;
  delete process.env.GODMODE_PHONE_HOST;
  delete process.env.GODMODE_REVIEW_PAIRING_CODE;
  stopMobileAccess();
  setTailscaleOverride(null);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

function phone(path: string, init: RequestInit & { bearer?: string; host?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", init.host ?? "review.example.com");
  if (init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

test("a public server listens without Tailscale and only for its own host", async () => {
  expect(mobileUrls()).toEqual(["https://review.example.com"]);
  expect((await mobileStatus()).error).toBeNull();
  expect((await phone("/api/health")).status).toBe(200);
  expect((await phone("/api/health", { host: `127.0.0.1` })).status).toBe(403);
});

test("the review code pairs any number of phones, each with its own token", async () => {
  const body = (name: string) => JSON.stringify({ code: REVIEW_CODE, name, platform: "ios" });
  const first = (await (await phone("/api/mobile/pair", { method: "POST", body: body("iPad") })).json()) as MobilePairResult;
  const second = (await (await phone("/api/mobile/pair", { method: "POST", body: body("iPhone") })).json()) as MobilePairResult;
  expect(first.token).not.toBe(second.token);
  expect((await phone("/api/mobile/me", { bearer: first.token })).status).toBe(200);
  expect((await phone("/api/mobile/me", { bearer: second.token })).status).toBe(200);
  const wrong = await phone("/api/mobile/pair", { method: "POST", body: JSON.stringify({ code: `${REVIEW_CODE}x`, name: "x", platform: "ios" }) });
  expect(wrong.status).toBe(401);
});
