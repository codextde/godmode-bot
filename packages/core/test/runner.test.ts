import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ServerEvent } from "@godmode/shared";
import { MAX_INSTRUCTIONS_LENGTH } from "@godmode/shared";
import { argValue, captureEvents, invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { insert, run as sql } from "../src/db";
import { updateSettings } from "../src/services/settings";
import { listMissingLogins } from "../src/services/missingLogins";
import {
  createConversation,
  deleteConversation,
  getConversation,
  sendMessage,
  startChat,
  transcriptPath,
  updateConversation,
} from "../src/services/conversations";
import { createWorkspace, updateWorkspace } from "../src/services/workspaces";
import { getAccessToken } from "../src/server/auth";
import {
  CLAUDE_NOT_FOUND,
  INTERRUPTED,
  __setClaudeBinaryForTests,
  activeRunForConversation,
  cancelRun,
  findRunLog,
  getRun,
  listActiveRuns,
  recoverInterruptedRuns,
  waitForRun,
} from "../src/runner/runner";
import { FAKE_CLAUDE } from "./fixtures/runner-harness";
import { now } from "../src/util";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv();
  agent = await makeAgent({ name: "Runner Test Bot", description: "test agent" });
});

afterAll(async () => {
  await env.close();
});

describe("runner end-to-end with fake claude", () => {
  let conversationId = "";
  let sessionId = "";

  test("first chat run: persisted, streamed, finalized, session stored", async () => {
    process.env.GODMODE_TOKEN = "must-not-leak";
    const { events, stop } = captureEvents();
    const started = await startChat({ agentId: agent.id, content: "Hello there\nsecond line" });
    conversationId = started.conversation.id;
    expect(started.conversation.title).toBe("Hello there");
    expect(started.message.role).toBe("user");
    expect(started.message.runId).toBe(started.run.id);
    expect(["queued", "running"]).toContain(started.run.status);
    expect(started.conversation.running).toBe(true);

    const finished = await waitForRun(started.run.id, 20_000);
    stop();
    delete process.env.GODMODE_TOKEN;

    expect(finished.status).toBe("succeeded");
    expect(finished.result).toBe("Hello, nice to meet you!");
    expect(finished.costUsd).toBeCloseTo(0.00896);
    expect(finished.numTurns).toBe(1);
    expect(finished.usage?.outputTokens).toBe(157);
    expect(finished.model).toBe("claude-haiku-4-5-20251001");
    expect(finished.finishedAt).not.toBeNull();

    const conv = getConversation(conversationId);
    expect(conv.activeRunId).toBeNull();
    expect(conv.running).toBe(false);
    expect(conv.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const assistant = conv.messages[1]!;
    expect(assistant.content).toBe("Hello, nice to meet you!");
    expect(assistant.blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(assistant.runId).toBe(finished.id);
    expect(conv.preview).toBe("Hello, nice to meet you!");

    const inv = invocations(env).at(-1)!;
    sessionId = argValue(inv, "--session-id")!;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(conv.claudeSessionId).toBe(sessionId);
    expect(inv.prompt).toBe("Hello there\nsecond line");
    expect(realpathSync(inv.cwd)).toBe(realpathSync(agent.repoPath));
    expect(inv.env.GODMODE_TOKEN).toBeNull();
    for (const flag of ["-p", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--dangerously-skip-permissions"]) {
      expect(inv.args).toContain(flag);
    }
    expect(argValue(inv, "--output-format")).toBe("stream-json");
    expect(argValue(inv, "--input-format")).toBe("text");
    expect(argValue(inv, "--model")).toBe("claude-opus-5-5");
    expect(argValue(inv, "--effort")).toBe("high");
    expect(argValue(inv, "--fallback-model")).toBe("claude-sonnet-5");
    expect(argValue(inv, "--setting-sources")).toBe("project,local");
    expect(argValue(inv, "--append-system-prompt")).toContain("vault_fill_login");
    expect(inv.args).not.toContain("--resume");
    // The MCP config (holds the run token) is removed after the run.
    expect(existsSync(argValue(inv, "--mcp-config")!)).toBe(false);

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "run.started").length).toBe(2); // queued + running
    expect(types).toContain("run.delta");
    expect(types).toContain("run.finished");
    expect(types).toContain("message.created");
    expect(types).toContain("message.updated");
    expect(types).toContain("conversation.updated");
    const labels = events.filter((e): e is Extract<ServerEvent, { type: "run.activity" }> => e.type === "run.activity").map((e) => e.label);
    expect(labels[0]).toBe("Starting…");
    expect(labels).toContain("Writing…");
    expect(labels.at(-1)).toBe("Done");
    const lastDelta = events.filter((e): e is Extract<ServerEvent, { type: "run.delta" }> => e.type === "run.delta").at(-1)!;
    expect(lastDelta.messageId).toBe(assistant.id);
    const streamedText = events
      .filter((e): e is Extract<ServerEvent, { type: "run.delta" }> => e.type === "run.delta")
      .map((e) => e.textDelta ?? "")
      .join("");
    expect(streamedText).toBe("Hello, nice to meet you!");

    // Transcript + raw run log in the agent repo.
    const transcript = readFileSync(transcriptPath(agent, conversationId), "utf8");
    expect(transcript).toContain("Hello there");
    expect(transcript).toContain("Hello, nice to meet you!");
    const logPath = findRunLog(finished)!;
    expect(logPath.startsWith(join(agent.repoPath, "runs"))).toBe(true);
    expect(readFileSync(logPath, "utf8").trim().split("\n").length).toBeGreaterThan(10);
  });

  test("follow-up resumes the Claude session and records tool results", async () => {
    const { run } = await sendMessage(conversationId, { content: "USE_TOOL now" });
    const finished = await waitForRun(run.id, 20_000);
    expect(finished.status).toBe("succeeded");
    expect(finished.result).toBe("DONE");
    const inv = invocations(env).at(-1)!;
    expect(argValue(inv, "--resume")).toBe(sessionId);
    expect(inv.args).not.toContain("--session-id");
    expect(inv.prompt.startsWith("<godmode-context>Current date/time:")).toBe(true);
    expect(inv.prompt.endsWith("USE_TOOL now")).toBe(true);
    const assistant = getConversation(conversationId).messages.at(-1)!;
    const tool = assistant.blocks.find((b) => b.type === "tool_use");
    expect(tool && tool.type === "tool_use" && tool.result).toBe("hi");
    expect(assistant.content).toBe("DONE");
  });

  test("a lost Claude session is replaced once, with a recap of recent messages", async () => {
    const lost = "00000000-1111-4222-8333-444444444444";
    sql("UPDATE conversations SET claude_session_id = ? WHERE id = ?", lost, conversationId);
    const before = invocations(env).length;
    const { run } = await sendMessage(conversationId, { content: "Are you still there?" });
    const finished = await waitForRun(run.id, 20_000);
    expect(finished.status).toBe("succeeded");
    const invs = invocations(env).slice(before);
    expect(invs).toHaveLength(2);
    expect(argValue(invs[0]!, "--resume")).toBe(lost);
    const fresh = argValue(invs[1]!, "--session-id")!;
    expect(fresh).not.toBe(lost);
    expect(invs[1]!.prompt).toContain("could not be restored");
    expect(invs[1]!.prompt).toContain("Hello there");
    expect(invs[1]!.prompt.endsWith("Are you still there?")).toBe(true);
    expect(getConversation(conversationId).claudeSessionId).toBe(fresh);
  });

  test("cancel kills the process and marks the run cancelled", async () => {
    const { run } = await sendMessage(conversationId, { content: "SLEEP please" });
    await until(() => getRun(run.id).status === "running" && getConversation(conversationId).messages.at(-1)!.blocks.length > 0, 10_000, "run to start");
    const t0 = Date.now();
    await cancelRun(run.id, "Cancelled by user");
    const finished = await waitForRun(run.id, 15_000);
    expect(finished.status).toBe("cancelled");
    expect(finished.error).toBe("Cancelled by user");
    expect(Date.now() - t0).toBeLessThan(10_000);
    const assistant = getConversation(conversationId).messages.at(-1)!;
    expect(assistant.blocks.some((b) => b.type === "notice" && b.text === "Cancelled by user")).toBe(true);
    expect(activeRunForConversation(conversationId)).toBeNull();
  });

  test("runs of one conversation are strictly sequential (FIFO)", async () => {
    const conv = createConversation({ agentId: agent.id });
    const first = await sendMessage(conv.id, { content: "SLEEP first" });
    const second = await sendMessage(conv.id, { content: "then this" });
    await until(() => getRun(first.run.id).status === "running", 10_000, "first run");
    await new Promise((r) => setTimeout(r, 200));
    expect(getRun(second.run.id).status).toBe("queued");
    expect(activeRunForConversation(conv.id)).toBe(first.run.id);
    await cancelRun(first.run.id);
    const done = await waitForRun(second.run.id, 20_000);
    expect(done.status).toBe("succeeded");
    const msgs = getConversation(conv.id).messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[3]!.content).toBe("Hello, nice to meet you!");
  });

  test("maxConcurrentRuns queues runs of other conversations", async () => {
    updateSettings({ runner: { maxConcurrentRuns: 1 } });
    try {
      const a = await startChat({ agentId: agent.id, content: "SLEEP a" });
      const b = await startChat({ agentId: agent.id, content: "hello b" });
      await until(() => getRun(a.run.id).status === "running", 10_000, "run a");
      await new Promise((r) => setTimeout(r, 200));
      expect(getRun(b.run.id).status).toBe("queued");
      expect(listActiveRuns().map((r) => r.runId).sort()).toEqual([a.run.id, b.run.id].sort());
      await cancelRun(a.run.id);
      expect((await waitForRun(b.run.id, 20_000)).status).toBe("succeeded");
    } finally {
      updateSettings({ runner: { maxConcurrentRuns: 3 } });
    }
  });

  test("runs sharing a browser profile take turns; delegated children may use the parent's browser", async () => {
    const browserA = await makeAgent({ name: "Browser A", browser: { enabled: true } });
    const browserB = await makeAgent({ name: "Browser B", browser: { enabled: true } });
    const a = await startChat({ agentId: browserA.id, content: "SLEEP a" });
    await until(() => getRun(a.run.id).status === "running", 10_000, "run a");

    // Independent run on the same profile waits…
    const b = await startChat({ agentId: browserB.id, content: "hello b" });
    // …but a run delegated by the holder may use the browser while the parent waits for it.
    const childConv = createConversation({ agentId: browserB.id, origin: "delegation" });
    const child = await sendMessage(childConv.id, { content: "hello child", trigger: "delegation", parentRunId: a.run.id, depth: 1 });
    expect((await waitForRun(child.run.id, 20_000)).status).toBe("succeeded");
    expect(getRun(b.run.id).status).toBe("queued");

    await cancelRun(a.run.id);
    expect((await waitForRun(b.run.id, 20_000)).status).toBe("succeeded");
  });

  test("cancelling a queued run never starts it", async () => {
    const conv = createConversation({ agentId: agent.id });
    const first = await sendMessage(conv.id, { content: "SLEEP" });
    const second = await sendMessage(conv.id, { content: "never" });
    const before = invocations(env).length;
    await cancelRun(second.run.id);
    expect(getRun(second.run.id).status).toBe("cancelled");
    await cancelRun(first.run.id);
    await waitForRun(first.run.id, 10_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(invocations(env).slice(before).some((i) => i.prompt.includes("never"))).toBe(false);
  });

  test("crash without a result fails with the stderr tail", async () => {
    const { run } = await startChat({ agentId: agent.id, content: "CRASH" });
    const finished = await waitForRun(run.id, 20_000);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("fatal: something exploded");
    const assistant = getConversation(finished.conversationId).messages.at(-1)!;
    expect(assistant.blocks.at(-1)).toEqual({ type: "error", text: finished.error! });
  });

  test("missing claude CLI fails the run with an install hint", async () => {
    __setClaudeBinaryForTests(false);
    try {
      const { run } = await startChat({ agentId: agent.id, content: "hi" });
      const finished = await waitForRun(run.id, 10_000);
      expect(finished.status).toBe("failed");
      expect(finished.error).toBe(CLAUDE_NOT_FOUND);
    } finally {
      __setClaudeBinaryForTests([process.execPath, FAKE_CLAUDE]);
    }
  });

  test("timeout kills the run", async () => {
    updateSettings({ runner: { runTimeoutMinutes: 0.01 } });
    try {
      const { run } = await startChat({ agentId: agent.id, content: "SLEEP forever" });
      const finished = await waitForRun(run.id, 15_000);
      expect(finished.status).toBe("failed");
      expect(finished.error).toMatch(/^Timed out after/);
    } finally {
      updateSettings({ runner: { runTimeoutMinutes: 60 } });
    }
  });

  test("login failures in the final answer are reported as missing logins", async () => {
    const { run } = await startChat({ agentId: agent.id, content: "LOGIN_FAIL" });
    const finished = await waitForRun(run.id, 20_000);
    expect(finished.status).toBe("succeeded");
    await until(() => listMissingLogins({}).some((m) => m.runId === run.id), 5000, "missing login");
    const item = listMissingLogins({}).find((m) => m.runId === run.id)!;
    expect(item.kind).toBe("other");
    expect(item.agentId).toBe(agent.id);
    expect(item.service).toBe("Unknown service");
    expect(item.reason).toContain("couldn't log in to example.com");
  });

  test("runs reach the MCP gateway; an explicit report disables the heuristic", async () => {
    const { run } = await startChat({ agentId: agent.id, content: "CALL_MCP" });
    const finished = await waitForRun(run.id, 20_000);
    expect(finished.status).toBe("succeeded");
    expect(finished.result).toContain('"server":"godmode"');
    expect(finished.result).toContain("Reported to the human");
    await new Promise((r) => setTimeout(r, 200));
    const reports = listMissingLogins({}).filter((m) => m.runId === run.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.kind).toBe("missing_credential");
    expect(reports[0]!.service).toBe("Example");
    // The run token is revoked after the run.
    const inv = invocations(env).at(-1)!;
    expect(existsSync(argValue(inv, "--mcp-config")!)).toBe(false);
  });

  test("attachments are saved into the agent workspace and referenced in the prompt", async () => {
    const conv = createConversation({ agentId: agent.id });
    const data = Buffer.from("hello").toString("base64");
    const { message, run } = await sendMessage(conv.id, {
      content: "Summarize this",
      attachments: [{ name: "../../evil name?.txt", mime: "text/plain", data }],
    });
    expect(message.attachments).toHaveLength(1);
    const att = message.attachments[0]!;
    expect(att.name).toBe("evil name_.txt");
    expect(att.path).toMatch(/^workspace\/uploads\/\d{4}-\d{2}-\d{2}\/evil name_\.txt$/);
    expect(att.size).toBe(5);
    expect(readFileSync(join(agent.repoPath, att.path), "utf8")).toBe("hello");
    await waitForRun(run.id, 20_000);
    const inv = invocations(env).at(-1)!;
    expect(inv.prompt).toBe(`Summarize this\n\nAttached files: ${join(agent.repoPath, att.path)}`);
  });

  test("deleting a conversation cancels its run first", async () => {
    const { run, conversation } = await startChat({ agentId: agent.id, content: "SLEEP until deleted" });
    await until(() => getRun(run.id).status === "running", 10_000, "run to start");
    await deleteConversation(conversation.id);
    expect(getRun(run.id).status).toBe("cancelled");
    expect(() => getConversation(conversation.id)).toThrow();
    expect(existsSync(transcriptPath(agent, conversation.id))).toBe(false);
  });

  test("a missing agent repo is rebuilt before the run", async () => {
    const bot = await makeAgent({ name: "Repo Rebuild Bot" });
    rmSync(bot.repoPath, { recursive: true, force: true });
    const { run } = await startChat({ agentId: bot.id, content: "hello" });
    expect((await waitForRun(run.id, 20_000)).status).toBe("succeeded");
    expect(existsSync(join(bot.repoPath, "CLAUDE.md"))).toBe(true);
  });

  test("disabled agents cannot start runs", async () => {
    const off = await makeAgent({ name: "Disabled Bot", enabled: false });
    await expect(startChat({ agentId: off.id, content: "hi" })).rejects.toThrow(/disabled/);
  });
});

describe("standing instructions", () => {
  afterAll(() => {
    updateSettings({ runner: { appendSystemPrompt: "" } });
  });

  const lastPrompt = async (conversationId: string, content: string) => {
    const sent = await sendMessage(conversationId, { content });
    await waitForRun(sent.run.id, 20_000);
    return invocations(env).at(-1)!.prompt;
  };

  test("global, workspace and chat layers reach the system prompt, most specific last", async () => {
    updateSettings({ runner: { appendSystemPrompt: "Use fewer comments." } });
    const ws = createWorkspace({ name: "Acme", instructions: "Invoices go to finance@acme.test." });
    const bot = await makeAgent({ name: "Layered Bot", workspaceId: ws.id });
    const { run } = await startChat({ agentId: bot.id, content: "Hi", instructions: "Answer in German." });
    expect((await waitForRun(run.id, 20_000)).status).toBe("succeeded");
    const system = argValue(invocations(env).at(-1)!, "--append-system-prompt")!;
    const every = system.indexOf("### For every agent\nUse fewer comments.");
    const workspace = system.indexOf('### For the "Acme" workspace\nInvoices go to finance@acme.test.');
    const chat = system.indexOf("### For this chat\nAnswer in German.");
    expect(system).toContain("## Standing instructions");
    expect(every).toBeGreaterThan(-1);
    expect(workspace).toBeGreaterThan(every);
    expect(chat).toBeGreaterThan(workspace);
  });

  test("a resumed chat is told when its instructions change, once", async () => {
    updateSettings({ runner: { appendSystemPrompt: "Use fewer comments." } });
    const { conversation, run } = await startChat({ agentId: agent.id, content: "Hi" });
    await waitForRun(run.id, 20_000);

    expect(await lastPrompt(conversation.id, "unchanged")).not.toContain("standing instructions");

    updateConversation(conversation.id, { instructions: "Always sign with Dan." });
    const changed = await lastPrompt(conversation.id, "after edit");
    expect(changed).toContain("Your standing instructions changed");
    expect(changed).toContain("### For this chat\nAlways sign with Dan.");
    expect(changed).toContain("### For every agent\nUse fewer comments.");
    expect(changed.endsWith("after edit")).toBe(true);

    expect(await lastPrompt(conversation.id, "again")).not.toContain("standing instructions");

    updateSettings({ runner: { appendSystemPrompt: "" } });
    updateConversation(conversation.id, { instructions: "" });
    expect(await lastPrompt(conversation.id, "cleared")).toContain("You have no standing instructions anymore");
  });

  test("workspace changes are restated to its agents' chats", async () => {
    const ws = createWorkspace({ name: "Globex", instructions: "Bill in EUR." });
    const bot = await makeAgent({ name: "Globex Bot", workspaceId: ws.id });
    const { conversation, run } = await startChat({ agentId: bot.id, content: "Hi" });
    await waitForRun(run.id, 20_000);
    updateWorkspace(ws.id, { instructions: "Bill in USD." });
    expect(await lastPrompt(conversation.id, "next")).toContain('### For the "Globex" workspace\nBill in USD.');
  });

  test("a restatement counts only once a run succeeds, and again after compaction", async () => {
    const { conversation, run } = await startChat({ agentId: agent.id, content: "Hi" });
    await waitForRun(run.id, 20_000);
    updateConversation(conversation.id, { instructions: "Be brief." });

    const { run: slow } = await sendMessage(conversation.id, { content: "SLEEP please" });
    await until(() => getRun(slow.id).status === "running" && invocations(env).at(-1)!.prompt.includes("SLEEP please"), 10_000, "run to start");
    expect(invocations(env).at(-1)!.prompt).toContain("Be brief.");
    await cancelRun(slow.id, "Cancelled by user");
    await waitForRun(slow.id, 15_000);
    expect(await lastPrompt(conversation.id, "retry")).toContain("Be brief.");
    expect(await lastPrompt(conversation.id, "steady")).not.toContain("standing instructions");

    expect(await lastPrompt(conversation.id, "/compact")).toBe("/compact");
    expect(await lastPrompt(conversation.id, "after compact")).toContain("### For this chat\nBe brief.");
  });

  test("instructions are capped", async () => {
    const tooLong = "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1);
    const res = await fetch(`${env.baseUrl}/api/settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runner: { appendSystemPrompt: tooLong } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("workspace folders and repositories", () => {
  test("runs get them with --add-dir, their CLAUDE.md and a prompt section; missing ones are skipped", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "godmode-ws-folder-")));
    const gone = realpathSync(mkdtempSync(join(tmpdir(), "godmode-ws-gone-")));
    const ws = createWorkspace({ name: "Sourced", sources: [{ kind: "folder", path: dir }, { kind: "folder", path: gone }] });
    rmSync(gone, { recursive: true });
    const bot = await makeAgent({ name: "Sourced Bot", workspaceId: ws.id });
    const { conversation, run } = await startChat({ agentId: bot.id, content: "Hi" });
    expect((await waitForRun(run.id, 20_000)).status).toBe("succeeded");
    const inv = invocations(env).at(-1)!;
    const added = inv.args.flatMap((a, i) => (inv.args[i - 1] === "--add-dir" ? [a] : []));
    expect(added).toEqual([dir]);
    expect(inv.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
    expect(argValue(inv, "--append-system-prompt")).toContain(`- \`${dir}\` (folder)`);
    const notices = getConversation(conversation.id).messages.at(-1)!.blocks.filter((b) => b.type === "notice");
    expect(notices.map((b) => (b.type === "notice" ? b.text : ""))).toEqual([expect.stringContaining("was skipped")]);

    const next = await sendMessage(conversation.id, { content: "again" });
    await waitForRun(next.run.id, 20_000);
    expect(invocations(env).at(-1)!.prompt).toContain(`Workspace folders and repositories (added to this session): \`${dir}\` (folder).`);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("recoverInterruptedRuns", () => {
  test("marks stale queued/running rows failed and flags their messages", () => {
    const conv = createConversation({ agentId: agent.id });
    const runId = "run_stale_test_000001";
    insert("runs", {
      id: runId,
      agent_id: agent.id,
      conversation_id: conv.id,
      trigger: "chat",
      status: "running",
      prompt: "x",
      created_at: now(),
    });
    insert("messages", {
      id: "msg_stale_test_000001",
      conversation_id: conv.id,
      role: "assistant",
      content: "",
      blocks: "[]",
      run_id: runId,
      attachments: "[]",
      created_at: now(),
    });
    recoverInterruptedRuns();
    const r = getRun(runId);
    expect(r.status).toBe("failed");
    expect(r.error).toBe(INTERRUPTED);
    const msg = getConversation(conv.id).messages.find((m) => m.id === "msg_stale_test_000001")!;
    expect(msg.blocks).toEqual([{ type: "error", text: INTERRUPTED }]);
  });
});
