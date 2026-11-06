import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePairingLink, type Agent, type MobilePairingOffer, type MobilePairResult } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { websocketHandler } from "../src/server/ws";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { mobileUrls, startMobileAccess, stopMobileAccess } from "../src/mobile/access";
import { setTailscaleOverride } from "../src/mobile/tailscale";
import * as vault from "../src/vault/vault";

/** What a paired phone reads of the vault, an agent's folder, integrations and servers (track V): never a secret. */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let dataDir: string;
let app: ReturnType<typeof createApp>;
let token: string;
let base: string;
let device: string;

function desktop(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return app.request(`http://127.0.0.1${path}`, { ...init, headers });
}

function phone(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${device}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

const send = (method: string, body: unknown = {}): RequestInit => ({ method, body: JSON.stringify(body) });

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-mobile-readonly-"));
  loadConfig({ dataDir, token: "mobile-readonly-token" });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  app = createApp();
  token = getAccessToken();
  setTailscaleOverride({ installed: true, running: true, ip: "127.0.0.1", dnsName: "localhost", tailnet: "me@example.com", detail: null });
  updateSettings({ mobile: { enabled: false, port: 0 } });
  startMobileAccess({ app, websocket: websocketHandler });
  await vault.setup("correct horse battery staple", false);

  const offer = (await (await desktop("/api/mobile/pairing", { method: "POST" })).json()) as MobilePairingOffer;
  base = mobileUrls()[1]!;
  const payload = parsePairingLink(offer.link)!;
  const res = await fetch(`${base}/api/mobile/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: payload.code, name: "Track V", platform: "ios" }) });
  device = ((await res.json()) as MobilePairResult).token;
});

afterAll(() => {
  stopMobileAccess();
  setTailscaleOverride(null);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a phone reads without secrets", () => {
  test("logins, 2FA and cards: lists only, never a reveal", async () => {
    const login = (await (await desktop("/api/credentials", send("POST", { name: "Shop", url: "https://shop.example.com/login?token=t0k3n", username: "daniel", password: "hunter2-secret", notes: "PIN 4711" }))).json()) as { id: string };
    const listed = await phone("/api/credentials");
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).not.toMatch(/hunter2-secret|4711|t0k3n/);
    expect(JSON.parse(text)).toEqual([expect.objectContaining({ id: login.id, username: "daniel", hasPassword: true, url: "https://shop.example.com/login" })]);
    expect((await phone(`/api/credentials/${login.id}`)).status).toBe(403);
    expect((await phone("/api/credentials?search=t0k3n")).status).toBe(403);
    expect((await phone("/api/cards?search=Daniel")).status).toBe(403);
    expect((await phone(`/api/credentials/${login.id}/reveal`, send("POST"))).status).toBe(403);

    await desktop("/api/totp", send("POST", { issuer: "Shop", accountName: "daniel", secret: "JBSWY3DPEHPK3PXP" }));
    const totp = await (await phone("/api/totp")).text();
    expect(totp).toContain("Shop");
    expect(totp).not.toMatch(/JBSWY3DPEHPK3PXP/);
    expect((await phone("/api/totp/codes")).status).toBe(403);

    const card = (await (await desktop("/api/cards", send("POST", { name: "Company Visa", number: "4242 4242 4242 4242", expMonth: 12, expYear: 2031, cvc: "123", holderName: "Daniel E", limitMonthly: 50_000 }))).json()) as { id: string };
    const cards = await (await phone("/api/cards")).text();
    expect(cards).not.toMatch(/4242424242424242|2031|Daniel E/);
    expect(JSON.parse(cards)).toEqual([expect.objectContaining({ id: card.id, last4: "4242", limitMonthly: 50_000, expMonth: 0, expYear: 0 })]);
    expect((await phone(`/api/cards/${card.id}/reveal`, send("POST"))).status).toBe(403);
    expect((await phone("/api/card-purchases?limit=50")).status).toBe(200);
    expect((await phone("/api/vault/secrets")).status).toBe(403);
    const mac = (await (await phone("/api/vault/mac-password")).json()) as { recent: unknown[] };
    expect(mac.recent).toEqual([]);
  });

  test("integrations and servers without commands, keys or passwords", async () => {
    await desktop("/api/mcp-servers", send("POST", { name: "Linear", transport: "stdio", command: "npx", args: ["linear-mcp", "--token", "lin_secret_1"], env: { LINEAR_API_KEY: "lin_secret_2" } }));
    await desktop("/api/mcp-servers", send("POST", { name: "Remote", transport: "http", url: "https://mcp.example.com/u/abc123secret/mcp?key=k_secret_3" }));
    const servers = await (await phone("/api/mcp-servers")).text();
    expect(servers).not.toMatch(/npx|lin_secret|LINEAR_API_KEY|abc123secret|k_secret_3/);
    expect(JSON.parse(servers)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Linear", transport: "stdio", command: "" }), expect.objectContaining({ name: "Remote", url: "https://mcp.example.com" })]),
    );

    await desktop("/api/api-tools", send("POST", { name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "AIza_secret_4", docs: "Send x-goog-api-key", envVar: "GEMINI_API_KEY" }));
    const tools = await (await phone("/api/api-tools")).text();
    expect(tools).not.toMatch(/AIza_secret_4|x-goog-api-key|GEMINI_API_KEY|v1beta/);
    expect(JSON.parse(tools)).toEqual([expect.objectContaining({ name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com", hasKey: true })]);

    const ssh = (await (await desktop("/api/ssh/servers", send("POST", { name: "Web", host: "127.0.0.1", port: 1, username: "deploy", auth: "password", password: "ssh_secret_5" }))).json()) as { id: string };
    const listed = await (await phone("/api/ssh/servers")).text();
    expect(listed).not.toContain("ssh_secret_5");
    expect(JSON.parse(listed)).toEqual([expect.objectContaining({ id: ssh.id, host: "127.0.0.1", username: "deploy", hasPassword: true })]);
    const tested = await phone(`/api/ssh/servers/${ssh.id}/test`, send("POST"));
    expect(tested.status).toBe(200);
    expect(((await tested.json()) as { ok: boolean }).ok).toBe(false);
    expect((await phone(`/api/ssh/servers/${ssh.id}/test`, send("POST", { command: "id" }))).status).toBe(403);
    expect((await phone(`/api/ssh/servers/${ssh.id}/exec`, send("POST", { command: "id" }))).status).toBe(403);

    expect((await phone("/api/mods")).status).toBe(200);
    expect((await phone("/api/mods/mod_missing", send("PATCH", { enabled: false }))).status).toBe(404);
    expect((await phone("/api/mods/mod_missing", send("PATCH", { enabled: true }))).status).toBe(403);
    expect((await phone("/api/mods/mod_missing", send("PATCH", { enabled: false, digest: "x" }))).status).toBe(403);
    expect((await phone("/api/messaging")).status).toBe(200);
    expect((await phone("/api/composio/connections")).status).toBe(200);
  });

  test("an agent's folder: browsed and previewed, never left", async () => {
    const agent = (await (await desktop("/api/agents", send("POST", { name: "Filer" }))).json()) as Agent;
    const ws = join(agent.repoPath, "workspace");
    mkdirSync(join(ws, "keys"), { recursive: true });
    writeFileSync(join(ws, "report.md"), "# Report\n");
    writeFileSync(join(ws, "shot.png"), PNG);
    writeFileSync(join(ws, ".env"), "OPENAI_API_KEY=sk-secret\n");
    writeFileSync(join(ws, "keys", "deploy.pem"), "-----BEGIN PRIVATE KEY-----\n");
    symlinkSync(join(ws, ".env"), join(ws, "settings.md"));
    const outside = mkdtempSync(join(tmpdir(), "godmode-outside-"));
    writeFileSync(join(outside, "secret.png"), PNG);
    symlinkSync(outside, join(ws, "elsewhere"));
    const files = `/api/agents/${agent.id}`;

    const listed = (await (await phone(`${files}/files?path=workspace`)).json()) as { path: string }[];
    const names = listed.map((f) => f.path);
    expect(names).toEqual(expect.arrayContaining(["workspace/report.md", "workspace/shot.png", "workspace/keys"]));
    expect(names).not.toContain("workspace/.env");
    expect(names).not.toContain("workspace/elsewhere");
    expect(((await (await phone(`${files}/files?path=workspace/keys`)).json()) as unknown[]).length).toBe(0);
    expect((await phone(`${files}/files`)).status).toBe(200);
    expect(((await (await phone(`${files}/file?path=workspace/report.md`)).json()) as { content: string }).content).toBe("# Report\n");

    const raw = await phone(`${files}/files/raw?path=workspace/shot.png`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(PNG);
    expect((await phone(`${files}/files/raw?path=workspace/report.md`)).status).toBe(415);

    for (const path of ["workspace/.env", "workspace/keys/deploy.pem", "workspace/settings.md", "workspace/elsewhere/secret.png", "../../etc/passwd", "/etc/passwd", ".git/config", "workspace%2F..%2F..%2Fx"]) {
      for (const route of ["file", "files/raw"]) expect((await phone(`${files}/${route}?path=${path}`)).status).toBe(403);
    }
    expect((await phone(`${files}/file?path=workspace/report.md&path=workspace/.env`)).status).toBe(403);
    for (const path of ["%20workspace/.env", "workspace/.env%20", "workspace/.ENV", "workspace/id_r%C5%BFa"]) expect((await phone(`${files}/file?path=${path}`)).status).toBe(403);
    expect((await phone(`${files}/file?path=workspace/.env`, { method: "HEAD" })).status).toBe(403);
    // What a secondary forwards from its phones: the folder rule runs here, on this computer's files.
    const forwarded = { headers: { "x-godmode-phone": "1" } };
    expect((await desktop(`${files}/file?path=workspace/settings.md`, forwarded)).status).toBe(403);
    expect((await desktop(`${files}/file?path=workspace/.env`, forwarded)).status).toBe(403);
    expect((await desktop(`${files}/files/raw?path=workspace/elsewhere/secret.png`, forwarded)).status).toBe(403);
    expect((await desktop(`${files}/file?path=workspace/report.md`, forwarded)).status).toBe(200);
    expect((await desktop(`${files}/file?path=workspace/settings.md`)).status).toBe(200);
    const hits = (await (await phone(`${files}/files/search?q=secret`)).json()) as { path: string }[];
    expect(hits.map((h) => h.path).some((p) => p.includes(".env") || p.endsWith(".pem"))).toBe(false);
    expect((await phone(`${files}/files/delete`, send("POST", { paths: ["workspace/report.md"] }))).status).toBe(403);
    expect((await phone("/api/files/overview")).status).toBe(200);
    expect((await phone(`/api/files/image?path=${encodeURIComponent(join(outside, "secret.png"))}`)).status).toBe(403);
    rmSync(outside, { recursive: true, force: true });
  });

  test("locking the vault from the phone; unlocking stays on the computer", async () => {
    const locked = await phone("/api/vault/lock", send("POST"));
    expect(locked.status).toBe(200);
    expect(((await locked.json()) as { unlocked: boolean }).unlocked).toBe(false);
    expect(((await (await phone("/api/vault/status")).json()) as { unlocked: boolean }).unlocked).toBe(false);
    expect((await phone("/api/vault/lock", send("POST", { passphrase: "x" }))).status).toBe(403);
    expect((await phone("/api/vault/unlock", send("POST", { passphrase: "correct horse battery staple" }))).status).toBe(403);
    expect((await phone("/api/credentials")).status).toBe(200);
  });
});
