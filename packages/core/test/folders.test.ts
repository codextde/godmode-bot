import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Agent, Conversation, FolderListing } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { createAgent, getAgent, updateAgent } from "../src/agents/service";
import { getAccessToken } from "../src/server/auth";
import { createConversation, getConversation, sendMessage, startChat, updateConversation } from "../src/services/conversations";
import { listFolders, normalizeWorkingDirectory, recentFolders } from "../src/services/folders";
import { waitForRun } from "../src/runner/runner";
import { run as sql } from "../src/db";

let env: TestEnv;
let agent: Agent;
let root: string;
let project: string;
let other: string;

beforeAll(async () => {
  env = await setupEnv("godmode-folders-");
  root = mkdtempSync(join(tmpdir(), "godmode-folder-root-"));
  project = join(root, "project");
  other = join(root, "other");
  for (const dir of [project, other, join(root, ".hidden"), join(project, ".git")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "notes.txt"), "not a folder");
  agent = await makeAgent({ name: "Folder Bot" });
});

afterAll(async () => {
  await env.close();
  rmSync(root, { recursive: true, force: true });
});

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${getAccessToken()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

describe("working folder validation", () => {
  test("accepts existing absolute folders and normalizes them", () => {
    expect(normalizeWorkingDirectory(`${project}/../project/`)).toBe(project);
    expect(normalizeWorkingDirectory("  ")).toBeNull();
    expect(normalizeWorkingDirectory(null)).toBeNull();
  });

  test("rejects relative, missing and file paths, and Godmode's data directory", () => {
    expect(() => normalizeWorkingDirectory("project")).toThrow(/absolute/);
    expect(() => normalizeWorkingDirectory(join(root, "missing"))).toThrow(/not found/);
    expect(() => normalizeWorkingDirectory(join(root, "notes.txt"))).toThrow(/not found/);
    expect(() => normalizeWorkingDirectory(agent.repoPath)).toThrow(/data directory/);
    expect(() => normalizeWorkingDirectory(env.dataDir)).toThrow(/data directory/);
    expect(() => normalizeWorkingDirectory(dirname(env.dataDir))).toThrow(/more specific/);
    expect(() => normalizeWorkingDirectory("/")).toThrow(/more specific/);
  });

  test("agents cannot set folders for other agents", async () => {
    const created = await createAgent({ name: "Agent Made", workingDirectory: project }, "agent:agt_orchestrator");
    expect(created.workingDirectory).toBeNull();
    const updated = await updateAgent(created.id, { workingDirectory: project }, "agent:agt_orchestrator");
    expect(updated.workingDirectory).toBeNull();
    expect((await updateAgent(created.id, { workingDirectory: project })).workingDirectory).toBe(project);
  });

  test("saving an agent whose folder disappeared keeps working until the folder is changed", async () => {
    const temp = join(root, "temporary");
    mkdirSync(temp);
    const bot = await createAgent({ name: "Vanishing Folder", workingDirectory: temp });
    rmSync(temp, { recursive: true });
    expect((await updateAgent(bot.id, { name: "Renamed", workingDirectory: temp })).name).toBe("Renamed");
    await expect(updateAgent(bot.id, { workingDirectory: join(root, "nope") })).rejects.toThrow(/not found/);
  });
});

describe("runs in a folder", () => {
  test("a chat started in a folder runs there, with the agent repo added and named in the prompt", async () => {
    const started = await startChat({ agentId: agent.id, content: "Look around", workingDirectory: project });
    expect(started.conversation.workingDirectory).toBe(project);
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");

    const inv = invocations(env).at(-1)!;
    expect(realpathSync(inv.cwd)).toBe(realpathSync(project));
    expect(argValue(inv, "--add-dir")).toBe(agent.repoPath);
    expect(inv.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
    const system = argValue(inv, "--append-system-prompt")!;
    expect(system).toContain(`Working directory: \`${project}\``);
    expect(system).toContain(join(agent.repoPath, "MEMORY.md"));

    const data = Buffer.from("hi").toString("base64");
    const { run, message } = await sendMessage(started.conversation.id, {
      content: "Read this",
      attachments: [{ name: "a.txt", mime: "text/plain", data }],
    });
    await waitForRun(run.id, 20_000);
    const next = invocations(env).at(-1)!;
    expect(next.prompt).toContain(`Working directory: \`${project}\``);
    expect(next.prompt.endsWith(`Attached files: ${join(agent.repoPath, message.attachments[0]!.path)}`)).toBe(true);
  });

  test("chats without a folder keep running in the agent repo", async () => {
    const { run } = await startChat({ agentId: agent.id, content: "Hello" });
    await waitForRun(run.id, 20_000);
    const inv = invocations(env).at(-1)!;
    expect(realpathSync(inv.cwd)).toBe(realpathSync(agent.repoPath));
    expect(inv.args).not.toContain("--add-dir");
    expect(inv.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBeNull();
  });

  test("the agent's folder is the default; a chat can override it and switch back", async () => {
    const bot = await makeAgent({ name: "Default Folder Bot", workingDirectory: other });
    expect(bot.workingDirectory).toBe(other);
    const conv = createConversation({ agentId: bot.id });
    expect(conv.workingDirectory).toBeNull();

    const first = await sendMessage(conv.id, { content: "one" });
    await waitForRun(first.run.id, 20_000);
    expect(realpathSync(invocations(env).at(-1)!.cwd)).toBe(realpathSync(other));

    updateConversation(conv.id, { workingDirectory: project });
    const second = await sendMessage(conv.id, { content: "two" });
    await waitForRun(second.run.id, 20_000);
    const resumed = invocations(env).at(-1)!;
    expect(realpathSync(resumed.cwd)).toBe(realpathSync(project));
    expect(resumed.prompt).toContain(`Working directory: \`${project}\``);

    expect(updateConversation(conv.id, { workingDirectory: null }).workingDirectory).toBeNull();
    const third = await sendMessage(conv.id, { content: "three" });
    await waitForRun(third.run.id, 20_000);
    expect(realpathSync(invocations(env).at(-1)!.cwd)).toBe(realpathSync(other));
  });

  test("a folder that disappeared fails the run with a clear message", async () => {
    const gone = join(root, "gone");
    mkdirSync(gone);
    const conv = createConversation({ agentId: agent.id, workingDirectory: gone });
    rmSync(gone, { recursive: true });
    const before = invocations(env).length;
    const { run } = await sendMessage(conv.id, { content: "Anyone there?" });
    const finished = await waitForRun(run.id, 20_000);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain(`The folder ${gone} doesn't exist anymore. Pick another folder for this chat.`);
    expect(invocations(env).length).toBe(before);
  });

  test("folders are re-checked at run time: overlapping the data directory or a vanished agent default", async () => {
    const conv = createConversation({ agentId: agent.id });
    sql("UPDATE conversations SET working_directory = ? WHERE id = ?", dirname(env.dataDir), conv.id);
    const risky = await sendMessage(conv.id, { content: "Hi" });
    expect((await waitForRun(risky.run.id, 20_000)).error).toContain("more specific folder");

    const temp = join(root, "agent-default");
    mkdirSync(temp);
    const bot = await makeAgent({ name: "Vanished Default Bot", workingDirectory: temp });
    rmSync(temp, { recursive: true });
    const { run } = await startChat({ agentId: bot.id, content: "Hi" });
    expect((await waitForRun(run.id, 20_000)).error).toContain("Change the default folder in Vanished Default Bot's settings.");
  });
});

describe("folder routes", () => {
  test("list subfolders without hidden ones, flagging git repositories", async () => {
    const { status, data } = await call<FolderListing>("GET", `/api/folders?path=${encodeURIComponent(root)}`);
    expect(status).toBe(200);
    expect(data.path).toBe(root);
    expect(data.parent).toBe(join(root, ".."));
    expect(data.entries.map((e) => e.name)).toEqual(["other", "project"]);
    expect(data.entries.find((e) => e.name === "project")!.git).toBe(true);
    expect(data.roots.length).toBeGreaterThan(0);
    expect(listFolders(root, true).entries.map((e) => e.name)).toContain(".hidden");
    expect(data.blocked).toBeNull();
    expect(data.entries.every((e) => !e.blocked)).toBe(true);

    const parent = listFolders(dirname(env.dataDir), true);
    expect(parent.blocked).toContain("more specific");
    expect(parent.entries.find((e) => e.path === env.dataDir)!.blocked).toBe(true);
  });

  test("errors for missing and relative paths; home by default", async () => {
    expect((await call("GET", `/api/folders?path=${encodeURIComponent(join(root, "missing"))}`)).status).toBe(404);
    expect((await call("GET", "/api/folders?path=relative/dir")).status).toBe(400);
    const home = await call<FolderListing>("GET", "/api/folders");
    expect(home.data.path).toBe(home.data.home);
  });

  test("conversation and agent routes validate folders", async () => {
    const conv = createConversation({ agentId: agent.id });
    const bad = await call<{ error: string }>("PATCH", `/api/conversations/${conv.id}`, { workingDirectory: join(root, "missing") });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("Folder not found");
    const ok = await call<Conversation>("PATCH", `/api/conversations/${conv.id}`, { workingDirectory: `${other}/` });
    expect(ok.data.workingDirectory).toBe(other);
    expect(getConversation(conv.id).workingDirectory).toBe(other);

    const patched = await call<Agent>("PATCH", `/api/agents/${agent.id}`, { workingDirectory: project });
    expect(patched.data.workingDirectory).toBe(project);
    expect((await call<Agent>("PATCH", `/api/agents/${agent.id}`, { workingDirectory: null })).data.workingDirectory).toBeNull();
    expect(getAgent(agent.id).workingDirectory).toBeNull();
  });

  test("recent folders come from chats and agents, newest first, existing only", async () => {
    const recent = await call<string[]>("GET", "/api/folders/recent");
    expect(recent.data).toContain(project);
    expect(recent.data).toContain(other);
    expect(recent.data).not.toContain(join(root, "gone"));
    expect(recentFolders(1)).toHaveLength(1);
  });
});
