/**
 * `chat_handoff` and `/handoff`: a long chat goes on in a fresh one. The agent writes a brief, Godmode opens a new chat
 * with the same setup that starts from the brief alone, and the two chats link to each other.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { handoffCommand } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { run as sql } from "../src/db";
import { callTool } from "../src/mcp/tools";
import { createConversation, getConversation, listMessages, sendMessage, startChat } from "../src/services/conversations";
import { submitMessage } from "../src/services/messageQueue";
import { handOff } from "../src/services/handoff";
import { listRuns, waitForRun } from "../src/runner/runner";

let env: TestEnv;
let agent: Agent;
let configDir: string;
const configBefore = process.env.CLAUDE_CONFIG_DIR;

const BRIEF =
  "Goal: ship the mobile checkout layout. Done: PR #12 merged (desktop layout), branch feat/mobile-checkout has the grid. Next: fix the sticky total on iOS Safari, then merge to main. Daniel wants no new colors.";

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "godmode-handoff-claude-"));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  env = await setupEnv("godmode-handoff-");
  agent = await makeAgent({ name: "Handoff Bot" });
});

afterAll(async () => {
  await env.close();
  if (configBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configBefore;
  rmSync(configDir, { recursive: true, force: true });
});

const ctxFor = (conversationId: string, runId = "run_handoff_test") => ({ runId, agentId: agent.id, conversationId, workspaceId: null, depth: 0 });

async function chat(content = "Build the checkout"): Promise<string> {
  const { conversation, run } = await startChat({ agentId: agent.id, content });
  await waitForRun(run.id, 20_000);
  return conversation.id;
}

const invocationOf = (prompt: string) => invocations(env).find((i) => i.prompt.includes(prompt));

describe("/handoff", () => {
  test("is Godmode's command, with what the new chat is for", () => {
    expect(handoffCommand("/handoff")).toBe("");
    expect(handoffCommand("  /handoff only the mobile layout\nand tests")).toBe("only the mobile layout\nand tests");
    expect(handoffCommand("/handoffs")).toBeNull();
    expect(handoffCommand("please /handoff")).toBeNull();
  });

  test("asks the agent for a brief instead of reaching Claude Code as a command", async () => {
    const id = await chat();
    const { run } = await sendMessage(id, { content: "/handoff only the mobile layout" });
    await waitForRun(run.id, 20_000);
    const inv = invocationOf("only the mobile layout")!;
    expect(inv.prompt).toContain("<godmode-handoff>");
    expect(inv.prompt).toContain("chat_handoff");
    expect(inv.prompt.trimStart().startsWith("/")).toBe(false);
    expect(listMessages(id).some((m) => m.role === "user" && m.content === "/handoff only the mobile layout")).toBe(true);
  });

  test("is refused in a chat that can't go on in a new one", async () => {
    const priv = createConversation({ agentId: agent.id, title: "Secret", private: true });
    await expect(submitMessage(priv.id, { content: "/handoff" })).rejects.toThrow(/can't go on in a new chat/);
    const task = createConversation({ agentId: agent.id, title: "Ticket", origin: "task" });
    await expect(submitMessage(task.id, { content: "/handoff" })).rejects.toThrow(/can't go on in a new chat/);
  });
});

describe("chat_handoff", () => {
  test("opens a new chat with this chat's setup that starts fresh from the brief", async () => {
    const from = await chat("Build the checkout");
    sql("UPDATE conversations SET instructions = ?, effort = ?, title = ? WHERE id = ?", "Answer in German", "high", "Checkout", from);

    const res = await callTool(ctxFor(from), "chat_handoff", { title: "Checkout: mobile layout", brief: BRIEF });
    expect(res.isError).toBeFalsy();
    const id = /\((cnv_[A-Za-z0-9_-]+)\)/.exec(res.content[0]!.text)?.[1];
    expect(id).toBeTruthy();

    const fresh = getConversation(id!);
    expect(fresh.title).toBe("Checkout: mobile layout");
    expect(fresh.agentId).toBe(agent.id);
    expect(fresh.origin).toBe("chat");
    expect(fresh.instructions).toBe("Answer in German");
    expect(fresh.effort).toBe("high");
    expect(fresh.continuedFrom).toEqual({ conversationId: from, title: "Checkout" });
    expect(getConversation(from).continuedFrom).toBeNull();
    expect(getConversation(from).archived).toBe(false);

    const first = fresh.messages.find((m) => m.role === "user")!;
    expect(first.source).toBe("handoff");
    expect(first.content).toBe(BRIEF);

    const run = listRuns({ conversationId: id! })[0]!;
    await waitForRun(run.id, 20_000);
    const inv = invocationOf("sticky total on iOS Safari")!;
    expect(inv.prompt).toContain(`continues "Checkout" (${from})`);
    expect(argValue(inv, "--resume")).toBeNull();
    expect(argValue(inv, "--session-id")).toBe(getConversation(id!).claudeSessionId);
    expect(getConversation(id!).claudeSessionId).not.toBe(getConversation(from).claudeSessionId);
  });

  test("a deleted earlier chat leaves no link", async () => {
    const from = await chat();
    const { conversation } = await handOff({ from, title: "Next part", brief: BRIEF });
    sql("DELETE FROM conversations WHERE id = ?", from);
    expect(getConversation(conversation.id).continuedFrom).toBeNull();
  });

  test("moves a /goal along: the new chat sets it again after the brief", async () => {
    const from = await chat();
    const sessionId = getConversation(from).claudeSessionId!;
    const dir = join(configDir, "projects", "-tmp-handoff");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "attachment", attachment: { type: "goal_status", met: false, sentinel: true, condition: "ship the report" } })}\n`);

    const res = await callTool(ctxFor(from), "chat_handoff", { title: "Report", brief: BRIEF });
    expect(res.content[0]!.text).toContain("/goal moved along");
    const id = /\((cnv_[A-Za-z0-9_-]+)\)/.exec(res.content[0]!.text)![1]!;
    await until(() => listRuns({ conversationId: id }).length === 2, 10_000, "two runs");
    for (const r of listRuns({ conversationId: id })) await waitForRun(r.id, 20_000);
    const users = listMessages(id).filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual([BRIEF, "/goal ship the report"]);
    expect(users.every((m) => m.source === "handoff")).toBe(true);
  });

  test("refuses a thin brief and chats that aren't the human's own", async () => {
    const from = await chat();
    const thin = await callTool(ctxFor(from), "chat_handoff", { title: "Next", brief: "Go on." });
    expect(thin.isError).toBe(true);
    expect(thin.content[0]!.text).toContain("real brief");

    const task = createConversation({ agentId: agent.id, title: "Ticket", origin: "task" });
    const refused = await callTool(ctxFor(task.id), "chat_handoff", { title: "Next", brief: BRIEF });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("not available");
  });
});

describe("a long chat", () => {
  test("tells the agent to start separate work in a fresh chat", async () => {
    const id = await chat();
    const system = argValue(invocations(env).at(-1)!, "--append-system-prompt") ?? "";
    expect(system).toContain("### Fresh chats");

    sql("UPDATE conversations SET context_tokens = ? WHERE id = ?", 120_000, id);
    await waitForRun((await sendMessage(id, { content: "Short chat question" })).run.id, 20_000);
    expect(invocationOf("Short chat question")!.prompt).not.toContain("chat_handoff");

    sql("UPDATE conversations SET context_tokens = ? WHERE id = ?", 312_000, id);
    await waitForRun((await sendMessage(id, { content: "Long chat question" })).run.id, 20_000);
    const prompt = invocationOf("Long chat question")!.prompt;
    expect(prompt).toContain("312k tokens");
    expect(prompt).toContain("chat_handoff");
  });
});
