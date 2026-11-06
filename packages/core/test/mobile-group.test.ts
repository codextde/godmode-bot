import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePairingLink, parseRunnerCode, type Agent, type MobilePairingOffer, type MobilePairResult, type Routine, type StartChatResult } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, insert, openDb, setMeta } from "../src/db";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { websocketHandler } from "../src/server/ws";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { listAudit } from "../src/services/audit";
import { createRoutine, getRoutine } from "../src/services/routines";
import { checkoutDir } from "../src/tasks/service";
import { setOwnerPin } from "../src/calls/pin";
import { mobileUrls, startMobileAccess, stopMobileAccess } from "../src/mobile/access";
import { setTailscaleOverride } from "../src/mobile/tailscale";
import { generateKeyPair } from "../src/remote/crypto";
import { RemoteLink } from "../src/remote/linkClient";
import { startLinkServer, stopLinkServer } from "../src/remote/linkServer";
import { createRunnerCode } from "../src/remote/pairing";
import { __setClaudeBinaryForTests, waitForRun } from "../src/runner/runner";
import { now, sleep } from "../src/util";
import * as vault from "../src/vault/vault";
import { FAKE_CLAUDE } from "./fixtures/runner-harness";

/**
 * A phone paired with another computer of the device group: that computer forwards the phone's requests over the link
 * with `x-godmode-phone`, and this one (the primary) applies the phones' rules again — the scope with its own settings
 * and files, the views, and what each route keeps from phones. Also the route rules for phones paired here.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let dataDir: string;
let app: ReturnType<typeof createApp>;
let token: string;
let base: string;
let device: string;
let link: RemoteLink;
let agent: Agent;

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

/** What the other computer of the group sends over the link: for one of its phones (`phone`), or for its own app. */
async function linked(method: string, path: string, body?: unknown, opts: { phone?: boolean } = { phone: true }) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.phone) headers["x-godmode-phone"] = "1";
  const res = await link.request(method, path, { ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers });
  const text = Buffer.from(res.body).toString();
  return { status: res.status, headers: res.headers, text, json: <T>() => JSON.parse(text) as T };
}

const send = (method: string, body: unknown = {}): RequestInit => ({ method, body: JSON.stringify(body) });

async function until(cond: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("Timed out");
    await sleep(20);
  }
}

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-mobile-group-"));
  loadConfig({ dataDir, token: "mobile-group-token" });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  updateSettings({ memory: { autoCommit: false }, browser: { enabled: false } });
  process.env.FAKE_CLAUDE_STATE = join(dataDir, "fake-claude");
  __setClaudeBinaryForTests([process.execPath, FAKE_CLAUDE]);
  app = createApp();
  token = getAccessToken();
  await vault.setup("correct horse battery staple", false);

  setTailscaleOverride({ installed: true, running: true, ip: "127.0.0.1", dnsName: "localhost", tailnet: "me@example.com", detail: null });
  updateSettings({ mobile: { enabled: false, port: 0 } });
  startMobileAccess({ app, websocket: websocketHandler });
  const offer = (await (await desktop("/api/mobile/pairing", { method: "POST" })).json()) as MobilePairingOffer;
  base = mobileUrls()[1]!;
  const pairing = parsePairingLink(offer.link)!;
  const paired = await fetch(`${base}/api/mobile/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairing.code, name: "Pixel", platform: "android" }) });
  device = ((await paired.json()) as MobilePairResult).token;

  setMeta("link.port", "0");
  const port = startLinkServer({ app, websocket: websocketHandler })!;
  const code = { ...parseRunnerCode((await createRunnerCode()).code)!, addresses: ["127.0.0.1"] };
  const identity = generateKeyPair();
  await RemoteLink.pair({ identity, code, name: "Laptop" });
  link = new RemoteLink({ identity, runnerKey: code.key, addresses: ["127.0.0.1"], port, name: "Primary", ownName: "Laptop", onEvent: () => {}, onState: () => {} });
  link.start();
  await until(() => link.state.state === "online");

  agent = (await (await desktop("/api/agents", send("POST", { name: "Folder Bot" }))).json()) as Agent;
  await desktop(`/api/agents/${agent.id}/files?path=`);
});

afterAll(() => {
  link.stop();
  stopLinkServer();
  stopMobileAccess();
  setTailscaleOverride(null);
  __setClaudeBinaryForTests(null);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a phone's request another computer of the group forwards", () => {
  test("meets the phones' scope here, with this computer's settings", async () => {
    expect((await linked("POST", "/api/vault/unlock", { passphrase: "x" })).status).toBe(403);
    expect((await linked("GET", "/api/search?q=invoice")).status).toBe(403);
    expect((await linked("GET", "/api/search?q=invoice&notes=0")).status).toBe(200);
    expect((await linked("POST", "/api/agents", { name: "Wide", permissions: { secretAccess: "reveal" } })).status).toBe(403);

    updateSettings({ phone: { enabled: false }, integrations: { enabled: false } });
    for (const feature of ["phone", "integrations"]) {
      const refused = await linked("PUT", "/api/settings", { [feature]: { enabled: true } });
      expect(refused.status).toBe(403);
      expect(refused.json<{ code: string }>().code).toBe("device_forbidden");
    }
    expect((await linked("PUT", "/api/settings", { general: { aiChatTitles: false } })).status).toBe(200);
    // The other computer's own app is not a phone.
    expect((await linked("PUT", "/api/settings", { activity: { enabled: true } }, { phone: false })).status).toBe(200);
  });

  test("gets what a route keeps for phones: fill-only agents and automations, no webhook URL", async () => {
    updateSettings({ security: { defaultSecretAccess: "reveal" } });
    const made = await linked("POST", "/api/agents", { name: "Made on a phone" });
    expect(made.status).toBe(200);
    expect(made.json<Agent>().permissions).toMatchObject({ secretAccess: "fill", credentialIds: [], totpIds: [] });
    const own = await linked("POST", "/api/agents", { name: "Made on the laptop" }, { phone: false });
    expect(own.json<Agent>().permissions.secretAccess).toBe("reveal");
    expect((await linked("POST", `/api/agents/${own.json<Agent>().id}/duplicate`)).status).toBe(403);
    updateSettings({ security: { defaultSecretAccess: "fill" } });

    const routine = await linked("POST", "/api/routines", { agentId: agent.id, name: "Morning", trigger: { type: "schedule" }, cron: "0 8 * * *", prompt: "Check" });
    expect(routine.status).toBe(200);
    expect(routine.json<Routine>()).toMatchObject({ fillOnly: true, webhookPath: null });
  });

  test("reads the agent's folder by this computer's files, also by the agent's slug", async () => {
    const at = (rel: string) => join(agent.repoPath, rel);
    mkdirSync(at("workspace"), { recursive: true });
    mkdirSync(at("runs"), { recursive: true });
    writeFileSync(at("workspace/report.md"), "# Report\n");
    writeFileSync(at("workspace/.env"), "KEY=secret\n");
    writeFileSync(at("workspace/shot.png"), PNG);
    writeFileSync(at("runs/run.log"), "raw log\n");
    symlinkSync(at("workspace/.env"), at("workspace/settings.md"));
    // Links that stay inside the folder: the core follows them, a phone doesn't (one could lead out of memory/).
    symlinkSync(at("workspace"), at("workspace/mirror"));
    mkdirSync(at("memory"), { recursive: true });
    symlinkSync(at("workspace"), at("memory/elsewhere"));

    for (const who of [agent.id, agent.slug]) {
      const files = `/api/agents/${who}`;
      for (const path of ["workspace/settings.md", "workspace/.env", "runs/run.log", "workspace/mirror/report.md"]) {
        expect((await linked("GET", `${files}/file?path=${path}`)).status).toBe(403);
        expect((await phone(`${files}/file?path=${path}`)).status).toBe(403);
      }
      expect((await linked("GET", `${files}/file?path=workspace/report.md`)).status).toBe(200);
      expect((await phone(`${files}/file`, send("PUT", { path: "memory/elsewhere/planted.md", content: "x" }))).status).toBe(403);
      expect((await linked("PUT", `${files}/file`, { path: "memory/elsewhere/planted.md", content: "x" })).status).toBe(403);
    }
    expect(existsSync(at("workspace/planted.md"))).toBe(false);
    expect((await desktop(`/api/agents/${agent.id}/file?path=workspace/mirror/report.md`)).status).toBe(200);
    expect((await linked("GET", `/api/agents/${agent.id}/file?path=runs/run.log`, undefined, { phone: false })).status).toBe(200);
    expect((await linked("GET", "/api/agents/agt_missing/files?path=")).status).toBe(403);

    const root = (await linked("GET", `/api/agents/${agent.id}/files?path=`)).json<{ path: string }[]>().map((e) => e.path);
    expect(root).toContain("workspace");
    expect(root).not.toContain("runs");
    expect((await linked("GET", `/api/agents/${agent.id}/files?path=`, undefined, { phone: false })).json<{ path: string }[]>().map((e) => e.path)).toContain("runs");

    // The sandbox policy of a file comes along over the link.
    const raw = await linked("GET", `/api/agents/${agent.id}/files/raw?path=workspace/shot.png`);
    expect(raw.status).toBe(200);
    expect(raw.headers["content-security-policy"]).toContain("sandbox");
    expect(raw.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("what routes keep from phones", () => {
  test("a private chat a phone starts is on record: who, which agent, never what was said", async () => {
    const direct = (await (await phone("/api/chat", send("POST", { agentId: agent.id, content: "Something personal", private: true }))).json()) as StartChatResult;
    const forwarded = await linked("POST", "/api/chat", { agentId: agent.id, content: "Something else", private: true });
    expect(forwarded.status).toBe(201);
    const viaLink = forwarded.json<StartChatResult>();
    await waitForRun(direct.run.id, 20_000);
    await waitForRun(viaLink.run.id, 20_000);
    const entries = listAudit(10, "chat.private");
    expect(entries.find((e) => e.target === direct.conversation.id)?.details).toMatchObject({ via: "phone", name: "Pixel", agentId: agent.id });
    expect((entries.find((e) => e.target === direct.conversation.id)?.details as { deviceId?: string }).deviceId).toMatch(/^dev_/);
    expect(entries.find((e) => e.target === viaLink.conversation.id)?.details).toMatchObject({ via: "phone", through: "Laptop", agentId: agent.id });
    expect(JSON.stringify(entries)).not.toMatch(/personal|Something else/);
    await desktop("/api/chat", send("POST", { agentId: agent.id, content: "From the computer", private: true }));
    expect(listAudit(10, "chat.private")).toHaveLength(2);
  });

  test("recordings of incoming calls with the PIN play on the computer only", async () => {
    setOwnerPin("482915");
    const call = (id: string, direction: "inbound" | "outbound") =>
      insert("phone_calls", { id, direction, purpose: direction === "inbound" ? "inbound" : "task", status: "done", number: "", contact_name: "", goal: "", context: "", language: "en", provider_call_id: `conv_${id}`, transcript: "[]", has_audio: 1, created_at: now(), updated_at: now() });
    call("call_in", "inbound");
    call("call_out", "outbound");
    expect((await linked("GET", "/api/calls/call_in/audio")).status).toBe(403);
    const refused = await phone("/api/calls/call_in/audio");
    expect((await refused.json()) as object).toMatchObject({ error: "Listen to incoming calls on your computer.", code: "device_forbidden" });
    // Other recordings aren't kept from the phone (without an ElevenLabs key here they don't load at all).
    const outbound = await phone("/api/calls/call_out/audio");
    expect(((await outbound.json()) as { code?: string }).code).not.toBe("device_forbidden");
    expect(((await (await desktop("/api/calls/call_in/audio")).json()) as { code?: string }).code).not.toBe("device_forbidden");
  });

  test("places calls with the desktop's fields and controls only the Android phones a chat uses", async () => {
    updateSettings({ phone: { enabled: false } });
    const call = { to: "+4915112345678", goal: "Book a table", contactName: "Trattoria", language: "it" };
    expect((await linked("POST", "/api/calls", call)).json<{ code: string }>().code).toBe("calls_disabled");
    expect((await linked("POST", "/api/calls", { ...call, numberId: "phnum_1" })).status).toBe(403);
    expect((await linked("POST", "/api/calls", { ...call, voicemail: "Call back" })).status).toBe(403);

    insert("android_devices", { id: "adr_group", serial: "serial-group", name: "Pixel", created_at: now(), updated_at: now() });
    const tap = { event: { type: "tap", x: 1, y: 1 }, frame: { width: 100, height: 200 } };
    const unused = await linked("POST", "/api/android/devices/adr_group/input", tap);
    expect(unused.status).toBe(403);
    expect(unused.json<{ code: string }>().code).toBe("device_forbidden");
    // The other computer's own app may; the phone isn't plugged in here.
    expect((await linked("POST", "/api/android/devices/adr_group/input", tap, { phone: false })).status).toBe(409);

    const chat = (await (await desktop("/api/chat", send("POST", { agentId: agent.id, content: "Use the Pixel" }))).json()) as StartChatResult;
    await waitForRun(chat.run.id, 20_000);
    expect((await desktop(`/api/android/devices/adr_group/assign`, send("POST", { kind: "conversation", id: chat.conversation.id, assigned: true }))).status).toBe(200);
    expect((await linked("POST", "/api/android/devices/adr_group/input", tap)).status).toBe(409);
    expect((await linked("POST", "/api/android/devices/adr_group/exec", { command: "id" })).status).toBe(403);
    expect((await linked("POST", "/api/android/devices/adr_group/assign", { kind: "conversation", id: chat.conversation.id, assigned: false })).status).toBe(403);
  });

  test("undoing a review's change never lifts an automation's fill-only from a phone", async () => {
    const routine = createRoutine({ agentId: agent.id, name: "Nightly", cron: "0 8 * * *", prompt: "Check", fillOnly: true, enabled: false });
    const action = (undo: unknown) => ({ kind: "automation_updated", text: "Changed", targetId: routine.id, conversationId: null, undo, undoneAt: null, at: now() });
    insert("reviews", {
      id: "rev_fill",
      run_id: null,
      conversation_id: null,
      reason: "manual",
      status: "succeeded",
      metrics: null,
      created_at: now(),
      actions: JSON.stringify([
        action({ type: "routine", routineId: routine.id, before: { fillOnly: false }, after: { fillOnly: true } }),
        action({ type: "routine", routineId: routine.id, before: { enabled: true }, after: { enabled: false } }),
      ]),
    });
    const refused = await phone("/api/reviews/rev_fill/actions/0/undo", send("POST"));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/raw secrets/);
    expect((await linked("POST", "/api/reviews/rev_fill/actions/0/undo", {})).status).toBe(403);
    expect(getRoutine(routine.id).fillOnly).toBe(true);
    expect((await phone("/api/reviews/rev_fill/actions/1/undo", send("POST"))).status).toBe(200);
    expect(getRoutine(routine.id).enabled).toBe(true);
    expect((await desktop("/api/reviews/rev_fill/actions/0/undo", { method: "POST" })).status).toBe(200);
    expect(getRoutine(routine.id).fillOnly).toBe(false);
  });

  test("a phone deletes a ticket only while its worktree holds nothing unsaved", async () => {
    const git = (cwd: string, ...args: string[]) => {
      const res = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      if (res.exitCode !== 0) throw new Error(res.stderr.toString());
    };
    const repo = mkdtempSync(join(tmpdir(), "godmode-ticket-repo-"));
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const ticket = async (title: string, branch: string) => {
      const task = (await (await desktop("/api/tasks", send("POST", { title }))).json()) as { id: string };
      mkdirSync(join(checkoutDir(task.id), ".."), { recursive: true });
      git(repo, "worktree", "add", "-q", "-b", branch, checkoutDir(task.id));
      return task.id;
    };

    const dirty = await ticket("Half done", "half-done");
    writeFileSync(join(checkoutDir(dirty), "work.md"), "not committed yet\n");
    expect((await linked("DELETE", `/api/tasks/${dirty}`)).status).toBe(403);
    const refused = await phone(`/api/tasks/${dirty}`, { method: "DELETE" });
    expect(((await refused.json()) as { error: string }).error).toBe("Delete it on your computer: its worktree has unsaved changes.");
    expect(existsSync(join(checkoutDir(dirty), "work.md"))).toBe(true);
    expect((await desktop(`/api/tasks/${dirty}`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(checkoutDir(dirty))).toBe(false);

    const clean = await ticket("All committed", "all-committed");
    expect((await phone(`/api/tasks/${clean}`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(checkoutDir(clean))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
  });
});
