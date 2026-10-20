/**
 * Two full Godmodes as one device group, end to end: the primary is a child process (`godmode serve`), the secondary
 * is this process. Joining with an invite, the secondary's app showing the primary's Godmode, chats that run on either
 * computer and show up on both, questions answered from anywhere, shared tools that run on the primary, moving chats
 * (also while they work), handing work off, the primary going away and coming back, and leaving the group.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentQuestion, Conversation, DeviceGroup, DeviceInvite, ServerEvent, StartChatResult } from "@godmode/shared";
import { config, loadConfig } from "../src/config";
import { all, closeDb, get, openDb, setMeta } from "../src/db";
import { ensureDefaultAgent } from "../src/agents/service";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { deliverForwarded, websocketHandler, type HubSocket } from "../src/server/ws";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { startChat } from "../src/services/conversations";
import { startDevices, stopDevices } from "../src/remote/devices";
import { forwarding, groupRole, primaryRunnerId, resetGroupCache, runsShared } from "../src/remote/group";
import { startLinkServer, stopLinkServer } from "../src/remote/linkServer";
import { startRunners, stopRunners } from "../src/remote/runners";
import { callTool } from "../src/mcp/tools";
import { setLogLevel } from "../src/log";
import { childEnv, sleep } from "../src/util";
import { __setClaudeBinaryForTests, cancelRun, listActiveRuns, waitForRun } from "../src/runner/runner";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const FAKE_CLAUDE = join(import.meta.dir, "fixtures", "fake-claude.ts");

let primaryDir: string;
let secondaryDir: string;
let child: ReturnType<typeof Bun.spawn> | null = null;
let primaryUrl = "";
let primaryToken = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let app: ReturnType<typeof createApp>;
let selfId = "";
let beforeJoinChat = "";
const savedClaudeConfig = process.env.CLAUDE_CONFIG_DIR;

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 20_000, what = "condition") {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

function childEnvFor() {
  return childEnv({
    GODMODE_KEYCHAIN: "0",
    GODMODE_LOG_LEVEL: "error",
    GODMODE_FAILOVER_MS: "1500",
    FAKE_CLAUDE_STATE: join(primaryDir, "fake-claude"),
    CLAUDE_CONFIG_DIR: join(primaryDir, "claude-config"),
  }) as Record<string, string>;
}

async function startPrimary() {
  child = Bun.spawn([process.execPath, INDEX, "serve", "--data-dir", primaryDir, "--port", "0", "--mode", "server"], { env: childEnvFor(), stdout: "pipe", stderr: "pipe" });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let out = "";
  const end = Date.now() + 30_000;
  while (!out.includes("GODMODE_READY ")) {
    if (Date.now() > end) throw new Error(`primary did not start:\n${out}`);
    const { done, value } = await reader.read();
    if (done) throw new Error(`primary exited:\n${out}\n${await new Response(child.stderr as ReadableStream).text()}`);
    out += new TextDecoder().decode(value);
  }
  primaryUrl = (JSON.parse(/GODMODE_READY (\{.*\})/.exec(out)![1]!) as { url: string }).url;
  void (async () => {
    for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return;
  })();
  void new Response(child.stderr as ReadableStream).text().catch(() => undefined);
}

async function stopPrimary() {
  if (!child) return;
  child.kill("SIGTERM");
  await Promise.race([child.exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  child = null;
}

/** The primary's own API (as its own app would ask it). */
async function onPrimary<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(primaryUrl + path, {
    ...init,
    headers: { authorization: `Bearer ${primaryToken}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** This computer's API, as its app asks it. */
async function here<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await app.request(`http://127.0.0.1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${getAccessToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

function localChat(id: string) {
  return get<{ runner_id: string | null; claude_session_id: string | null }>("SELECT runner_id, claude_session_id FROM conversations WHERE id = ?", id);
}

function runsOf(id: string) {
  return all<{ id: string; status: string }>("SELECT id, status FROM runs WHERE conversation_id = ? ORDER BY created_at, rowid", id);
}

beforeAll(async () => {
  setLogLevel("error");
  primaryDir = mkdtempSync(join(tmpdir(), "godmode-devices-primary-"));
  secondaryDir = mkdtempSync(join(tmpdir(), "godmode-devices-secondary-"));

  // The primary's data dir: the fake Claude Code, and any free port for the link.
  loadConfig({ dataDir: primaryDir });
  openDb(join(primaryDir, "godmode.db"));
  resetSettingsCache();
  const claude = join(primaryDir, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(claude, 0o755);
  updateSettings({ runner: { claudePath: claude }, browser: { enabled: false }, memory: { autoCommit: false } });
  setMeta("link.port", "0");
  closeDb();
  resetSettingsCache();
  await startPrimary();
  primaryToken = Bun.spawnSync([process.execPath, INDEX, "token", "--data-dir", primaryDir], { env: childEnvFor(), stdout: "pipe" }).stdout.toString().trim();

  // This process is the secondary, with its own fake Claude Code. It stands in for the primary 1.5 s after it went.
  process.env.GODMODE_STAND_IN_MS = "1500";
  process.env.FAKE_CLAUDE_STATE = join(secondaryDir, "fake-claude");
  process.env.CLAUDE_CONFIG_DIR = join(secondaryDir, "claude-config");
  __setClaudeBinaryForTests([process.execPath, FAKE_CLAUDE]);
  loadConfig({ dataDir: secondaryDir });
  openDb(join(secondaryDir, "godmode.db"));
  resetSettingsCache();
  resetGroupCache();
  updateSettings({ browser: { enabled: false }, memory: { autoCommit: false } });
  setMeta("link.port", "0");
  app = createApp();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, srv) => app.fetch(req, { server: srv }) });
  config().port = server.port!;
  const agent = await ensureDefaultAgent();
  // A chat this computer had before it joined: it stays, and shows up on the primary with the primary's agent.
  const before = await startChat({ agentId: agent.id, content: "Before joining" });
  beforeJoinChat = before.conversation.id;
  await waitForRun(before.run.id, 20_000);
  startDevices({ app, websocket: websocketHandler }, deliverForwarded);
  startRunners();
}, 120_000);

afterAll(async () => {
  for (const r of listActiveRuns()) {
    await cancelRun(r.runId).catch(() => undefined);
    await waitForRun(r.runId, 10_000).catch(() => undefined);
  }
  __setClaudeBinaryForTests(null);
  delete process.env.GODMODE_STAND_IN_MS;
  if (savedClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfig;
  stopDevices();
  stopRunners();
  stopLinkServer();
  await stopPrimary();
  server?.stop(true);
  closeDb();
  resetSettingsCache();
  resetGroupCache();
  if (process.env.KEEP_DEVICE_TEST_DIRS) console.log("kept", primaryDir, secondaryDir);
  else {
    rmSync(primaryDir, { recursive: true, force: true });
    rmSync(secondaryDir, { recursive: true, force: true });
  }
}, 60_000);

describe("a device group, end to end", () => {
  test("an invite from one computer and joining on the other makes a group of two, linked both ways", async () => {
    const invite = await onPrimary<DeviceInvite>("/api/devices/invite", { method: "POST" });
    expect(invite.status).toBe(201);
    expect(invite.body.code.startsWith("gmd1.")).toBe(true);

    const joined = await here<DeviceGroup>("/api/devices/join", { method: "POST", body: JSON.stringify({ code: invite.body.code }) });
    expect(joined.status).toBe(200);
    expect(joined.body.role).toBe("secondary");
    selfId = joined.body.selfId!;
    expect(selfId).toBeTruthy();
    expect(groupRole()).toBe("secondary");
    await until(() => forwarding(), 20_000, "the primary to be shown here");

    await until(
      async () => (await onPrimary<DeviceGroup>("/api/devices")).body.devices.some((d) => d.id === selfId && d.state === "online"),
      20_000,
      "the primary to reach this computer",
    );
    const group = (await onPrimary<DeviceGroup>("/api/devices")).body;
    expect(group.role).toBe("primary");
    expect(group.devices.map((d) => d.role).sort()).toEqual(["primary", "secondary"]);

    const mine = (await here<DeviceGroup>("/api/devices")).body;
    expect(mine.primaryOnline).toBe(true);
    expect(mine.devices.find((d) => d.self)?.id).toBe(selfId);
  }, 90_000);

  test("this computer's app shows the primary's Godmode, with what is about this computer kept here", async () => {
    const created = await onPrimary<{ id: string }>("/api/agents", { method: "POST", body: JSON.stringify({ name: "Researcher" }) });
    expect(created.status).toBeLessThan(300);
    const agents = (await here<{ id: string; name: string }[]>("/api/agents")).body;
    expect(agents.map((a) => a.name)).toContain("Researcher");

    const boot = (await here<{ dataDir: string; counts: { agents: number } }>("/api/bootstrap")).body;
    expect(boot.dataDir).toBe(secondaryDir);
    expect(boot.counts.agents).toBe(agents.length);

    // The setup is copied here too, for the runs that work on this computer.
    await until(() => !!get("SELECT id FROM agents WHERE id = ?", created.body.id), 30_000, "the setup copy");
  }, 60_000);

  test("the chat this computer had before joining shows up on the primary, with the primary's agent", async () => {
    await until(
      async () => (await onPrimary<Conversation[]>("/api/conversations?limit=100")).body.some((c) => c.id === beforeJoinChat && c.runnerId === selfId),
      30_000,
      "the old chat on the primary",
    );
    const primaryAgents = (await onPrimary<{ id: string; slug: string }[]>("/api/agents")).body;
    const godmode = primaryAgents.find((a) => a.slug === "godmode")!;
    expect(get<{ agent_id: string }>("SELECT agent_id FROM conversations WHERE id = ?", beforeJoinChat)?.agent_id).toBe(godmode.id);
  }, 60_000);

  test("a chat started here to run here works on this computer and shows on both", async () => {
    const res = await here<StartChatResult>("/api/chat", { method: "POST", body: JSON.stringify({ content: "Hello from the laptop", runnerId: selfId }) });
    expect(res.status).toBe(201);
    const id = res.body.conversation.id;
    expect(res.body.conversation.runnerId).toBe(selfId);
    await until(() => runsOf(id).some((r) => r.status === "succeeded"), 30_000, "the run here");
    expect(localChat(id)?.runner_id).toBeNull();
    await until(
      async () => (await onPrimary<{ messages: { role: string; content: string }[] }>(`/api/conversations/${id}`)).body.messages.some((m) => m.role === "assistant" && m.content.includes("Hello")),
      20_000,
      "the answer on the primary",
    );
    const viaApp = (await here<{ runnerId: string; messages: { role: string }[] }>(`/api/conversations/${id}`)).body;
    expect(viaApp.runnerId).toBe(selfId);
    expect(viaApp.messages.some((m) => m.role === "assistant")).toBe(true);
  }, 60_000);

  test("the primary's events reach this computer's windows", async () => {
    const seen: ServerEvent[] = [];
    const ws: HubSocket = {
      data: { id: "ws_test", subscriptions: new Set(), auth: "token" },
      send: (m: string) => void seen.push(JSON.parse(m) as ServerEvent),
      close: () => undefined,
      getBufferedAmount: () => 0,
    };
    websocketHandler.open(ws);
    try {
      await until(() => seen.some((e) => e.type === "hello"), 10_000, "hello");
      const res = await here<StartChatResult>("/api/chat", { method: "POST", body: JSON.stringify({ content: "Runs on the primary" }) });
      expect(res.body.conversation.runnerId).toBeNull();
      const id = res.body.conversation.id;
      await until(() => seen.some((e) => e.type === "run.finished" && e.run.conversationId === id), 30_000, "run.finished from the primary");
      // Not this computer's chat: it works on the primary, this computer keeps a copy for while the primary is away.
      await until(() => localChat(id)?.runner_id === primaryRunnerId(), 20_000, "the copy of the primary's chat");
    } finally {
      websocketHandler.close(ws);
    }
  }, 60_000);

  test("a question asked in a chat on this computer is answered through the primary", async () => {
    const res = await here<StartChatResult>("/api/chat", { method: "POST", body: JSON.stringify({ content: "ASK_HUMAN please", runnerId: selfId }) });
    const id = res.body.conversation.id;
    let question: AgentQuestion | undefined;
    await until(
      async () => {
        question = (await onPrimary<AgentQuestion[]>("/api/questions?status=open")).body.find((q) => q.conversationId === id);
        return !!question;
      },
      30_000,
      "the question on the primary",
    );
    const answered = await here(`/api/questions/${question!.id}/answer`, { method: "POST", body: JSON.stringify({ optionId: question!.options[0]!.id }) });
    expect(answered.status).toBe(200);
    await until(() => runsOf(id).some((r) => r.status === "succeeded"), 30_000, "the run to continue here");
    await until(
      async () => (await onPrimary<AgentQuestion>(`/api/questions/${question!.id}`)).body.status === "answered",
      20_000,
      "the primary's copy to settle",
    );
  }, 90_000);

  test("a shared tool an agent calls here runs on the primary", async () => {
    const chat = all<{ id: string; agent_id: string }>("SELECT id, agent_id FROM conversations WHERE runner_id IS NULL ORDER BY created_at DESC LIMIT 1")[0]!;
    const run = get<{ id: string }>("SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1", chat.id)!;
    const ctx = { runId: run.id, agentId: chat.agent_id, conversationId: chat.id, workspaceId: null, depth: 0 };
    const out = await callTool(ctx, "human_task_create", { title: "Sign the contract", instructions: "Open the PDF and sign it." });
    expect(out.isError).toBeUndefined();
    const tasks = (await onPrimary<{ title: string }[]>("/api/human-tasks")).body;
    expect(tasks.map((t) => t.title)).toContain("Sign the contract");
    // Made there, and then copied here like everything the group shares.
    await until(() => !!get("SELECT id FROM human_tasks WHERE title = ?", "Sign the contract"), 20_000, "the copy of the task");
  }, 60_000);

  test("a chat of the primary moves to this computer with its Claude session and continues here", async () => {
    const started = await onPrimary<StartChatResult>("/api/chat", { method: "POST", body: JSON.stringify({ content: "Start on the desk" }) });
    const id = started.body.conversation.id;
    await until(async () => (await onPrimary<{ status: string }>(`/api/runs/${started.body.run.id}`)).body.status === "succeeded", 30_000, "the first run");

    const moved = await here<Conversation>(`/api/conversations/${id}/move`, { method: "POST", body: JSON.stringify({ to: selfId }) });
    expect(moved.status).toBe(200);
    expect(moved.body.runnerId).toBe(selfId);
    expect(localChat(id)?.runner_id).toBeNull();
    expect(localChat(id)?.claude_session_id).toBeTruthy();

    const sent = await here(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content: "Go on here" }) });
    expect(sent.status).toBe(201);
    await until(() => runsOf(id).filter((r) => r.status === "succeeded").length >= 2, 30_000, "the next run here");
  }, 90_000);

  test("a working chat moves with force: the run stops and the agent continues on the other computer", async () => {
    const started = await onPrimary<StartChatResult>("/api/chat", { method: "POST", body: JSON.stringify({ content: "WAIT_TO_FINISH a long job" }) });
    const id = started.body.conversation.id;
    await sleep(1_500);
    const refused = await here<{ code: string }>(`/api/conversations/${id}/move`, { method: "POST", body: JSON.stringify({ to: selfId }) });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("chat_busy");

    const moved = await here<Conversation>(`/api/conversations/${id}/move`, { method: "POST", body: JSON.stringify({ to: selfId, force: true }) });
    expect(moved.status).toBe(200);
    expect(localChat(id)?.runner_id).toBeNull();
    // The turn that continues it works here and knows why.
    await until(() => runsOf(id).some((r) => r.status === "succeeded"), 30_000, "the continued run");
    const marker = all<{ blocks: string }>("SELECT blocks FROM messages WHERE conversation_id = ?", id).find((m) => m.blocks.includes('"moved"'));
    expect(marker?.blocks).toContain('"continued":true');
  }, 90_000);

  test("handing off before the lid closes moves the work of this computer to the primary", async () => {
    rmSync(join(secondaryDir, "fake-claude", "finish"), { force: true });
    const res = await here<StartChatResult>("/api/chat", { method: "POST", body: JSON.stringify({ content: "WAIT_TO_FINISH on the laptop", runnerId: selfId }) });
    const id = res.body.conversation.id;
    await until(() => runsOf(id).some((r) => r.status === "running"), 20_000, "the run here");
    const handed = await here<{ moved: string[]; failed: unknown[] }>("/api/devices/handoff", { method: "POST", body: JSON.stringify({ from: selfId, to: null }) });
    expect(handed.status).toBe(200);
    expect(handed.body.moved).toContain(id);
    await until(async () => (await onPrimary<Conversation>(`/api/conversations/${id}`)).body.runnerId === null, 20_000, "the chat on the primary");
    // It lives on the primary now; this computer keeps its messages as a copy of it.
    await until(() => localChat(id)?.runner_id === primaryRunnerId(), 20_000, "this computer's chat to become a copy");
  }, 90_000);

  test("when this computer goes away with work running, the primary continues it and this computer drops its copy", async () => {
    rmSync(join(secondaryDir, "fake-claude", "finish"), { force: true });
    const res = await here<StartChatResult>("/api/chat", { method: "POST", body: JSON.stringify({ content: "WAIT_TO_FINISH before the lid closes", runnerId: selfId }) });
    const id = res.body.conversation.id;
    await until(() => runsOf(id).some((r) => r.status === "running"), 20_000, "the run here");
    await until(async () => (await onPrimary<Conversation>(`/api/conversations/${id}`)).body.running === true, 20_000, "the primary to see it work");
    // The lid closes: the primary can't reach this computer anymore.
    stopLinkServer();
    await until(async () => (await onPrimary<Conversation>(`/api/conversations/${id}`)).body.runnerId === null, 30_000, "the primary to take the chat over");
    await until(
      async () => (await onPrimary<{ runs?: unknown; messages: { blocks: { type: string }[] }[] }>(`/api/conversations/${id}`)).body.messages.some((m) => m.blocks.some((b) => b.type === "moved")),
      20_000,
      "the moved marker",
    );
    // The lid opens again: the chat lives on the primary, this computer keeps it as a copy, and what it still did ends.
    startLinkServer({ app, websocket: websocketHandler });
    await until(() => localChat(id)?.runner_id === primaryRunnerId(), 60_000, "this computer's chat to become a copy");
    expect(listActiveRuns().some((r) => r.conversationId === id)).toBe(false);
  }, 120_000);

  let standInChat = "";

  test("while the primary is away this computer keeps every feature, and stands in for it", async () => {
    rmSync(join(primaryDir, "fake-claude", "finish"), { force: true });
    const started = await onPrimary<StartChatResult>("/api/chat", { method: "POST", body: JSON.stringify({ content: "WAIT_TO_FINISH on the desk" }) });
    standInChat = started.body.conversation.id;
    await until(() => localChat(standInChat)?.runner_id === primaryRunnerId(), 20_000, "the copy of the working chat");
    await until(() => (get<{ runner_state: string | null }>("SELECT runner_state FROM conversations WHERE id = ?", standInChat)?.runner_state ?? "").includes('"running":true'), 20_000, "the copy to know it works");

    await stopPrimary();
    await until(() => !forwarding(), 30_000, "the primary to be gone");
    // Nothing is read only: agents, the board and everything else change here.
    const agent = await here<{ id: string; name: string }>("/api/agents", { method: "POST", body: JSON.stringify({ name: "Offline agent" }) });
    expect(agent.status).toBeLessThan(300);
    const ticket = await here<{ id: string }>("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Written on the laptop" }) });
    expect(ticket.status).toBeLessThan(300);
    expect((await here<{ name: string }[]>("/api/agents")).body.map((a) => a.name)).toContain("Researcher");

    // A moment later it stands in: the shared work runs here, and the chat that worked on the primary continues here.
    await until(async () => (await here<DeviceGroup>("/api/devices")).body.standIn.state === "active", 20_000, "standing in");
    expect(runsShared()).toBe(true);
    expect((await here<DeviceGroup>("/api/devices")).body.pendingChanges).toBeGreaterThan(0);
    await until(() => localChat(standInChat)?.runner_id === null, 20_000, "the primary's chat to continue here");
    await until(() => runsOf(standInChat).some((r) => r.status === "succeeded"), 30_000, "the continued run here");
  }, 120_000);

  test("when the primary is back, what changed here is there, its chat stays here, and standing in ends", async () => {
    await startPrimary();
    primaryToken = Bun.spawnSync([process.execPath, INDEX, "token", "--data-dir", primaryDir], { env: childEnvFor(), stdout: "pipe" }).stdout.toString().trim();
    await until(() => forwarding(), 60_000, "the primary to be back");
    expect(runsShared()).toBe(false);
    expect((await here<DeviceGroup>("/api/devices")).body.standIn.state).toBe("off");
    await until(async () => (await onPrimary<{ name: string }[]>("/api/agents")).body.some((a) => a.name === "Offline agent"), 30_000, "the new agent on the primary");
    await until(async () => (await onPrimary<{ title: string }[]>("/api/tasks")).body.some((t) => t.title === "Written on the laptop"), 30_000, "the ticket on the primary");
    // The chat continued here while the primary was away: it lives here now, and the primary shows it as this computer's.
    await until(async () => (await onPrimary<Conversation>(`/api/conversations/${standInChat}`)).body.runnerId === selfId, 30_000, "the primary to hand the chat over");
    expect(localChat(standInChat)?.runner_id).toBeNull();
    await until(async () => (await here<DeviceGroup>("/api/devices")).body.pendingChanges === 0, 30_000, "everything to be taken");
    // The primary didn't pick the chat up again after its restart: every run it shows there is one of this computer's.
    await sleep(3_000);
    const theirs = (await onPrimary<{ id: string }[]>(`/api/runs?conversationId=${standInChat}&limit=50`)).body.map((r) => r.id);
    const mine = new Set(runsOf(standInChat).map((r) => r.id));
    expect(theirs.filter((id) => !mine.has(id))).toEqual([]);
  }, 150_000);

  test("leaving makes both computers a Godmode of their own again", async () => {
    const left = await here<DeviceGroup>("/api/devices/leave", { method: "POST" });
    expect(left.status).toBe(200);
    expect(left.body.role).toBeNull();
    expect(groupRole()).toBeNull();
    await until(async () => (await onPrimary<DeviceGroup>("/api/devices")).body.role === null, 20_000, "the primary to be alone");
    expect(existsSync(secondaryDir)).toBe(true);
  }, 60_000);
});
