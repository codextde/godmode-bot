import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { parseSlashCommand } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { getConversation, sendMessage, startChat } from "../src/services/conversations";
import { waitForRun } from "../src/runner/runner";
import { __clearSlashCommandCache, listSlashCommands } from "../src/runner/commands";
import { StreamAccumulator } from "../src/runner/stream";
import { getAccessToken } from "../src/server/auth";
import { run as sql } from "../src/db";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-slash-");
  agent = await makeAgent({ name: "Slash Bot" });
});

afterAll(async () => {
  await env.close();
});

async function send(conversationId: string, content: string) {
  const { run } = await sendMessage(conversationId, { content });
  const finished = await waitForRun(run.id, 20_000);
  expect(finished.status).toBe("succeeded");
  return { finished, inv: invocations(env).at(-1)!, conv: getConversation(conversationId) };
}

describe("parseSlashCommand", () => {
  test("splits name and arguments", () => {
    expect(parseSlashCommand("/goal ship the report\nby friday")).toEqual({ name: "goal", args: "ship the report\nby friday" });
    expect(parseSlashCommand("  /context  ")).toEqual({ name: "context", args: "" });
    expect(parseSlashCommand("/my-plugin:do-it now")).toEqual({ name: "my-plugin:do-it", args: "now" });
  });

  test("ignores plain text and paths", () => {
    expect(parseSlashCommand("hello /goal")).toBeNull();
    expect(parseSlashCommand("/Users/me/report.pdf what is this?")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
  });
});

describe("StreamAccumulator — local slash commands", () => {
  test("turns a locally handled command into a command block", () => {
    const acc = new StreamAccumulator();
    acc.push({ type: "system", subtype: "init", session_id: "s1", model: "claude-opus-5-5" });
    acc.push({
      type: "assistant",
      message: { id: "m1", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "## Context Usage\n\n**Tokens:** 55.7k" }] },
      parent_tool_use_id: null,
      local_command_run: { command: "context", args: "" },
    });
    acc.push({ type: "result", subtype: "success", is_error: false, result: "## Context Usage\n\n**Tokens:** 55.7k", local_command: "context" });
    expect(acc.blocks).toEqual([{ type: "command", name: "context", args: "", output: "## Context Usage\n\n**Tokens:** 55.7k" }]);
    expect(acc.localCommand).toEqual({ name: "context", args: "", output: "## Context Usage\n\n**Tokens:** 55.7k" });
    expect(acc.model).toBe("claude-opus-5-5");
    expect(acc.finalText()).toBe("## Context Usage\n\n**Tokens:** 55.7k");
  });

  test("/clear and /compact become notices", () => {
    const acc = new StreamAccumulator();
    expect(acc.push({ type: "conversation_reset", new_conversation_id: "x", trigger: "clear" })).toBe(true);
    expect(acc.contextCleared).toBe(true);
    acc.push({ type: "system", subtype: "status", status: "compacting" });
    expect(acc.activityLabel()).toBe("Compacting conversation…");
    acc.push({ type: "system", subtype: "status", status: null, compact_result: "success" });
    expect(acc.compacted).toBe(false);
    acc.push({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 58279, post_tokens: 2556 } });
    expect(acc.compacted).toBe(true);
    expect(acc.blocks).toEqual([
      { type: "notice", level: "info", text: "Context cleared — your next message starts a fresh session." },
      { type: "notice", level: "success", text: "Conversation compacted · 58.3k → 2.6k tokens" },
    ]);
  });
});

describe("slash commands in chat runs", () => {
  let conversationId = "";

  test("a resumed slash command reaches Claude Code verbatim (no context prefix)", async () => {
    const started = await startChat({ agentId: agent.id, content: "Hello" });
    conversationId = started.conversation.id;
    await waitForRun(started.run.id, 20_000);
    const { inv, conv } = await send(conversationId, "/goal the report is sent");
    expect(inv.args).toContain("--resume");
    expect(inv.prompt).toBe("/goal the report is sent");
    const answer = conv.messages.at(-1)!;
    expect(answer.blocks).toEqual([{ type: "command", name: "goal", args: "the report is sent", output: "Ran /goal the report is sent" }]);
    expect(answer.content).toBe("Ran /goal the report is sent");
  });

  test("plain messages keep the context prefix", async () => {
    const { inv } = await send(conversationId, "/Users/me/file.txt what is in it?");
    expect(inv.prompt.startsWith("<godmode-context>")).toBe(true);
  });

  test("/model and /effort stick to the conversation", async () => {
    const { conv } = await send(conversationId, "/model sonnet");
    expect(conv.model).toBe("sonnet");
    const effort = await send(conversationId, "/effort Max");
    expect(effort.conv.effort).toBe("max");
    const next = await send(conversationId, "Hi again");
    expect(argValue(next.inv, "--model")).toBe("sonnet");
    expect(argValue(next.inv, "--effort")).toBe("max");
  });

  test("rejected or reset overrides", async () => {
    expect((await send(conversationId, "/model bogus")).conv.model).toBe("sonnet");
    expect((await send(conversationId, "/effort extreme")).conv.effort).toBe("max");
    expect((await send(conversationId, "/model default")).conv.model).toBeNull();
    expect((await send(conversationId, "/effort auto")).conv.effort).toBeNull();
  });

  test("a slash command on a lost session keeps it, so the next message still gets the recap", async () => {
    const lost = "00000000-1111-4222-8333-444444444444";
    sql("UPDATE conversations SET claude_session_id = ? WHERE id = ?", lost, conversationId);
    const { conv } = await send(conversationId, "/context");
    expect(conv.claudeSessionId).toBe(lost);
    const next = await send(conversationId, "Where were we?");
    expect(next.inv.prompt).toContain("could not be restored");
    expect(next.conv.claudeSessionId).not.toBe(lost);
  });

  test("/rename renames the chat", async () => {
    expect((await send(conversationId, "/rename Quarterly numbers")).conv.title).toBe("Quarterly numbers");
  });

  test("/clear drops the Claude session so the next turn starts fresh", async () => {
    const { conv } = await send(conversationId, "/clear");
    expect(conv.claudeSessionId).toBeNull();
    expect(conv.messages.at(-1)!.blocks).toEqual([
      { type: "notice", level: "info", text: "Context cleared — your next message starts a fresh session." },
    ]);
    const next = await send(conversationId, "What were we doing?");
    expect(next.inv.args).not.toContain("--resume");
    expect(argValue(next.inv, "--session-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(next.inv.prompt).toBe("What were we doing?");
  });
});

describe("slash command catalog", () => {
  test("lists the CLI's commands for the agent, without terminal-only or internal ones", async () => {
    __clearSlashCommandCache();
    const commands = await listSlashCommands(agent);
    expect(commands).toEqual([
      { name: "goal", description: "Set a goal — keep working until the condition is met", argumentHint: "", aliases: [], builtin: true },
      { name: "clear", description: "Start a new session with empty context", argumentHint: "[name]", aliases: ["reset", "new"], builtin: true },
      { name: "hello", description: "Say hello to someone", argumentHint: "<name>", aliases: [], builtin: false },
    ]);
    const probe = invocations(env).at(-1)!;
    expect(argValue(probe, "--input-format")).toBe("stream-json");
    expect(argValue(probe, "--setting-sources")).toBe("project,local");
    expect(probe.args).toContain("--no-session-persistence");
  });

  test("is cached per agent", async () => {
    const before = invocations(env).length;
    await listSlashCommands(agent);
    expect(invocations(env).length).toBe(before);
  });

  test("a list that has grown old is answered at once and looked up again behind the request", async () => {
    const before = invocations(env).length;
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60_000;
    try {
      const stale = await listSlashCommands(agent);
      expect(stale.map((c) => c.name)).toEqual(["goal", "clear", "hello"]);
      // Asked again while that lookup runs: no second one.
      await listSlashCommands(agent);
      await until(() => invocations(env).length > before, 10_000, "the lookup behind the request");
      await Bun.sleep(300);
      expect(invocations(env).length).toBe(before + 1);
      // The new list is the one at hand now.
      await listSlashCommands(agent);
      expect(invocations(env).length).toBe(before + 1);
    } finally {
      Date.now = realNow;
    }
  });

  test("is served over HTTP", async () => {
    const res = await fetch(`${env.baseUrl}/api/agents/${agent.id}/commands`, { headers: { authorization: `Bearer ${getAccessToken()}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }[]).map((c) => c.name)).toEqual(["goal", "clear", "hello"]);
  });
});
