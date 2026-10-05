/**
 * What a run costs and how its in-flight message reaches the clients and the database: the cost of a resumed Claude
 * session, a process that ends more than once, deltas that carry only what changed, and the row saved while it works.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { applyRunDelta, type Agent, type ClientEvent, type MessageBlock, type RunDelta, type RunDeltaState, type ServerEvent } from "@godmode/shared";
import { captureEvents, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { get } from "../src/db";
import { getConversation, getMessage, sendMessage, startChat } from "../src/services/conversations";
import { __setPersistForTests, waitForRun } from "../src/runner/runner";
import { rememberSecret } from "../src/vault/vault";
import { websocketHandler, type WsData } from "../src/server/ws";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-run-stream-");
  agent = await makeAgent({ name: "Stream Test Bot", description: "test agent" });
});

afterAll(async () => {
  await env.close();
});

const deltasOf = (events: ServerEvent[], runId: string) => events.filter((e): e is RunDelta => e.type === "run.delta" && e.runId === runId);

function sessionCost(conversationId: string): number | null {
  return get<{ cost: number | null }>("SELECT claude_session_cost_usd AS cost FROM conversations WHERE id = ?", conversationId)!.cost;
}

describe("what a run costs", () => {
  test("a resumed Claude session reports its running total: each run is charged its own part", async () => {
    const started = await startChat({ agentId: agent.id, content: "SESSION_COST one" });
    const first = await waitForRun(started.run.id, 20_000);
    expect(first.costUsd).toBeCloseTo(0.5);
    expect(sessionCost(started.conversation.id)).toBeCloseTo(0.5);

    const second = await waitForRun((await sendMessage(started.conversation.id, { content: "SESSION_COST two" })).run.id, 20_000);
    const third = await waitForRun((await sendMessage(started.conversation.id, { content: "SESSION_COST three" })).run.id, 20_000);
    // Claude Code said 1.0 and 1.5.
    expect(second.costUsd).toBeCloseTo(0.5);
    expect(third.costUsd).toBeCloseTo(0.5);
    expect(sessionCost(started.conversation.id)).toBeCloseTo(1.5);
  });

  test("a new session starts counting again", async () => {
    const started = await startChat({ agentId: agent.id, content: "SESSION_COST one" });
    await waitForRun(started.run.id, 20_000);
    await waitForRun((await sendMessage(started.conversation.id, { content: "SESSION_COST two" })).run.id, 20_000);
    expect(sessionCost(started.conversation.id)).toBeCloseTo(1);

    await waitForRun((await sendMessage(started.conversation.id, { content: "/clear" })).run.id, 20_000);
    expect(getConversation(started.conversation.id).claudeSessionId).toBeNull();
    expect(sessionCost(started.conversation.id)).toBeNull();

    const fresh = await waitForRun((await sendMessage(started.conversation.id, { content: "SESSION_COST again" })).run.id, 20_000);
    expect(fresh.costUsd).toBeCloseTo(0.5);
    expect(sessionCost(started.conversation.id)).toBeCloseTo(0.5);
  });

  test("a total below what the session had counted is no running total: it is taken as it is", async () => {
    const started = await startChat({ agentId: agent.id, content: "SESSION_COST one" });
    await waitForRun(started.run.id, 20_000);
    await waitForRun((await sendMessage(started.conversation.id, { content: "SESSION_COST two" })).run.id, 20_000);
    expect(sessionCost(started.conversation.id)).toBeCloseTo(1);
    // The fake's default answer always says 0.00896.
    const plain = await waitForRun((await sendMessage(started.conversation.id, { content: "hello" })).run.id, 20_000);
    expect(plain.costUsd).toBeCloseTo(0.00896);
    expect(sessionCost(started.conversation.id)).toBeCloseTo(0.00896);
  });

  test("a process that ends twice: turns and tokens add up, the time is the clock's, the cost is the last total", async () => {
    const startedAt = Date.now();
    const started = await startChat({ agentId: agent.id, content: "TWO_RESULTS" });
    const run = await waitForRun(started.run.id, 20_000);
    expect(run.status).toBe("succeeded");
    expect(run.result).toBe("the background task finished");
    expect(run.costUsd).toBeCloseTo(0.3);
    // The results' own times (1000 + 200 ms) leave out the wait between them.
    expect(run.durationMs).toBeGreaterThan(0);
    expect(run.durationMs).toBeLessThanOrEqual(Date.now() - startedAt);
    expect(run.numTurns).toBe(4);
    expect(run.usage).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 });
  });
});

describe("the in-flight message", () => {
  test("deltas carry what changed, and applying them in order gives the stored message", async () => {
    const { events, stop } = captureEvents();
    const started = await startChat({ agentId: agent.id, content: "SHOTS:6" });
    const run = await waitForRun(started.run.id, 20_000);
    stop();
    expect(run.status).toBe("succeeded");

    const deltas = deltasOf(events, run.id);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.seq)).toEqual(deltas.map((_, i) => i + 1));
    expect(deltas.every((d) => d.patch && d.blocks === undefined)).toBe(true);

    let have: RunDeltaState | null = null;
    for (const d of deltas) {
      have = applyRunDelta(have, d);
      expect(have).not.toBeNull();
    }
    const stored = getMessage(getConversation(started.conversation.id).messages.at(-1)!.id);
    expect(have!.blocks).toEqual(stored.blocks);
    expect(stored.blocks.filter((b) => b.type === "tool_use" && b.image).length).toBe(6);

    // A screenshot travels once: with the delta in which its step got its result.
    const sent = deltas.flatMap((d) => d.patch!.map(([, b]) => b)).filter((b) => b.type === "tool_use" && b.image);
    expect(sent.length).toBe(6);
  });

  test("a delta that was missed can't be applied: the client asks for the whole list", () => {
    const text = (t: string): MessageBlock => ({ type: "text", text: t });
    const delta = (seq: number, patch: [number, MessageBlock][], length: number): RunDelta => ({ type: "run.delta", runId: "run_x", conversationId: "cnv_x", messageId: "msg_x", seq, patch, length });
    const first = applyRunDelta(null, delta(1, [[0, text("a")]], 1))!;
    expect(first).toEqual({ blocks: [text("a")], seq: 1 });
    const second = applyRunDelta(first, delta(2, [[0, text("ab")], [1, text("c")]], 2))!;
    expect(second.blocks).toEqual([text("ab"), text("c")]);
    // Untouched blocks stay the same objects (what the UI's memoized rows compare).
    const third = applyRunDelta(second, delta(3, [[1, text("cd")]], 2))!;
    expect(third.blocks[0]).toBe(second.blocks[0]!);
    // The list got shorter (a pause drops what the model was still writing).
    expect(applyRunDelta(third, delta(4, [], 1))!.blocks).toEqual([text("ab")]);

    expect(applyRunDelta(first, delta(3, [[1, text("c")]], 2))).toBeNull();
    expect(applyRunDelta(null, delta(5, [[4, text("e")]], 5))).toBeNull();
    // Joined mid-run with a patch that doesn't cover everything.
    expect(applyRunDelta(null, delta(1, [[1, text("b")]], 2))).toBeNull();
    // The whole list always applies.
    expect(applyRunDelta(first, { type: "run.delta", runId: "run_x", conversationId: "cnv_x", messageId: "msg_x", seq: 9, blocks: [text("z")] })).toEqual({ blocks: [text("z")], seq: 9 });
    // A paused run continues in a new stretch: its first delta carries every block and counts from 1 again; what the
    // client had of the earlier stretch doesn't count.
    const stretch = (seq: number, patch: [number, MessageBlock][], length: number, stream: string): RunDelta => ({ ...delta(seq, patch, length), stream });
    const before = applyRunDelta(applyRunDelta(null, stretch(1, [[0, text("a")], [1, text("b")]], 2, "str_1")), stretch(2, [[1, text("bb")]], 2, "str_1"))!;
    expect(before).toEqual({ blocks: [text("a"), text("bb")], seq: 2, stream: "str_1" });
    const after = applyRunDelta(before, stretch(1, [[0, text("a")], [1, text("bb")], [2, text("c")]], 3, "str_2"))!;
    expect(after).toEqual({ blocks: [text("a"), text("bb"), text("c")], seq: 1, stream: "str_2" });
    // Its second delta never applies to the earlier stretch's list, even when the count would fit.
    expect(applyRunDelta(before, stretch(3, [[1, text("x")]], 2, "str_2"))).toBeNull();
    expect(applyRunDelta({ ...before, seq: 1 }, stretch(2, [[1, text("x")]], 2, "str_2"))).toBeNull();
    // An older core sends the whole list without a count.
    expect(applyRunDelta(null, { type: "run.delta", runId: "run_x", conversationId: "cnv_x", messageId: "msg_x", blocks: [text("z")] })).toEqual({ blocks: [text("z")], seq: 0 });
  });

  test("the row saved while the run works is the message so far, and a secret saved meanwhile is masked in what was already sent", async () => {
    // Saved with every delta here (as usual: every two seconds and less often the longer saving takes).
    __setPersistForTests(0, 0);
    try {
      const { events, stop } = captureEvents();
      const started = await startChat({ agentId: agent.id, content: "SHOTS:3 THEN_WAIT:inflight" });
      const runId = started.run.id;
      const state = () => {
        let have: RunDeltaState | null = null;
        for (const d of deltasOf(events, runId)) have = applyRunDelta(have, d);
        return have?.blocks ?? [];
      };
      const shots = (blocks: MessageBlock[]) => blocks.filter((b) => b.type === "tool_use" && b.image).length;
      await until(() => shots(state()) === 3, 10_000, "three screenshots");
      expect(JSON.stringify(state())).toContain("shot 1");

      // From now on "shot 1" is a saved secret.
      rememberSecret("shot 1");
      await Bun.write(`${env.stateDir}/inflight-next`, "");
      await until(() => JSON.stringify(state()).includes("almost there"), 10_000, "the next delta");
      expect(JSON.stringify(state())).not.toContain("shot 1");
      expect(shots(state())).toBe(3);

      const messageId = deltasOf(events, runId)[0]!.messageId;
      const saved = JSON.parse(get<{ blocks: string }>("SELECT blocks FROM messages WHERE id = ?", messageId)!.blocks) as MessageBlock[];
      expect(saved).toEqual(state());
      expect(saved.map((b) => (b.type === "tool_use" ? b.result : b.type === "text" ? b.text : null))).toEqual(["shot 0", "••••••••", "shot 2", "almost there"]);

      await Bun.write(`${env.stateDir}/inflight-done`, "");
      const run = await waitForRun(runId, 20_000);
      stop();
      expect(run.status).toBe("succeeded");
      const message = getMessage(messageId);
      expect(shots(message.blocks)).toBe(3);
      expect(JSON.stringify(message.blocks)).not.toContain("shot 1");
      expect(state()).toEqual(message.blocks);
    } finally {
      __setPersistForTests(2000, 50);
    }
  });

  test("a background task's progress (changed in place) arrives through patches", async () => {
    const { events, stop } = captureEvents();
    const started = await startChat({ agentId: agent.id, content: "SLOW_TASK" });
    const run = await waitForRun(started.run.id, 20_000);
    stop();
    expect(run.status).toBe("succeeded");
    const deltas = deltasOf(events, run.id);
    const tasks = deltas.flatMap((d) => d.patch!.flatMap(([, b]) => (b.type === "tool_use" && b.task ? [b.task] : [])));
    expect(tasks.map((t) => t.activity)).toEqual(expect.arrayContaining(["step 1", "step 2", "step 3"]));
    expect(tasks.at(-1)).toMatchObject({ status: "completed", totalTokens: 400 });
    let have: RunDeltaState | null = null;
    for (const d of deltas) have = applyRunDelta(have, d);
    expect(have!.blocks).toEqual(getMessage(deltas[0]!.messageId).blocks);
  });

  test("streamed text (partial messages) arrives through patches exactly as it is stored", async () => {
    const { events, stop } = captureEvents();
    const started = await startChat({ agentId: agent.id, content: "SLOW_STREAM" });
    const run = await waitForRun(started.run.id, 20_000);
    stop();
    const deltas = deltasOf(events, run.id);
    // Word by word: the one text block changes in place, and each delta sends it again.
    const texts = deltas.flatMap((d) => d.patch!.filter(([i]) => i === 0).map(([, b]) => (b.type === "text" ? b.text : "")));
    expect(texts.length).toBeGreaterThan(3);
    expect(texts.at(-1)).toBe("one two three four five six");
    expect(texts.every((t, i) => i === 0 || t.length >= texts[i - 1]!.length)).toBe(true);
    let have: RunDeltaState | null = null;
    for (const d of deltas) have = applyRunDelta(have, d);
    expect(have!.blocks).toEqual(getMessage(deltas[0]!.messageId).blocks);
    expect(have!.blocks).toEqual([{ type: "text", text: "one two three four five six" }]);
  });
});

describe("clients", () => {
  function client(id: string, data: Partial<WsData> = {}) {
    const got: ServerEvent[] = [];
    const ws = { data: { id, subscriptions: new Set<string>(), ...data }, send: (payload: string) => (got.push(JSON.parse(payload)), 0), close: () => {} } as unknown as ServerWebSocket<WsData>;
    const say = (event: ClientEvent) => websocketHandler.message(ws, JSON.stringify(event));
    return { ws, got, say, deltas: (runId: string) => deltasOf(got, runId) };
  }

  test("patches for a client that asked for them, the whole list for one that didn't, and on request", async () => {
    const modern = client("ws_modern", { auth: "token" });
    const legacy = client("ws_legacy", { auth: "token" });
    websocketHandler.open(modern.ws);
    websocketHandler.open(legacy.ws);
    modern.say({ type: "deltas.patch" });

    const started = await startChat({ agentId: agent.id, content: "SHOTS:2 THEN_WAIT:clients" });
    const runId = started.run.id;
    await until(() => modern.deltas(runId).length > 0 && legacy.deltas(runId).length > 0, 10_000, "deltas");
    expect(modern.deltas(runId).every((d) => d.patch && !d.blocks)).toBe(true);
    expect(legacy.deltas(runId).every((d) => d.blocks && !d.patch)).toBe(true);

    // Someone who joins while it runs is told where it stands…
    const late = client("ws_late", { auth: "token" });
    websocketHandler.open(late.ws);
    expect(late.deltas(runId).length).toBe(1);
    expect(late.deltas(runId)[0]!.blocks!.length).toBeGreaterThan(0);
    // …and a phone when it opens the chat (never before).
    const phone = client("ws_phone", { auth: "device", deviceId: "dev_1" });
    websocketHandler.open(phone.ws);
    expect(phone.deltas(runId).length).toBe(0);
    phone.say({ type: "run.resync", runId });
    expect(phone.deltas(runId).length).toBe(0);
    phone.say({ type: "conversation.subscribe", conversationId: started.conversation.id });
    expect(phone.deltas(runId).length).toBe(1);

    const before = modern.deltas(runId).length;
    modern.say({ type: "run.resync", runId });
    const whole = modern.deltas(runId).at(-1)!;
    expect(modern.deltas(runId).length).toBe(before + 1);
    expect(whole.blocks).toEqual(late.deltas(runId)[0]!.blocks!);
    expect(whole.seq).toBe(modern.deltas(runId).at(-2)!.seq!);

    await Bun.write(`${env.stateDir}/clients-next`, "");
    await Bun.write(`${env.stateDir}/clients-done`, "");
    const run = await waitForRun(runId, 20_000);
    expect(run.status).toBe("succeeded");
    // What each of them shows at the end is the stored message.
    const stored = getMessage(whole.messageId).blocks;
    let patched: RunDeltaState | null = null;
    for (const d of modern.deltas(runId)) patched = applyRunDelta(patched, d) ?? patched;
    expect(patched!.blocks).toEqual(stored);
    for (const c of [modern, legacy, late, phone]) websocketHandler.close(c.ws);
  });
});
