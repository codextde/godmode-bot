import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { closeDb, openDb, run } from "../src/db";
import { ensureDefaultAgent } from "../src/agents/service";
import { createConversation } from "../src/services/conversations";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { websocketHandler } from "../src/server/ws";
import { bus } from "../src/events/bus";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { mobileUrls, refreshMobileAccess, startMobileAccess, stopMobileAccess } from "../src/mobile/access";
import { PAIRING_TTL_MS } from "../src/mobile/devices";
import { PHONE_CLEANUP, deviceBodyKeys, deviceBodyRefusal, deviceMayCall, deviceQueryRefusal } from "../src/mobile/scope";
import { deviceView } from "../src/mobile/views";
import { RECOMMENDED } from "../src/services/cleanup";
import { reportMissingLogin } from "../src/services/missingLogins";
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
  let known = "";
  beforeAll(async () => {
    known = (await ensureDefaultAgent()).id;
  });

  test("opens what the app uses and nothing else", () => {
    expect(deviceMayCall("GET", "/api/conversations")).toBe(true);
    expect(deviceMayCall("POST", "/api/conversations/conv_1/messages")).toBe(true);
    expect(deviceMayCall("POST", "/api/runs/run_1/cancel")).toBe(true);
    expect(deviceMayCall("GET", "/api/vms/vm_1/screenshot")).toBe(true);
    expect(deviceMayCall("POST", "/api/vms/vm_1/start")).toBe(true);
    expect(deviceMayCall("POST", "/api/vms/vm_1/input")).toBe(true);
    expect(deviceMayCall("POST", "/api/browser/profiles/bp_1/launch")).toBe(true);
    expect(deviceMayCall("POST", "/api/browser/profiles/bp_1/stop")).toBe(true);
    expect(deviceMayCall("POST", "/api/vms/vm_1/exec")).toBe(false);
    expect(deviceMayCall("GET", "/api/android/devices")).toBe(true);
    expect(deviceMayCall("GET", "/api/android/devices/adr_1/screenshot")).toBe(true);
    expect(deviceMayCall("POST", "/api/android/devices/adr_1/input")).toBe(true);
    expect(deviceBodyKeys("POST", "/api/android/devices/adr_1/input")).toEqual(["event", "frame"]);
    for (const action of ["exec", "assign", "disconnect", "input/raw"]) expect(deviceMayCall("POST", `/api/android/devices/adr_1/${action}`)).toBe(false);
    for (const action of ["connect", "refresh", "install"]) expect(deviceMayCall("POST", `/api/android/${action}`)).toBe(false);
    expect(deviceMayCall("POST", "/api/android/devices/adr_1/../adr_2/input")).toBe(false);
    expect(deviceMayCall("GET", "/api/android/devices/adr_1/input")).toBe(false);
    expect(deviceMayCall("PATCH", "/api/android/devices/adr_1")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/android/devices/adr_1")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/vms/vm_1")).toBe(false);
    expect(deviceMayCall("GET", "/api/credentials")).toBe(true);
    expect(deviceMayCall("POST", "/api/credentials/c1/reveal")).toBe(false);
    expect(deviceMayCall("GET", "/api/totp/codes")).toBe(false);
    expect(deviceMayCall("PUT", "/api/settings")).toBe(true);
    expect(deviceMayCall("PUT", "/api/vault/settings")).toBe(false);
    expect(deviceMayCall("POST", "/api/backup/export")).toBe(false);
    expect(deviceMayCall("GET", "/api/mobile")).toBe(false);
    expect(deviceMayCall("POST", "/api/mobile/pairing")).toBe(false);
    expect(deviceMayCall("GET", "/api/agents/a1/file")).toBe(true);
    expect(deviceMayCall("GET", "/api/folders")).toBe(false);
    expect(deviceMayCall("GET", "/api/tasks")).toBe(true);
    expect(deviceMayCall("POST", "/api/tasks")).toBe(true);
    expect(deviceMayCall("PATCH", "/api/tasks/tsk_1")).toBe(true);
    expect(deviceMayCall("POST", "/api/tasks/tsk_1/messages")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/tasks/tsk_1")).toBe(true);
    expect(deviceMayCall("POST", "/api/tasks/tsk_1/approve")).toBe(true);
    expect(deviceMayCall("PATCH", "/api/conversations/conv_1/followup")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/conversations/conv_1/followup")).toBe(true);
    expect(deviceMayCall("POST", "/api/conversations/conv_1/followup/run")).toBe(true);
    expect(deviceMayCall("GET", "/api/followups")).toBe(true);
    expect(deviceMayCall("POST", "/api/conversations/read")).toBe(true);
    expect(deviceMayCall("GET", "/api/goals")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/goals/gol_1")).toBe(true);
    expect(deviceMayCall("GET", "/api/runs/run_1")).toBe(true);
    expect(deviceMayCall("GET", "/api/runs/run_1/log")).toBe(true);
    expect(deviceMayCall("GET", "/api/away")).toBe(true);
    expect(deviceMayCall("POST", "/api/routines")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/routines/rtn_1")).toBe(true);
    expect(deviceMayCall("GET", "/api/routines/rtn_1/events")).toBe(true);
    expect(deviceMayCall("POST", "/api/routines/rtn_1/test-event")).toBe(false);
    expect(deviceMayCall("POST", "/api/routines/rtn_1/webhook/rotate")).toBe(false);
    expect(deviceMayCall("GET", "/api/agents/a1/heartbeat")).toBe(true);
    expect(deviceMayCall("POST", "/api/agents/a1/dreams")).toBe(true);
    expect(deviceMayCall("GET", "/api/dreams/drm_1")).toBe(true);
    expect(deviceMayCall("POST", "/api/dreams/drm_1/revert")).toBe(false);
    expect(deviceMayCall("GET", "/api/conversations/conv_1/messages")).toBe(true);
    expect(deviceMayCall("GET", "/api/conversations/conv_1/messages/msg_1/images/toolu_1")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/conversations/conv_1/messages/msg_1")).toBe(false);
    expect(deviceMayCall("POST", "/api/tasks/attachments")).toBe(true);
    expect(deviceMayCall("GET", "/api/tasks/attachments/tat_1/shot.png")).toBe(true);
    expect(deviceMayCall("GET", "/api/files/image")).toBe(false);
    expect(deviceMayCall("POST", "/api/workspaces")).toBe(true);
    expect(deviceMayCall("PATCH", "/api/projects/prj_1")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/agents/a1")).toBe(true);
    expect(deviceMayCall("GET", "/api/agents/a1/commands")).toBe(true);
    expect(deviceMayCall("GET", "/api/models")).toBe(true);
    expect(deviceMayCall("PATCH", "/api/conversations/conv_1/queue/qmsg_1")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/conversations/conv_1/queue/qmsg_1")).toBe(true);
    expect(deviceMayCall("POST", "/api/conversations/conv_1/queue/send")).toBe(true);
    expect(deviceMayCall("PATCH", "/api/agents/a1")).toBe(true);
    expect(deviceMayCall("PUT", "/api/agents/a1/file")).toBe(true);
    expect(deviceMayCall("GET", "/api/agents/a1/memory")).toBe(true);
    expect(deviceMayCall("PUT", "/api/agents/a1/memory")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/agents/a1/memory")).toBe(false);
  });

  test("searches, dictates and keeps a paused chat going, nothing next to it", () => {
    expect(deviceMayCall("PATCH", "/api/conversations/cnv_1/pause")).toBe(true);
    expect(deviceMayCall("PUT", "/api/conversations/cnv_1/pause")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/conversations/cnv_1/pause")).toBe(false);
    expect(deviceMayCall("PATCH", "/api/conversations/cnv_1/continue")).toBe(false);
    expect(deviceMayCall("GET", "/api/search")).toBe(true);
    expect(deviceMayCall("POST", "/api/search")).toBe(false);
    expect(deviceMayCall("GET", "/api/search/notes")).toBe(false);
    for (const method of ["GET", "HEAD"]) {
      expect(deviceQueryRefusal(method, "/api/search", new URLSearchParams({ q: "invoice" }))).toMatch(/notes/);
      expect(deviceQueryRefusal(method, "/api/search", new URLSearchParams({ q: "invoice", notes: "0" }))).toBeNull();
    }
    expect(deviceMayCall("POST", "/api/voice/transcribe")).toBe(true);
    expect(deviceMayCall("POST", "/api/voice/speak")).toBe(false);
    expect(deviceMayCall("GET", "/api/voice/hex")).toBe(false);
    expect(deviceMayCall("POST", "/api/voice/hex/prepare")).toBe(false);
    expect(deviceMayCall("POST", "/api/conversations/cnv_1/share")).toBe(false);
    expect(deviceMayCall("POST", "/api/conversations/import")).toBe(false);
  });

  test("shows pictures attached to a chat, nothing else of it", () => {
    expect(deviceMayCall("GET", "/api/conversations/cnv_1/attachment")).toBe(true);
    expect(deviceMayCall("HEAD", "/api/conversations/cnv_1/attachment")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/conversations/cnv_1/attachment")).toBe(false);
    expect(deviceMayCall("POST", "/api/conversations/cnv_1/attachment")).toBe(false);
    expect(deviceMayCall("GET", "/api/conversations/cnv_1/attachments")).toBe(false);
    expect(deviceMayCall("GET", "/api/conversations/cnv_1/attachment/x")).toBe(false);
    expect(deviceMayCall("GET", "/api/conversations/cnv_1/files")).toBe(false);
  });

  test("manages agents and teams, and of an agent's files writes only its notes", () => {
    expect(deviceMayCall("GET", "/api/team-templates")).toBe(true);
    expect(deviceMayCall("POST", "/api/team-templates/back-office/install")).toBe(true);
    expect(deviceMayCall("POST", "/api/team-templates/back-office")).toBe(false);
    for (const action of ["pause", "continue", "run", "duplicate"]) expect(deviceMayCall("POST", `/api/agents/a1/${action}`)).toBe(true);
    expect(deviceMayCall("POST", "/api/agents/a1/move")).toBe(false);
    expect(deviceMayCall("GET", "/api/agents/a1/commits")).toBe(true);
    expect(deviceMayCall("GET", "/api/agents/a1/files")).toBe(true);
    for (const sub of ["sizes", "review", "notes", "deleted"]) expect(deviceMayCall("GET", `/api/agents/a1/files/${sub}`)).toBe(false);
    for (const sub of ["folder", "move", "delete", "inspect"]) expect(deviceMayCall("POST", `/api/agents/a1/files/${sub}`)).toBe(false);
    expect(deviceMayCall("DELETE", "/api/agents/a1/files/deleted")).toBe(false);
    expect(deviceMayCall("GET", "/api/files/overview")).toBe(true);
    expect(deviceBodyKeys("POST", "/api/team-templates/back-office/install")).toEqual(["workspaceId", "newWorkspace", "automations", "timezone", "skip"]);
    expect(deviceBodyKeys("POST", "/api/agents/a1/run")).toEqual(["prompt", "workspaceId"]);
    expect(deviceBodyKeys("POST", "/api/agents/a1/duplicate")).toEqual([]);
    expect(deviceBodyKeys("PUT", "/api/agents/a1/file")).toEqual(["path", "content", "create"]);
    const query = (path: string) => deviceQueryRefusal("GET", `/api/agents/${known}/file`, new URLSearchParams({ path }));
    // Reading covers the agent's whole folder (track V); writing stays under memory/.
    for (const path of ["memory", "memory/people.md", "./memory/a/b.md", "memory//x.md", "", ".", "MEMORY.md", "CLAUDE.md", "memoryx/a.md"]) expect(query(path)).toBeNull();
    for (const path of ["memory/../CLAUDE.md", "memory/..", "/etc/passwd", "memory\\..\\CLAUDE.md", "C:/x", ".git/config"]) {
      expect(query(path)).toMatch(/agent's folder/);
    }
    expect(deviceQueryRefusal("GET", `/api/agents/${known}/files`, new URLSearchParams())).toBeNull();
    expect(deviceBodyRefusal("PUT", `/api/agents/${known}/file`, { path: "memory/x.md", content: "" })).toBeNull();
    expect(deviceBodyRefusal("PUT", `/api/agents/${known}/file`, { path: "CLAUDE.md", content: "" })).toMatch(/memory\//);
    expect(deviceBodyRefusal("PUT", `/api/agents/${known}/file`, { content: "" })).toMatch(/memory\//);
    // An agent the check can't find is one whose folder it can't check.
    expect(deviceQueryRefusal("GET", "/api/agents/agt_missing/files", new URLSearchParams())).toMatch(/no such agent/);
    expect(deviceBodyRefusal("PUT", "/api/agents/agt_missing/file", { path: "memory/x.md", content: "" })).toMatch(/no such agent/);
  });

  test("reads passwords, files, integrations, plugins, messaging and servers without their secrets", () => {
    for (const path of ["/api/vault/status", "/api/vault/mac-password", "/api/credentials", "/api/totp", "/api/passkeys", "/api/cards", "/api/card-purchases", "/api/ssh/key-manager"]) {
      expect(deviceMayCall("GET", path)).toBe(true);
    }
    expect(deviceMayCall("POST", "/api/vault/lock")).toBe(true);
    expect(deviceBodyKeys("POST", "/api/vault/lock")).toEqual([]);
    for (const [method, path] of [
      ["POST", "/api/vault/unlock"],
      ["POST", "/api/vault/grant"],
      ["POST", "/api/vault/setup"],
      ["POST", "/api/vault/remember"],
      ["POST", "/api/vault/passphrase"],
      ["PUT", "/api/vault/mac-password"],
      ["DELETE", "/api/vault/mac-password"],
      ["GET", "/api/vault/secrets"],
      ["GET", "/api/vault/touch-id"],
      ["GET", "/api/credentials/c1"],
      ["POST", "/api/credentials/c1/reveal"],
      ["POST", "/api/credentials"],
      ["PATCH", "/api/credentials/c1"],
      ["DELETE", "/api/credentials/c1"],
      ["POST", "/api/credentials/import"],
      ["GET", "/api/totp/codes"],
      ["GET", "/api/totp/autolink"],
      ["POST", "/api/totp"],
      ["DELETE", "/api/passkeys/pk1"],
      ["GET", "/api/cards/card1"],
      ["POST", "/api/cards/card1/reveal"],
      ["PATCH", "/api/cards/card1"],
      ["PATCH", "/api/card-purchases/p1"],
      ["POST", "/api/ssh/key-manager"],
      ["PATCH", "/api/ssh/key-manager/id_ed25519"],
      ["POST", "/api/ssh/key-manager/id_ed25519/install"],
      ["GET", "/api/ssh/local-keys"],
      ["POST", "/api/ssh/keys"],
    ] as const) {
      expect(deviceMayCall(method, path)).toBe(false);
    }

    for (const path of ["/api/mcp-servers", "/api/api-tools", "/api/composio/status", "/api/composio/connections", "/api/mods", "/api/messaging", "/api/ssh/servers"]) {
      expect(deviceMayCall("GET", path)).toBe(true);
    }
    for (const [method, path] of [
      ["POST", "/api/mcp-servers"],
      ["PATCH", "/api/mcp-servers/m1"],
      ["POST", "/api/mcp-servers/m1/test"],
      ["POST", "/api/api-tools/t1/test"],
      ["PATCH", "/api/api-tools/t1"],
      ["PUT", "/api/composio/key"],
      ["POST", "/api/composio/connect"],
      ["DELETE", "/api/composio/connections/c1"],
      ["GET", "/api/mods/m1"],
      ["GET", "/api/mods/catalog"],
      ["POST", "/api/mods/install"],
      ["POST", "/api/mods/m1/update"],
      ["DELETE", "/api/mods/m1"],
      ["GET", "/api/messaging/msg1"],
      ["GET", "/api/messaging/msg1/users"],
      ["PATCH", "/api/messaging/msg1/users/u1"],
      ["PATCH", "/api/messaging/msg1"],
      ["GET", "/api/messaging/msg1/teams-app"],
      ["GET", "/api/ssh/servers/s1"],
      ["PATCH", "/api/ssh/servers/s1"],
      ["POST", "/api/ssh/servers/s1/exec"],
      ["POST", "/api/ssh/servers/s1/godmode"],
      ["GET", "/api/ssh/servers/s1/folders"],
      ["POST", "/api/ssh/test"],
    ] as const) {
      expect(deviceMayCall(method, path)).toBe(false);
    }
    expect(deviceMayCall("PATCH", "/api/mods/m1")).toBe(true);
    expect(deviceBodyKeys("PATCH", "/api/mods/m1")).toEqual(["enabled"]);
    expect(deviceBodyRefusal("PATCH", "/api/mods/m1", { enabled: false })).toBeNull();
    expect(deviceBodyRefusal("PATCH", "/api/mods/m1", { enabled: true })).toMatch(/computer/);
    expect(deviceBodyRefusal("PATCH", "/api/mods/m1", {})).toMatch(/computer/);
    expect(deviceMayCall("POST", "/api/ssh/servers/s1/test")).toBe(true);
    expect(deviceBodyKeys("POST", "/api/ssh/servers/s1/test")).toEqual([]);

    for (const action of ["start", "stop", "suspend", "restart"]) {
      expect(deviceMayCall("POST", `/api/vms/vm_1/${action}`)).toBe(true);
      expect(deviceBodyKeys("POST", `/api/vms/vm_1/${action}`)).toEqual([]);
    }
    for (const action of ["reset", "duplicate", "exec", "open", "assign"]) expect(deviceMayCall("POST", `/api/vms/vm_1/${action}`)).toBe(false);
  });

  test("reads inside an agent's folder and nowhere else", () => {
    for (const sub of ["files", "file", "files/raw", "files/search"]) expect(deviceMayCall("GET", `/api/agents/a1/${sub}`)).toBe(true);
    expect(deviceMayCall("GET", "/api/files/overview")).toBe(true);
    for (const sub of ["sizes", "review", "notes", "deleted", "raws"]) expect(deviceMayCall("GET", `/api/agents/a1/files/${sub}`)).toBe(false);
    for (const sub of ["folder", "move", "delete", "inspect", "deleted/del_1/restore"]) expect(deviceMayCall("POST", `/api/agents/a1/files/${sub}`)).toBe(false);
    for (const path of ["/api/files/image", "/api/files/text", "/api/files/markdown"]) expect(deviceMayCall("GET", path)).toBe(false);
    expect(deviceMayCall("POST", "/api/files/reveal")).toBe(false);

    const read = (route: string, path: string) => deviceQueryRefusal("GET", `/api/agents/${known}/${route}`, new URLSearchParams({ path }));
    for (const path of ["", "workspace", "workspace/report.md", "workspace/shot.png", "memory/people.md", "MEMORY.md", "CLAUDE.md", "workspace/env-notes.md", "workspace/id_rsa.pub"]) {
      for (const route of ["files", "file", "files/raw"]) expect(read(route, path)).toBeNull();
    }
    for (const path of ["/etc/passwd", "../other-agent/MEMORY.md", "workspace/../../x", "..", "~/secrets", "C:/x", "workspace\\..\\x", "a\0b", ".git/config", "workspace/.GIT/HEAD"]) {
      for (const route of ["files", "file", "files/raw"]) expect(read(route, path)).toMatch(/agent's folder/);
    }
    for (const path of [".env", "workspace/.env", "workspace/.env.local", "workspace/keys/server.pem", "workspace/id_ed25519", "workspace/.npmrc", "workspace/credentials.json", "workspace/secrets.yaml", "workspace/.netrc"]) {
      expect(read("file", path)).toMatch(/computer/);
    }
    // Percent-encoded, the way it arrives in a query string.
    expect(deviceQueryRefusal("GET", "/api/agents/a1/file", new URLSearchParams("path=workspace%2F..%2F..%2Fx"))).toMatch(/agent's folder/);
    // Spelled so the check and the disk disagree: spaces the core trims, control characters, macOS' Unicode folding, Windows names.
    for (const path of [" .env", ".env ", "\t.npmrc", "workspace/id_rsa ", "a\u0001b", "workspace/x:y", "workspace/CREDEN~1.JSO"]) expect(read("file", path)).toMatch(/agent's folder/);
    for (const path of ["workspace/id_r\u017fa", "workspace/server.\u212aey", "workspace/.ENV"]) expect(read("file", path)).toMatch(/computer/);
    // Godmode's own records of the agent: raw run logs, transcripts and its state.
    for (const path of ["runs", "runs/2026-11-06.log", "conversations/c.md", "state/settings.json", "./runs/x", "RUNS/x", "\uff52uns/x"]) {
      for (const route of ["files", "file", "files/raw"]) expect(read(route, path)).toMatch(/computer/);
    }
    for (const path of ["workspace/runs/x.md", "memory/state.md", "runsheet.md"]) expect(read("file", path)).toBeNull();
    expect(deviceQueryRefusal("HEAD", "/api/agents/a1/file", new URLSearchParams({ path: "workspace/.env" }))).toMatch(/computer/);
    expect(deviceQueryRefusal("GET", "/api/agents/a1/file", new URLSearchParams("path=ok.md&path=.env"))).toMatch(/agent's folder/);
    // Searching what a list leaves out would spell it out; the phone filters its own list.
    for (const path of ["/api/credentials", "/api/cards"]) {
      expect(deviceQueryRefusal("GET", path, new URLSearchParams({ search: "token=a" }))).not.toBeNull();
      expect(deviceQueryRefusal("GET", path, new URLSearchParams())).toBeNull();
    }
  });

  test("leaves secrets out of what it shows a phone", () => {
    const view = (method: string, path: string, body: unknown) => deviceView(method, path)!(body);
    const now = "2026-11-06T00:00:00.000Z";
    const [login] = view("GET", "/api/credentials", [{ id: "c1", workspaceId: null, name: "Shop", url: "https://shop.example.com/login?token=abc#x", domains: [], username: "me", hasPassword: true, password: "hunter2", notes: "pin 1234", totpId: "t1", tags: [], lastUsedAt: null, createdAt: now, updatedAt: now }]) as Record<string, unknown>[];
    expect(login).toMatchObject({ url: "https://shop.example.com/login", hasPassword: true, totpId: "t1" });
    expect(JSON.stringify(login)).not.toMatch(/hunter2|1234|token/);

    const [card] = view("GET", "/api/cards", [{ id: "card1", name: "Visa", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030, holderName: "Daniel", billingCountry: "DE", limitMonthly: 5000 }]) as Record<string, unknown>[];
    expect(card).toMatchObject({ last4: "4242", expMonth: 0, expYear: 0, holderName: "", billingCountry: "", limitMonthly: 5000 });

    const mac = view("GET", "/api/vault/mac-password", { supported: true, saved: true, username: "me", savedAt: now, lastUsedAt: now, recent: [{ at: now, kind: "run", what: "sudo cp key /etc", agent: "Ops", ok: true }] });
    expect(mac).toMatchObject({ saved: true, recent: [] });

    const [server] = view("GET", "/api/mcp-servers", [{ id: "m1", name: "Linear", transport: "http", command: "npx", args: ["--token", "lin_abc"], url: "https://mcp.example.com/u/secret-id/mcp?key=k1", envKeys: ["LINEAR_KEY"], headerKeys: ["Authorization"], enabled: true, composio: { toolkits: ["gmail"], userId: "u-123" } }]) as Record<string, unknown>[];
    expect(server).toMatchObject({ name: "Linear", transport: "http", enabled: true, command: "", args: [], url: "https://mcp.example.com", envKeys: [], headerKeys: [], composio: { toolkits: ["gmail"], userId: "" } });

    const [tool] = view("GET", "/api/api-tools", [{ id: "t1", name: "Gemini", baseUrl: "https://api.example.com/v1?key=abc", docs: "use key AIza123", docsUrl: "https://docs.example.com", auth: { in: "header", name: "x-api-key", prefix: "" }, testPath: "/models", envVar: "GEMINI_KEY", hasKey: true, enabled: true }]) as Record<string, unknown>[];
    expect(tool).toMatchObject({ name: "Gemini", baseUrl: "https://api.example.com", docs: "", envVar: null, hasKey: true, auth: { in: "header", name: "", prefix: "" } });

    const [connection] = view("GET", "/api/composio/connections", [{ id: "c1", connectedAccountId: "ca_1", toolkit: "gmail", userId: "u-1", status: "ACTIVE" }]) as Record<string, unknown>[];
    expect(connection).toMatchObject({ toolkit: "gmail", status: "ACTIVE", connectedAccountId: "", userId: "" });

    const mod = { id: "mod1", name: "x", enabled: true, files: { "hooks/register.ts": "code" }, digest: "d", options: [{ key: "k" }], values: { k: "v" }, secretKeys: ["s"], check: { ok: true, hooks: [{ event: "PreToolUse" }], calls: ["$.fs.write"] }, source: { url: "https://user:tok@github.com/o/r.git", repo: "o/r", web: "https://github.com/o/r", path: "p", npm: null, checkError: "x" } };
    for (const shown of [(view("GET", "/api/mods", [mod]) as unknown[])[0], view("PATCH", "/api/mods/mod1", mod)]) {
      expect(shown).toMatchObject({ enabled: true, files: {}, digest: "", options: [], values: {}, secretKeys: [], check: { ok: true, hooks: [], calls: [] }, source: { url: "", repo: "o/r", web: "https://github.com/o/r", path: "" } });
    }

    const [bot] = view("GET", "/api/messaging", [{ id: "msg1", provider: "teams", name: "Bot", endpointPath: "/hooks/messaging/secret", config: { appId: "a", publicUrl: "https://x" }, status: { state: "connected" } }]) as Record<string, unknown>[];
    expect(bot).toMatchObject({ endpointPath: null, config: {}, status: { state: "connected" } });

    const keys = view("GET", "/api/ssh/key-manager", { dir: "/Users/me/.ssh", agent: { available: true, loaded: 1 }, keys: [{ name: "id_ed25519", path: "/Users/me/.ssh/id_ed25519", fingerprint: "SHA256:x", publicKey: "ssh-ed25519 AAA" }] });
    expect(keys).toMatchObject({ dir: "", keys: [{ name: "id_ed25519", path: null, fingerprint: "SHA256:x", publicKey: "ssh-ed25519 AAA" }] });

    const entries = view("GET", "/api/agents/a1/files", ["workspace/report.md", "workspace/.env", "workspace/deploy.pem", "workspace/id_rsa.pub", "workspace/id_rsa", "runs", "conversations", "state", "workspace/runs"].map((path) => ({ path, type: "file", size: 1, modifiedAt: now })));
    expect((entries as { path: string }[]).map((e) => e.path)).toEqual(["workspace/report.md", "workspace/id_rsa.pub", "workspace/runs"]);
    const hits = view("GET", "/api/agents/a1/files/search", [{ path: "workspace/.env.production", type: "file", line: 1, snippet: "KEY=x" }, { path: "workspace/notes.md", type: "file", line: 3, snippet: "key" }, { path: "runs/r.log", type: "file", line: 2, snippet: "key" }, { path: "state/x.json", type: "file", line: 1, snippet: "key" }]);
    expect((hits as { path: string }[]).map((e) => e.path)).toEqual(["workspace/notes.md"]);
    expect(deviceView("GET", "/api/totp")).toBeNull();
  });

  test("opens, uses and changes artifacts, never their files on the computer", () => {
    expect(deviceMayCall("GET", "/api/artifacts")).toBe(true);
    expect(deviceMayCall("GET", "/api/artifacts/art_1")).toBe(true);
    expect(deviceMayCall("PATCH", "/api/artifacts/art_1")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/artifacts/art_1")).toBe(true);
    expect(deviceMayCall("PUT", "/api/artifacts/art_1/data")).toBe(true);
    expect(deviceMayCall("GET", "/api/artifacts/art_1/versions")).toBe(true);
    expect(deviceMayCall("GET", "/api/artifacts/art_1/versions/2")).toBe(true);
    for (const action of ["restore", "message", "refresh", "review-done"]) expect(deviceMayCall("POST", `/api/artifacts/art_1/${action}`)).toBe(true);
    expect(deviceMayCall("POST", "/api/artifacts/start")).toBe(true);
    expect(deviceMayCall("POST", "/api/artifacts/art_1/files/photo.png/open")).toBe(false);
    expect(deviceMayCall("POST", "/api/artifacts/art_1/files/photo.png/reveal")).toBe(false);
    expect(deviceMayCall("POST", "/api/artifacts/art_1/versions")).toBe(false);
    expect(deviceBodyKeys("PATCH", "/api/artifacts/art_1")).toEqual(["title", "description", "pinned", "refreshPrompt"]);
    expect(deviceBodyKeys("PUT", "/api/artifacts/art_1/data")).toEqual(["data", "version"]);
    expect(deviceBodyKeys("POST", "/api/artifacts/art_1/message")).toEqual(["content", "source"]);
    expect(deviceBodyKeys("POST", "/api/artifacts/art_1/restore")).toEqual(["version"]);
    expect(deviceBodyKeys("POST", "/api/artifacts/art_1/refresh")).toEqual([]);
    expect(deviceBodyKeys("POST", "/api/artifacts/start")).toEqual(["prompt", "agentId", "workspaceId"]);
  });

  test("reads calls and places them like the desktop's New call, never sets them up", () => {
    expect(deviceMayCall("GET", "/api/calls")).toBe(true);
    expect(deviceMayCall("GET", "/api/calls/call_4f9Kd81LmQ2xYz0a")).toBe(true);
    expect(deviceMayCall("GET", "/api/calls/call_4f9Kd81LmQ2xYz0a/audio")).toBe(true);
    expect(deviceMayCall("POST", "/api/calls")).toBe(true);
    expect(deviceBodyKeys("POST", "/api/calls")).toEqual(["to", "goal", "context", "contactName", "language"]);
    for (const key of ["voicemail", "numberId", "purpose", "agentId", "conversationId", "pin", "ownerNumber"]) expect(deviceBodyKeys("POST", "/api/calls")).not.toContain(key);
    expect(deviceMayCall("GET", "/api/calls/setup")).toBe(false);
    expect(deviceMayCall("GET", "/api/calls/pin")).toBe(false);
    expect(deviceMayCall("PUT", "/api/calls/pin")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/calls/pin")).toBe(false);
    expect(deviceMayCall("GET", "/api/calls/numbers")).toBe(false);
    expect(deviceMayCall("POST", "/api/calls/")).toBe(false);
    expect(deviceMayCall("POST", "/api/calls/test")).toBe(false);
    expect(deviceMayCall("POST", "/api/calls/numbers")).toBe(false);
    expect(deviceMayCall("POST", "/api/calls/setup")).toBe(false);
    expect(deviceMayCall("POST", "/api/calls/pin")).toBe(false);
    expect(deviceMayCall("POST", "/api/calls/call_1")).toBe(false);
    expect(deviceMayCall("PUT", "/api/calls")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/calls/call_1")).toBe(false);
    expect(deviceMayCall("GET", "/api/agent-templates")).toBe(true);
    expect(deviceMayCall("POST", "/api/notifications/read")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/notifications")).toBe(true);
    expect(deviceMayCall("PATCH", "/api/missing-logins/ml_1")).toBe(true);
    expect(deviceMayCall("POST", "/api/human-tasks")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/human-tasks/htk_1")).toBe(true);
  });

  test("home, inbox, tickets, automations and calls like the desktop", () => {
    expect(deviceMayCall("GET", "/api/offers")).toBe(true);
    expect(deviceMayCall("POST", "/api/offers/ofr_1/accept")).toBe(true);
    expect(deviceMayCall("POST", "/api/offers/ofr_1/dismiss")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/offers/ofr_1")).toBe(false);
    expect(deviceMayCall("PATCH", "/api/offers/ofr_1")).toBe(false);
    expect(deviceMayCall("POST", "/api/offers/ofr_1/accept/now")).toBe(false);
    expect(deviceMayCall("POST", "/api/offers/other/accept")).toBe(false);
    expect(deviceMayCall("GET", "/api/attention")).toBe(true);
    expect(deviceMayCall("POST", "/api/attention")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/notifications/ntf_1")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/tasks/tsk_1")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/tasks/attachments")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/tasks/tsk_1/events")).toBe(false);
    expect(deviceMayCall("POST", "/api/tasks/tsk_1/push")).toBe(true);
    expect(deviceMayCall("POST", "/api/tasks/tsk_1/pull-request")).toBe(true);
    expect(deviceMayCall("POST", "/api/tasks/tsk_1/merge")).toBe(false);
    expect(deviceMayCall("POST", "/api/tasks/archive")).toBe(true);
    expect(deviceMayCall("GET", "/api/automation-events")).toBe(true);
    expect(deviceMayCall("POST", "/api/automation-events")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/automation-events")).toBe(false);
    expect(deviceMayCall("GET", "/api/calls/call_1/audio")).toBe(true);
    expect(deviceMayCall("GET", "/api/calls/setup/audio")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/calls/call_1/audio")).toBe(false);
    expect(deviceMayCall("GET", "/api/calls/call_1/audio/raw")).toBe(false);
    expect(deviceBodyKeys("PATCH", "/api/tasks/tsk_1")).toEqual(expect.arrayContaining(["priority", "dueDate", "labels", "goalId", "waitsFor", "blockedReason"]));
    for (const key of ["repoUrl", "repoPath", "baseBranch", "autoMerge", "type", "beforeId"]) expect(deviceBodyKeys("PATCH", "/api/tasks/tsk_1")).not.toContain(key);
    expect(deviceBodyKeys("POST", "/api/tasks/tsk_1/push")).toEqual([]);
    expect(deviceBodyKeys("POST", "/api/tasks/tsk_1/pull-request")).toEqual([]);
    expect(deviceBodyKeys("POST", "/api/offers/ofr_1/accept")).toEqual([]);
    expect(deviceBodyKeys("POST", "/api/offers/ofr_1/dismiss")).toEqual([]);
  });

  test("settings like the desktop's, without what stays on the computer", () => {
    expect(deviceMayCall("GET", "/api/reviews")).toBe(true);
    expect(deviceMayCall("POST", "/api/reviews")).toBe(true);
    expect(deviceMayCall("GET", "/api/reviews/rev_1")).toBe(true);
    expect(deviceMayCall("POST", "/api/reviews/rev_1/actions/3/undo")).toBe(true);
    expect(deviceMayCall("POST", "/api/reviews/rev_1/actions/x/undo")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/reviews/rev_1")).toBe(false);
    expect(deviceBodyKeys("POST", "/api/reviews")).toEqual([]);
    expect(deviceBodyKeys("POST", "/api/reviews/rev_1/actions/0/undo")).toEqual([]);

    expect(deviceMayCall("POST", "/api/memory/import")).toBe(true);
    expect(deviceBodyKeys("POST", "/api/memory/import")).toEqual(["source", "text"]);
    expect(deviceMayCall("POST", "/api/dreams/all")).toBe(true);
    expect(deviceMayCall("POST", "/api/dreams/drm_1/revert")).toBe(false);

    expect(deviceMayCall("GET", "/api/claude-accounts")).toBe(true);
    expect(deviceMayCall("POST", "/api/claude-accounts/refresh")).toBe(true);
    expect(deviceMayCall("POST", "/api/claude-accounts/system/default")).toBe(true);
    expect(deviceMayCall("POST", "/api/claude-accounts/login")).toBe(false);
    expect(deviceMayCall("POST", "/api/claude-accounts/login/code")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/claude-accounts/login")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/claude-accounts/cla_1")).toBe(false);
    expect(deviceMayCall("POST", "/api/doctor/claude-login")).toBe(false);

    expect(deviceMayCall("POST", "/api/browser/profiles")).toBe(true);
    expect(deviceBodyKeys("POST", "/api/browser/profiles")).toEqual(["name"]);
    expect(deviceMayCall("PATCH", "/api/browser/profiles/bp_1")).toBe(true);
    expect(deviceBodyKeys("PATCH", "/api/browser/profiles/bp_1")).toEqual(["name", "isDefault"]);
    expect(deviceMayCall("DELETE", "/api/browser/profiles/bp_1")).toBe(true);
    expect(deviceMayCall("POST", "/api/browser/profiles/bp_1/bot-check")).toBe(true);
    expect(deviceMayCall("POST", "/api/browser/profiles/bp_1/import")).toBe(false);
    expect(deviceMayCall("POST", "/api/browser/profiles/bp_1/navigate")).toBe(false);
    expect(deviceMayCall("GET", "/api/browser/chrome-profiles")).toBe(false);
    expect(deviceMayCall("POST", "/api/browser/profile-use/sync")).toBe(false);
    expect(deviceMayCall("POST", "/api/browser/captcha/balance")).toBe(false);
    expect(deviceMayCall("GET", "/api/computer/status")).toBe(true);
    expect(deviceMayCall("POST", "/api/computer/cua/stop")).toBe(true);
    expect(deviceMayCall("POST", "/api/computer/cua/install")).toBe(false);
    expect(deviceMayCall("POST", "/api/computer/permissions")).toBe(false);

    expect(deviceMayCall("GET", "/api/cleanup")).toBe(true);
    expect(deviceMayCall("POST", "/api/cleanup")).toBe(true);
    expect(deviceBodyKeys("POST", "/api/cleanup")).toEqual(["ids"]);
    expect(deviceMayCall("GET", "/api/optimize")).toBe(true);
    expect(deviceMayCall("POST", "/api/optimize")).toBe(true);
    for (const id of PHONE_CLEANUP) expect(RECOMMENDED).toContain(id as never);

    expect(deviceMayCall("GET", "/api/doctor")).toBe(true);
    expect(deviceMayCall("GET", "/api/doctor/permissions")).toBe(true);
    expect(deviceMayCall("GET", "/api/doctor/maintenance")).toBe(true);
    for (const path of ["/api/doctor/install", "/api/doctor/fix", "/api/doctor/updates", "/api/doctor/permissions/fix", "/api/doctor/permissions/open", "/api/doctor/claude-update"]) {
      expect(deviceMayCall("POST", path)).toBe(false);
    }
    expect(deviceMayCall("GET", "/api/doctor/updates")).toBe(false);
    expect(deviceMayCall("GET", "/api/power")).toBe(true);
    expect(deviceMayCall("POST", "/api/power/lid")).toBe(true);
    expect(deviceBodyKeys("POST", "/api/power/lid")).toEqual(["enabled"]);

    expect(deviceMayCall("GET", "/api/license")).toBe(true);
    expect(deviceMayCall("GET", "/api/license/usage")).toBe(true);
    expect(deviceMayCall("PUT", "/api/license")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/license")).toBe(false);
    expect(deviceMayCall("POST", "/api/license/refresh")).toBe(false);
    expect(deviceMayCall("PUT", "/api/license/reminders")).toBe(false);
    expect(deviceMayCall("GET", "/api/usage")).toBe(true);
    expect(deviceMayCall("GET", "/api/cloud")).toBe(true);
    expect(deviceMayCall("GET", "/api/cloud/billing")).toBe(true);
    expect(deviceMayCall("PUT", "/api/cloud")).toBe(false);
    expect(deviceMayCall("POST", "/api/cloud/link")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/cloud/link")).toBe(false);
    expect(deviceMayCall("POST", "/api/cloud/billing/cancel")).toBe(false);

    expect(deviceMayCall("GET", "/api/devices")).toBe(true);
    expect(deviceMayCall("PATCH", "/api/devices")).toBe(false);
    expect(deviceMayCall("POST", "/api/devices/invite")).toBe(false);
    expect(deviceMayCall("POST", "/api/devices/join")).toBe(false);
    expect(deviceMayCall("POST", "/api/devices/leave")).toBe(false);
    expect(deviceMayCall("DELETE", "/api/devices/dev_1")).toBe(false);
    expect(deviceMayCall("GET", "/api/connectors")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/connectors/con_1")).toBe(true);
    expect(deviceMayCall("POST", "/api/connectors")).toBe(false);
    expect(deviceMayCall("GET", "/api/logs")).toBe(true);
    expect(deviceMayCall("GET", "/api/logs/entries")).toBe(true);
    expect(deviceMayCall("DELETE", "/api/logs")).toBe(false);
    expect(deviceMayCall("POST", "/api/logs/fix")).toBe(false);
    expect(deviceMayCall("GET", "/api/logs/report")).toBe(false);
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

  test("answers to phones are gzipped, the desktop's are not", async () => {
    const { token: device } = await pair("Zipped");
    const gz = await phone("/api/settings", { bearer: device, headers: { "accept-encoding": "gzip" }, decompress: false } as never);
    expect(gz.status).toBe(200);
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer()))))).toHaveProperty("runner");
    const plain = await desktop("/api/settings", { headers: { "accept-encoding": "gzip" } });
    expect(plain.headers.get("content-encoding")).toBeNull();
  });

  test("phones can't widen what a chat or an automation may do", async () => {
    const { token: device } = await pair("Scoped");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });
    const widen = await phone("/api/conversations/cnv_missing", json("PATCH", { workingDirectory: "/" }));
    expect(widen.status).toBe(403);
    expect(((await widen.json()) as { code: string }).code).toBe("device_forbidden");
    expect((await phone("/api/conversations/cnv_missing", json("PATCH", { pinned: true }))).status).toBe(404);
    expect((await phone("/api/conversations/cnv_missing", json("PATCH", { model: "opus", effort: "high", ultracode: true }))).status).toBe(404);
    expect((await phone("/api/conversations/cnv_missing", json("PATCH", { vmId: "vm_1" }))).status).toBe(403);
    expect((await phone("/api/conversations/cnv_missing/messages", json("POST", { content: "hi", attachments: [], queue: true }))).status).toBe(404);
    expect((await phone("/api/conversations/cnv_missing/messages", json("POST", { content: "hi", workingDirectory: "/" }))).status).toBe(403);
    expect((await phone("/api/conversations/cnv_missing/queue/qmsg_x", json("PATCH", { content: "reworded", attachments: [] }))).status).toBe(403);
    expect((await phone("/api/chat", json("POST", { content: "hi", computerTarget: { kind: "desktop" } }))).status).toBe(403);
    expect((await phone("/api/routines/rtn_missing", json("PATCH", { prompt: "Summarize my inbox" }))).status).toBe(404);
    expect((await phone("/api/routines/rtn_missing", json("PATCH", { enabled: true, fillOnly: false }))).status).toBe(403);
    expect((await phone("/api/routines/rtn_missing", json("PATCH", { trigger: { type: "webhook" } }))).status).toBe(403);
    expect((await phone("/api/routines", json("POST", { agentId: "a1", name: "Hook", prompt: "x", trigger: { type: "app", connectionId: "c1", triggerSlug: "GMAIL_NEW" } }))).status).toBe(403);
    expect((await phone("/api/tasks", json("POST", { title: "Fork it", repoUrl: "https://evil.example.com/x.git" }))).status).toBe(403);
    expect((await phone("/api/tasks/tsk_missing", json("PATCH", { repoPath: "/" }))).status).toBe(403);
    expect((await phone("/api/tasks/tsk_missing", json("PATCH", { status: "todo" }))).status).toBe(404);
    expect((await phone("/api/browser/profiles/bpr_missing/launch", json("POST", { headless: false }))).status).toBe(403);
    expect((await phone("/api/browser/profiles/bpr_missing/launch", json("POST", {}))).status).toBe(404);
    const screen = await phone("/api/computer/input", json("POST", { view: "display:1", event: { type: "click", x: 1, y: 1 } }));
    expect(screen.status).toBe(403);
    expect(((await screen.json()) as { error: string }).error).toMatch(/shared in a chat/);
    expect((await phone("/api/vms/vm_missing/input", json("POST", { event: { type: "text", text: "hi" }, frame: { width: 1, height: 1 }, cwd: "/" }))).status).toBe(403);
  });

  test("phones place calls with the desktop's fields, only while calls are on", async () => {
    const { token: device } = await pair("Caller");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });
    const call = { to: "+4915112345678", goal: "Book a table for two", context: "Friday at 8", contactName: "Trattoria", language: "de" };
    updateSettings({ phone: { enabled: false } });
    const off = await phone("/api/calls", json("POST", call));
    expect(off.status).toBe(409);
    expect(((await off.json()) as { code: string }).code).toBe("calls_disabled");
    for (const refused of [{ numberId: "phnum_1" }, { voicemail: "Call me back" }, { purpose: "inform" }, { agentId: "agt_1" }, { pin: "1234" }]) {
      const res = await phone("/api/calls", json("POST", { ...call, ...refused }));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("device_forbidden");
    }
  });

  test("phones control an Android phone only while a chat uses it", async () => {
    const { token: device } = await pair("Remote");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });
    const stamp = new Date().toISOString();
    run("INSERT INTO android_devices (id, serial, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", "adr_used", "serial-used", "Pixel", stamp, stamp);
    const agent = await ensureDefaultAgent();
    const chat = createConversation({ agentId: agent.id, title: "Book on the phone" });
    const tap = { event: { type: "tap", x: 10, y: 20 }, frame: { width: 360, height: 780 } };

    const unused = await phone("/api/android/devices/adr_used/input", json("POST", tap));
    expect(unused.status).toBe(403);
    expect(((await unused.json()) as { error: string }).error).toMatch(/a chat uses/);

    run("UPDATE conversations SET android_device_ids = ? WHERE id = ?", JSON.stringify(["adr_used"]), chat.id);
    // Past the phone's rules: the computer answers that the phone isn't plugged in.
    expect((await phone("/api/android/devices/adr_used/input", json("POST", tap))).status).toBe(409);
    expect((await phone("/api/android/devices/adr_used/input", json("POST", { event: { type: "key", key: "home" } }))).status).toBe(409);
    expect((await phone("/api/android/devices/adr_other/input", json("POST", tap))).status).toBe(403);
    expect((await phone("/api/android/devices/adr_used/input", json("POST", { ...tap, serial: "other" }))).status).toBe(403);
    for (const [method, path, body] of [
      ["POST", "/api/android/devices/adr_used/exec", { command: "id" }],
      ["POST", "/api/android/devices/adr_used/assign", { kind: "conversation", id: chat.id, assigned: false }],
      ["POST", "/api/android/devices/adr_used/disconnect", {}],
      ["PATCH", "/api/android/devices/adr_used", { name: "Mine" }],
      ["DELETE", "/api/android/devices/adr_used", undefined],
      ["POST", "/api/android/connect", { host: "10.0.0.2" }],
    ] as const) {
      expect((await phone(path, body === undefined ? { bearer: device, method } : json(method, body))).status).toBe(403);
    }

    run("UPDATE conversations SET archived = 1 WHERE id = ?", chat.id);
    expect((await phone("/api/android/devices/adr_used/input", json("POST", tap))).status).toBe(403);
  });

  test("phones set a chat's project, browser profile and instructions, start private chats, search and dictate", async () => {
    const { token: device } = await pair("Chat level");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });
    const chat = "/api/conversations/cnv_missing";
    for (const allowed of [{ projectId: null }, { browserProfileId: null }, { instructions: "Answer in German" }]) {
      expect((await phone(chat, json("PATCH", allowed))).status).toBe(404);
    }
    for (const refused of [{ workspaceId: "wsp_1" }, { workingDirectory: "/" }, { computerTarget: null }, { sshServerIds: [] }, { androidDeviceIds: [] }, { runnerToolsId: "x" }]) {
      expect((await phone(chat, json("PATCH", refused))).status).toBe(403);
    }
    expect((await phone(`${chat}/pause`, json("PATCH", { auto: true }))).status).toBe(404);
    expect((await phone(`${chat}/pause`, json("PATCH", { auto: true, runId: "run_1" }))).status).toBe(403);

    const start = { content: "hi", agentId: "agt_missing" };
    for (const allowed of [{ private: true }, { browserProfileId: null }, { instructions: "Be brief" }]) {
      expect((await phone("/api/chat", json("POST", { ...start, ...allowed }))).status).not.toBe(403);
    }
    for (const refused of [{ runnerId: "dev_1" }, { vmId: "vm_1" }, { workingDirectory: "/" }, { sshServerIds: ["srv_1"] }, { androidDeviceIds: ["adr_1"] }, { voice: true }]) {
      expect((await phone("/api/chat", json("POST", { ...start, ...refused }))).status).toBe(403);
    }

    expect((await phone("/api/search?q=invoice", { bearer: device })).status).toBe(403);
    expect((await phone("/api/search?q=invoice&notes=1", { bearer: device })).status).toBe(403);
    const found = await phone("/api/search?q=invoice&notes=0", { bearer: device });
    expect(found.status).toBe(200);
    expect(((await found.json()) as { notes: unknown[] }).notes).toEqual([]);

    // Without a key or Hex on the computer the phone is told where to set it up; it never sets it up itself.
    const form = new FormData();
    form.set("audio", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "speech.wav");
    const dictated = await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { authorization: `Bearer ${device}` }, body: form });
    expect(dictated.status).toBe(400);
    expect(((await dictated.json()) as { code: string }).code).toBe("voice_not_set_up");
    expect((await phone("/api/voice/speak", json("POST", { text: "hi" }))).status).toBe(403);
    expect((await phone("/api/voice/hex/prepare", json("POST", {}))).status).toBe(403);
  });

  test("a limited phone sets when agents dream", async () => {
    const { token: device } = await pair("Dreams");
    const saved = await phone("/api/settings", { bearer: device, method: "PUT", body: JSON.stringify({ memory: { dreaming: { cron: "15 4 * * *" } } }) });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { memory: { dreaming: { cron: string } } }).memory.dreaming.cron).toBe("15 4 * * *");
  });

  test("phones set up instructions, defaults, workspaces, projects and agents", async () => {
    const { token: device } = await pair("Setup");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });

    const settings = await phone("/api/settings", { bearer: device });
    expect(settings.status).toBe(200);
    const saved = await phone("/api/settings", json("PUT", { general: { mode: "easy" }, runner: { effort: "high" }, memory: { dreaming: { enabled: true } } }));
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { runner: { effort: string } }).runner).toMatchObject({ effort: "high" });
    // What every agent follows in every run is written on the computer (or from a phone with full access).
    expect((await phone("/api/settings", json("PUT", { runner: { appendSystemPrompt: "Commit as me only." } }))).status).toBe(403);
    expect((await phone("/api/settings", json("PUT", { runner: { monthlyBudgetUsd: 50 } }))).status).toBe(403);
    expect((await phone("/api/settings", json("PUT", { runner: { spendTracking: true } }))).status).toBe(403);
    expect((await phone("/api/settings", json("PUT", { runner: { effort: "high&calc" } }))).status).toBe(400);
    const themed = await phone("/api/settings", json("PUT", { general: { theme: "dark" } }));
    expect(((await themed.json()) as { general: { theme: string } }).general.theme).toBe("dark");
    expect((await phone("/api/settings", json("PUT", { runner: { model: "x y" } }))).status).toBe(400);
    for (const patch of [
      { runner: { claudePath: "/tmp/evil" } },
      { runner: { extraArgs: ["--dangerously-skip-permissions"] } },
      { runner: { bypassPermissions: true } },
      { browser: { chromePath: "/tmp/evil" } },
      { security: { defaultSecretAccess: "reveal" } },
      { mobile: { enabled: false } },
      { cloud: { enabled: false } },
      { vm: { vaultFill: true } },
      { vm: { isolateHostShell: false } },
      { runner: { maxConcurrentRuns: 100000 } },
      { runner: { runTimeoutMinutes: -1 } },
      { general: { userName: "x".repeat(81) } },
      { general: { theme: "purple" } },
      JSON.parse('{"memory":{"dreaming":{"__proto__":{}}}}') as object,
      { runner: { effort: 5 } },
      { memory: { dreaming: { cron: 1 } } },
      { runner: "x" },
    ]) {
      expect((await phone("/api/settings", json("PUT", patch))).status).toBe(403);
    }

    expect((await phone("/api/workspaces", json("POST", { name: "From the phone", instructions: "Be brief." }))).status).toBe(403);
    const ws = await phone("/api/workspaces", json("POST", { name: "From the phone", icon: "🚀" }));
    expect(ws.status).toBe(200);
    const workspace = (await ws.json()) as { id: string; instructions: string };
    expect(workspace.instructions).toBe("");
    expect((await phone("/api/workspaces", json("POST", { name: "Sneaky", sources: [{ kind: "folder", path: "/" }] }))).status).toBe(403);
    expect((await phone("/api/workspaces", json("POST", { name: "Sneaky", vmId: "vm_1" }))).status).toBe(403);

    const folder = mkdtempSync(join(tmpdir(), "godmode-phone-folder-"));
    try {
      const set = await desktop(`/api/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ sources: [{ kind: "folder", path: folder }] }) });
      const sources = ((await set.json()) as { sources: { path: string }[] }).sources;
      expect(sources.length).toBe(1);
      const kept = await phone(`/api/workspaces/${workspace.id}`, json("PATCH", { name: "Still from the phone", sources: [{ kind: "folder", path: sources[0]!.path }] }));
      expect(kept.status).toBe(200);
      expect((await phone(`/api/workspaces/${workspace.id}`, json("PATCH", { sources: [{ kind: "folder", path: tmpdir() }] }))).status).toBe(403);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }

    const project = await phone("/api/projects", json("POST", { workspaceId: workspace.id, name: "Launch", instructions: "Ship it." }));
    expect(project.status).toBe(201);
    const created = (await project.json()) as { id: string; workspaceId: string };
    expect(created.workspaceId).toBe(workspace.id);
    expect((await phone(`/api/projects?workspaceId=${workspace.id}`, { bearer: device })).status).toBe(200);
    expect((await phone(`/api/projects/${created.id}`, json("PATCH", { instructions: "Ship it today." }))).status).toBe(200);

    const agent = await phone("/api/agents", json("POST", { name: "Phone helper", workspaceId: workspace.id, instructions: "Help." }));
    expect(agent.status).toBe(200);
    const helper = (await agent.json()) as { id: string; inheritMcp: boolean; permissions: { credentialIds: string[] | null; secretAccess: string } };
    expect(helper.inheritMcp).toBe(false);
    expect(helper.permissions).toMatchObject({ credentialIds: [], secretAccess: "fill" });
    const renamed = await phone(`/api/agents/${helper.id}`, json("PATCH", { role: "Helper", instructions: "Help a lot.", projectId: created.id }));
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { instructions: string }).instructions).toBe("Help a lot.");
    expect((await phone(`/api/agents/${helper.id}`, json("PATCH", { permissions: { secretAccess: "reveal" } }))).status).toBe(403);
    expect((await phone(`/api/agents/${helper.id}`, json("PATCH", { workingDirectory: "/" }))).status).toBe(403);

    expect((await phone(`/api/workspaces/${workspace.id}?force=1`, { bearer: device, method: "DELETE" })).status).toBe(403);
    expect((await phone(`/api/workspaces/${workspace.id}`, { bearer: device, method: "DELETE" })).status).toBe(409);
    expect((await phone("/api/workspaces", json("POST", { name: "Drive", sources: [{ kind: "git", url: "C:/Users/me/secret" }] }))).status).toBe(400);
    expect((await phone(`/api/projects/${created.id}`, { bearer: device, method: "DELETE" })).status).toBe(200);
  });

  test("automations set up or changed on a phone run without raw secrets", async () => {
    const { token: device } = await pair("Automations");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });
    const agent = (await (await desktop("/api/agents", { method: "POST", body: JSON.stringify({ name: "Reporter" }) })).json()) as { id: string };
    const made = await phone("/api/routines", json("POST", { agentId: agent.id, name: "Weekly report", prompt: "Sum up the week.", cron: "0 9 * * 1", timezone: "Europe/Berlin" }));
    expect(made.status).toBe(200);
    expect((await made.json()) as { fillOnly: boolean; webhookPath: string | null }).toMatchObject({ fillOnly: true, webhookPath: null });

    const desk = (await (await desktop("/api/routines", { method: "POST", body: JSON.stringify({ agentId: agent.id, name: "Inbox", prompt: "Read the inbox.", cron: "0 8 * * *" }) })).json()) as { id: string; fillOnly: boolean };
    expect(desk.fillOnly).toBe(false);
    const paused = await phone(`/api/routines/${desk.id}`, json("PATCH", { enabled: false }));
    expect(((await paused.json()) as { fillOnly: boolean }).fillOnly).toBe(false);
    const reworded = await phone(`/api/routines/${desk.id}`, json("PATCH", { prompt: "Read the inbox and reply." }));
    expect(((await reworded.json()) as { fillOnly: boolean }).fillOnly).toBe(true);
    expect((await phone(`/api/routines/${desk.id}`, { bearer: device, method: "DELETE" })).status).toBe(200);
  });

  test("phones install teams, run, pause, copy and delete agents, and edit only their notes", async () => {
    const { token: device } = await pair("Agents");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });
    type Made = { id: string; name: string; isDefault: boolean; repoPath: string; inheritMcp: boolean; permissions: { secretAccess: string; credentialIds: string[] | null; totpIds: string[] | null } };
    // Even where new agents read secrets by default, a team installed from the phone doesn't.
    updateSettings({ security: { defaultSecretAccess: "reveal" } });
    try {
      expect((await phone("/api/team-templates", { bearer: device })).status).toBe(200);
      expect((await phone("/api/team-templates/back-office/install", json("POST", { workspaceId: null, permissions: { secretAccess: "reveal" } }))).status).toBe(403);
      const installed = await phone("/api/team-templates/back-office/install", json("POST", { workspaceId: null, automations: true, timezone: "Europe/Berlin", skip: ["0.1", "0.2"] }));
      expect(installed.status).toBe(201);
      const team = (await installed.json()) as { lead: Made; members: Made[]; automations: number };
      expect(team.members.length).toBe(1);
      expect(team.automations).toBe(1);
      for (const a of [team.lead, ...team.members]) {
        expect(a.inheritMcp).toBe(false);
        expect(a.permissions).toMatchObject({ secretAccess: "fill", credentialIds: [], totpIds: [] });
      }
      const routines = (await (await phone(`/api/routines?agentId=${team.members[0]!.id}`, { bearer: device })).json()) as { fillOnly: boolean }[];
      expect(routines.map((r) => r.fillOnly)).toEqual([true]);

      const revealing = (await (await desktop("/api/agents", { method: "POST", body: JSON.stringify({ name: "Treasurer", permissions: { secretAccess: "reveal" } }) })).json()) as Made;
      expect(revealing.permissions.secretAccess).toBe("reveal");
      const refused = await phone(`/api/agents/${revealing.id}/duplicate`, json("POST", {}));
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe("device_forbidden");
    } finally {
      updateSettings({ security: { defaultSecretAccess: "fill" } });
    }

    const lead = ((await (await phone("/api/agents", { bearer: device })).json()) as Made[]).find((a) => a.name.startsWith("Office"))!;
    const copy = await phone(`/api/agents/${lead.id}/duplicate`, json("POST", {}));
    expect(copy.status).toBe(200);
    const copied = (await copy.json()) as Made;
    expect((await phone(`/api/agents/${copied.id}/duplicate`, json("POST", { name: "Mine" }))).status).toBe(403);
    expect((await phone(`/api/agents/${copied.id}/pause`, json("POST", {}))).status).toBe(409);
    expect((await phone(`/api/agents/${copied.id}/continue`, json("POST", {}))).status).toBe(409);
    expect((await phone(`/api/agents/${copied.id}/run`, json("POST", { prompt: "Tidy up", workingDirectory: "/" }))).status).toBe(403);
    expect((await phone(`/api/agents/${copied.id}`, json("PATCH", { enabled: false }))).status).toBe(200);
    expect((await phone(`/api/agents/${copied.id}/run`, json("POST", { prompt: "Tidy up" }))).status).toBe(409);
    expect((await phone(`/api/agents/${copied.id}`, { bearer: device, method: "DELETE" })).status).toBe(200);
    const builtin = await ensureDefaultAgent();
    expect((await phone(`/api/agents/${builtin.id}`, { bearer: device, method: "DELETE" })).status).toBe(400);
    expect((await phone(`/api/agents/${builtin.id}/duplicate`, json("POST", {}))).status).toBe(400);

    const notes = `/api/agents/${lead.id}`;
    expect((await desktop(`${notes}/file`, { method: "PUT", body: JSON.stringify({ path: "memory/people.md", content: "# People\n" }) })).status).toBe(200);
    const listed = await phone(`${notes}/files?path=memory`, { bearer: device });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { path: string }[]).map((f) => f.path)).toContain("memory/people.md");
    expect(((await (await phone(`${notes}/file?path=memory/people.md`, { bearer: device })).json()) as { content: string }).content).toBe("# People\n");
    expect((await phone(`${notes}/file`, json("PUT", { path: "memory/people.md", content: "# People\n- Anna\n" }))).status).toBe(200);
    expect((await phone(`${notes}/file`, json("PUT", { path: "memory/new/topic.md", content: "x", create: true }))).status).toBe(200);
    expect((await phone(`${notes}/commits`, { bearer: device })).status).toBe(200);
    for (const path of ["CLAUDE.md", "MEMORY.md"]) expect((await phone(`${notes}/file?path=${path}`, { bearer: device })).status).toBe(200);
    for (const path of ["memory/../CLAUDE.md", "memory%2F..%2FCLAUDE.md", ".git/config"]) {
      expect((await phone(`${notes}/file?path=${path}`, { bearer: device })).status).toBe(403);
    }
    expect((await phone(`${notes}/files`, { bearer: device })).status).toBe(200);
    expect((await phone(`${notes}/files?path=memory&path=.`, { bearer: device })).status).toBe(403);
    expect((await phone(`${notes}/files?path=.&path=memory`, { bearer: device })).status).toBe(403);
    for (const path of ["CLAUDE.md", "MEMORY.md", "memory/../CLAUDE.md", "notes.md"]) {
      expect((await phone(`${notes}/file`, json("PUT", { path, content: "overwritten" }))).status).toBe(403);
    }
    expect((await phone(`${notes}/file`, json("PUT", { path: "memory/people.md", content: "x", workingDirectory: "/" }))).status).toBe(403);
    symlinkSync(join(lead.repoPath, "CLAUDE.md"), join(lead.repoPath, "memory", "link.md"));
    symlinkSync(lead.repoPath, join(lead.repoPath, "memory", "up"));
    expect((await phone(`${notes}/file?path=memory/link.md`, { bearer: device })).status).toBe(403);
    expect((await phone(`${notes}/file`, json("PUT", { path: "memory/link.md", content: "overwritten" }))).status).toBe(403);
    expect((await phone(`${notes}/files?path=memory/up`, { bearer: device })).status).toBe(403);
    expect((await phone(`${notes}/file?path=memory/up/CLAUDE.md`, { bearer: device })).status).toBe(403);
  });

  test("phones create and follow tasks in a workspace", async () => {
    const { token: device } = await pair("Tasks");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });
    const ws = (await (await desktop("/api/workspaces", { method: "POST", body: JSON.stringify({ name: "Phone work" }) })).json()) as { id: string };
    const created = await phone("/api/tasks", json("POST", { workspaceId: ws.id, title: "Write the release notes", description: "For 0.2", type: "research" }));
    expect(created.status).toBe(200);
    const task = (await created.json()) as { id: string; workspaceId: string; status: string };
    expect(task).toMatchObject({ workspaceId: ws.id, status: "backlog" });
    const listed = (await (await phone(`/api/tasks?workspaceId=${ws.id}`, { bearer: device })).json()) as { id: string }[];
    const board = (await (await phone(`/api/tasks?workspaceId=${ws.id}&fields=summary`, { bearer: device })).json()) as { id: string; title: string; description: string }[];
    expect(board.find((t) => t.id === task.id)).toMatchObject({ title: "Write the release notes", description: "" });
    expect(listed.map((t) => t.id)).toEqual([task.id]);
    const moved = await phone(`/api/tasks/${task.id}`, json("PATCH", { status: "cancelled" }));
    expect(((await moved.json()) as { status: string }).status).toBe("cancelled");
    expect((await phone(`/api/conversations?workspaceId=${ws.id}`, { bearer: device })).status).toBe(200);

    const project = (await (await desktop("/api/projects", { method: "POST", body: JSON.stringify({ workspaceId: ws.id, name: "Docs" }) })).json()) as { id: string };
    const listedWs = (await (await phone("/api/workspaces", { bearer: device })).json()) as { id: string; projects: { id: string }[] }[];
    expect(listedWs.find((w) => w.id === ws.id)?.projects.map((p) => p.id)).toEqual([project.id]);
    const inProject = await phone("/api/tasks", json("POST", { workspaceId: ws.id, projectId: project.id, title: "Write the docs" }));
    expect(((await inProject.json()) as { projectId: string }).projectId).toBe(project.id);
    const out = await phone(`/api/tasks/${task.id}`, json("PATCH", { projectId: project.id }));
    expect(((await out.json()) as { projectId: string }).projectId).toBe(project.id);
  });

  test("phones edit, push and delete tickets, never point them at another repository", async () => {
    const { token: device } = await pair("Tickets");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });
    const ticket = (await (await phone("/api/tasks", json("POST", { title: "Draft the launch post" }))).json()) as { id: string };
    const other = (await (await phone("/api/tasks", json("POST", { title: "Pick the date" }))).json()) as { id: string; number: number };
    const edited = await phone(
      `/api/tasks/${ticket.id}`,
      json("PATCH", { title: "Draft the launch post v2", description: "Short", priority: "high", dueDate: "2030-01-31", labels: ["launch"], waitsFor: [other.id], goalId: null }),
    );
    expect(edited.status).toBe(200);
    expect((await edited.json()) as object).toMatchObject({ title: "Draft the launch post v2", priority: "high", dueDate: "2030-01-31", labels: ["launch"], waitsFor: [{ id: other.id }] });
    const blocked = await phone(`/api/tasks/${ticket.id}`, json("PATCH", { status: "blocked", blockedReason: "Waiting for legal" }));
    expect(((await blocked.json()) as { blockedReason: string }).blockedReason).toBe("Waiting for legal");
    expect((await phone(`/api/tasks/${ticket.id}`, json("PATCH", { repoUrl: "https://github.com/evil/repo.git" }))).status).toBe(403);
    expect((await phone(`/api/tasks/${ticket.id}`, json("PATCH", { autoMerge: true }))).status).toBe(403);
    expect((await phone(`/api/tasks/${ticket.id}/push`, json("POST", {}))).status).toBe(409);
    expect((await phone(`/api/tasks/${ticket.id}/pull-request`, json("POST", { base: "main" }))).status).toBe(403);
    expect((await phone("/api/attention", { bearer: device })).status).toBe(200);
    expect((await phone("/api/automation-events?limit=20", { bearer: device })).status).toBe(200);
    expect((await phone("/api/offers", { bearer: device })).status).toBe(200);
    expect((await phone("/api/offers/ofr_missing/accept", json("POST", { prompt: "Do something else" }))).status).toBe(403);
    expect((await phone(`/api/tasks/${ticket.id}`, { bearer: device, method: "DELETE" })).status).toBe(200);
    expect((await phone(`/api/tasks/${ticket.id}`, { bearer: device })).status).toBe(404);
  });

  test("phones send files with messages and attach them to tasks", async () => {
    const { token: device } = await pair("Files");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });
    const file = { name: "receipt.png", mime: "image/png", data: Buffer.from("png").toString("base64") };
    expect((await phone("/api/conversations/cnv_missing/messages", json("POST", { content: "", attachments: [file] }))).status).toBe(404);
    expect((await phone("/api/chat", json("POST", { agentId: "agt_missing", content: "", attachments: [file] }))).status).toBe(404);
    expect((await phone("/api/tasks/tsk_missing/messages", json("POST", { content: "Here", attachments: [file] }))).status).toBe(404);

    const form = new FormData();
    form.append("file", new File([Buffer.from("screenshot")], "bug.png", { type: "image/png" }));
    const uploaded = await fetch(`${base}/api/tasks/attachments`, { method: "POST", headers: { authorization: `Bearer ${device}` }, body: form });
    expect(uploaded.status).toBe(200);
    const attachment = (await uploaded.json()) as { url: string; name: string };
    expect(attachment.name).toBe("bug.png");
    const read = await phone(attachment.url, { bearer: device });
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("screenshot");
  });

  test("phones read calls, keep up with the inbox and add their own tasks", async () => {
    const { token: device } = await pair("Inbox");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });

    expect((await phone("/api/calls?limit=50", { bearer: device })).status).toBe(200);
    expect((await phone("/api/calls/call_0000000000000000", { bearer: device })).status).toBe(404);
    expect((await phone("/api/calls/setup", { bearer: device })).status).toBe(403);
    expect((await phone("/api/calls/numbers", { bearer: device })).status).toBe(403);
    expect((await phone("/api/calls/call_0000000000000000/audio", { bearer: device })).status).toBe(404);
    expect((await phone("/api/calls/test", json("POST", {}))).status).toBe(403);
    expect((await phone("/api/calls/pin", json("PUT", { pin: "1234" }))).status).toBe(403);
    expect((await phone("/api/calls/numbers", json("POST", { number: "+4930123456", sid: "AC1", token: "t" }))).status).toBe(403);

    const templates = await phone("/api/agent-templates", { bearer: device });
    expect(templates.status).toBe(200);
    expect(((await templates.json()) as unknown[]).length).toBeGreaterThan(0);
    const ws = (await (await desktop("/api/workspaces", { method: "POST", body: JSON.stringify({ name: "Hired" }) })).json()) as { id: string };
    const hired = await phone("/api/agents", json("POST", { name: "Bookkeeper", workspaceId: ws.id, avatar: "📒", color: "amber", character: { body: "kitty" } }));
    expect(hired.status).toBe(200);
    expect((await phone("/api/agents", json("POST", { name: "Sneaky", workspaceId: ws.id, permissions: { secretAccess: "reveal" } }))).status).toBe(403);

    expect((await phone("/api/notifications/read", json("POST", { ids: "all" }))).status).toBe(200);
    expect((await phone("/api/notifications/read", json("POST", { ids: "all", clear: true }))).status).toBe(403);
    expect((await phone("/api/notifications", { bearer: device, method: "DELETE" })).status).toBe(200);

    const login = reportMissingLogin({ agentId: null, runId: null, workspaceId: null, kind: "missing_credential", service: "Acme Portal" });
    expect((await phone(`/api/missing-logins/${login.id}`, json("PATCH", { credentialId: "crd_1" }))).status).toBe(403);
    expect((await phone(`/api/missing-logins/${login.id}`, json("PATCH", { status: "resolved", credentialId: "crd_1" }))).status).toBe(403);
    const dismissed = await phone(`/api/missing-logins/${login.id}`, json("PATCH", { status: "dismissed" }));
    expect(((await dismissed.json()) as { status: string }).status).toBe("dismissed");
    expect((await phone(`/api/missing-logins/${login.id}`, json("PATCH", { status: "open" }))).status).toBe(200);

    const created = await phone("/api/human-tasks", json("POST", { title: "Call the bank", priority: "high", status: "backlog" }));
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string; status: string; priority: string };
    expect(task).toMatchObject({ status: "backlog", priority: "high" });
    expect((await phone("/api/human-tasks", json("POST", { title: "With a file", attachments: [] }))).status).toBe(403);
    const edited = await phone(`/api/human-tasks/${task.id}`, json("PATCH", { title: "Call the bank today", body: "About the card", priority: "normal" }));
    expect(((await edited.json()) as { title: string }).title).toBe("Call the bank today");
    expect((await phone(`/api/human-tasks/${task.id}`, json("PATCH", { agentId: "agt_1" }))).status).toBe(403);
    expect((await phone(`/api/human-tasks/${task.id}`, { bearer: device, method: "DELETE" })).status).toBe(200);

    // A ticket an agent stands still for stays until it is answered.
    const waiting = (await (await phone("/api/human-tasks", json("POST", { title: "Pick a color" }))).json()) as { id: string };
    run("UPDATE human_tasks SET question_id = 'qst_waiting' WHERE id = ?", waiting.id);
    expect((await phone(`/api/human-tasks/${waiting.id}`, { bearer: device, method: "DELETE" })).status).toBe(400);
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

  test("phones switch features off, and only the harmless ones back on", async () => {
    const { token: device } = await pair("Features");
    const put = (patch: unknown) => phone("/api/settings", { bearer: device, method: "PUT", body: JSON.stringify(patch) });
    updateSettings({ integrations: { enabled: true }, cards: { enabled: true }, vm: { enabled: true }, activity: { enabled: false }, artifacts: { enabled: false } });
    for (const feature of ["integrations", "cards", "vm"]) {
      expect((await put({ [feature]: { enabled: false } })).status).toBe(200);
      const refused = await put({ [feature]: { enabled: true } });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toMatch(/on your computer/);
    }
    for (const feature of ["messaging", "plugins", "ssh", "sshKeys", "android"]) expect((await put({ [feature]: { enabled: true } })).status).toBe(403);
    expect((await put({ activity: { enabled: true }, artifacts: { enabled: true } })).status).toBe(200);
    // Already on: saving it on again changes nothing and is fine.
    updateSettings({ cards: { enabled: true } });
    expect((await put({ cards: { enabled: true } })).status).toBe(200);
    expect((await put({ android: { vaultFill: true } })).status).toBe(403);
    expect((await put({ cards: { enabled: false, limit: 1 } })).status).toBe(403);
    updateSettings({ integrations: { enabled: false }, cards: { enabled: false }, vm: { enabled: false } });

    expect((await put({ general: { aiChatTitles: false, aiNotificationSummaries: true } })).status).toBe(200);
    expect((await put({ runner: { accountAutoSwitch: true, accountSwitchPercent: 80 } })).status).toBe(200);
    expect((await put({ runner: { accountSwitchPercent: 10 } })).status).toBe(403);
    expect((await put({ browser: { passkeys: true }, computer: { screenshotMaxSize: 1024 } })).status).toBe(200);
    expect((await put({ computer: { screenshotMaxSize: 5000 } })).status).toBe(403);
    expect((await put({ browser: { captchaSolver: "2captcha" } })).status).toBe(403);
    expect((await put({ review: { enabled: true, cron: "0 2 * * *", autoFix: false, team: true } })).status).toBe(200);
    // Fixing by itself and settling the team's questions go off from the phone, back on at the computer.
    expect((await put({ review: { team: false } })).status).toBe(200);
    for (const key of ["autoFix", "team"]) {
      const refused = await put({ review: { [key]: true } });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toMatch(/on your computer/);
    }
    updateSettings({ review: { autoFix: true, team: true } });
    expect((await put({ review: { autoFix: true, team: true } })).status).toBe(200);
    expect((await put({ review: { cron: "every day" } })).status).toBe(400);
    expect((await put({ voice: { ttsProvider: "openai", rate: 1.25, language: "de" } })).status).toBe(200);
    expect((await put({ voice: { ttsProvider: "somewhere" } })).status).toBe(403);
    expect((await put({ voice: { sttProvider: "hex" } })).status).toBe(403);
    expect((await put({ voice: { openaiBaseUrl: "https://evil.example.com" } })).status).toBe(403);
    expect((await put({ voice: { hexPath: "/tmp/evil" } })).status).toBe(403);
    expect((await put({ voice: { hexModel: "cohere_transcribe" } })).status).toBe(403);
    expect((await put({ phone: { callerName: "Sam", language: "de", maxMinutes: 15, quietFrom: "22:00", quietTo: "07:00" } })).status).toBe(200);
    for (const [key, max] of [["callerName", 60], ["inboundGreeting", 500], ["quietFrom", 5], ["quietTo", 5], ["language", 3]] as const) {
      expect((await put({ phone: { [key]: "x".repeat(max + 1) } })).status).toBe(403);
    }
    // Calls go off from the phone; only the computer switches them back on.
    updateSettings({ phone: { enabled: false } });
    expect((await put({ phone: { enabled: true } })).status).toBe(403);
    updateSettings({ phone: { enabled: true } });
    expect((await put({ phone: { enabled: true } })).status).toBe(200);
    expect((await put({ phone: { enabled: false } })).status).toBe(200);
    for (const key of ["ownerNumber", "numberId", "answerInbound", "inboundInstructions", "inboundAgentId", "callOwner", "voiceId"]) {
      expect((await put({ phone: { [key]: key === "answerInbound" || key === "callOwner" ? true : "+4915112345678" } })).status).toBe(403);
    }
    updateSettings({ phone: { enabled: false } });
  });

  test("phones clean up, read the status screens and never see a sign-in link", async () => {
    const { token: device } = await pair("Status");
    const json = (method: string, body: unknown) => ({ bearer: device, method, body: JSON.stringify(body) });
    expect((await phone("/api/cleanup", json("POST", { ids: ["trash"] }))).status).toBe(403);
    expect((await phone("/api/cleanup", json("POST", { ids: ["temp-files", "vm-images"] }))).status).toBe(403);
    expect((await phone("/api/cleanup", json("POST", { ids: ["temp-files"], force: true }))).status).toBe(403);
    expect((await phone("/api/browser/profiles", json("POST", { name: "Phone", workspaceId: "ws_1" }))).status).toBe(403);
    expect((await phone("/api/browser/profiles/bpr_missing", json("PATCH", { name: "Renamed", workspaceId: null }))).status).toBe(403);
    expect((await phone("/api/memory/import", json("POST", { source: "chatgpt", text: "x", agentId: "a1" }))).status).toBe(403);

    const accounts = await phone("/api/claude-accounts", { bearer: device });
    expect(accounts.status).toBe(200);
    expect(((await accounts.json()) as { login: { url: string | null } }).login.url).toBeNull();
    const license = await phone("/api/license", { bearer: device });
    expect(license.status).toBe(200);
    expect(((await license.json()) as { manageUrl: string | null }).manageUrl).toBeNull();
    const cloud = await phone("/api/cloud", { bearer: device });
    expect(cloud.status).toBe(200);
    expect(((await cloud.json()) as { pending: unknown }).pending).toBeNull();
    expect((await phone("/api/devices", { bearer: device })).status).toBe(200);
    expect((await phone("/api/connectors", { bearer: device })).status).toBe(200);
    expect((await phone("/api/logs/entries", { bearer: device })).status).toBe(200);
    expect((await phone("/api/reviews", { bearer: device })).status).toBe(200);
  });

  test("phones see the pictures attached to a chat, only from the agent's uploads", async () => {
    const { token: device } = await pair("Pictures");
    const agent = await ensureDefaultAgent();
    const chat = createConversation({ agentId: agent.id, title: "Pictures" });
    mkdirSync(join(agent.repoPath, "workspace", "uploads"), { recursive: true });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    writeFileSync(join(agent.repoPath, "workspace", "uploads", "shot.png"), png);
    writeFileSync(join(agent.repoPath, "workspace", "uploads", "notes.txt"), "not a picture");
    const at = (path: string) => `/api/conversations/${chat.id}/attachment?path=${encodeURIComponent(path)}`;
    const shown = await phone(at("workspace/uploads/shot.png"), { bearer: device });
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-type")).toBe("image/png");
    expect((await phone(at("workspace/uploads/notes.txt"), { bearer: device })).status).toBe(404);
    expect((await phone(at("workspace/uploads/../../CLAUDE.md"), { bearer: device })).status).not.toBe(200);
    expect((await phone(at("CLAUDE.md"), { bearer: device })).status).toBe(404);
    expect((await phone(`/api/conversations/${chat.id}/attachment`, { bearer: device, method: "DELETE" })).status).toBe(403);
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
