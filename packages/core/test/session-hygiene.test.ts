import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { authenticate, getAccessToken, setDashboardPassword } from "../src/server/auth";
import { clientCount, websocketHandler, type WsData } from "../src/server/ws";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { childEnv } from "../src/util";

let dataDir: string;
let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-session-hygiene-"));
  loadConfig({ dataDir, token: "hygiene-token" });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  app = createApp();
  token = getAccessToken();
});

afterAll(() => {
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("childEnv", () => {
  test("drops every GODMODE_* variable and adds extras", () => {
    const saved = { ...process.env };
    try {
      process.env.GODMODE_TOKEN = "secret";
      process.env.GODMODE_HOME = "/somewhere";
      process.env.godmode_lower = "also";
      process.env.HYGIENE_KEEP = "kept";
      const env = childEnv({ PATH: "/custom/bin", EXTRA: "1" });
      expect(env.GODMODE_TOKEN).toBeUndefined();
      expect(env.GODMODE_HOME).toBeUndefined();
      expect(env.godmode_lower).toBeUndefined();
      expect(env.HYGIENE_KEEP).toBe("kept");
      expect(env.PATH).toBe("/custom/bin");
      expect(env.EXTRA).toBe("1");
      expect(Object.keys(childEnv()).some((k) => k.toUpperCase().startsWith("GODMODE_"))).toBe(false);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("query-string token", () => {
  test("is ignored for normal API routes", async () => {
    const withQuery = await app.request(`http://127.0.0.1/api/vault/status?token=${token}`);
    expect(withQuery.status).toBe(401);
    const status = await app.request(`http://127.0.0.1/api/auth/status?token=${token}`);
    expect(((await status.json()) as { authenticated: boolean }).authenticated).toBe(false);
    const withHeader = await app.request("http://127.0.0.1/api/vault/status", { headers: { authorization: `Bearer ${token}` } });
    expect(withHeader.status).toBe(200);
  });

  test("is accepted for the WebSocket upgrade path only", () => {
    const shim = (url: string) =>
      ({
        req: {
          header: () => undefined,
          query: (n: string) => new URL(url).searchParams.get(n) ?? undefined,
          raw: new Request(url),
          url,
        },
      }) as never;
    expect(authenticate(shim(`http://127.0.0.1/api/ws?token=${token}`))).toBe("token");
    expect(authenticate(shim("http://127.0.0.1/api/ws?token=wrong"))).toBeNull();
    expect(authenticate(shim(`http://127.0.0.1/api/wsx?token=${token}`))).toBeNull();
  });
});

describe("session cookie Secure flag", () => {
  const login = (headers: Record<string, string> = {}) =>
    app.request("http://127.0.0.1/api/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ token }),
    });

  test("X-Forwarded-Proto: https only counts with remote access on", async () => {
    try {
      let res = await login({ "x-forwarded-proto": "https" });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).not.toContain("Secure");

      updateSettings({ server: { remoteAccess: true } });
      res = await login({ "x-forwarded-proto": "https" });
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("Secure");

      res = await login({ "x-forwarded-proto": "http" });
      expect(res.headers.get("set-cookie")).not.toContain("Secure");
    } finally {
      updateSettings({ server: { remoteAccess: false } });
    }
  });
});

describe("dashboard password change", () => {
  test("closes WebSockets that authenticated with a session cookie", () => {
    const closed: string[] = [];
    const fake = (id: string, auth: "token" | "session") =>
      ({
        data: { id, subscriptions: new Set<string>(), auth },
        send: () => 0,
        close: (code: number) => void closed.push(`${id}:${code}`),
      }) as unknown as ServerWebSocket<WsData>;
    const bySession = fake("ws_session", "session");
    const byToken = fake("ws_token", "token");
    const before = clientCount();
    websocketHandler.open(bySession);
    websocketHandler.open(byToken);
    expect(clientCount()).toBe(before + 2);

    setDashboardPassword("a brand new dashboard password");
    expect(closed).toEqual(["ws_session:4001"]);
    expect(clientCount()).toBe(before + 1);

    websocketHandler.close(bySession);
    websocketHandler.close(byToken);
    expect(clientCount()).toBe(before);
  });
});
