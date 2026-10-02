import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, MessageBlock, QueuedMessage } from "@godmode/shared";
import { argValue, captureEvents, invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { get, insert, run as sql } from "../src/db";
import { now } from "../src/util";
import { getAccessToken } from "../src/server/auth";
import * as vault from "../src/vault/vault";
import { createCredential } from "../src/vault/credentials";
import { stopAgentRuns } from "../src/agents/service";
import { createConversation, deleteConversation, getConversation, sendMessage, startChat, transcriptPath } from "../src/services/conversations";
import { editQueued, listQueue, removeQueued, sendQueuedNow, submitMessage } from "../src/services/messageQueue";
import { activeRunForConversation, cancelRun, deliverQueued, getRun, listRuns, waitForRun } from "../src/runner/runner";

let env: TestEnv;
let agent: Agent;
const PASSWORD = "s3cret-Portal-pass";

beforeAll(async () => {
  env = await setupEnv("godmode-queue-");
  agent = await makeAgent({ name: "Queue Test Bot" });
  await vault.setup("queue test passphrase", false);
  createCredential({ name: "Portal", url: "https://portal.example.com", username: "dana", password: PASSWORD });
});

afterAll(async () => {
  await env.close();
});

/** Files the fake Claude waits for: `queue-ready` lets it ask for the queue, `finish` lets it end its turn. */
const signal = (name: "queue-ready" | "finish") => writeFileSync(join(env.stateDir, name), "");

afterEach(() => {
  for (const name of ["queue-ready", "finish"]) rmSync(join(env.stateDir, name), { force: true });
});

type Picked = Extract<MessageBlock, { type: "user_message" }>;

const queuedOf = (outcome: Awaited<ReturnType<typeof submitMessage>>): QueuedMessage => {
  if (!("queued" in outcome)) throw new Error("expected the message to be queued");
  return outcome.queued;
};

async function busyChat(content: string, as: Agent = agent) {
  const started = await startChat({ agentId: as.id, content });
  // Until Claude answers: its session exists, so the next turn resumes it.
  await until(() => getRun(started.run.id).status === "running" && getConversation(started.conversation.id).messages.at(-1)!.blocks.length > 0, 10_000, "run to start");
  return started;
}

const idle = (conversationId: string) => until(() => activeRunForConversation(conversationId) === null, 20_000, "the chat to go idle");

describe("message queue", () => {
  test("an idle chat answers right away", async () => {
    const conv = createConversation({ agentId: agent.id });
    const outcome = await submitMessage(conv.id, { content: "hello" });
    if (!("run" in outcome)) throw new Error("expected a run");
    expect((await waitForRun(outcome.run.id, 20_000)).status).toBe("succeeded");
    expect(getConversation(conv.id).queue).toEqual([]);
  });

  test("the working agent picks queued messages up between two steps", async () => {
    const { events, stop } = captureEvents();
    const started = await busyChat("WAIT_FOR_QUEUE");
    const conversationId = started.conversation.id;

    const first = queuedOf(await submitMessage(conversationId, { content: "also check the invoices", attachments: [{ name: "note.txt", mime: "text/plain", data: "aGk=" }] }));
    const second = queuedOf(await submitMessage(conversationId, { content: "and use the blue template" }));
    expect(getConversation(conversationId).queue.map((q) => q.id)).toEqual([first.id, second.id]);
    expect(getConversation(conversationId).messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(listRuns({ conversationId })).toHaveLength(1);
    signal("queue-ready");

    const finished = await waitForRun(started.run.id, 20_000);
    stop();
    expect(finished.status).toBe("succeeded");
    const answer = JSON.parse(finished.result!.slice("QUEUE ".length)) as { hookType: string; subagent: number; context: string };
    expect(answer.hookType).toBe("http");
    // A subagent's step leaves the queue alone.
    expect(answer.subagent).toBe(204);
    expect(answer.context).toContain("<message-from-human>\nalso check the invoices\n\nAttached files: ");
    expect(answer.context).toContain(join(agent.repoPath, first.attachments[0]!.path));
    expect(answer.context).toContain("<message-from-human>\nand use the blue template\n</message-from-human>");

    const conv = getConversation(conversationId);
    expect(conv.queue).toEqual([]);
    // No run of their own: the messages are part of the turn that picked them up.
    expect(listRuns({ conversationId })).toHaveLength(1);
    expect(conv.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const blocks = conv.messages[1]!.blocks;
    const picked = blocks.filter((b): b is Picked => b.type === "user_message");
    expect(picked.map((b) => b.text)).toEqual(["also check the invoices", "and use the blue template"]);
    expect(picked[0]!.attachments[0]!.name).toBe("note.txt");
    expect(blocks.findIndex((b) => b.type === "tool_use")).toBeLessThan(blocks.indexOf(picked[0]!));

    const updates = events.flatMap((e) => (e.type === "queue.updated" && e.conversationId === conversationId ? [e.queue.length] : []));
    expect(updates).toEqual([1, 2, 0]);
    expect(readFileSync(transcriptPath(agent, conversationId), "utf8")).toContain(`while ${agent.name} was working\n\nalso check the invoices`);
    // Too late to reword or take back.
    expect(() => editQueued(conversationId, first.id, "something else")).toThrow("Queued message not found");

    const inv = invocations(env).find((i) => i.prompt.includes("WAIT_FOR_QUEUE"))!;
    expect(argValue(inv, "--append-system-prompt")).toContain("### Messages while you work");
  });

  test("the hook needs the run's token", async () => {
    const res = await fetch(`${env.baseUrl}/mcp/hooks/post-tool-batch`, { method: "POST", headers: { Authorization: `Bearer ${getAccessToken()}` }, body: "{}" });
    expect(res.status).toBe(401);
  });

  test("a saved secret reaches the agent but is stored masked", async () => {
    const started = await busyChat("WAIT_FOR_QUEUE");
    const conversationId = started.conversation.id;
    const queued = queuedOf(await submitMessage(conversationId, { content: `the portal password is ${PASSWORD}` }));
    expect(queued.content).toBe("the portal password is ••••••••");
    expect(get<{ content: string }>("SELECT content FROM queued_messages WHERE id = ?", queued.id)!.content).not.toContain(PASSWORD);
    // The editor only ever sees the mask: saving it would replace the secret.
    expect(() => editQueued(conversationId, queued.id, "the portal password is •••••••• (new)")).toThrow("can't be edited");
    signal("queue-ready");

    await waitForRun(started.run.id, 20_000);
    expect(readFileSync(join(env.stateDir, "queue-context.txt"), "utf8")).toContain(`<message-from-human>\nthe portal password is ${PASSWORD}\n`);
    const assistant = getConversation(conversationId).messages.at(-1)!;
    expect(JSON.stringify(assistant)).not.toContain(PASSWORD);
    expect(assistant.blocks.find((b): b is Picked => b.type === "user_message")!.text).toBe("the portal password is ••••••••");
  });

  test("what still waits when the run ends becomes one turn", async () => {
    const started = await busyChat("WAIT_TO_FINISH");
    const conversationId = started.conversation.id;
    queuedOf(await submitMessage(conversationId, { content: "first thing" }));
    queuedOf(await submitMessage(conversationId, { content: "second thing" }));
    signal("finish");

    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
    await until(() => listRuns({ conversationId }).length === 2, 10_000, "the queue's run");
    const next = listRuns({ conversationId })[0]!;
    expect((await waitForRun(next.id, 20_000)).status).toBe("succeeded");

    const conv = getConversation(conversationId);
    expect(conv.queue).toEqual([]);
    expect(conv.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user", "assistant"]);
    expect(conv.messages.slice(2, 4).map((m) => [m.content, m.runId])).toEqual([
      ["first thing", next.id],
      ["second thing", next.id],
    ]);
    expect(invocations(env).at(-1)!.prompt.endsWith("first thing\n\nsecond thing")).toBe(true);
    const transcript = readFileSync(transcriptPath(agent, conversationId), "utf8");
    expect(transcript).toContain("first thing");
    expect(transcript).toContain("second thing");
  });

  test("stopping the agent leaves the queue until the human sends it", async () => {
    const started = await busyChat("SLEEP");
    const conversationId = started.conversation.id;
    queuedOf(await submitMessage(conversationId, { content: "wait for me" }));

    await cancelRun(started.run.id, "Cancelled by user");
    expect((await waitForRun(started.run.id, 15_000)).status).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 200));
    expect(listRuns({ conversationId })).toHaveLength(1);
    expect(listQueue(conversationId).map((q) => q.content)).toEqual(["wait for me"]);
    // A stopped run takes nothing either.
    expect(deliverQueued(started.run.id)).toBeNull();

    await sendQueuedNow(conversationId);
    await until(() => listRuns({ conversationId }).length === 2, 10_000, "the queue's run");
    expect((await waitForRun(listRuns({ conversationId })[0]!.id, 20_000)).status).toBe("succeeded");
    expect(listQueue(conversationId)).toEqual([]);
    expect(invocations(env).at(-1)!.prompt.endsWith("wait for me")).toBe(true);
  });

  test("a slash command waits for its own turn", async () => {
    const started = await busyChat("SLEEP");
    const conversationId = started.conversation.id;
    queuedOf(await submitMessage(conversationId, { content: "/compact" }));
    queuedOf(await submitMessage(conversationId, { content: "after compacting" }));
    // Nothing to hand over mid-run: the command leads the queue.
    expect(deliverQueued(started.run.id)).toBeNull();
    expect(listQueue(conversationId)).toHaveLength(2);

    await sendQueuedNow(conversationId);
    await until(() => listRuns({ conversationId }).length === 3, 20_000, "both turns");
    await idle(conversationId);
    const prompts = invocations(env).slice(-2).map((i) => i.prompt);
    expect(prompts[0]).toBe("/compact");
    expect(prompts[1]!.endsWith("after compacting")).toBe(true);
    expect(listQueue(conversationId)).toEqual([]);
  });

  test("queued messages can be edited, removed and sent right away", async () => {
    const started = await busyChat("SLEEP");
    const conversationId = started.conversation.id;
    const a = queuedOf(await submitMessage(conversationId, { content: "draft" }));
    const b = queuedOf(await submitMessage(conversationId, { content: "never mind" }));

    expect(editQueued(conversationId, a.id, "  final wording ").content).toBe("final wording");
    expect(() => editQueued(conversationId, a.id, "  ")).toThrow("Message is empty");
    removeQueued(conversationId, b.id);
    expect(() => removeQueued(conversationId, b.id)).toThrow("Queued message not found");
    expect(listQueue(conversationId).map((q) => q.content)).toEqual(["final wording"]);

    // Answers once the agent has stopped.
    await sendQueuedNow(conversationId);
    const stopped = getRun(started.run.id);
    expect(stopped.status).toBe("cancelled");
    expect(stopped.error).toBe("Stopped to start on your queued messages");
    await until(() => listRuns({ conversationId }).length === 2, 10_000, "the queue's run");
    expect((await waitForRun(listRuns({ conversationId })[0]!.id, 20_000)).status).toBe("succeeded");
    expect(invocations(env).at(-1)!.prompt.endsWith("final wording")).toBe(true);
    await expect(sendQueuedNow(conversationId)).rejects.toThrow("Queued message not found");
  });

  test("the API queues on request and keeps starting runs otherwise", async () => {
    const started = await busyChat("SLEEP");
    const conversationId = started.conversation.id;
    const headers = { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" };
    const call = (path: string, method: string, body?: unknown) =>
      fetch(`${env.baseUrl}/api/conversations/${conversationId}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });

    // The client names the queued message, so its row is the same before and after the answer.
    const queueId = "qmsg_abcdefghijklmnop";
    const queued = await call("/messages", "POST", { content: "from the app", queue: true, queueId });
    expect(queued.status).toBe(202);
    expect(((await queued.json()) as { queued: QueuedMessage }).queued).toMatchObject({ id: queueId, content: "from the app" });
    expect((await call("/messages", "POST", { content: "twice", queue: true, queueId })).status).toBe(409);
    expect((await call("/messages", "POST", { content: "odd id", queue: true, queueId: "../etc" })).status).toBe(400);
    expect(((await (await call("", "GET")).json()) as { queue: QueuedMessage[] }).queue.map((q) => q.id)).toEqual([queueId]);

    const edited = await call(`/queue/${queueId}`, "PATCH", { content: "from the app, edited" });
    expect(((await edited.json()) as QueuedMessage).content).toBe("from the app, edited");
    expect((await call(`/queue/${queueId}`, "DELETE")).status).toBe(200);
    expect((await call(`/queue/${queueId}`, "PATCH", { content: "too late" })).status).toBe(404);
    expect((await call(`/queue/${queueId}`, "DELETE")).status).toBe(404);
    expect((await call("/queue/send", "POST")).status).toBe(404);

    // Clients that don't ask for the queue get a run of their own, as before.
    const plain = await call("/messages", "POST", { content: "old client" });
    expect(plain.status).toBe(201);
    const { run } = (await plain.json()) as { run: { id: string; status: string } };
    expect(run.status).toBe("queued");

    await cancelRun(started.run.id);
    expect((await waitForRun(run.id, 20_000)).status).toBe("succeeded");
  });

  test("a run of its own in between leaves the queue for the turn after it", async () => {
    const started = await busyChat("SLEEP");
    const conversationId = started.conversation.id;
    queuedOf(await submitMessage(conversationId, { content: "left over" }));
    const second = await sendMessage(conversationId, { content: "WAIT_TO_FINISH" });
    // Nothing to interrupt once the first run is gone and the second hasn't started.
    await cancelRun(started.run.id);
    await until(() => getRun(second.run.id).status === "running" && getConversation(conversationId).messages.at(-1)!.blocks.length > 0, 10_000, "second run");
    expect(listQueue(conversationId)).toHaveLength(1);
    signal("finish");
    await until(() => listQueue(conversationId).length === 0, 10_000, "the queue to start");
    await idle(conversationId);
    expect(invocations(env).at(-1)!.prompt.endsWith("left over")).toBe(true);
  });

  test("messages left over from before go first when the human writes again", async () => {
    const conv = createConversation({ agentId: agent.id });
    // What a restart leaves behind: a queue, and nothing running.
    insert("queued_messages", { id: "qmsg_left", conversation_id: conv.id, content: "from before the restart", attachments: "[]", voice: 0, created_at: now() });
    expect(getConversation(conv.id).queue.map((q) => q.content)).toEqual(["from before the restart"]);

    const outcome = await submitMessage(conv.id, { content: "and this" });
    if (!("run" in outcome)) throw new Error("expected a run");
    expect(outcome.message.content).toBe("and this");
    expect((await waitForRun(outcome.run.id, 20_000)).status).toBe("succeeded");
    expect(invocations(env).at(-1)!.prompt).toBe("from before the restart\n\nand this");
    expect(getConversation(conv.id).messages.map((m) => m.content)).toEqual(["from before the restart", "and this", "Hello, nice to meet you!"]);
  });

  test("a queue that can't start keeps its messages", async () => {
    const other = await makeAgent({ name: "Queue Off Bot" });
    const conv = createConversation({ agentId: other.id });
    insert("queued_messages", { id: "qmsg_keep", conversation_id: conv.id, content: "still here", attachments: "[]", voice: 0, created_at: now() });
    sql("UPDATE agents SET enabled = 0 WHERE id = ?", other.id);

    await expect(sendQueuedNow(conv.id)).rejects.toThrow("is disabled");
    expect(listQueue(conv.id).map((q) => q.content)).toEqual(["still here"]);
    expect(getConversation(conv.id).messages).toEqual([]);
    expect(listRuns({ conversationId: conv.id })).toEqual([]);
  });

  test("stopping an agent's runs or deleting the chat never starts the queue", async () => {
    const other = await makeAgent({ name: "Queue Teardown Bot" });
    const first = await busyChat("SLEEP", other);
    queuedOf(await submitMessage(first.conversation.id, { content: "not now" }));
    await stopAgentRuns(other.id);
    expect(listRuns({ agentId: other.id }).map((r) => r.status)).toEqual(["cancelled"]);
    expect(listQueue(first.conversation.id)).toHaveLength(1);

    const second = await busyChat("SLEEP", other);
    const conversationId = second.conversation.id;
    queuedOf(await submitMessage(conversationId, { content: "too late" }));
    await deleteConversation(conversationId);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM queued_messages WHERE conversation_id = ?", conversationId)!.n).toBe(0);
    expect(listRuns({ conversationId }).filter((r) => r.status === "queued" || r.status === "running")).toEqual([]);
  });
});
