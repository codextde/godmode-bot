import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, AppNotification, Conversation, ConversationWithMessages, Message, MissingLogin, Run, ServerEvent } from "@godmode/shared";
import { runnerView } from "@godmode/shared";
import { captureEvents, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { all, get, insert } from "../src/db";
import { HttpError, now } from "../src/util";
import { INTERRUPTED, cancelRun, getRun, recoverInterruptedRuns, startRun } from "../src/runner/runner";
import { addMessage, createConversation, getConversation, getConversationSummary, listConversations, updateConversation } from "../src/services/conversations";
import { clearRunner, remoteRunForConversation, remoteRuns } from "../src/remote/activeRuns";
import { adoptChat, applyRunnerEvent, catchUp, reconcileConversation, runnerDisconnected, setMirrorHooks, type RunnerApi } from "../src/remote/mirror";

const RUNNER = "rnr_mirrortest00000a";
const OTHER = "rnr_mirrortest00000b";

let env: TestEnv;
let agent: Agent;
let colleague: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-mirror-");
  agent = await makeAgent({ name: "Mirror Bot" });
  colleague = await makeAgent({ name: "Mirror Colleague" });
});

afterAll(async () => {
  setMirrorHooks({});
  clearRunner(RUNNER);
  clearRunner(OTHER);
  await env.close();
});

/* ------------------------------------------------------------------ */
/* What a runner would send                                            */
/* ------------------------------------------------------------------ */

let seq = 0;
const uid = (prefix: string) => `${prefix}_mirror${String(++seq).padStart(10, "0")}`;
/** A moment on the runner's clock, `n` seconds into the test. */
const at = (n: number) => new Date(Date.UTC(2031, 0, 1, 0, 0, n)).toISOString();

function chat(over: Partial<Conversation> = {}): Conversation {
  return {
    id: uid("cnv"),
    agentId: agent.id,
    title: "On the runner",
    origin: "chat",
    ultracode: null,
    claudeSessionId: null,
    model: null,
    effort: null,
    workingDirectory: null,
    computerTarget: null,
    vmId: null,
    browserProfileId: null,
    workspaceId: null,
    sshServerIds: [],
    instructions: "",
    runnerId: null,
    runnerToolsId: null,
    pinned: false,
    archived: false,
    lastMessageAt: null,
    createdAt: at(0),
    updatedAt: at(0),
    preview: "",
    running: false,
    followup: null,
    paused: null,
    delegatedFrom: null,
    ...over,
  };
}

function message(conversationId: string, over: Partial<Message> = {}): Message {
  return { id: uid("msg"), conversationId, role: "user", content: "Hello", blocks: [], runId: null, attachments: [], createdAt: at(1), ...over };
}

function run(conversationId: string, over: Partial<Run> = {}): Run {
  return {
    id: uid("run"),
    agentId: agent.id,
    conversationId,
    routineId: null,
    parentRunId: null,
    trigger: "chat",
    status: "queued",
    prompt: "Hello",
    result: null,
    error: null,
    costUsd: null,
    durationMs: null,
    numTurns: null,
    usage: null,
    model: null,
    startedAt: null,
    finishedAt: null,
    createdAt: at(1),
    ...over,
  };
}

type Sent<T extends ServerEvent["type"]> = Extract<ServerEvent, { type: T }>;

/** How a call failed. */
async function failure(call: Promise<unknown>): Promise<HttpError> {
  try {
    await call;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("expected the call to fail");
}

/** Everything the bus carried while `fn` ran. */
function during(fn: () => void): ServerEvent[] {
  const captured = captureEvents();
  try {
    fn();
  } finally {
    captured.stop();
  }
  return captured.events;
}

/** A chat `runnerId` reported, as it is stored here afterwards. */
function adopt(runnerId = RUNNER, over: Partial<Conversation> = {}): Conversation {
  const conversation = chat(over);
  applyRunnerEvent(runnerId, { type: "conversation.updated", conversation });
  return conversation;
}

/** The rows a runner could touch, to prove it didn't. */
function database(): string {
  return JSON.stringify({
    conversations: all("SELECT * FROM conversations ORDER BY id"),
    messages: all("SELECT * FROM messages ORDER BY id"),
    runs: all("SELECT * FROM runs ORDER BY id"),
    notifications: all("SELECT * FROM notifications ORDER BY id"),
    missingLogins: all("SELECT * FROM missing_logins ORDER BY id"),
  });
}

const count = (table: "conversations" | "messages" | "runs" | "notifications" | "missing_logins", id: string) =>
  get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, id)!.n;

const messageIds = (conversationId: string) => getConversation(conversationId).messages.map((m) => m.id);

function localRun(conversationId: string, status: Run["status"]): string {
  const id = uid("run");
  insert("runs", { id, agent_id: agent.id, conversation_id: conversationId, trigger: "chat", status, prompt: "x", created_at: now() });
  return id;
}

/* ------------------------------------------------------------------ */

describe("a chat the runner reports", () => {
  test("becomes a chat on that runner when its agent exists here", () => {
    const conversation = chat({ title: "Book the flights", model: "opus", effort: "high", instructions: "Be brief", lastMessageAt: at(5), updatedAt: at(5) });
    const events = during(() => applyRunnerEvent(RUNNER, { type: "conversation.updated", conversation }));

    const local = getConversationSummary(conversation.id);
    expect(local).toMatchObject({
      id: conversation.id,
      agentId: agent.id,
      runnerId: RUNNER,
      runnerToolsId: null,
      title: "Book the flights",
      model: "opus",
      effort: "high",
      instructions: "Be brief",
      workingDirectory: null,
      computerTarget: null,
      pinned: false,
      archived: false,
      lastMessageAt: at(5),
      createdAt: at(0),
      updatedAt: at(5),
    });
    expect(events).toEqual([{ type: "conversation.updated", conversation: local }]);
  });

  test("is filed under archived when the runner had archived it", () => {
    const conversation = adopt(RUNNER, { archived: true });
    expect(getConversationSummary(conversation.id).archived).toBe(true);
  });

  test("is ignored when its agent doesn't exist here", () => {
    const conversation = chat({ agentId: "agt_nobodyhere000000" });
    const before = database();
    const events = during(() => applyRunnerEvent(RUNNER, { type: "conversation.updated", conversation }));
    expect(events).toEqual([]);
    expect(database()).toBe(before);
  });

  test("is ignored when its id could not be a file name, or it claims to be a dream", () => {
    const before = database();
    const events = during(() => {
      applyRunnerEvent(RUNNER, { type: "conversation.updated", conversation: chat({ id: "../../outside" }) });
      applyRunnerEvent(RUNNER, { type: "conversation.updated", conversation: chat({ origin: "dream" }) });
      applyRunnerEvent(RUNNER, { type: "conversation.updated", conversation: chat({ createdAt: "yesterday" }) });
      applyRunnerEvent(RUNNER, { type: "conversation.updated", conversation: null } as unknown as ServerEvent);
    });
    expect(events).toEqual([]);
    expect(database()).toBe(before);
  });

  test("keeps the pin and the archive the human set here, whatever the runner says later", () => {
    const conversation = adopt();
    updateConversation(conversation.id, { pinned: true, archived: true });

    const events = during(() =>
      applyRunnerEvent(RUNNER, { type: "conversation.updated", conversation: { ...conversation, title: "Renamed there", pinned: false, archived: false, updatedAt: at(9) } }),
    );

    const local = getConversationSummary(conversation.id);
    expect(local).toMatchObject({ title: "Renamed there", pinned: true, archived: true, updatedAt: at(9), runnerId: RUNNER });
    expect(events).toEqual([{ type: "conversation.updated", conversation: local }]);
  });

  test("goes when the runner deletes it", () => {
    const conversation = adopt();
    applyRunnerEvent(RUNNER, { type: "message.created", message: message(conversation.id) });
    const events = during(() => applyRunnerEvent(RUNNER, { type: "conversation.deleted", id: conversation.id }));
    expect(events).toEqual([{ type: "conversation.deleted", id: conversation.id }]);
    expect(count("conversations", conversation.id)).toBe(0);
    expect(all("SELECT id FROM messages WHERE conversation_id = ?", conversation.id)).toEqual([]);
  });
});

describe("messages and runs of a runner's chat", () => {
  test("are stored and passed on, and the same event twice leaves one row", () => {
    const conversation = adopt();
    const finishedRuns: [string, string][] = [];
    setMirrorHooks({ runFinished: (runnerId, r) => finishedRuns.push([runnerId, r.id]) });

    const started = run(conversation.id);
    const question = message(conversation.id, { content: "What's the weather?", runId: started.id });
    const answer = message(conversation.id, { role: "assistant", content: "", runId: started.id, createdAt: at(2) });
    const answered: Message = { ...answer, content: "Sunny.", blocks: [{ type: "text", text: "Sunny." }] };
    const finished: Run = { ...started, status: "succeeded", result: "Sunny.", costUsd: 0.01, numTurns: 1, durationMs: 1200, startedAt: at(2), finishedAt: at(3) };
    const sent: ServerEvent[] = [
      { type: "message.created", message: question },
      { type: "message.created", message: answer },
      { type: "run.started", run: started },
      { type: "run.started", run: { ...started, status: "running", startedAt: at(2) } },
      { type: "message.updated", message: answered },
      { type: "run.finished", run: finished },
    ];

    const events = during(() => {
      for (const e of sent.slice(0, 4)) applyRunnerEvent(RUNNER, e);
      // While it works, the chat is busy here too.
      expect(remoteRunForConversation(conversation.id)).toBe(started.id);
      expect(getRun(started.id).status).toBe("running");
      for (const e of sent.slice(4)) applyRunnerEvent(RUNNER, e);
    });

    expect(events).toEqual(sent);
    expect(getConversation(conversation.id).messages).toEqual([question, answered]);
    expect(getRun(started.id)).toEqual(finished);
    expect(remoteRunForConversation(conversation.id)).toBeNull();
    expect(finishedRuns).toEqual([[RUNNER, started.id]]);

    // The link may deliver an event again (after a reconnect, next to an answer that held the same).
    for (const e of [sent[0], sent[1], sent[4], sent[5]]) applyRunnerEvent(RUNNER, e);
    expect(messageIds(conversation.id)).toEqual([question.id, answer.id]);
    expect(count("messages", question.id)).toBe(1);
    expect(count("messages", answer.id)).toBe(1);
    expect(count("runs", started.id)).toBe(1);
    expect(getRun(started.id)).toEqual(finished);
    setMirrorHooks({});
  });

  test("a run that ended isn't brought back by a late word that it works", () => {
    const conversation = adopt();
    const ended = run(conversation.id, { status: "failed", error: "Boom", finishedAt: at(4) });
    applyRunnerEvent(RUNNER, { type: "run.finished", run: ended });

    const events = during(() => applyRunnerEvent(RUNNER, { type: "run.started", run: { ...ended, status: "running", error: null, finishedAt: null } }));
    expect(events).toEqual([]);
    expect(getRun(ended.id)).toMatchObject({ status: "failed", error: "Boom" });
    expect(remoteRunForConversation(conversation.id)).toBeNull();
  });

  test("streaming, activity and the queue are passed on for the runner's own chat only", () => {
    const conversation = adopt();
    const local = createConversation({ agentId: agent.id, title: "Stays here" });
    const working = run(conversation.id, { status: "running" });
    const answer = message(conversation.id, { role: "assistant", content: "", runId: working.id });
    applyRunnerEvent(RUNNER, { type: "run.started", run: working });
    applyRunnerEvent(RUNNER, { type: "message.created", message: answer });

    const delta: Sent<"run.delta"> = { type: "run.delta", runId: working.id, conversationId: conversation.id, messageId: answer.id, blocks: [{ type: "text", text: "Su" }], textDelta: "Su" };
    const queue: Sent<"queue.updated"> = {
      type: "queue.updated",
      conversationId: conversation.id,
      queue: [{ id: "qmsg_0000000000000001", conversationId: conversation.id, content: "And tomorrow?", attachments: [], createdAt: at(3) }],
    };
    const events = during(() => {
      applyRunnerEvent(RUNNER, delta);
      applyRunnerEvent(RUNNER, { type: "run.activity", runId: working.id, agentId: colleague.id, label: "Reading the forecast" });
      applyRunnerEvent(RUNNER, queue);
      // About a chat of this computer, or a run nobody here knows: nothing.
      applyRunnerEvent(RUNNER, { ...delta, conversationId: local.id });
      applyRunnerEvent(RUNNER, { type: "run.activity", runId: "run_unknown000000000", agentId: agent.id, label: "Sneaking" });
      applyRunnerEvent(RUNNER, { ...queue, conversationId: local.id });
    });

    // The agent is the one the run is stored with, not the one the event names.
    expect(events).toEqual([delta, { type: "run.activity", runId: working.id, agentId: agent.id, label: "Reading the forecast" }, queue]);
    expect(remoteRuns(RUNNER).find((r) => r.runId === working.id)).toMatchObject({ status: "running", label: "Reading the forecast", conversationId: conversation.id });
    applyRunnerEvent(RUNNER, { type: "run.finished", run: { ...working, status: "cancelled", finishedAt: at(4) } });
  });

  test("a run never reaches an automation, a run or an agent of this computer", () => {
    const conversation = adopt();
    const local = createConversation({ agentId: agent.id, title: "Stays here" });
    const localParent = localRun(local.id, "succeeded");

    const child = run(conversation.id, { routineId: "rtn_localroutine0000", parentRunId: localParent, status: "succeeded", finishedAt: at(2) });
    const events = during(() => applyRunnerEvent(RUNNER, { type: "run.finished", run: child }));
    expect(getRun(child.id)).toMatchObject({ routineId: null, parentRunId: null, status: "succeeded" });
    expect(events).toEqual([{ type: "run.finished", run: { ...child, routineId: null, parentRunId: null } }]);

    // A run under one of the runner's own runs keeps its parent.
    const grandchild = run(conversation.id, { parentRunId: child.id, status: "succeeded", finishedAt: at(3) });
    applyRunnerEvent(RUNNER, { type: "run.finished", run: grandchild });
    expect(getRun(grandchild.id).parentRunId).toBe(child.id);

    // Booked on another agent than the chat's: refused.
    const misbooked = run(conversation.id, { agentId: colleague.id });
    expect(during(() => applyRunnerEvent(RUNNER, { type: "run.started", run: misbooked }))).toEqual([]);
    expect(count("runs", misbooked.id)).toBe(0);
  });
});

describe("what isn't the runner's", () => {
  test("a chat of this computer can't be changed by a runner", () => {
    const mine = adopt();
    const local = createConversation({ agentId: agent.id, title: "Stays here" });
    const localMessage = addMessage({ conversationId: local.id, role: "user", content: "Private" });
    const localRunId = localRun(local.id, "succeeded");
    const before = database();

    const events = during(() => {
      applyRunnerEvent(RUNNER, { type: "conversation.updated", conversation: chat({ id: local.id, title: "Taken over" }) });
      applyRunnerEvent(RUNNER, { type: "message.created", message: message(local.id, { content: "Injected" }) });
      // An existing message, claimed for the local chat and for the runner's own chat.
      applyRunnerEvent(RUNNER, { type: "message.updated", message: { ...localMessage, content: "Rewritten" } });
      applyRunnerEvent(RUNNER, { type: "message.updated", message: { ...localMessage, conversationId: mine.id, content: "Rewritten" } });
      // An existing run, likewise.
      applyRunnerEvent(RUNNER, { type: "run.finished", run: run(local.id, { id: localRunId, status: "failed", error: "Rewritten" }) });
      applyRunnerEvent(RUNNER, { type: "run.finished", run: run(mine.id, { id: localRunId, status: "failed", error: "Rewritten" }) });
      applyRunnerEvent(RUNNER, { type: "run.started", run: run(local.id) });
      applyRunnerEvent(RUNNER, { type: "conversation.deleted", id: local.id });
    });

    expect(events).toEqual([]);
    expect(database()).toBe(before);
    expect(getConversation(local.id).messages.map((m) => m.content)).toEqual(["Private"]);
    expect(getRun(localRunId)).toMatchObject({ status: "succeeded", error: null, conversationId: local.id });
    expect(remoteRuns(RUNNER).some((r) => r.conversationId === local.id)).toBe(false);
  });

  test("another runner's chat can't be changed either", () => {
    const theirs = adopt(RUNNER, { title: "Belongs to the first runner" });
    const theirMessage = message(theirs.id);
    const theirRun = run(theirs.id, { status: "succeeded", finishedAt: at(2) });
    applyRunnerEvent(RUNNER, { type: "message.created", message: theirMessage });
    applyRunnerEvent(RUNNER, { type: "run.finished", run: theirRun });
    const before = database();

    const events = during(() => {
      applyRunnerEvent(OTHER, { type: "conversation.updated", conversation: { ...theirs, title: "Taken over" } });
      applyRunnerEvent(OTHER, { type: "message.created", message: message(theirs.id, { content: "Injected" }) });
      applyRunnerEvent(OTHER, { type: "message.updated", message: { ...theirMessage, content: "Rewritten" } });
      applyRunnerEvent(OTHER, { type: "run.finished", run: { ...theirRun, status: "failed" } });
      applyRunnerEvent(OTHER, { type: "run.started", run: run(theirs.id) });
      applyRunnerEvent(OTHER, { type: "conversation.deleted", id: theirs.id });
    });

    expect(events).toEqual([]);
    expect(database()).toBe(before);
    expect(getConversationSummary(theirs.id)).toMatchObject({ title: "Belongs to the first runner", runnerId: RUNNER });
    expect(remoteRuns(OTHER)).toEqual([]);
  });

  test("the answer to a new chat is refused when it names a chat of this computer", () => {
    const local = createConversation({ agentId: agent.id, title: "Stays here" });
    const before = database();
    let refused: unknown = null;
    const events = during(() => {
      try {
        adoptChat(RUNNER, { conversation: chat({ id: local.id, title: "Taken over" }), message: message(local.id), run: run(local.id) });
      } catch (err) {
        refused = err;
      }
    });
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).status).toBe(502);
    expect(events).toEqual([]);
    expect(database()).toBe(before);
  });
});

describe("the chat the API returns", () => {
  test("shows what the runner says: busy, paused, a follow-up, and the run that works", () => {
    const conversation = adopt(RUNNER, { running: true });
    // The runner says it works; which run isn't known yet.
    expect(getConversation(conversation.id)).toMatchObject({ runnerId: RUNNER, running: true, activeRunId: null, paused: null, followup: null, queue: [] });

    const working = run(conversation.id, { status: "running", startedAt: at(2) });
    applyRunnerEvent(RUNNER, { type: "run.started", run: working });
    expect(getConversation(conversation.id)).toMatchObject({ running: true, activeRunId: working.id });
    expect(listConversations({ agentId: agent.id }).find((c) => c.id === conversation.id)).toMatchObject({ running: true, runnerId: RUNNER });

    const paused = { runId: working.id, reason: "limit" as const, pausedAt: at(6), limit: "session limit", resumeAt: at(600), auto: true };
    const followup = { note: "Check the reply", dueAt: at(900), createdAt: at(6) };
    applyRunnerEvent(RUNNER, { type: "run.paused", run: { ...working, status: "paused" } });
    applyRunnerEvent(RUNNER, { type: "conversation.updated", conversation: { ...conversation, running: false, paused, followup } });
    // A run that stands still is known, but the chat isn't busy.
    expect(getConversation(conversation.id)).toMatchObject({ running: false, activeRunId: null, paused, followup });
    expect(remoteRuns(RUNNER).find((r) => r.runId === working.id)?.status).toBe("paused");

    // It continues, then the link drops: the copy keeps what the runner said last, but no run is known to work.
    applyRunnerEvent(RUNNER, { type: "run.started", run: { ...working, status: "running" } });
    applyRunnerEvent(RUNNER, { type: "conversation.updated", conversation: { ...conversation, running: true } });
    expect(getConversation(conversation.id)).toMatchObject({ running: true, activeRunId: working.id, paused: null, followup: null });
    runnerDisconnected(RUNNER);
    expect(remoteRuns(RUNNER)).toEqual([]);
    expect(getConversation(conversation.id)).toMatchObject({ running: true, activeRunId: null });
    expect(getRun(working.id).status).toBe("running");
  });

  test("is what it always was for a chat of this computer", () => {
    const local = createConversation({ agentId: agent.id, title: "Stays here" });
    const expected: ConversationWithMessages = {
      id: local.id,
      agentId: agent.id,
      title: "Stays here",
      origin: "chat",
      claudeSessionId: null,
      model: null,
      effort: null,
      ultracode: null,
      workingDirectory: null,
      computerTarget: null,
      vmId: null,
      browserProfileId: null,
      workspaceId: null,
      sshServerIds: [],
      instructions: "",
      runnerId: null,
      runnerToolsId: null,
      pinned: false,
      archived: false,
      lastMessageAt: null,
      createdAt: local.createdAt,
      updatedAt: local.updatedAt,
      preview: "",
      running: false,
      followup: null,
      paused: null,
      delegatedFrom: null,
      messages: [],
      activeRunId: null,
      queue: [],
    };
    // Field for field, in this order.
    expect(JSON.stringify(getConversation(local.id))).toBe(JSON.stringify(expected));

    // A run a runner reports in its own chat doesn't make a local chat busy.
    const other = adopt(RUNNER, { running: true });
    applyRunnerEvent(RUNNER, { type: "run.started", run: run(other.id, { status: "running" }) });
    expect(JSON.stringify(getConversation(local.id))).toBe(JSON.stringify(expected));
    runnerDisconnected(RUNNER);
  });
});

describe("notifications and missing logins from a runner", () => {
  const notification = (over: Partial<AppNotification>): AppNotification => ({
    id: uid("ntf"),
    kind: "run",
    title: "Done",
    body: "",
    link: null,
    read: false,
    createdAt: at(7),
    ...over,
  });
  const stored = (id: string) => get<{ title: string; body: string; link: string | null; read: number }>("SELECT title, body, link, read FROM notifications WHERE id = ?", id);

  test("a notification is stored and shown once, cut to size", () => {
    const sent = notification({ title: "T".repeat(500), body: "B".repeat(5000), link: "/inbox", read: true });
    const events = during(() => {
      applyRunnerEvent(RUNNER, { type: "notification", notification: sent });
      applyRunnerEvent(RUNNER, { type: "notification", notification: { ...sent, title: "Again" } });
    });

    const row = stored(sent.id)!;
    expect(row.title.length).toBe(200);
    expect(row.body.length).toBe(4000);
    expect(row).toMatchObject({ link: "/inbox", read: 0 });
    expect(count("notifications", sent.id)).toBe(1);
    expect(events).toEqual([{ type: "notification", notification: { ...sent, title: row.title, body: row.body, read: false } }]);
  });

  test("its link is kept only when it stays inside the app", () => {
    const links: [string | null, string | null][] = [
      ["/agents/agt_1", "/agents/agt_1"],
      ["//evil.example/login", null],
      ["https://evil.example/login", null],
      ["/\\evil.example", null],
      ["javascript:alert(1)", null],
      ["inbox", null],
      [null, null],
    ];
    for (const [link, kept] of links) {
      const sent = notification({ link });
      applyRunnerEvent(RUNNER, { type: "notification", notification: sent });
      expect(stored(sent.id)!.link).toBe(kept);
    }
  });

  test("a missing login of a runner's run goes to the inbox once and is updated after that", () => {
    const conversation = adopt();
    const working = run(conversation.id, { status: "running" });
    applyRunnerEvent(RUNNER, { type: "run.started", run: working });
    const item: MissingLogin = {
      id: uid("mlg"),
      agentId: agent.id,
      runId: working.id,
      workspaceId: null,
      kind: "missing_credential",
      service: "Lufthansa",
      url: "https://lufthansa.com/login",
      reason: "No login saved",
      status: "open",
      credentialId: null,
      occurrences: 1,
      createdAt: at(8),
      updatedAt: at(8),
    };

    const events = during(() => {
      applyRunnerEvent(RUNNER, { type: "missing-login.created", item });
      applyRunnerEvent(RUNNER, { type: "missing-login.updated", item: { ...item, occurrences: 2, updatedAt: at(9) } });
      // Not from one of this runner's runs: neither a new report nor a change of this one.
      applyRunnerEvent(RUNNER, { type: "missing-login.created", item: { ...item, id: uid("mlg"), runId: "run_unknown000000000" } });
      applyRunnerEvent(OTHER, { type: "missing-login.updated", item: { ...item, service: "Taken over" } });
    });

    expect(events).toEqual([
      { type: "missing-login.created", item },
      { type: "missing-login.updated", item: { ...item, occurrences: 2, updatedAt: at(9) } },
    ]);
    expect(all<{ service: string; occurrences: number }>("SELECT service, occurrences FROM missing_logins WHERE id = ?", item.id)).toEqual([{ service: "Lufthansa", occurrences: 2 }]);
    expect(all("SELECT id FROM missing_logins WHERE run_id = 'run_unknown000000000'")).toEqual([]);
    applyRunnerEvent(RUNNER, { type: "run.finished", run: { ...working, status: "succeeded", finishedAt: at(10) } });
  });
});

describe("live views of a runner", () => {
  test("its screen comes out under the runner's name", () => {
    const frame: Sent<"computer.frame"> = { type: "computer.frame", view: "display:1", data: "aGk=", mime: "image/jpeg", width: 1280, height: 800, label: "Built-in display" };
    const action: Sent<"computer.action"> = { type: "computer.action", view: "window:812:4711", runId: "run_onrunner00000000", action: "click", x: 0.5, y: 0.25 };
    const events = during(() => {
      applyRunnerEvent(RUNNER, frame);
      applyRunnerEvent(RUNNER, action);
      // A view that already claims to be someone's is no view of a runner.
      applyRunnerEvent(RUNNER, { ...frame, view: runnerView(OTHER, "display:1") });
    });
    expect(events).toEqual([
      { ...frame, view: `runner:${RUNNER}:display:1` },
      { ...action, view: `runner:${RUNNER}:window:812:4711` },
    ]);
  });

  test("its browser is shown only as the tab of one of its own chats", () => {
    const conversation = adopt();
    const foreign = adopt(OTHER);
    const local = createConversation({ agentId: agent.id, title: "Stays here" });
    const frame = { type: "browser.frame" as const, profileId: "prof_default", data: "aGk=", url: "https://example.com", title: "Example", width: 1280, height: 800 };
    const events = during(() => {
      applyRunnerEvent(RUNNER, { ...frame, conversationId: conversation.id });
      applyRunnerEvent(RUNNER, frame);
      applyRunnerEvent(RUNNER, { ...frame, conversationId: local.id });
      applyRunnerEvent(RUNNER, { ...frame, conversationId: foreign.id });
    });
    expect(events).toEqual([{ ...frame, conversationId: conversation.id }]);
  });
});

describe("reconciling a chat with the runner's answer", () => {
  test("removes a message the runner no longer has and keeps the others in the runner's order", () => {
    const conversation = adopt();
    const first = message(conversation.id, { content: "One", createdAt: at(1) });
    const second = message(conversation.id, { content: "Two", createdAt: at(2) });
    const third = message(conversation.id, { content: "Three", createdAt: at(3) });
    for (const m of [first, second, third]) applyRunnerEvent(RUNNER, { type: "message.created", message: m });
    // Missed here, and written in the same millisecond as "One" on the runner.
    const missed = message(conversation.id, { role: "assistant", content: "One and a half", createdAt: at(1) });
    const fourth = message(conversation.id, { content: "Four", createdAt: at(4) });
    const working = run(conversation.id, { status: "running" });
    const queue = [{ id: "qmsg_0000000000000002", conversationId: conversation.id, content: "Later", attachments: [], createdAt: at(5) }];
    const remote: ConversationWithMessages = {
      ...conversation,
      lastMessageAt: at(4),
      updatedAt: at(4),
      running: true,
      messages: [first, missed, { ...third, content: "Three, edited" }, fourth],
      activeRunId: working.id,
      queue,
    };

    let view!: ConversationWithMessages;
    const events = during(() => {
      view = reconcileConversation(RUNNER, remote, [working]);
    });

    expect(messageIds(conversation.id)).toEqual([first.id, missed.id, third.id, fourth.id]);
    expect(count("messages", second.id)).toBe(0);
    expect(view.messages.map((m) => m.content)).toEqual(["One", "One and a half", "Three, edited", "Four"]);
    expect(view).toMatchObject({ runnerId: RUNNER, running: true, activeRunId: working.id, queue, lastMessageAt: at(4) });
    expect(getRun(working.id).status).toBe("running");
    expect(events.map((e) => e.type).sort()).toEqual(["conversation.updated", "message.created", "message.created", "message.updated", "run.started"]);

    // The UI asks again after each of those events: the same answer must not make it ask forever.
    expect(during(() => reconcileConversation(RUNNER, remote, [working]))).toEqual([]);
    expect(messageIds(conversation.id)).toEqual([first.id, missed.id, third.id, fourth.id]);

    // New messages at the end are appended; the run that ended while nobody listened is told.
    const fifth = message(conversation.id, { role: "assistant", content: "Five", createdAt: at(5) });
    const done: Run = { ...working, status: "succeeded", finishedAt: at(5) };
    const later = during(() => {
      view = reconcileConversation(RUNNER, { ...remote, running: false, messages: [...remote.messages, fifth], activeRunId: null, queue: [] }, [done]);
    });
    expect(messageIds(conversation.id)).toEqual([first.id, missed.id, third.id, fourth.id, fifth.id]);
    expect(view).toMatchObject({ running: false, activeRunId: null, queue: [] });
    expect(later.map((e) => e.type).sort()).toEqual(["conversation.updated", "message.created", "run.finished"]);
    expect(remoteRunForConversation(conversation.id)).toBeNull();
  });

  test("never takes a message of another chat, and refuses a chat that isn't the runner's", () => {
    const conversation = adopt();
    const local = createConversation({ agentId: agent.id, title: "Stays here" });
    const localMessage = addMessage({ conversationId: local.id, role: "user", content: "Private" });
    const own = message(conversation.id, { content: "Mine" });

    reconcileConversation(RUNNER, { ...conversation, messages: [own, { ...localMessage, conversationId: conversation.id, content: "Stolen" }], activeRunId: null, queue: [] });
    expect(messageIds(conversation.id)).toEqual([own.id]);
    expect(getConversation(local.id).messages).toEqual([localMessage]);

    const before = database();
    expect(() => reconcileConversation(RUNNER, { ...chat({ id: local.id }), messages: [], activeRunId: null, queue: [] })).toThrow(HttpError);
    expect(() => reconcileConversation(OTHER, { ...conversation, messages: [], activeRunId: null, queue: [] })).toThrow(HttpError);
    // An answer that isn't a chat with its messages (an older runner, an error body) must not empty the copy.
    expect(() => reconcileConversation(RUNNER, conversation as ConversationWithMessages)).toThrow(HttpError);
    expect(database()).toBe(before);
    expect(messageIds(conversation.id)).toEqual([own.id]);
  });
});

describe("catching up after a connect", () => {
  test("adopts chats, fills in what was missed and knows again which runs work", async () => {
    // Known here from before the link dropped: a chat with one message and a run that worked.
    const known = adopt(RUNNER, { title: "Known", lastMessageAt: at(1), updatedAt: at(1) });
    const seen = message(known.id, { content: "Seen", createdAt: at(1) });
    const interrupted = run(known.id, { status: "running", startedAt: at(1) });
    applyRunnerEvent(RUNNER, { type: "message.created", message: seen });
    applyRunnerEvent(RUNNER, { type: "run.started", run: interrupted });
    runnerDisconnected(RUNNER);

    // Meanwhile on the runner: that run ended, a message was written, another run works; a second chat appeared.
    const missed = message(known.id, { role: "assistant", content: "Missed", createdAt: at(20) });
    const working = run(known.id, { status: "running", startedAt: at(21), createdAt: at(21) });
    const ended: Run = { ...interrupted, status: "succeeded", result: "Missed", finishedAt: at(20) };
    const knownNow: Conversation = { ...known, lastMessageAt: at(20), updatedAt: at(21), running: true };
    const fresh = chat({ title: "Started while away", archived: true, lastMessageAt: at(30), updatedAt: at(30) });
    const freshMessage = message(fresh.id, { content: "Hello from afar", createdAt: at(30) });
    const freshRun = run(fresh.id, { status: "succeeded", finishedAt: at(31), createdAt: at(30) });
    const stranger = chat({ agentId: "agt_nobodyhere000000" });

    const calls: string[] = [];
    const answers: Record<string, unknown> = {
      "/api/conversations?limit=500": [knownNow, stranger],
      "/api/conversations?limit=500&archived=1": [fresh],
      [`/api/conversations/${known.id}`]: { ...knownNow, messages: [seen, missed], activeRunId: working.id, queue: [] },
      [`/api/runs?conversationId=${known.id}&limit=500`]: [working, ended],
      [`/api/conversations/${fresh.id}`]: { ...fresh, messages: [freshMessage], activeRunId: null, queue: [] },
      [`/api/runs?conversationId=${fresh.id}&limit=500`]: [freshRun],
      "/api/runs?status=queued,running,paused&limit=500": [working],
    };
    const api: RunnerApi = {
      async json<T>(method: string, path: string): Promise<T> {
        calls.push(`${method} ${path}`);
        if (!(path in answers)) throw new HttpError(404, "Not found", "not_found");
        return answers[path] as T;
      },
    };

    const captured = captureEvents();
    const result = await catchUp(RUNNER, api);
    captured.stop();

    expect(result).toEqual({ conversations: 2, refreshed: 2 });
    expect(count("conversations", stranger.id)).toBe(0);
    expect(getConversation(known.id).messages).toEqual([seen, missed]);
    expect(getConversation(known.id)).toMatchObject({ running: true, activeRunId: working.id, lastMessageAt: at(20) });
    expect(getConversation(fresh.id)).toMatchObject({ runnerId: RUNNER, archived: true, title: "Started while away", running: false, activeRunId: null });
    expect(getConversation(fresh.id).messages).toEqual([freshMessage]);
    expect(getRun(freshRun.id).status).toBe("succeeded");
    expect(getRun(ended.id)).toMatchObject({ status: "succeeded", finishedAt: at(20) });
    expect(remoteRuns(RUNNER).map((r) => r.runId)).toEqual([working.id]);

    const events = captured.events;
    expect(events).toContainEqual({ type: "message.created", message: missed });
    expect(events).toContainEqual({ type: "run.finished", run: ended });
    expect(events).toContainEqual({ type: "run.started", run: working });
    expect(events).toContainEqual({ type: "conversation.updated", conversation: getConversationSummary(fresh.id) });
    // History that is new here is stored quietly: nobody is told that an old run "finished".
    expect(events.some((e) => e.type === "run.finished" && e.run.id === freshRun.id)).toBe(false);

    // The next connect: only the chat that still works is fetched again, and nothing new is told about its messages.
    calls.length = 0;
    const again = captureEvents();
    expect(await catchUp(RUNNER, api)).toEqual({ conversations: 2, refreshed: 1 });
    again.stop();
    expect(calls).not.toContain(`GET /api/conversations/${fresh.id}`);
    expect(calls).toContain(`GET /api/conversations/${known.id}`);
    expect(again.events.filter((e) => e.type !== "run.started")).toEqual([]);
    expect(again.events).toEqual([{ type: "run.started", run: working }]);
    runnerDisconnected(RUNNER);
  });

  test("stops when the runner goes offline in the middle", async () => {
    const api: RunnerApi = {
      async json<T>(_method: string, path: string): Promise<T> {
        if (path.startsWith("/api/conversations?")) return [chat({ title: "Half read" })] as T;
        throw new HttpError(409, "Mac mini is offline", "runner_offline");
      },
    };
    expect((await failure(catchUp(RUNNER, api))).code).toBe("runner_offline");
  });
});

describe("the run executor and a runner's chat", () => {
  test("a restart of this computer doesn't fail the runner's run, and still fails a stale local one", () => {
    const conversation = adopt();
    const remote = run(conversation.id, { status: "running", startedAt: at(2) });
    const answer = message(conversation.id, { role: "assistant", content: "", runId: remote.id });
    applyRunnerEvent(RUNNER, { type: "run.started", run: remote });
    applyRunnerEvent(RUNNER, { type: "message.created", message: answer });
    const local = createConversation({ agentId: agent.id, title: "Stays here" });
    const stale = localRun(local.id, "running");

    recoverInterruptedRuns();

    expect(getRun(remote.id)).toMatchObject({ status: "running", error: null, finishedAt: null });
    expect(getConversation(conversation.id).messages).toEqual([answer]);
    expect(getRun(stale)).toMatchObject({ status: "failed", error: INTERRUPTED });
  });

  test("no run starts here in a runner's chat, and its run can't be ended from here", async () => {
    const conversation = adopt();
    const remote = run(conversation.id, { status: "running", startedAt: at(2) });
    applyRunnerEvent(RUNNER, { type: "run.started", run: remote });
    const before = database();

    const start = await failure(startRun({ agentId: agent.id, conversationId: conversation.id, prompt: "Hi", trigger: "chat" }));
    expect([start.status, start.message]).toEqual([409, "This chat works on a runner"]);
    const cancel = await failure(cancelRun(remote.id));
    expect([cancel.status, cancel.code, cancel.message]).toEqual([409, "runner_offline", "The runner this chat works on is offline"]);
    expect(database()).toBe(before);
    expect(getRun(remote.id).status).toBe("running");
    runnerDisconnected(RUNNER);
  });
});
