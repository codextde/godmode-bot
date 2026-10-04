import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { CloudRelayUser, CloudStatus, UsageSummary } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, insert, openDb, setMeta } from "../src/db";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { getSettings, resetSettingsCache, updateSettings } from "../src/services/settings";
import { createAgent } from "../src/agents/service";
import { createConversation } from "../src/services/conversations";
import { exportBackup } from "../src/backup/backup";
import { openWithPassphrase } from "../src/vault/crypto";
import { newId } from "../src/util";
import { cloudPathRefusal, cloudRefusal, isCloudRouteClassified, viewerMaySend } from "../src/cloud/scope";

let dataDir: string;
let app: ReturnType<typeof createApp>;
let token: string;

const OWNER: CloudRelayUser = { id: "usr_owner", email: "owner@example.com", name: null, role: "owner" };

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-cloud-scope-"));
  loadConfig({ dataDir, token: "cloud-scope-token" });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  app = createApp();
  token = getAccessToken();
  // Requests relayed by hand below need the link switched on (nothing dials: this computer isn't linked).
  updateSettings({ cloud: { enabled: true } });
});

afterAll(() => {
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as T };
}

/** A request as cloud/dispatch.ts hands it to the app. */
function relayed(method: string, path: string, user: CloudRelayUser = OWNER, body?: unknown) {
  return app.fetch(
    new Request(`http://cloud.link${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    { channel: "cloud", cloud: { user, ip: "203.0.113.9" } },
  );
}

describe("cloud route classification", () => {
  test("every /api route is classified, so a new route stays closed to the cloud until someone decides", () => {
    const missing: string[] = [];
    for (const route of app.routes) {
      if (!route.path.startsWith("/api/") || route.path.includes("*") || route.method === "ALL") continue;
      if (!isCloudRouteClassified(route.method, route.path)) missing.push(`${route.method} ${route.path}`);
    }
    expect(missing).toEqual([]);
  });

  test("runner management and the proxy to a runner stay on the computer", async () => {
    const body = async () => null;
    expect(await cloudRefusal("GET", "/api/runners", "owner", body)).toBeNull();
    for (const [method, path] of [
      ["GET", "/api/runners/run_1/proxy/computer/sources"],
      ["POST", "/api/runners/run_1/proxy/vault/unlock"],
      ["POST", "/api/runners/run_1/sync"],
      ["POST", "/api/link/exec"],
    ] as const) {
      expect(await cloudRefusal(method, path, "owner", body)).not.toBeNull();
    }
  });

  test("an unclassified route is refused", async () => {
    expect(isCloudRouteClassified("GET", "/api/brand-new")).toBe(false);
    expect(await cloudRefusal("GET", "/api/brand-new", "owner", async () => null)).toBe(
      "This can only be done in Godmode on the computer itself, not through Godmode Cloud.",
    );
    const res = await relayed("GET", "/api/brand-new");
    expect(res.status).toBe(403);
  });

  test("sign-in and pairing are refused before requireAuth; the status read is not", () => {
    expect(cloudPathRefusal("GET", "/api/auth/status")).toBeNull();
    expect(cloudPathRefusal("HEAD", "/api/auth/status")).toBeNull();
    expect(cloudPathRefusal("POST", "/api/auth/status")).not.toBeNull();
    expect(cloudPathRefusal("POST", "/api/auth/login")).not.toBeNull();
    expect(cloudPathRefusal("POST", "/api/mobile/pair")).not.toBeNull();
    expect(cloudPathRefusal("GET", "/api/bootstrap")).toBeNull();
  });

  test("viewer socket messages", () => {
    expect(viewerMaySend(JSON.stringify({ type: "ping" }))).toBe(true);
    expect(viewerMaySend(JSON.stringify({ type: "conversation.subscribe", conversationId: "cnv_1" }))).toBe(true);
    expect(viewerMaySend(JSON.stringify({ type: "browser.subscribe", profileId: "bpr_1", passive: true }))).toBe(true);
    expect(viewerMaySend(JSON.stringify({ type: "browser.subscribe", profileId: "bpr_1" }))).toBe(false);
    expect(viewerMaySend(JSON.stringify({ type: "computer.subscribe", view: "display:1" }))).toBe(false);
    expect(viewerMaySend(JSON.stringify({ type: "computer.unsubscribe", view: "display:1" }))).toBe(true);
    expect(viewerMaySend("not json")).toBe(false);
  });

  test("relayed requests never count as local and never use the token or the cookie", async () => {
    const conv = createConversation({ agentId: (await createAgent({ name: "Files Bot" })).id });
    const files = await relayed("POST", `/api/conversations/${conv.id}/files`, OWNER, { messages: [] });
    expect(files.status).toBe(200);
    expect(((await files.json()) as { local: boolean }).local).toBe(false);
    // Browser access off: the cloud channel is not signed in, whatever the request carries.
    updateSettings({ cloud: { browserAccess: false } });
    const res = await app.fetch(new Request("http://cloud.link/api/bootstrap", { headers: { authorization: `Bearer ${token}` } }), {
      channel: "cloud",
      cloud: { user: OWNER, ip: null },
    });
    expect(res.status).toBe(401);
    updateSettings({ cloud: { browserAccess: true } });
  });
});

describe("passphrase limiter", () => {
  test("relayed passphrase attempts share one bucket per channel, whatever address the cloud reports", async () => {
    updateSettings({ cloud: { allowSecrets: true } });
    const attempt = (n: number) =>
      app.fetch(
        new Request("http://cloud.link/api/vault/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passphrase: "guess" }) }),
        { channel: "cloud", cloud: { user: OWNER, ip: `198.51.100.${n}` } },
      );
    const statuses: number[] = [];
    for (let n = 1; n <= 11; n++) statuses.push((await attempt(n)).status);
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
    // The computer's own dashboard keeps its own bucket.
    expect((await call("POST", "/api/vault/unlock", { passphrase: "guess" })).status).not.toBe(429);
    updateSettings({ cloud: { allowSecrets: false } });
  });
});

describe("cloud settings on the computer", () => {
  test("PUT /api/settings validates the cloud group", async () => {
    expect((await call("PUT", "/api/settings", { cloud: { allowSecrets: "yes" } })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { cloud: { linkSecret: "gml_x" } })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { cloud: [] })).status).toBe(400);
    const ok = await call<{ cloud: { allowSecrets: boolean } }>("PUT", "/api/settings", { cloud: { allowSecrets: true } });
    expect(ok.status).toBe(200);
    expect(ok.data.cloud.allowSecrets).toBe(true);
    updateSettings({ cloud: { allowSecrets: false } });
  });

  test("PUT /api/cloud takes only the four switches and answers the status", async () => {
    expect((await call("PUT", "/api/cloud", { secret: "x" })).status).toBe(400);
    const res = await call<CloudStatus>("PUT", "/api/cloud", { phoneAccess: false });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ state: "unlinked", settings: { phoneAccess: false } });
    expect(getSettings().cloud.phoneAccess).toBe(false);
    updateSettings({ cloud: { phoneAccess: true } });
  });
});

describe("backup", () => {
  test("cloud state stays on the machine", async () => {
    setMeta("cloud.url", "https://cloud.example.com");
    setMeta("cloud.device_id", "dvc_AbCdEfGh12345678");
    updateSettings({ cloud: { enabled: true, allowSecrets: true } });
    const { data } = await exportBackup({ passphrase: "backup passphrase 123", includeAgentRepos: false });
    const entries = unzipSync(openWithPassphrase("backup passphrase 123", data));
    const tables = (JSON.parse(strFromU8(entries["db.json"]!)) as { tables: Record<string, { key: string }[]> }).tables;
    expect(tables.meta!.some((r) => r.key.startsWith("cloud."))).toBe(false);
    expect(tables.settings!.some((r) => r.key === "cloud")).toBe(false);
    updateSettings({ cloud: { enabled: false, allowSecrets: false } });
  });
});

describe("usage", () => {
  test("GET /api/usage sums the runs of the range in one query", async () => {
    const agent = await createAgent({ name: "Usage Bot" });
    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();
    const run = (createdAt: string, fields: Record<string, string | number | null>) =>
      insert("runs", { id: newId("run"), agent_id: agent.id, conversation_id: "cnv_usage", trigger: "manual", status: "completed", prompt: "x", created_at: createdAt, ...fields });
    const usage = JSON.stringify({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 });
    run(day(0), { model: "claude-opus", cost_usd: 0.5, duration_ms: 1000, num_turns: 3, usage });
    run(day(0), { model: "claude-opus", cost_usd: 0.5, duration_ms: 2000, num_turns: 1, usage });
    run(day(1), { model: null, cost_usd: 0.25, duration_ms: 500, num_turns: 2, usage: null });
    run(day(2), { model: "claude-sonnet", cost_usd: null, duration_ms: null, num_turns: null, usage: "not json" });
    run(day(40), { model: "claude-opus", cost_usd: 9, duration_ms: 9, num_turns: 9, usage });

    const res = await call<UsageSummary>("GET", "/api/usage?days=30");
    expect(res.status).toBe(200);
    const u = res.data;
    expect(u).toMatchObject({ runs: 4, costUsd: 1.25, durationMs: 3500, turns: 6, tokens: { input: 200, output: 100, cacheRead: 20, cacheWrite: 10 } });
    expect(u.byDay).toHaveLength(30);
    expect(u.byDay.at(-1)).toEqual({ day: day(0).slice(0, 10), runs: 2, costUsd: 1 });
    expect(u.byDay.at(-2)).toEqual({ day: day(1).slice(0, 10), runs: 1, costUsd: 0.25 });
    expect(u.byModel).toEqual([
      { model: "claude-opus", runs: 2, costUsd: 1 },
      { model: "unknown", runs: 1, costUsd: 0.25 },
      { model: "claude-sonnet", runs: 1, costUsd: 0 },
    ]);
    expect(Date.parse(u.from)).toBeLessThan(Date.parse(u.to));

    expect((await call<UsageSummary>("GET", "/api/usage")).data.byDay).toHaveLength(30);
    expect((await call<UsageSummary>("GET", "/api/usage?days=365")).data.runs).toBe(5);
    expect((await call("GET", "/api/usage?days=0")).status).toBe(400);
    expect((await call("GET", "/api/usage?days=366")).status).toBe(400);
    expect((await call("GET", "/api/usage?days=abc")).status).toBe(400);
  });
});
