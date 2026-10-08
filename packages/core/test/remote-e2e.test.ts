/**
 * A real runner (a child process: `godmode runner serve`) and a controller (this process) end to end: pairing with
 * the code `godmode runner pair` prints, the setup copy, a chat that works on the runner and shows up here live, the
 * runner going away and coming back, and catching up on what finished while nobody listened.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, ServerEvent, StartChatResult } from "@godmode/shared";
import { loadConfig, config } from "../src/config";
import { all, closeDb, get, openDb, setMeta } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import { ensureDefaultAgent } from "../src/agents/service";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { createCredential } from "../src/vault/credentials";
import * as vault from "../src/vault/vault";
import { connectRunner, getRunner, link, listRunners, pairWithCode, removeRunner, startAutofix, startRunners, stopRunners } from "../src/remote/runners";
import { Database } from "bun:sqlite";
import { callTool, listToolsFor } from "../src/mcp/tools";
import { getAgent } from "../src/agents/service";
import { childEnv, sleep } from "../src/util";
import { __setClaudeBinaryForTests, cancelRun, listActiveRuns, waitForRun } from "../src/runner/runner";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const FAKE_CLAUDE = join(import.meta.dir, "fixtures", "fake-claude.ts");

let runnerDir: string;
let controllerDir: string;
let child: ReturnType<typeof Bun.spawn> | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
let app: ReturnType<typeof createApp>;
let runnerId: string;
let agentId: string;
const events: ServerEvent[] = [];

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 20_000, what = "condition") {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

function env() {
  // No installs and no keychain items on the machine that runs the tests.
  return childEnv({ GODMODE_RUNNER_BOOTSTRAP: "0", GODMODE_KEYCHAIN: "0", GODMODE_LOG_LEVEL: "error", FAKE_CLAUDE_STATE: join(runnerDir, "fake-claude") }) as Record<string, string>;
}

/** Start the runner and wait until it says it is ready. */
async function startChild() {
  child = Bun.spawn([process.execPath, INDEX, "runner", "serve", "--data-dir", runnerDir, "--port", "0"], { env: env(), stdout: "pipe", stderr: "pipe" });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let out = "";
  const end = Date.now() + 30_000;
  while (!out.includes("GODMODE_READY ")) {
    if (Date.now() > end) throw new Error(`runner did not start:\n${out}`);
    const { done, value } = await reader.read();
    if (done) throw new Error(`runner exited:\n${out}\n${await new Response(child.stderr as ReadableStream).text()}`);
    out += new TextDecoder().decode(value);
  }
  // Keep draining so the child never blocks on a full pipe.
  void (async () => {
    for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return;
  })();
  void new Response(child.stderr as ReadableStream).text().catch(() => undefined);
}

async function stopChild() {
  if (!child) return;
  child.kill("SIGTERM");
  await Promise.race([child.exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  child = null;
}

function api(path: string, init: RequestInit = {}) {
  return app.request(`http://127.0.0.1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${getAccessToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

beforeAll(async () => {
  setLogLevel("error");
  runnerDir = mkdtempSync(join(tmpdir(), "godmode-e2e-runner-"));
  controllerDir = mkdtempSync(join(tmpdir(), "godmode-e2e-controller-"));

  // The runner's data dir: the fake Claude Code instead of the real one, and any free port for the link.
  loadConfig({ dataDir: runnerDir, role: "runner" });
  openDb(join(runnerDir, "godmode.db"));
  resetSettingsCache();
  const claude = join(runnerDir, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(claude, 0o755);
  updateSettings({ runner: { claudePath: claude }, browser: { enabled: false }, memory: { autoCommit: false } });
  setMeta("link.port", "0");
  closeDb();
  resetSettingsCache();

  await startChild();
  const pair = Bun.spawnSync([process.execPath, INDEX, "runner", "pair", "--data-dir", runnerDir], { env: env(), stdout: "pipe", stderr: "pipe" });
  const code = /gmr1\.[A-Za-z0-9_-]+/.exec(pair.stdout.toString())?.[0];
  if (!code) throw new Error(`no pairing code:\n${pair.stdout.toString()}\n${pair.stderr.toString()}`);

  // This process is the controller. Its own runs (the fix-with-Claude chat) use the fake Claude Code too: never the
  // real one, which would work with bypassed permissions on this machine.
  process.env.FAKE_CLAUDE_STATE = join(controllerDir, "fake-claude");
  __setClaudeBinaryForTests([process.execPath, FAKE_CLAUDE]);
  loadConfig({ dataDir: controllerDir });
  openDb(join(controllerDir, "godmode.db"));
  resetSettingsCache();
  updateSettings({ browser: { enabled: false }, memory: { autoCommit: false } });
  app = createApp();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, srv) => app.fetch(req, { server: srv }) });
  config().port = server.port!;
  agentId = (await ensureDefaultAgent()).id;
  await vault.setup("correct horse battery", false);
  createCredential({ name: "Billing portal", url: "https://billing.example.com", username: "me@example.com", password: "s3cret-Passw0rd!" });
  bus.on((e) => events.push(e));
  startRunners();

  const runner = await pairWithCode(code);
  runnerId = runner.id;
  await until(() => getRunner(runnerId).state === "online", 20_000, "runner online");
  await until(() => getRunner(runnerId).sync.state === "synced", 30_000, "setup copied");
}, 120_000);

afterAll(async () => {
  for (const r of listActiveRuns()) {
    await cancelRun(r.runId);
    await waitForRun(r.runId, 10_000);
  }
  __setClaudeBinaryForTests(null);
  stopRunners();
  await stopChild();
  server?.stop(true);
  closeDb();
  resetSettingsCache();
  rmSync(runnerDir, { recursive: true, force: true });
  rmSync(controllerDir, { recursive: true, force: true });
}, 30_000);

describe("a runner, end to end", () => {
  test("pairing stored the runner with its key; the runner knows this computer", () => {
    const r = getRunner(runnerId);
    expect(r.fingerprint).toMatch(/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
    expect(r.version).toBe(config().version);
  });

  test("the setup and the vault key are on the runner: its vault is open and it lists the login", async () => {
    const info = await link(runnerId).json<{ vault: { unlocked: boolean } }>("GET", "/api/link/info");
    expect(info.vault.unlocked).toBe(true);
    const logins = await link(runnerId).json<{ name: string }[]>("GET", "/api/credentials?workspaceId=all");
    expect(logins.map((l) => l.name)).toContain("Billing portal");
  });

  test("a chat started on the runner works there and shows up here live, under the runner's ids", async () => {
    events.length = 0;
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ content: "Hello there", agentId, runnerId }) });
    expect(res.status).toBe(201);
    const started = (await res.json()) as StartChatResult;
    expect(started.conversation.runnerId).toBe(runnerId);
    const id = started.conversation.id;

    await until(() => events.some((e) => e.type === "run.finished" && e.run.conversationId === id), 30_000, "run.finished");
    expect(events.some((e) => e.type === "run.delta" && e.conversationId === id)).toBe(true);

    const local = get<{ runner_id: string }>("SELECT runner_id FROM conversations WHERE id = ?", id);
    expect(local?.runner_id).toBe(runnerId);
    await until(
      () => all<{ role: string; content: string }>("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", id).some((m) => m.role === "assistant" && m.content.includes("Hello")),
      10_000,
      "assistant message copied",
    );
    const run = get<{ status: string }>("SELECT status FROM runs WHERE id = ?", started.run.id);
    expect(run?.status).toBe("succeeded");

    const viaApi = (await (await api(`/api/conversations/${id}`)).json()) as { runnerId: string; messages: Message[] };
    expect(viaApi.runnerId).toBe(runnerId);
    expect(viaApi.messages.map((m) => m.id)).toContain(started.message.id);
  }, 60_000);

  test("a turn that failed on the runner is tried again there, from here", async () => {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ content: "CRASH on the runner", agentId, runnerId }) });
    const { conversation, run } = (await res.json()) as StartChatResult;
    await until(() => get<{ status: string }>("SELECT status FROM runs WHERE id = ?", run.id)?.status === "failed", 30_000, "the run to fail");
    const retried = await api(`/api/conversations/${conversation.id}/retry`, { method: "POST", body: JSON.stringify({ runId: run.id }) });
    expect(retried.status).toBe(201);
    const again = (await retried.json()) as { mode: string; run: { id: string } };
    expect(again.mode).toBe("again");
    await until(() => !!get<{ status: string }>("SELECT status FROM runs WHERE id = ? AND status IN ('failed', 'succeeded')", again.run.id), 30_000, "the retry to end");
  }, 60_000);

  test("the fix-with-Claude chat runs here, gets the runner tools, and runner_exec runs on the runner", async () => {
    const started = await startAutofix(runnerId, { note: "It seems stuck" });
    expect(started.conversation.runnerId).toBeNull();
    expect(started.conversation.runnerToolsId).toBe(runnerId);
    const prompt = get<{ content: string }>("SELECT content FROM messages WHERE id = ?", started.message.id)!.content;
    expect(prompt).toContain("Health report:");
    expect(prompt).toContain("It seems stuck");
    const ctx = { runId: started.run.id, agentId, conversationId: started.conversation.id, workspaceId: null, depth: 0 };
    const names = listToolsFor(getAgent(agentId), ctx as never).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["runner_exec", "runner_health", "runner_fix"]));
    const out = await callTool(ctx as never, "runner_exec", { command: "pwd && echo on-the-runner" });
    expect(out.isError).toBeUndefined();
    expect(out.content[0]!.text).toContain("on-the-runner");
    expect(out.content[0]!.text).toContain(runnerDir.split("/").pop()!);
    // The chat's own run is the fake Claude Code's: it is done before the next test.
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
    expect(get<{ content: string }>("SELECT content FROM messages WHERE run_id = ? AND role = 'assistant'", started.run.id)?.content).toContain("Hello");
    // An ordinary chat doesn't get them.
    const chatId = all<{ id: string }>("SELECT id FROM conversations WHERE runner_id = ?", runnerId)[0]!.id;
    const plain = listToolsFor(getAgent(agentId), { ...ctx, conversationId: chatId } as never).map((t) => t.name);
    expect(plain).not.toContain("runner_exec");
  }, 60_000);

  test("while the runner is away its chat answers runner_offline; when it is back the chat continues", async () => {
    const id = all<{ id: string }>("SELECT id FROM conversations WHERE runner_id = ?", runnerId)[0]!.id;
    await stopChild();
    await until(() => getRunner(runnerId).state !== "online", 10_000, "offline");
    const refused = await api(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content: "Are you there?" }) });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("runner_offline");
    // The copy here still answers.
    expect((await api(`/api/conversations/${id}`)).status).toBe(200);

    await startChild();
    connectRunner(runnerId);
    await until(() => getRunner(runnerId).state === "online", 20_000, "back online");
    const sent = await api(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content: "Still there?" }) });
    expect(sent.status).toBe(201);
    await until(() => (get<{ c: number }>("SELECT COUNT(*) AS c FROM runs WHERE conversation_id = ? AND status = 'succeeded'", id)?.c ?? 0) >= 2, 30_000, "second run");
  }, 90_000);

  test("deleting a runner's chat removes it there and here, and answers ok", async () => {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ content: "A chat to delete", agentId, runnerId }) });
    const { conversation, run } = (await res.json()) as StartChatResult;
    await until(() => get<{ status: string }>("SELECT status FROM runs WHERE id = ?", run.id)?.status === "succeeded", 30_000, "run done");
    const deleted = await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(get("SELECT id FROM conversations WHERE id = ?", conversation.id)).toBeNull();
    const gone = await link(runnerId).request("GET", `/api/conversations/${conversation.id}`);
    expect(gone.status).toBe(404);
  }, 60_000);

  test("a chat the runner no longer has is still readable here", async () => {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ content: "A chat the runner loses", agentId, runnerId }) });
    const { conversation, run } = (await res.json()) as StartChatResult;
    await until(() => get<{ status: string }>("SELECT status FROM runs WHERE id = ?", run.id)?.status === "succeeded", 30_000, "run done");
    // Deleted on the runner behind this computer's back (its event is dropped by pausing the link).
    stopRunners();
    const runnerToken = (await Bun.file(join(runnerDir, "access-token")).text()).trim();
    const apiPort = (JSON.parse(await Bun.file(join(runnerDir, "runner.json")).text()) as { apiPort: number }).apiPort;
    const direct = await fetch(`http://127.0.0.1:${apiPort}/api/conversations/${conversation.id}`, { method: "DELETE", headers: { authorization: `Bearer ${runnerToken}` } });
    expect(direct.status).toBe(200);
    startRunners();
    await until(() => getRunner(runnerId).state === "online", 20_000, "reconnected");
    const read = await api(`/api/conversations/${conversation.id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { messages: Message[] }).messages.length).toBeGreaterThanOrEqual(2);
  }, 90_000);

  test("what finished while this computer wasn't listening is caught up on reconnect", async () => {
    const id = all<{ id: string }>("SELECT id FROM conversations WHERE runner_id = ?", runnerId)[0]!.id;
    const sent = await api(`/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content: "WAIT_TO_FINISH then answer" }) });
    expect(sent.status).toBe(201);
    const { run } = (await sent.json()) as { run: { id: string } };
    await until(() => !!get("SELECT id FROM runs WHERE id = ?", run.id), 10_000, "run copied");

    stopRunners();
    writeFileSync(join(runnerDir, "fake-claude", "finish"), "");
    // Give the runner time to finish without anyone listening.
    await sleep(3_000);
    expect(get<{ status: string }>("SELECT status FROM runs WHERE id = ?", run.id)?.status).not.toBe("succeeded");

    startRunners();
    await until(() => getRunner(runnerId).state === "online", 20_000, "reconnected");
    await until(() => get<{ status: string }>("SELECT status FROM runs WHERE id = ?", run.id)?.status === "succeeded", 20_000, "caught up");
    const answer = get<{ content: string }>("SELECT content FROM messages WHERE run_id = ? AND role = 'assistant'", run.id);
    expect(answer?.content).toContain("finished");
    expect(existsSync(join(runnerDir, "fake-claude", "finish"))).toBe(true);
  }, 90_000);

  test("the runner tells its build and tools; one running from source refuses a new program with a clear answer", async () => {
    const runner = getRunner(runnerId);
    expect(runner.build).toBeTruthy();
    expect(runner.update).toMatchObject({ state: "current", autoUpdate: true, target: { version: runner.version } });
    const report = await link(runnerId).json<{ tools: unknown[] }>("GET", "/api/link/updates");
    expect(Array.isArray(report.tools)).toBe(true);
    const res = await link(runnerId).request("PUT", "/api/link/update/chunk?offset=0&total=4", { body: new Uint8Array([1, 2, 3, 4]), headers: { "content-type": "application/octet-stream" } });
    expect(res.status).toBe(409);
    expect(JSON.parse(Buffer.from(res.body).toString("utf8"))).toMatchObject({ code: "runner_from_source" });
    const off = await api(`/api/runners/${runnerId}`, { method: "PATCH", body: JSON.stringify({ autoUpdate: false }) });
    expect(((await off.json()) as { update: { autoUpdate: boolean } }).update.autoUpdate).toBe(false);
  }, 120_000);

  test("removing the runner makes it forget this computer; its chats stay here as this computer's", async () => {
    const chats = all<{ id: string }>("SELECT id FROM conversations WHERE runner_id = ?", runnerId).map((c) => c.id);
    expect(chats.length).toBeGreaterThan(0);
    // A runner's word about servers doesn't survive it.
    const { run } = await import("../src/db");
    run("UPDATE conversations SET ssh_server_ids = '[\"ssh_fromrunner\"]' WHERE id = ?", chats[0]!);
    await removeRunner(runnerId);
    expect(listRunners()).toEqual([]);
    for (const id of chats) {
      const row = get<{ runner_id: string | null; ssh_server_ids: string }>("SELECT runner_id, ssh_server_ids FROM conversations WHERE id = ?", id);
      expect(row).toEqual({ runner_id: null, ssh_server_ids: "[]" });
    }
    await sleep(500);
    const runnerDb = new Database(join(runnerDir, "godmode.db"), { readonly: true });
    expect(runnerDb.query("SELECT COUNT(*) AS c FROM link_controllers").get()).toEqual({ c: 0 });
    runnerDb.close();
  }, 30_000);
});
