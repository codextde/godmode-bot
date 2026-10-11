import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Agent, Conversation, ConversationWithMessages, MessageBlock, MessagePage, Run, StartChatResult } from "@godmode/shared";
import { makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { run as sql } from "../src/db";
import {
  DEFAULT_CONVERSATION_TITLE,
  addMessage,
  createConversation,
  getConversation,
  listConversations,
  listMessagePage,
  safeFileName,
  sendMessage,
  setConversationState,
  titleFromContent,
  updateConversation,
} from "../src/services/conversations";
import { cancelFollowup, scheduleFollowup } from "../src/services/followups";
import { cancelRun, getRun, waitForRun } from "../src/runner/runner";
import { ensureDefaultAgent } from "../src/agents/service";
import { createWorkspace } from "../src/services/workspaces";
import { getAccessToken } from "../src/server/auth";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-conv-");
  agent = await makeAgent({ name: "Conversation Bot" });
});

afterAll(async () => {
  await env.close();
});

describe("helpers", () => {
  test("titleFromContent uses the first non-empty line, max 60 chars", () => {
    expect(titleFromContent("\n\n  Book a table  \nfor two")).toBe("Book a table");
    expect(titleFromContent("   ")).toBe(DEFAULT_CONVERSATION_TITLE);
    const long = titleFromContent("x".repeat(100));
    expect(long.length).toBe(60);
    expect(long.endsWith("…")).toBe(true);
  });

  test("safeFileName strips paths and unsafe characters", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(safeFileName("a<b>c:d|e?.txt")).toBe("a_b_c_d_e_.txt");
    expect(safeFileName("...")).toBe("file");
    expect(safeFileName("CON.txt")).toBe("_CON.txt");
  });
});

describe("conversation list", () => {
  test("preview, pinned-first ordering, archive filter and search", () => {
    const a = createConversation({ agentId: agent.id, title: "Alpha" });
    const b = createConversation({ agentId: agent.id, title: "Beta" });
    const c = createConversation({ agentId: agent.id });
    expect(c.title).toBe(DEFAULT_CONVERSATION_TITLE);
    addMessage({ conversationId: a.id, role: "user", content: "hello   from\nalpha" });
    addMessage({ conversationId: b.id, role: "user", content: "find the needle here" });
    setConversationState(a.id, { lastMessageAt: "2030-01-01T00:00:00.000Z" });
    setConversationState(b.id, { lastMessageAt: "2030-01-02T00:00:00.000Z" });
    updateConversation(c.id, { pinned: true });

    const list = listConversations({ agentId: agent.id });
    expect(list.slice(0, 3).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(list.find((x) => x.id === a.id)!.preview).toBe("hello from alpha");
    expect(list.every((x) => x.running === false)).toBe(true);

    expect(listConversations({ search: "needle" }).map((x) => x.id)).toEqual([b.id]);
    expect(listConversations({ search: "alph" }).map((x) => x.id)).toEqual([a.id]);
    expect(listConversations({ search: "100%" })).toEqual([]);

    updateConversation(a.id, { archived: true });
    expect(listConversations({ agentId: agent.id }).some((x) => x.id === a.id)).toBe(false);
    expect(listConversations({ agentId: agent.id, archived: true }).map((x) => x.id)).toEqual([a.id]);
    expect(listConversations({ agentId: agent.id, limit: 1 })).toHaveLength(1);
  });

  test("a workspace's chats: its agents' and global agents' chats started in it", async () => {
    const ws = createWorkspace({ name: "Chat scope" });
    const other = createWorkspace({ name: "Other scope" });
    const member = await makeAgent({ name: "Scoped Bot", workspaceId: ws.id });
    const own = createConversation({ agentId: member.id, title: "Member chat" });
    const started = createConversation({ agentId: agent.id, title: "Global chat in it", workspaceId: ws.id });
    const elsewhere = createConversation({ agentId: agent.id, title: "Global chat elsewhere", workspaceId: other.id });
    const unscoped = createConversation({ agentId: agent.id, title: "Global chat" });
    const ids = listConversations({ workspaceId: ws.id }).map((x) => x.id);
    expect(ids.sort()).toEqual([own.id, started.id].sort());
    expect(ids).not.toContain(elsewhere.id);
    expect(ids).not.toContain(unscoped.id);
    expect(listConversations({ workspaceId: other.id }).map((x) => x.id)).toEqual([elsewhere.id]);

    const global = listConversations({ workspaceId: "global" }).map((x) => x.id);
    expect(global).toContain(unscoped.id);
    expect(global).not.toContain(own.id);
    expect(global).not.toContain(started.id);
    expect(listConversations({ workspaceId: "all" }).map((x) => x.id)).toEqual(expect.arrayContaining([own.id, started.id, elsewhere.id, unscoped.id]));
  });

  test("archived chats are listed by last activity, pinned or not", () => {
    const pinned = createConversation({ agentId: agent.id, title: "Pinned old" });
    const recent = createConversation({ agentId: agent.id, title: "Recent" });
    setConversationState(pinned.id, { lastMessageAt: "2031-01-01T00:00:00.000Z" });
    setConversationState(recent.id, { lastMessageAt: "2031-02-01T00:00:00.000Z" });
    updateConversation(pinned.id, { pinned: true, archived: true });
    updateConversation(recent.id, { archived: true });
    const ids = listConversations({ agentId: agent.id, archived: true }).map((x) => x.id);
    expect(ids.indexOf(recent.id)).toBeLessThan(ids.indexOf(pinned.id));
  });

  test("the archive tells which chats still have work ahead", async () => {
    const inAnHour = new Date(Date.now() + 3_600_000);
    const waiting = createConversation({ agentId: agent.id, title: "Waits for a reply" });
    const working = createConversation({ agentId: agent.id, title: "Still working" });
    const done = createConversation({ agentId: agent.id, title: "Done" });
    const ticket = createConversation({ agentId: agent.id, title: "#7 A ticket", origin: "task" });
    scheduleFollowup({ conversationId: waiting.id, agentId: agent.id, dueAt: inAnHour, note: "Check the reply" });
    scheduleFollowup({ conversationId: ticket.id, agentId: agent.id, dueAt: inAnHour, note: "Check the build" });
    const { run } = await sendMessage(working.id, { content: "SLEEP on it" });
    await until(() => getRun(run.id).status === "running", 10_000, "run to start");
    for (const c of [waiting, working, done, ticket]) updateConversation(c.id, { archived: true });
    // A chat on a runner has its state there: this computer knows it from what the runner last said.
    const onRunner = (title: string, state: object) => {
      const c = createConversation({ agentId: agent.id, title });
      sql("UPDATE conversations SET archived = 1, runner_id = 'rnr_archive', runner_state = ? WHERE id = ?", JSON.stringify(state), c.id);
      return c;
    };
    const remote = onRunner("Waits on the runner", { running: false, paused: null, followup: { note: "Check the build", dueAt: inAnHour.toISOString(), createdAt: inAnHour.toISOString() } });
    onRunner("Done on the runner", { running: false, paused: null, followup: null });

    const ongoing = listConversations({ agentId: agent.id, archived: true, ongoing: true });
    expect(ongoing.map((c) => c.id).sort()).toEqual([waiting.id, working.id, remote.id].sort());
    expect(ongoing.find((c) => c.id === waiting.id)).toMatchObject({ archived: true, followup: { note: "Check the reply" } });
    expect(ongoing.find((c) => c.id === working.id)).toMatchObject({ archived: true, running: true });
    // A chat in Recent with work ahead isn't in the archive.
    expect(listConversations({ agentId: agent.id, ongoing: true }).map((c) => c.id)).not.toContain(waiting.id);

    const res = await fetch(`${env.baseUrl}/api/conversations?archived=1&ongoing=1&agentId=${agent.id}`, { headers: { Authorization: `Bearer ${getAccessToken()}` } });
    expect(((await res.json()) as Conversation[]).map((c) => c.id).sort()).toEqual([waiting.id, working.id, remote.id].sort());

    await cancelRun(run.id);
    await waitForRun(run.id, 10_000);
    cancelFollowup(waiting.id);
    cancelFollowup(ticket.id);
    sql("DELETE FROM conversations WHERE id = ?", remote.id);
    expect(listConversations({ agentId: agent.id, archived: true, ongoing: true })).toEqual([]);
  });

  test("routine runs keep an archived chat archived", async () => {
    const conv = createConversation({ agentId: agent.id, title: "Morning digest" });
    updateConversation(conv.id, { archived: true });
    const { run } = await sendMessage(conv.id, { content: "digest", trigger: "routine" });
    await waitForRun(run.id, 20_000);
    expect(getConversation(conv.id).archived).toBe(true);
  });

  test("validation", () => {
    const conv = createConversation({ agentId: agent.id });
    expect(() => updateConversation(conv.id, { title: "  " })).toThrow(/Title/);
    expect(() => getConversation("cnv_missing")).toThrow(/not found/);
    expect(() => createConversation({ agentId: "agt_missing" })).toThrow();
  });
});

describe("HTTP routes", () => {
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${env.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${getAccessToken()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res;
  };

  test("requires auth", async () => {
    expect((await fetch(`${env.baseUrl}/api/conversations`)).status).toBe(401);
  });

  test("a window of the latest messages, older pages and the pictures they left out", async () => {
    const conv = createConversation({ agentId: agent.id });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
    const first = addMessage({ conversationId: conv.id, role: "user", content: "look" });
    const shot = addMessage({
      conversationId: conv.id,
      role: "assistant",
      content: "",
      blocks: [{ type: "tool_use", id: "toolu_1", name: "screenshot", input: {}, result: "ok", image: png.toString("base64") }],
    });
    addMessage({ conversationId: conv.id, role: "user", content: "thanks" });

    const latest = (await (await api("GET", `/api/conversations/${conv.id}?limit=2&lite=1`)).json()) as ConversationWithMessages;
    expect(latest.messages.map((m) => m.id)).toEqual([shot.id, latest.messages[1]!.id]);
    expect(latest.hasMore).toBe(true);
    const block = latest.messages[0]!.blocks[0] as Extract<MessageBlock, { type: "tool_use" }>;
    expect(block.image).toBeUndefined();

    const picture = await api("GET", block.imageUrl!);
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(new Uint8Array(png));
    expect((await api("GET", `/api/conversations/${conv.id}/messages/${shot.id}/images/toolu_missing`)).status).toBe(404);

    const page = (await (await api("GET", `/api/conversations/${conv.id}/messages?before=${shot.id}&limit=5`)).json()) as MessagePage;
    expect(page).toEqual({ messages: [expect.objectContaining({ id: first.id })], hasMore: false });
    expect((await api("GET", `/api/conversations/${conv.id}/messages?before=msg_missing`)).status).toBe(404);
  });

  test("chat lifecycle over HTTP", async () => {
    const defaultAgent = await ensureDefaultAgent();
    const started = await api("POST", "/api/chat", { content: "Plan my week" });
    expect(started.status).toBe(201);
    const chat = (await started.json()) as StartChatResult;
    expect(chat.conversation.agentId).toBe(defaultAgent.id);
    expect(chat.conversation.title).toBe("Plan my week");
    await waitForRun(chat.run.id, 20_000);

    const conv = (await (await api("GET", `/api/conversations/${chat.conversation.id}`)).json()) as ConversationWithMessages;
    expect(conv.messages.map((m) => m.content)).toEqual(["Plan my week", "Hello, nice to meet you!"]);
    expect(conv.activeRunId).toBeNull();

    const sent = await api("POST", `/api/conversations/${conv.id}/messages`, { content: "USE_TOOL again" });
    expect(sent.status).toBe(201);
    const { run } = (await sent.json()) as { run: Run };
    await waitForRun(run.id, 20_000);

    const runs = (await (await api("GET", `/api/runs?agentId=${defaultAgent.id}&status=succeeded&limit=5`)).json()) as Run[];
    expect(runs.map((r) => r.id)).toContain(run.id);
    const detail = (await (await api("GET", `/api/runs/${run.id}`)).json()) as Run & { logPath: string | null };
    expect(detail.status).toBe("succeeded");
    expect(detail.logPath).toContain(run.id);
    const log = await api("GET", `/api/runs/${run.id}/log`);
    expect(log.headers.get("content-type")).toContain("text/plain");
    expect((await log.text()).split("\n").filter(Boolean).length).toBeGreaterThan(3);
    expect((await api("POST", `/api/runs/${run.id}/cancel`)).status).toBe(200);

    const patched = (await (await api("PATCH", `/api/conversations/${conv.id}`, { title: "Week plan", pinned: true })).json()) as Conversation;
    expect(patched.title).toBe("Week plan");
    expect(patched.pinned).toBe(true);
    const listed = (await (await api("GET", `/api/conversations?agentId=${defaultAgent.id}&search=week`)).json()) as Conversation[];
    expect(listed.map((c) => c.id)).toEqual([conv.id]);

    const archived = (await (await api("PATCH", `/api/conversations/${conv.id}`, { archived: true })).json()) as Conversation;
    expect(archived.archived).toBe(true);
    const archivedList = (await (await api("GET", `/api/conversations?archived=true&agentId=${defaultAgent.id}`)).json()) as Conversation[];
    expect(archivedList.map((c) => c.id)).toEqual([conv.id]);
    const reply = (await (await api("POST", `/api/conversations/${conv.id}/messages`, { content: "Back to this" })).json()) as { run: Run };
    await waitForRun(reply.run.id, 20_000);
    expect(((await (await api("GET", `/api/conversations/${conv.id}`)).json()) as Conversation).archived).toBe(false);

    expect((await api("DELETE", `/api/conversations/${conv.id}`)).status).toBe(200);
    expect((await api("GET", `/api/conversations/${conv.id}`)).status).toBe(404);
  });

  test("running an agent without a task falls back to its instructions", async () => {
    for (const body of [{}, { prompt: "   " }]) {
      const res = await api("POST", `/api/agents/${agent.id}/run`, body);
      expect(res.status).toBe(200);
      const { conversation, run, message } = (await res.json()) as StartChatResult;
      // The human clicked "Run task": it's their chat, not an API call.
      expect(conversation.origin).toBe("chat");
      expect(message.content).toBe("Carry out your instructions and report back what you did.");
      expect(conversation.title).toBe(message.content);
      await waitForRun(run.id, 20_000);
    }
  });

  test("a message takes any number of files", async () => {
    const conv = createConversation({ agentId: agent.id });
    // Pasted pictures all carry the same name.
    const attachments = Array.from({ length: 60 }, (_, i) => ({ name: i < 40 ? `photo_${i + 1}.txt` : "image.txt", mime: "text/plain", data: "aGk=" }));
    const sent = await api("POST", `/api/conversations/${conv.id}/messages`, { content: "All of these", attachments });
    expect(sent.status).toBe(201);
    const { run } = (await sent.json()) as { run: Run };
    await waitForRun(run.id, 20_000);
    const saved = getConversation(conv.id).messages[0]!.attachments;
    expect(saved.slice(0, 41).map((a) => a.name)).toEqual(attachments.slice(0, 41).map((a) => a.name));
    expect(saved.slice(41).map((a) => a.name)).toEqual(Array.from({ length: 19 }, (_, i) => `image-${i + 1}.txt`));
    expect(new Set(saved.map((a) => a.path)).size).toBe(60);
    expect(run.prompt).toContain(join(agent.repoPath, saved[59]!.path));
  });

  test("create conversation + errors", async () => {
    const created = await api("POST", "/api/conversations", { agentId: agent.id, title: "Manual" });
    expect(created.status).toBe(201);
    const conv = (await created.json()) as Conversation;
    expect(conv.origin).toBe("chat");
    expect(conv.instructions).toBe("");
    const ruled = (await (await api("PATCH", `/api/conversations/${conv.id}`, { instructions: "  Reply in German.\n" })).json()) as Conversation;
    expect(ruled.instructions).toBe("Reply in German.");
    expect((await api("PATCH", `/api/conversations/${conv.id}`, { instructions: "x".repeat(20_001) })).status).toBe(400);
    expect((await api("POST", `/api/conversations/${conv.id}/messages`, { content: "" })).status).toBe(400);
    expect((await api("POST", `/api/conversations/${conv.id}/messages`, { content: "x", attachments: [{ name: "a", data: "!!!" }] })).status).toBe(400);
    expect((await api("POST", "/api/conversations/cnv_nope/messages", { content: "x" })).status).toBe(404);
    expect((await api("POST", "/api/conversations", { title: "no agent" })).status).toBe(400);
    expect((await api("GET", "/api/runs/run_nope")).status).toBe(404);
    expect((await api("GET", "/api/runs/run_nope/log")).status).toBe(404);
  });
});

describe("message windows", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");

  function chatWith(count: number) {
    const conv = createConversation({ agentId: agent.id, title: "Long chat" });
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(addMessage({ conversationId: conv.id, role: i % 2 ? "assistant" : "user", content: `m${i}` }).id);
    return { conv, ids };
  }

  test("the latest messages, then older pages until the first", () => {
    const { conv, ids } = chatWith(7);
    const latest = getConversation(conv.id, { limit: 3 });
    expect(latest.messages.map((m) => m.content)).toEqual(["m4", "m5", "m6"]);
    expect(latest.hasMore).toBe(true);
    const older = listMessagePage(conv.id, { limit: 3, before: ids[4] });
    expect(older.messages.map((m) => m.content)).toEqual(["m1", "m2", "m3"]);
    expect(older.hasMore).toBe(true);
    const first = listMessagePage(conv.id, { limit: 3, before: ids[1] });
    expect(first).toEqual({ messages: [expect.objectContaining({ content: "m0" })], hasMore: false });
    expect(getConversation(conv.id).hasMore).toBeUndefined();
    expect(getConversation(conv.id).messages).toHaveLength(7);
  });

  test("messages written in the same millisecond keep their order across pages", () => {
    const conv = createConversation({ agentId: agent.id });
    const ids = [1, 2, 3, 4].map((n) => addMessage({ conversationId: conv.id, role: "user", content: `same${n}` }).id);
    sql("UPDATE messages SET created_at = '2026-01-01T00:00:00.000Z' WHERE conversation_id = ?", conv.id);
    expect(getConversation(conv.id, { limit: 2 }).messages.map((m) => m.content)).toEqual(["same3", "same4"]);
    expect(listMessagePage(conv.id, { limit: 2, before: ids[2] }).messages.map((m) => m.content)).toEqual(["same1", "same2"]);
  });

  test("light messages leave pictures out and cut long tool output", () => {
    const conv = createConversation({ agentId: agent.id });
    const blocks: MessageBlock[] = [
      { type: "tool_use", id: "toolu_shot", name: "mcp__browser__browser_screenshot", input: {}, result: "ok", image: PNG },
      { type: "tool_use", id: "toolu_long", name: "Bash", input: {}, result: "x".repeat(10_000) },
      { type: "text", text: "Done" },
    ];
    const msg = addMessage({ conversationId: conv.id, role: "assistant", content: "Done", blocks });
    const [lite] = getConversation(conv.id, { lite: true }).messages;
    const [shot, long, text] = lite!.blocks as Extract<MessageBlock, { type: "tool_use" }>[];
    expect(shot!.image).toBeUndefined();
    expect(shot!.imageUrl).toBe(`/api/conversations/${conv.id}/messages/${msg.id}/images/toolu_shot`);
    expect(long!.result).toHaveLength(6000);
    expect(long!.resultTruncated).toBe(true);
    expect(text).toEqual({ type: "text", text: "Done" } as never);
    expect(getConversation(conv.id).messages[0]!.blocks[0]).toMatchObject({ image: PNG });
  });
});

describe("plainPreview", () => {
  test("strips markdown formatting for one-line previews", async () => {
    const { plainPreview } = await import("../src/services/conversations");
    const md = "I created the **📰 HN AI Digest** agent.\n\n| Agent | Next |\n|---|---|\n- [Docs](https://example.com) and `code` _here_\n```ts\nconst x = 1;\n```";
    const out = plainPreview(md).replace(/\s+/g, " ").trim();
    expect(out).toContain("I created the 📰 HN AI Digest agent.");
    expect(out).toContain("Docs and code here");
    expect(out).not.toMatch(/\*\*|`|\]\(|const x/);
  });
});
