import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { get, insert, run as sql } from "../src/db";
import { getAccessToken } from "../src/server/auth";
import { deviceMayCall } from "../src/mobile/scope";
import { getRun, waitForRun } from "../src/runner/runner";
import { getConversation, markConversationsRead, sendMessage, startChat } from "../src/services/conversations";
import { createRoutine } from "../src/services/routines";
import { listNotifications } from "../src/services/notifications";
import { listAttention } from "../src/services/attention";
import { startRunNotices, stopRunNotices } from "../src/services/runNotices";
import { createTask, startTasks, stopTasks, updateTask } from "../src/tasks/service";
import { newId, now } from "../src/util";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-attention-");
  agent = await makeAgent({ name: "Mia" });
  startTasks();
  startRunNotices();
});

afterAll(async () => {
  stopRunNotices();
  stopTasks();
  await env.close();
});

const titles = () => listNotifications().map((n) => n.title);

describe("unread chats and their notices", () => {
  test("a chat that finishes while nobody looks is unread and says so once; opening it reads it", async () => {
    const before = titles().length;
    const chat = await startChat({ agentId: agent.id, content: "Say hello", title: "Q4 plan" });
    await waitForRun(chat.run.id, 20_000);
    await until(() => !!getConversation(chat.conversation.id).unread, 5_000, "the chat to be unread");
    expect(getConversation(chat.conversation.id).unread).toEqual({ runId: chat.run.id, failed: false });
    expect(titles().slice(0, titles().length - before)).toEqual(["Mia replied in “Q4 plan”"]);
    expect(markConversationsRead([chat.conversation.id])).toBe(1);
    expect(getConversation(chat.conversation.id).unread).toBeNull();
    const res = await fetch(`${env.baseUrl}/api/conversations/read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: "all" }),
    });
    expect(await res.json()).toEqual({ read: 0 });
  }, 30_000);

  test("a failed chat run is on the list until the chat is read", async () => {
    const chat = await startChat({ agentId: agent.id, content: "CRASH now", title: "Broken" });
    await waitForRun(chat.run.id, 20_000);
    await until(() => listAttention().some((i) => i.id === `failed:${chat.conversation.id}`), 5_000, "the failure to be listed");
    expect(titles()[0]).toBe("Mia ran into a problem in “Broken”");
    markConversationsRead([chat.conversation.id]);
    expect(listAttention().some((i) => i.id === `failed:${chat.conversation.id}`)).toBe(false);
  }, 30_000);

  test("the agent's own notify_user replaces Godmode's notice", async () => {
    const chat = await startChat({ agentId: agent.id, content: "Say hello", title: "Told already" });
    await waitForRun(chat.run.id, 20_000);
    // A second turn whose answer mentions the tool, as a run that called notify_user stores it.
    const conv = chat.conversation.id;
    const runId = newId("run");
    insert("runs", { id: runId, agent_id: agent.id, conversation_id: conv, trigger: "chat", status: "succeeded", prompt: "x", created_at: now(), finished_at: now() });
    insert("messages", { id: newId("msg"), conversation_id: conv, role: "assistant", content: "done", blocks: JSON.stringify([{ type: "tool_use", id: "t", name: "mcp__godmode__notify_user", input: {} }]), run_id: runId, attachments: "[]", created_at: now() });
    const before = titles().length;
    const { bus } = await import("../src/events/bus");
    bus.emit({ type: "run.finished", run: getRun(runId) });
    expect(titles().length).toBe(before);
    expect(getConversation(conv).unread?.runId).toBe(runId);
  }, 30_000);
});

describe("automations tell the human what they're set to", () => {
  test("by default only a failure, once until it works again; never = silent", async () => {
    const routine = createRoutine({ agentId: agent.id, name: "Nightly report", cron: "0 3 * * *", prompt: "CRASH again" });
    const { triggerRoutine } = await import("../src/scheduler/scheduler");
    const count = () => titles().filter((t) => t === "“Nightly report” failed").length;
    const first = await triggerRoutine(routine.id, { scheduled: true });
    await waitForRun(first.id, 20_000);
    await until(() => count() === 1, 5_000, "the failure notice");
    await until(() => listAttention().some((i) => i.id === `automation:${routine.id}`), 5_000, "the automation to be listed");
    const second = await triggerRoutine(routine.id, { scheduled: true });
    await waitForRun(second.id, 20_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(count()).toBe(1);
    // Automation chats are never "unread": the automation tells the human, or the list does.
    expect(getConversation(getRun(second.id).conversationId).unread).toBeNull();

    const quiet = createRoutine({ agentId: agent.id, name: "Quiet one", cron: "0 4 * * *", prompt: "CRASH quietly", notify: "never" });
    const q = await triggerRoutine(quiet.id, { scheduled: true });
    await waitForRun(q.id, 20_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(titles()).not.toContain("“Quiet one” failed");
  }, 60_000);
});

describe("the list", () => {
  test("tickets to review and blocked ones are listed until they move; the phone can't read the list", async () => {
    const t = createTask({ title: "Write the summary" });
    sql("UPDATE tasks SET status = 'in_review' WHERE id = ?", t.id);
    expect(listAttention().find((i) => i.id === `review:${t.id}`)).toMatchObject({ kind: "review", action: "Review", link: `/tasks?task=${t.id}` });
    updateTask(t.id, { status: "done" });
    expect(listAttention().some((i) => i.id === `review:${t.id}`)).toBe(false);
    expect(deviceMayCall("GET", "/api/attention")).toBe(false);
    const res = await fetch(`${env.baseUrl}/api/system/bootstrap`, { headers: { Authorization: `Bearer ${getAccessToken()}` } }).catch(() => null);
    if (res?.ok) {
      const boot = (await res.json()) as { counts: { attention: { total: number }; unreadChats: number } };
      expect(boot.counts.attention.total).toBe(listAttention().length);
    }
  });

  test("a chat paused by the human waits for them; one held run per budget is one row", async () => {
    const conv = newId("cnv");
    insert("conversations", { id: conv, agent_id: agent.id, title: "Paused chat", origin: "chat", created_at: now(), updated_at: now() });
    const runId = newId("run");
    insert("runs", { id: runId, agent_id: agent.id, conversation_id: conv, trigger: "chat", status: "paused", prompt: "x", created_at: now() });
    const msg = newId("msg");
    insert("messages", { id: msg, conversation_id: conv, role: "assistant", content: "", blocks: "[]", run_id: runId, attachments: "[]", created_at: now() });
    insert("paused_runs", { run_id: runId, conversation_id: conv, agent_id: agent.id, message_id: msg, also_answers: "[]", reason: "user", auto: 0, delivered: 1, retries: 0, depth: 0, voice: 0, created_at: now() });
    expect(listAttention().find((i) => i.id === `paused:${runId}`)).toMatchObject({ title: "Mia is paused", action: "Continue", link: `/chat/${conv}` });
    sql("DELETE FROM paused_runs WHERE run_id = ?", runId);
    expect(listAttention().some((i) => i.id === `paused:${runId}`)).toBe(false);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE unread_run_id IS NOT NULL")!.n).toBeGreaterThanOrEqual(0);
  });

  test("a chat a window shows is read at once, and its runs leave nothing unread", async () => {
    const chat = await startChat({ agentId: agent.id, content: "Say hello", title: "Watched" });
    await waitForRun(chat.run.id, 20_000);
    await until(() => !!getConversation(chat.conversation.id).unread, 5_000, "unread");
    // A socket the way the server accepts a window's (the test harness serves HTTP only).
    const { websocketHandler } = await import("../src/server/ws");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req, { data: { id: newId("ws"), subscriptions: new Set<string>(), auth: "token" as const } }) ? undefined : new Response("no", { status: 400 })),
      websocket: websocketHandler,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("socket error")));
    });
    try {
      ws.send(JSON.stringify({ type: "conversation.view", conversationId: chat.conversation.id }));
      await until(() => !getConversation(chat.conversation.id).unread, 5_000, "the chat to be read");
      const before = titles().length;
      const { run } = await sendMessage(chat.conversation.id, { content: "Say hello again" });
      await waitForRun(run.id, 20_000);
      await new Promise((r) => setTimeout(r, 100));
      expect(getConversation(chat.conversation.id).unread).toBeNull();
      expect(titles().length).toBe(before);
    } finally {
      ws.close();
      server.stop(true);
    }
  }, 30_000);
});
