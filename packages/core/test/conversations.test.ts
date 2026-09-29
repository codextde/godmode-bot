import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, Conversation, ConversationWithMessages, Run, StartChatResult } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import {
  DEFAULT_CONVERSATION_TITLE,
  addMessage,
  createConversation,
  getConversation,
  listConversations,
  safeFileName,
  sendMessage,
  setConversationState,
  titleFromContent,
  updateConversation,
} from "../src/services/conversations";
import { waitForRun } from "../src/runner/runner";
import { ensureDefaultAgent } from "../src/agents/service";
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
      expect(conversation.origin).toBe("api");
      expect(message.content).toBe("Carry out your instructions and report back what you did.");
      expect(conversation.title).toBe(message.content);
      await waitForRun(run.id, 20_000);
    }
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
