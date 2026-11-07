import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { deviceBodyKeys, deviceMayCall } from "../src/mobile/scope";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { resetSettingsCache } from "../src/services/settings";
import { generatePassword } from "../src/vault/credentials";

/** The vault's password generator for the phone app (it has no secure random source): full-access phones and the desktop only. */

let dir: string;
let app: ReturnType<typeof createApp>;
let token: string;

function generate(body: unknown) {
  return app.request("http://127.0.0.1/api/vault/generate-password", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  setLogLevel("error");
  dir = mkdtempSync(join(tmpdir(), "godmode-generate-password-"));
  loadConfig({ dataDir: dir, token: "generate-password-token" });
  openDb(join(dir, "test.db"));
  resetSettingsCache();
  app = createApp();
  token = getAccessToken();
});

afterAll(() => {
  closeDb();
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("password generator", () => {
  test("makes a password of the asked length with every kind asked for and no look-alikes", async () => {
    const res = await generate({ length: 32, numbers: true, symbols: true });
    expect(res.status).toBe(200);
    const { password } = (await res.json()) as { password: string };
    expect(password).toHaveLength(32);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
    expect(password).not.toMatch(/[Il1O0o]/);
  });

  test("leaves out numbers and symbols when asked, defaults to 20 characters", async () => {
    const letters = ((await (await generate({ length: 40, numbers: false, symbols: false })).json()) as { password: string }).password;
    expect(letters).toMatch(/^[A-Za-z]{40}$/);
    const plain = ((await (await generate({})).json()) as { password: string }).password;
    expect(plain).toHaveLength(20);
    expect(new Set(Array.from({ length: 20 }, () => generatePassword(16))).size).toBe(20);
  });

  test("refuses lengths outside 8 to 128", async () => {
    expect((await generate({ length: 7 })).status).toBe(400);
    expect((await generate({ length: 129 })).status).toBe(400);
    expect((await generate({ length: 12.5 })).status).toBe(400);
  });

  test("agents' sign-up passwords keep every character kind", () => {
    const password = generatePassword();
    expect(password).toHaveLength(24);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
  });

  test("a limited phone may not call it, its neighbours stay as they were", () => {
    expect(deviceMayCall("POST", "/api/vault/generate-password")).toBe(false);
    expect(deviceBodyKeys("POST", "/api/vault/generate-password")).toBeNull();
    expect(deviceMayCall("POST", "/api/vault/lock")).toBe(true);
    expect(deviceMayCall("POST", "/api/vault/unlock")).toBe(false);
    expect(deviceMayCall("POST", "/api/vault/grant")).toBe(false);
  });
});
