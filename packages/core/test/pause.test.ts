import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, MessageBlock, Run } from "@godmode/shared";
import { argValue, captureEvents, invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { all, get, run as sql } from "../src/db";
import { getAccessToken } from "../src/server/auth";
import { deviceMayCall } from "../src/mobile/scope";
import { getAgent, stopAgentRuns } from "../src/agents/service";
import { deleteConversation, getConversation, sendMessage, startChat, transcriptPath } from "../src/services/conversations";
import { listQueue, sendQueuedNow, submitMessage } from "../src/services/messageQueue";
import { listNotifications } from "../src/services/notifications";
import { updateSettings } from "../src/services/settings";
import {
  MAX_RETRIES,
  continueAgent,
  continueConversation,
  limitReached,
  pauseAgent,
  pauseConversation,
  pauseOf,
  setAutoContinue,
  startPauses,
  stopPauses,
  sweep,
} from "../src/services/pauses";
import { activeRunForConversation, cancelRun, deliverQueued, findRunLog, getRun, listRuns, pauseRun, waitForRun } from "../src/runner/runner";
import { StreamAccumulator } from "../src/runner/stream";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-pause-");
  agent = await makeAgent({ name: "Pause Test Bot" });
});

afterAll(async () => {
  stopPauses();
  await env.close();
});

const FILES = ["step-done", "stopped-by-hook", "limit", "finish"] as const;
const signal = (name: (typeof FILES)[number], content = "") => writeFileSync(join(env.stateDir, name), content);

afterEach(() => {
  for (const name of FILES) rmSync(join(env.stateDir, name), { force: true });
});

type Pause = Extract<MessageBlock, { type: "pause" }>;

/** Start a chat and wait until Claude has answered (its session exists and the prompt is in it). */
async function working(content: string, as: Agent = agent) {
  const started = await startChat({ agentId: as.id, content });
  await until(() => getRun(started.run.id).status === "running" && getConversation(started.conversation.id).messages.at(-1)!.blocks.length > 0, 10_000, "run to start");
  return started;
}

const paused = (runId: string) => until(() => getRun(runId).status === "paused", 15_000, "the run to pause");
const assistantOf = (conversationId: string) => getConversation(conversationId).messages.findLast((m) => m.role === "assistant")!;
const lastPrompt = () => invocations(env).at(-1)!;

describe("pausing a run", () => {
  test("a step in progress finishes, then the run stands still and continues in the same run", async () => {
    const { events, stop } = captureEvents();
    const started = await working("LONG_STEP please");
    const { id: conversationId } = started.conversation;
    const runId = started.run.id;

    await pauseConversation(conversationId);
    // The step is still running: nothing was cut off.
    await new Promise((r) => setTimeout(r, 150));
    expect(getRun(runId).status).toBe("running");
    signal("step-done");
    await paused(runId);
    expect(JSON.parse(readFileSync(join(env.stateDir, "stopped-by-hook"), "utf8"))).toEqual({ continue: false, stopReason: "Paused" });

    const conv = getConversation(conversationId);
    expect(conv.running).toBe(false);
    expect(conv.activeRunId).toBeNull();
    expect(conv.paused).toMatchObject({ runId, reason: "user", limit: null, resumeAt: null, auto: false });
    expect(getAgent(agent.id).pausedRuns).toBe(1);
    const before = assistantOf(conversationId);
    expect(before.blocks.map((b) => b.type)).toEqual(["tool_use", "pause"]);
    expect(before.blocks[0]).toMatchObject({ type: "tool_use", result: "built" });
    expect(before.blocks[1]).toMatchObject({ type: "pause", reason: "user" });
    // Not an ending: nobody who waits for the run is told.
    expect(events.some((e) => e.type === "run.finished" && e.run.id === runId)).toBe(false);
    expect(events.some((e) => e.type === "run.paused" && e.run.id === runId && e.run.status === "paused")).toBe(true);
    expect(getRun(runId).finishedAt).toBeNull();
    expect(existsSync(transcriptPath(agent, conversationId))).toBe(false);
    const spent = getRun(runId);
    expect(spent.costUsd).toBe(0.001);

    const again = continueConversation(conversationId);
    expect(again.id).toBe(runId);
    const finished = await waitForRun(runId, 20_000);
    stop();
    expect(finished.status).toBe("succeeded");
    expect(finished.result).toBe("Hello, nice to meet you!");
    // Both stretches count.
    expect(finished.costUsd).toBeGreaterThan(spent.costUsd!);
    expect(finished.numTurns).toBeGreaterThan(spent.numTurns!);
    expect(finished.usage!.outputTokens).toBeGreaterThan(spent.usage!.outputTokens);
    expect(listRuns({ conversationId })).toHaveLength(1);

    const inv = lastPrompt();
    expect(argValue(inv, "--resume")).toBe(argValue(invocations(env).at(-2)!, "--session-id"));
    expect(inv.prompt).toContain("<godmode-continue>");
    expect(inv.prompt).toContain("paused this turn");
    expect(inv.prompt).not.toContain("LONG_STEP");

    const after = getConversation(conversationId);
    expect(after.paused).toBeNull();
    expect(getAgent(agent.id).pausedRuns).toBe(0);
    expect(after.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const blocks = after.messages[1]!.blocks;
    expect(blocks.slice(0, 2).map((b) => b.type)).toEqual(["tool_use", "pause"]);
    expect((blocks[1] as Pause).resumedAt).toBeTruthy();
    expect(blocks.at(-1)).toMatchObject({ type: "text", text: "Hello, nice to meet you!" });
    expect(events.filter((e) => e.type === "run.finished" && e.run.id === runId)).toHaveLength(1);
    // One log for the whole run.
    const logged = readFileSync(findRunLog(finished)!, "utf8");
    expect(logged).toContain("toolu_long");
    expect(logged).toContain("nice to meet you");
    expect(readFileSync(transcriptPath(agent, conversationId), "utf8")).toContain("Hello, nice to meet you!");
  });

  test("with no step running it stops right away", async () => {
    const started = await working("SLEEP now");
    const t0 = Date.now();
    await pauseConversation(started.conversation.id);
    await paused(started.run.id);
    expect(Date.now() - t0).toBeLessThan(7000);
    expect(assistantOf(started.conversation.id).blocks.map((b) => b.type)).toEqual(["text", "pause"]);
    await expect(pauseConversation(started.conversation.id)).rejects.toThrow("paused already");

    continueConversation(started.conversation.id);
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
    expect(lastPrompt().prompt).toContain("<godmode-continue>");
    expect(() => continueConversation(started.conversation.id)).toThrow("Paused run not found");
  });

  test("a run that hasn't reached Claude yet sends its prompt when it continues", async () => {
    updateSettings({ runner: { maxConcurrentRuns: 1 } });
    try {
      const first = await working("SLEEP in front");
      const second = await startChat({ agentId: agent.id, content: "the real question" });
      expect(getRun(second.run.id).status).toBe("queued");
      await pauseConversation(second.conversation.id);
      expect(getRun(second.run.id).status).toBe("paused");
      expect(get<{ delivered: number }>("SELECT delivered FROM paused_runs WHERE run_id = ?", second.run.id)!.delivered).toBe(0);

      await cancelRun(first.run.id);
      await waitForRun(first.run.id, 15_000);
      // Frozen: a free slot doesn't start it.
      await new Promise((r) => setTimeout(r, 150));
      expect(getRun(second.run.id).status).toBe("paused");

      continueConversation(second.conversation.id);
      expect((await waitForRun(second.run.id, 20_000)).status).toBe("succeeded");
      expect(lastPrompt().prompt).toBe("the real question");
    } finally {
      updateSettings({ runner: { maxConcurrentRuns: 3 } });
    }
  });

  test("a message to a paused chat continues it and goes along", async () => {
    const started = await working("SLEEP until told");
    const { id: conversationId } = started.conversation;
    await pauseConversation(conversationId);
    await paused(started.run.id);

    const outcome = await submitMessage(conversationId, { content: "use the blue template instead" });
    expect("queued" in outcome).toBe(true);
    const finished = await waitForRun(started.run.id, 20_000);
    expect(finished.status).toBe("succeeded");
    expect(listRuns({ conversationId })).toHaveLength(1);
    expect(listQueue(conversationId)).toEqual([]);
    const { prompt } = lastPrompt();
    expect(prompt).toContain("<godmode-continue>");
    expect(prompt.endsWith("</godmode-continue>\n\nuse the blue template instead")).toBe(true);
    const blocks = assistantOf(conversationId).blocks.filter((b) => b.type !== "thinking");
    expect(blocks.map((b) => b.type)).toEqual(["text", "pause", "user_message", "text"]);
    expect(blocks[2]).toMatchObject({ type: "user_message", text: "use the blue template instead" });
  });

  test("runs that come after a paused one wait for it", async () => {
    const started = await working("SLEEP frozen");
    const { id: conversationId } = started.conversation;
    await pauseConversation(conversationId);
    await paused(started.run.id);

    // Work that isn't a message from a human (an automation, an agent) gets its run behind the paused one.
    const next = await sendMessage(conversationId, { content: "and one more thing", trigger: "manual" });
    await new Promise((r) => setTimeout(r, 200));
    expect(getRun(next.run.id).status).toBe("queued");
    // The chat has one paused run; what waits behind it can't be paused as well.
    await expect(pauseConversation(conversationId)).rejects.toThrow("paused already");
    await expect(pauseRun(next.run.id)).rejects.toThrow("paused already");
    expect(await pauseAgent(agent.id)).toBe(0);
    expect(pauseOf(conversationId)!.run_id).toBe(started.run.id);
    expect(getRun(next.run.id).status).toBe("queued");

    continueConversation(conversationId);
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
    expect((await waitForRun(next.run.id, 20_000)).status).toBe("succeeded");
    expect(invocations(env).at(-1)!.prompt.endsWith("and one more thing")).toBe(true);
  });

  test("a message from a client that doesn't queue continues a chat the human paused", async () => {
    const started = await working("SLEEP until the phone writes");
    const { id: conversationId } = started.conversation;
    await pauseConversation(conversationId);
    await paused(started.run.id);

    // The phone and platform chats get a run of their own: the paused run goes on first, then the message's turn.
    const next = await sendMessage(conversationId, { content: "are you still on it?" });
    expect(next.run.id).not.toBe(started.run.id);
    expect(getConversation(conversationId).paused).toBeNull();
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
    expect((await waitForRun(next.run.id, 20_000)).status).toBe("succeeded");
    const prompts = invocations(env).slice(-2).map((i) => i.prompt);
    expect(prompts[0]).toContain("<godmode-continue>");
    expect(prompts[1]!.endsWith("are you still on it?")).toBe(true);
  });

  test("a run that is being paused takes no queued message; the message goes along when it continues", async () => {
    const started = await working("LONG_STEP with a message");
    const { id: conversationId } = started.conversation;
    const queued = await submitMessage(conversationId, { content: "one more detail" });
    expect("queued" in queued).toBe(true);
    await pauseConversation(conversationId);
    // Between the pause and the end of the process Claude Code may still ask for the queue.
    expect(deliverQueued(started.run.id)).toBeNull();
    expect(listQueue(conversationId)).toHaveLength(1);
    signal("step-done");
    await paused(started.run.id);
    expect(listQueue(conversationId)).toHaveLength(1);

    continueConversation(conversationId);
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
    expect(lastPrompt().prompt.endsWith("</godmode-continue>\n\none more detail")).toBe(true);
    expect(listQueue(conversationId)).toEqual([]);
  });

  test("continuing after the Claude session is gone hands the task over again", async () => {
    const started = await working("LONG_STEP whose session gets lost");
    const { id: conversationId } = started.conversation;
    await pauseConversation(conversationId);
    signal("step-done");
    await paused(started.run.id);
    rmSync(join(env.stateDir, "sessions", argValue(lastPrompt(), "--session-id")!));

    continueConversation(conversationId);
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
    const retry = lastPrompt();
    expect(argValue(retry, "--resume")).toBeNull();
    expect(retry.prompt).toContain("could not be restored");
    // The new session knows what it was asked and that it continues, not only that it should "go on".
    expect(retry.prompt).toContain("User: LONG_STEP whose session gets lost");
    expect(retry.prompt).toContain("<godmode-continue>");
    expect(assistantOf(conversationId).blocks.map((b) => b.type).slice(0, 2)).toEqual(["tool_use", "pause"]);
  });

  test("waiting for a run can end when it is paused", async () => {
    const started = await working("SLEEP while someone waits");
    const waiting = waitForRun(started.run.id, 20_000, { orPaused: true });
    await pauseConversation(started.conversation.id);
    expect((await waiting).status).toBe("paused");
    expect((await waitForRun(started.run.id, 20_000, { orPaused: true })).status).toBe("paused");
    await cancelRun(started.run.id);
  });

  test("stopping a paused run ends it and lets the chat go on", async () => {
    const { events, stop } = captureEvents();
    const started = await working("SLEEP then stop");
    const { id: conversationId } = started.conversation;
    await pauseConversation(conversationId);
    await paused(started.run.id);
    await submitQueuedBehind(conversationId);

    await cancelRun(started.run.id, "Cancelled by user");
    stop();
    const run = getRun(started.run.id);
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe("Cancelled by user");
    expect(run.finishedAt).toBeTruthy();
    expect(pauseOf(conversationId)).toBeNull();
    expect(getConversation(conversationId).paused).toBeNull();
    expect(assistantOf(conversationId).blocks.at(-1)).toEqual({ type: "notice", level: "info", text: "Cancelled by user" });
    expect(events.filter((e) => e.type === "run.finished" && e.run.id === started.run.id)).toHaveLength(1);
    expect(readFileSync(transcriptPath(agent, conversationId), "utf8")).toContain("cancelled");
    // Stop means stop: the queue waits for the human.
    expect(listQueue(conversationId)).toHaveLength(1);
    await sendQueuedNow(conversationId);
    await until(() => listRuns({ conversationId }).length === 2, 10_000, "the queue's run");
    expect((await waitForRun(listRuns({ conversationId })[0]!.id, 20_000)).status).toBe("succeeded");

    async function submitQueuedBehind(id: string) {
      // The limit case keeps messages waiting; a user pause would continue with them, so queue it directly.
      sql("INSERT INTO queued_messages (id, conversation_id, content, attachments, voice, created_at) VALUES (?, ?, ?, '[]', 0, ?)", "qmsg_behind", id, "later", new Date().toISOString());
    }
  });

  test("dreams and checks can't be paused, and an idle chat has nothing to pause", async () => {
    const idle = await startChat({ agentId: agent.id, content: "hi" });
    await waitForRun(idle.run.id, 20_000);
    await expect(pauseConversation(idle.conversation.id)).rejects.toThrow("Nothing is running in this chat");
    await expect(pauseConversation("cnv_missing")).rejects.toThrow("Conversation not found");
    await expect(pauseRun(idle.run.id)).rejects.toThrow("isn't working right now");
  });

  test("deleting the chat or stopping the agent ends its paused runs", async () => {
    const other = await makeAgent({ name: "Pause Teardown Bot" });
    const first = await working("SLEEP one", other);
    await pauseConversation(first.conversation.id);
    await paused(first.run.id);
    await deleteConversation(first.conversation.id);
    expect(getRun(first.run.id).status).toBe("cancelled");
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM paused_runs WHERE run_id = ?", first.run.id)!.n).toBe(0);

    const second = await working("SLEEP two", other);
    await pauseConversation(second.conversation.id);
    await paused(second.run.id);
    await stopAgentRuns(other.id);
    expect(getRun(second.run.id).status).toBe("cancelled");
    expect(getAgent(other.id).pausedRuns).toBe(0);
  });

  test("an agent pauses and continues everything it works on", async () => {
    const other = await makeAgent({ name: "Busy Bot" });
    const a = await working("SLEEP a", other);
    const b = await working("SLEEP b", other);
    expect(await pauseAgent(other.id)).toBe(2);
    await paused(a.run.id);
    await paused(b.run.id);
    expect(getAgent(other.id).pausedRuns).toBe(2);
    expect(getAgent(other.id).status).toBe("idle");
    expect(await pauseAgent(other.id)).toBe(0);

    expect(continueAgent(other.id)).toBe(2);
    const done = await Promise.all([waitForRun(a.run.id, 20_000), waitForRun(b.run.id, 20_000)]);
    expect(done.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    expect(continueAgent(other.id)).toBe(0);
  });

  test("the API pauses and continues chats and agents", async () => {
    const started = await working("SLEEP api");
    const { id: conversationId } = started.conversation;
    const headers = { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" };
    const call = (path: string, method = "POST", body?: unknown) => fetch(`${env.baseUrl}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });

    expect((await call(`/conversations/${conversationId}/continue`)).status).toBe(404);
    expect((await call(`/conversations/${conversationId}/pause`)).status).toBe(200);
    await paused(started.run.id);
    expect((await call(`/conversations/${conversationId}/pause`)).status).toBe(409);
    // Only a run that waits for the limit continues by itself.
    expect((await call(`/conversations/${conversationId}/pause`, "PATCH", { auto: true })).status).toBe(400);
    const conv = (await (await call(`/conversations/${conversationId}`, "GET")).json()) as { paused: { runId: string } | null };
    expect(conv.paused?.runId).toBe(started.run.id);

    const continued = await call(`/conversations/${conversationId}/continue`);
    expect(continued.status).toBe(201);
    expect(((await continued.json()) as Run).id).toBe(started.run.id);
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");

    expect((await call(`/agents/${agent.id}/pause`)).status).toBe(409);
    expect((await call(`/agents/${agent.id}/continue`)).status).toBe(409);
    const busy = await working("SLEEP agent api");
    expect(await (await call(`/agents/${agent.id}/pause`)).json()).toEqual({ paused: 1 });
    await paused(busy.run.id);
    expect(await (await call(`/agents/${agent.id}/continue`)).json()).toEqual({ continued: 1 });
    expect((await waitForRun(busy.run.id, 20_000)).status).toBe("succeeded");

    // Phones may pause and continue chats, not whole agents.
    expect(deviceMayCall("POST", `/api/conversations/${conversationId}/pause`)).toBe(true);
    expect(deviceMayCall("POST", `/api/conversations/${conversationId}/continue`)).toBe(true);
    expect(deviceMayCall("PATCH", `/api/conversations/${conversationId}/pause`)).toBe(false);
    expect(deviceMayCall("POST", `/api/agents/${agent.id}/pause`)).toBe(false);
  });
});

describe("Claude's usage limit", () => {
  const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
  /** Let the limit reset: the waiting run is due now. */
  const due = (runId: string) => sql("UPDATE paused_runs SET resume_at = ? WHERE run_id = ?", new Date(Date.now() - 1000).toISOString(), runId);

  test("a run that hits the limit waits and continues by itself after the reset", async () => {
    const resetsAt = inAnHour();
    signal("limit", String(resetsAt));
    const { events, stop } = captureEvents();
    const started = await startChat({ agentId: agent.id, content: "LIMIT_HIT do the weekly report" });
    const { id: conversationId } = started.conversation;
    const runId = started.run.id;
    await paused(runId);

    const conv = getConversation(conversationId);
    expect(conv.paused).toMatchObject({ runId, reason: "limit", limit: "session limit", auto: true });
    // A little after the reset.
    expect(Date.parse(conv.paused!.resumeAt!)).toBe(resetsAt * 1000 + 30_000);
    const blocks = assistantOf(conversationId).blocks;
    // Claude Code's own line about the limit is replaced by the marker; nothing reads like an error.
    expect(blocks.map((b) => b.type)).toEqual(["pause"]);
    expect(blocks[0]).toMatchObject({ type: "pause", reason: "limit", limit: "session limit", resumeAt: conv.paused!.resumeAt });
    expect(getRun(runId).error).toBeNull();
    expect(events.some((e) => e.type === "run.finished" && e.run.id === runId)).toBe(false);
    const note = listNotifications().find((n) => n.title === "Claude's session limit is reached")!;
    expect(note.body).toContain("continues by itself");
    expect(note.link).toBe(`/chat/${conversationId}`);

    // What the human writes meanwhile waits: there is nothing to continue with yet.
    const outcome = await submitMessage(conversationId, { content: "and add last week's numbers" });
    expect("queued" in outcome).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(getRun(runId).status).toBe("paused");
    expect(listQueue(conversationId)).toHaveLength(1);

    startPauses();
    sweep();
    expect(getRun(runId).status).toBe("paused");

    rmSync(join(env.stateDir, "limit"));
    due(runId);
    sweep();
    const finished = await waitForRun(runId, 20_000);
    stop();
    expect(finished.status).toBe("succeeded");
    expect(finished.result).toBe("back after the limit");
    expect(listRuns({ conversationId })).toHaveLength(1);
    // Claude never answered the prompt: it is sent again, with what was written meanwhile.
    expect(lastPrompt().prompt.endsWith("LIMIT_HIT do the weekly report\n\nand add last week's numbers")).toBe(true);
    expect(argValue(lastPrompt(), "--resume")).toBeTruthy();
    expect(getConversation(conversationId).paused).toBeNull();
    expect(assistantOf(conversationId).blocks.map((b) => b.type)).toEqual(["pause", "user_message", "text"]);
    // The same limit again is not announced twice.
    expect(listNotifications().filter((n) => n.title === "Claude's session limit is reached")).toHaveLength(1);
  });

  test("continuing by itself can be turned off for one run or for all", async () => {
    signal("limit", String(inAnHour()));
    const started = await startChat({ agentId: agent.id, content: "LIMIT_HIT one" });
    await paused(started.run.id);
    expect(setAutoContinue(started.conversation.id, false).auto).toBe(false);
    due(started.run.id);
    sweep();
    await new Promise((r) => setTimeout(r, 150));
    expect(getRun(started.run.id).status).toBe("paused");
    expect(setAutoContinue(started.conversation.id, true).auto).toBe(true);
    await cancelRun(started.run.id);

    updateSettings({ runner: { autoContinueOnLimit: false } });
    try {
      const manual = await startChat({ agentId: agent.id, content: "LIMIT_HIT two" });
      await paused(manual.run.id);
      expect(getConversation(manual.conversation.id).paused).toMatchObject({ reason: "limit", auto: false });
      // The human continues it when the limit has reset.
      rmSync(join(env.stateDir, "limit"));
      continueConversation(manual.conversation.id);
      expect((await waitForRun(manual.run.id, 20_000)).status).toBe("succeeded");
    } finally {
      updateSettings({ runner: { autoContinueOnLimit: true } });
    }
  });

  test("what the human chose for a run stays when it hits the limit again", async () => {
    signal("limit", String(inAnHour()));
    const started = await startChat({ agentId: agent.id, content: "LIMIT_HIT choice" });
    const { id: conversationId } = started.conversation;
    await paused(started.run.id);
    setAutoContinue(conversationId, false);
    // "Continue now" while the limit is still there.
    continueConversation(conversationId);
    await until(() => assistantOf(conversationId).blocks.filter((b) => b.type === "pause").length === 2 && getRun(started.run.id).status === "paused", 15_000, "paused again");
    expect(pauseOf(conversationId)).toMatchObject({ auto: 0, choice: 0, retries: 0 });
    setAutoContinue(conversationId, true);
    continueConversation(conversationId);
    await until(() => assistantOf(conversationId).blocks.filter((b) => b.type === "pause").length === 3 && getRun(started.run.id).status === "paused", 15_000, "paused once more");
    // Trying by hand doesn't use up the tries of the timer.
    expect(pauseOf(conversationId)).toMatchObject({ auto: 1, retries: 0 });
    await cancelRun(started.run.id);
  });

  test("a run that waited without a reset time follows the setting once Claude names one", async () => {
    signal("limit", "");
    const started = await startChat({ agentId: agent.id, content: "LIMIT_HIT then a time" });
    const { id: conversationId } = started.conversation;
    await paused(started.run.id);
    expect(pauseOf(conversationId)).toMatchObject({ auto: 0, choice: null });
    // Nobody switched Auto off: with a reset time the run continues by itself again.
    signal("limit", String(inAnHour()));
    continueConversation(conversationId);
    await until(() => assistantOf(conversationId).blocks.filter((b) => b.type === "pause").length === 2 && getRun(started.run.id).status === "paused", 15_000, "paused again");
    expect(pauseOf(conversationId)).toMatchObject({ auto: 1, choice: null });
    await cancelRun(started.run.id);
  });

  test("a failure while Claude reports a limit but still answers is a failure", async () => {
    const started = await startChat({ agentId: agent.id, content: "OVERAGE_CRASH" });
    const run = await waitForRun(started.run.id, 20_000);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("exploded");
    expect(getConversation(started.conversation.id).paused).toBeNull();
  });

  test("without a reset time the run waits for the human", async () => {
    signal("limit", "");
    const started = await startChat({ agentId: agent.id, content: "LIMIT_HIT no time" });
    await paused(started.run.id);
    expect(getConversation(started.conversation.id).paused).toMatchObject({ reason: "limit", resumeAt: null, auto: false });
    expect(() => setAutoContinue(started.conversation.id, true)).toThrow("didn't say when the limit resets");
    await cancelRun(started.run.id);
  });

  test("a limit that doesn't lift stops the run from continuing by itself", async () => {
    signal("limit", String(inAnHour()));
    const started = await startChat({ agentId: agent.id, content: "LIMIT_HIT stubborn" });
    const runId = started.run.id;
    await paused(runId);
    for (let i = 1; i <= MAX_RETRIES; i++) {
      due(runId);
      sweep();
      await until(() => get<{ retries: number }>("SELECT retries FROM paused_runs WHERE run_id = ?", runId)?.retries === i, 15_000, `try ${i}`);
    }
    const row = pauseOf(started.conversation.id)!;
    expect(row.auto).toBe(0);
    expect(listNotifications().some((n) => n.title.includes("couldn't continue") && n.body.includes("still reports its session limit"))).toBe(true);
    // Each try added a marker to the same message, in the same run.
    expect(listRuns({ conversationId: started.conversation.id })).toHaveLength(1);
    expect(assistantOf(started.conversation.id).blocks.filter((b) => b.type === "pause")).toHaveLength(MAX_RETRIES + 1);
    await cancelRun(runId);
  });

  test("a paused run whose agent was turned off stays paused and says why", async () => {
    signal("limit", String(inAnHour()));
    const other = await makeAgent({ name: "Off Bot" });
    const started = await startChat({ agentId: other.id, content: "LIMIT_HIT off" });
    await paused(started.run.id);
    sql("UPDATE agents SET enabled = 0 WHERE id = ?", other.id);
    due(started.run.id);
    sweep();
    expect(getRun(started.run.id).status).toBe("paused");
    expect(pauseOf(started.conversation.id)!.auto).toBe(0);
    expect(listNotifications().some((n) => n.title === `Off Bot couldn't continue “LIMIT_HIT off”` && n.body.includes("is disabled"))).toBe(true);
    sql("UPDATE agents SET enabled = 1 WHERE id = ?", other.id);
    await cancelRun(started.run.id);
  });

  test("names the limit and the reset from what Claude reports", () => {
    const at = Math.floor(Date.now() / 1000) + 600;
    const line = "You've hit your weekly limit · resets Oct 9, 9am";
    expect(limitReached({ type: "seven_day", resetsAt: at }, line)).toEqual({ limit: "weekly limit", resumeAt: new Date(at * 1000 + 30_000).toISOString() });
    expect(limitReached(null, "You've hit your Opus limit · resets Oct 9, 9am")).toEqual({ limit: "Opus limit", resumeAt: null });
    // What Claude reports alone proves nothing: requests still go through on usage credits.
    expect(limitReached({ type: "seven_day", resetsAt: at }, "fatal: something exploded")).toBeNull();
    expect(limitReached(null, `Claude AI usage limit reached|${at}`)).toEqual({ limit: "usage limit", resumeAt: new Date(at * 1000 + 30_000).toISOString() });
    // A reset that has passed while Claude still refuses: try again in a few minutes.
    const stale = limitReached({ type: "five_hour", resetsAt: at - 3600 }, "usage limit reached")!;
    expect(Date.parse(stale.resumeAt!) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(limitReached(null, "API Error: 500 Internal server error")).toBeNull();
  });

  test("the stream tells a reached limit from a warning, and Claude Code's line from the model's", () => {
    const acc = new StreamAccumulator();
    acc.push({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1790955600, rateLimitType: "five_hour", overageStatus: "rejected" } });
    expect(acc.limit).toBeNull();
    acc.push({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "You've hit your stride, the usage limit reached in the docs is 5." }] } });
    expect(acc.limitLine).toBeNull();
    expect(acc.answered).toBe(true);
    acc.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1790955600, rateLimitType: "five_hour" } });
    expect(acc.limit).toEqual({ type: "five_hour", resetsAt: 1790955600 });
    acc.push({ type: "assistant", message: { id: "m2", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 3pm" }] } });
    expect(acc.limitLine).toBe("You've hit your session limit · resets 3pm");
    expect(acc.model).toBe("claude-opus-5-5");

    // What the model was still writing when the run stopped is not in its session: it goes, the marker comes last.
    acc.push({ type: "stream_event", event: { type: "message_start", message: { id: "m3" } } });
    acc.push({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "Half a sen" } } });
    acc.markPause({ type: "pause", reason: "limit", at: "2026-10-02T12:00:00.000Z" });
    expect(acc.blocks.map((b) => b.type)).toEqual(["text", "pause"]);
    expect(acc.blocks[0]).toMatchObject({ text: "You've hit your stride, the usage limit reached in the docs is 5." });
  });
});

describe("restart", () => {
  test("a paused run continues after a restart, and one that lost its pause is closed", async () => {
    const started = await working("SLEEP across a restart");
    const { id: conversationId } = started.conversation;
    await pauseConversation(conversationId);
    await paused(started.run.id);
    // What a restart leaves: the rows, nothing in memory.
    stopPauses();
    startPauses();
    expect(getRun(started.run.id).status).toBe("paused");
    expect(activeRunForConversation(conversationId)).toBeNull();
    continueConversation(conversationId);
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");

    const lost = await working("SLEEP and lose it");
    await pauseConversation(lost.conversation.id);
    await paused(lost.run.id);
    sql("DELETE FROM paused_runs WHERE run_id = ?", lost.run.id);
    stopPauses();
    startPauses();
    expect(getRun(lost.run.id).status).toBe("cancelled");
    expect(all<{ id: string }>("SELECT id FROM runs WHERE status = 'paused'")).toEqual([]);
  });
});
