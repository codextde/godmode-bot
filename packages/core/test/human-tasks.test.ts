import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Agent, MessageBlock, Task } from "@godmode/shared";
import { taskEventText } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { callTool } from "../src/mcp/tools";
import { updateAgent } from "../src/agents/service";
import { getAccessToken } from "../src/server/auth";
import { deleteConversation, getConversation, sendMessage, startChat } from "../src/services/conversations";
import { listAttention } from "../src/services/attention";
import { listNotifications } from "../src/services/notifications";
import { updateSettings } from "../src/services/settings";
import { closeHumanTask, getHumanTask, listHumanTasks, noteOpenDecision, sameAsk, startHumanTasks, stopHumanTasks } from "../src/services/humanTasks";
import { run as sql } from "../src/db";
import { answerQuestion, getQuestion, openQuestionOf } from "../src/services/questions";
import { stopPauses } from "../src/services/pauses";
import { cancelRun, getRun, listRuns, waitForRun } from "../src/runner/runner";
import { createTask, getTask, listTaskEvents, startTasks, stopTasks } from "../src/tasks/service";

let env: TestEnv;
let agent: Agent;
let other: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-human-tasks-");
  startTasks();
  startHumanTasks();
  agent = await makeAgent({ name: "Ads Bot" });
  other = await makeAgent({ name: "Other Bot" });
  updateSettings({ general: { userName: "Dana" } });
});

afterAll(async () => {
  stopHumanTasks();
  stopPauses();
  stopTasks();
  await env.close();
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A chat whose agent gave Dana a task (through the gateway, like Claude Code calls it). */
async function chatWithTask(content = "HUMAN_TASK set up the ads") {
  const { conversation, run } = await startChat({ agentId: agent.id, content });
  const done = await waitForRun(run.id, 10_000);
  const task = listHumanTasks({ conversationId: conversation.id })[0]!;
  return { conversationId: conversation.id, run: done, task };
}

const lastPrompt = () => invocations(env).at(-1)!.prompt;

describe("an agent gives the human a task", () => {
  test("it lands on the list with a notification and the chat continues once it is done", async () => {
    const { conversationId, run, task } = await chatWithTask();
    expect(run.result).toContain("Added to Dana's tasks as H-");
    expect(run.result).toContain("continues by itself");
    expect(task).toMatchObject({
      title: "Create the passkey",
      body: "1. Open Google Ads\n2. Add a passkey",
      url: "https://ads.google.com/security",
      status: "open",
      agentId: agent.id,
      agentName: "Ads Bot",
      conversationId,
      runId: run.id,
      taskId: null,
    });
    expect(listNotifications().some((n) => n.title === "Ads Bot has a task for you" && n.link === `/my-tasks?task=${task.id}`)).toBe(true);
    const item = listAttention().find((i) => i.id === `todo:${task.id}`);
    expect(item).toMatchObject({ kind: "todo", title: "Ads Bot needs you to: Create the passkey", link: `/my-tasks?task=${task.id}` });
    // The agent's system prompt tells it how.
    expect(invocations(env).at(-1)!.args.join(" ")).toContain("### Tasks for Dana");

    const out = await closeHumanTask(task.id, { outcome: "done", note: "Passkey is set up on the YubiKey" });
    expect(out.continued).toBe(true);
    expect(out.task).toMatchObject({ status: "done", response: { text: "Passkey is set up on the YubiKey" } });
    let next: string | undefined;
    await until(() => !!(next = listRuns({ conversationId }).find((r) => r.id !== run.id)?.id), 10_000, "the chat to continue");
    await waitForRun(next!, 10_000);
    expect(lastPrompt()).toContain("<godmode-human-task>");
    expect(lastPrompt()).toContain(`${task.number === 1 ? "H-1" : `H-${task.number}`} “Create the passkey”. Dana marked it done.`);
    expect(lastPrompt()).toContain("Passkey is set up on the YubiKey");
    const marker = getConversation(conversationId).messages.find((m) => m.role === "system" && m.blocks.some((b) => b.type === "human_task"));
    expect(marker?.blocks[0]).toMatchObject({ type: "human_task", id: task.id, outcome: "done", note: "Passkey is set up on the YubiKey" } as Partial<MessageBlock>);
    expect(listAttention().some((i) => i.id === `todo:${task.id}`)).toBe(false);
    // Closed once: a second close is refused.
    await expect(closeHumanTask(task.id, { outcome: "done" })).rejects.toThrow(/closed already/);
  }, 30_000);

  test("can't do it: the agent is told to find another way", async () => {
    const { conversationId, run, task } = await chatWithTask();
    await closeHumanTask(task.id, { outcome: "declined", note: "No access to that account" });
    await until(() => listRuns({ conversationId }).some((r) => r.id !== run.id && r.status === "succeeded"), 10_000, "the chat to continue");
    expect(lastPrompt()).toContain("Dana says they can't do it.");
    expect(lastPrompt()).toContain("Find another way");
    expect(getHumanTask(task.id).status).toBe("declined");
  }, 30_000);

  test("while the agent works in the chat, the outcome waits in its queue", async () => {
    const { conversationId, task } = await chatWithTask();
    const { run } = await sendMessage(conversationId, { content: "SLEEP a while" });
    await until(() => getRun(run.id).status === "running", 10_000, "the run to start");
    const out = await closeHumanTask(task.id, { outcome: "done" });
    expect(out.continued).toBe(true);
    expect(getConversation(conversationId).queue.map((q) => q.content)).toEqual([`Done: H-${task.number} Create the passkey`]);
    await cancelRun(run.id);
    await waitForRun(run.id, 10_000);
  }, 30_000);

  test("the agent lists and takes back its own tasks; another agent can't", async () => {
    const { conversationId, run, task } = await chatWithTask();
    const ctx = { runId: run.id, agentId: agent.id, conversationId, workspaceId: null, depth: 0 };
    const listed = await callTool(ctx, "human_tasks_list", {});
    expect(listed.content[0]!.text).toContain(`"ref": "H-${task.number}"`);
    const foreign = await callTool({ ...ctx, agentId: other.id }, "human_task_cancel", { id: `H-${task.number}` });
    expect(foreign.isError).toBe(true);
    const back = await callTool(ctx, "human_task_cancel", { id: `H-${task.number}`, reason: "Found an API key instead" });
    expect(back.content[0]!.text).toBe(`H-${task.number} is off the list.`);
    expect(getHumanTask(task.id)).toMatchObject({ status: "withdrawn", closedReason: "Found an API key instead" });
  }, 30_000);

  test("at most five open tasks per chat; deleting the chat withdraws them", async () => {
    const { conversationId, run } = await chatWithTask();
    const ctx = { runId: run.id, agentId: agent.id, conversationId, workspaceId: null, depth: 0 };
    for (let i = 0; i < 4; i++) expect((await callTool(ctx, "human_task_create", { title: `Step ${i}` })).isError).toBeUndefined();
    const sixth = await callTool(ctx, "human_task_create", { title: "One too many" });
    expect(sixth.isError).toBe(true);
    expect(sixth.content[0]!.text).toContain("already has 5 open tasks");
    const bad = await callTool(ctx, "human_task_create", { title: "Click it", url: "javascript:alert(1)" });
    expect(bad.isError).toBe(true);

    await deleteConversation(conversationId);
    await until(() => listHumanTasks({ status: "active", agentId: agent.id }).every((t) => t.conversationId !== null), 5_000, "orphans to be withdrawn");
    const gone = listHumanTasks({ status: "closed", agentId: agent.id }).filter((t) => t.closedReason === "The chat it was for was deleted.");
    expect(gone).toHaveLength(5);
  }, 30_000);
});

describe("on a board task", () => {
  test("the ticket waits in Blocked and continues once the task is done", async () => {
    const t = createTask({ title: "HUMAN_TASK launch the campaign", agentId: agent.id });
    const settled = (statuses: Task["status"][]) =>
      until(() => statuses.includes(getTask(t.id).status) && !getTask(t.id).activity && !["running", "queued"].includes(getTask(t.id).runStatus ?? ""), 15_000, statuses.join("/"));
    await settled(["blocked"]);
    const human = listHumanTasks({ conversationId: getTask(t.id).conversationId! })[0]!;
    expect(human.taskId).toBe(t.id);
    expect(human.taskNumber).toBe(t.number);
    expect(getTask(t.id)).toMatchObject({ blockedKind: "needs_input" });
    expect(getTask(t.id).blockedReason).toContain(`Waiting for you: H-${human.number} “Create the passkey”`);
    // Needs you once: as the task for the human, not also as a blocked ticket.
    const attention = listAttention();
    expect(attention.some((i) => i.id === `todo:${human.id}`)).toBe(true);
    expect(attention.some((i) => i.id === `blocked:${t.id}`)).toBe(false);
    expect(listNotifications().some((n) => n.title === `Task #${t.number} needs you`)).toBe(false);
    const asked = listTaskEvents(t.id).find((e) => e.kind === "asked")!;
    expect(taskEventText(asked, { you: "You", youObject: "you" })).toBe("Ads Bot gave you a task");

    const res = await api("POST", `/api/human-tasks/${human.id}/close`, { outcome: "done", note: "Done, passkey added" });
    expect(res.status).toBe(200);
    expect(res.json.continued).toBe(true);
    await settled(["in_review"]);
    expect(lastPrompt()).toContain("Done, passkey added");
    const answered = listTaskEvents(t.id).find((e) => e.kind === "answered")!;
    expect(taskEventText(answered, { you: "You", youObject: "you" })).toBe("You did the task");
  }, 40_000);
});

describe("the human's own tasks", () => {
  test("added, moved and closed over the API without anyone to continue", async () => {
    const a = await api("POST", "/api/human-tasks", { title: "Renew the domain", url: "https://dash.cloudflare.com", priority: "high" });
    expect(a.status).toBe(201);
    const b = await api("POST", "/api/human-tasks", { title: "Call the bank" });
    const aId = a.json.id as string;
    const bId = b.json.id as string;
    expect(a.json).toMatchObject({ status: "open", agentId: null, conversationId: null, priority: "high" });

    expect((await api("PATCH", `/api/human-tasks/${aId}`, { status: "doing" })).json).toMatchObject({ status: "doing" });
    expect(getHumanTask(aId).startedAt).not.toBeNull();
    expect((await api("PATCH", `/api/human-tasks/${bId}`, { title: "Call the bank about the card" })).json.title).toBe("Call the bank about the card");
    expect((await api("PATCH", `/api/human-tasks/${bId}`, { status: "doing", beforeId: aId })).status).toBe(200);
    const doing = listHumanTasks({ status: "active" }).filter((t) => t.status === "doing").map((t) => t.id);
    expect(doing.indexOf(bId)).toBeLessThan(doing.indexOf(aId));

    const closed = await api("POST", `/api/human-tasks/${aId}/close`, { outcome: "done" });
    expect(closed.json).toMatchObject({ continued: false });
    expect(closed.json.notContinued).toBeUndefined();
    expect((await api("DELETE", `/api/human-tasks/${bId}`)).status).toBe(200);
    expect((await api("GET", `/api/human-tasks/${bId}`)).status).toBe(404);
  });

  test("the backlog: parked for later, still open for the agent, but not waiting for you", async () => {
    const own = await api("POST", "/api/human-tasks", { title: "Sort the receipts", status: "backlog" });
    expect(own.status).toBe(201);
    expect(own.json).toMatchObject({ status: "backlog" });
    expect(listAttention().some((i) => i.id === `todo:${own.json.id}`)).toBe(false);

    const { conversationId, run, task } = await chatWithTask();
    const parked = await api("PATCH", `/api/human-tasks/${task.id}`, { status: "backlog" });
    expect(parked.json).toMatchObject({ status: "backlog" });
    expect(listHumanTasks({ status: "active", conversationId }).map((t) => t.id)).toContain(task.id);
    expect(listAttention().some((i) => i.id === `todo:${task.id}`)).toBe(false);
    expect(listNotifications().find((n) => n.link === `/my-tasks?task=${task.id}`)?.read).toBe(true);

    expect((await api("PATCH", `/api/human-tasks/${task.id}`, { status: "open" })).json).toMatchObject({ status: "open" });
    expect(listAttention().some((i) => i.id === `todo:${task.id}`)).toBe(true);
    await api("PATCH", `/api/human-tasks/${task.id}`, { status: "backlog" });
    const out = await closeHumanTask(task.id, { outcome: "done", note: "Did it after all" });
    expect(out.task.status).toBe("done");
    let next: string | undefined;
    await until(() => !!(next = listRuns({ conversationId }).find((r) => r.id !== run.id)?.id), 10_000, "the chat to continue");
    await waitForRun(next!, 10_000);
  }, 30_000);

    test("an agent's words stay as they were", async () => {
    const { task } = await chatWithTask();
    const res = await api("PATCH", `/api/human-tasks/${task.id}`, { title: "Something else" });
    expect(res.status).toBe(400);
  }, 20_000);
});

describe("a decision an answer leaves open", () => {
  // Every test leaves the same decision: an earlier one would keep it off the list.
  beforeEach(() => {
    sql("DELETE FROM human_tasks WHERE from_answer = 1");
  });

  /** A chat whose agent finished with a "Decision for you" in its answer. */
  async function chatWithDecision(content = "LEAVE_DECISION set up the store") {
    const { conversation, run } = await startChat({ agentId: agent.id, content });
    const done = await waitForRun(run.id, 10_000);
    const task = listHumanTasks({ status: "active", conversationId: conversation.id })[0]!;
    return { conversationId: conversation.id, run: done, task };
  }

  test("it lands on the list, and the answer continues the chat", async () => {
    const { conversationId, run, task } = await chatWithDecision();
    expect(task).toMatchObject({
      kind: "decision",
      fromAnswer: true,
      questionId: null,
      title: "Should the store take real orders before a domain exists?",
      body: "If yes, it needs a payment account with a card.",
      status: "open",
      agentId: agent.id,
      conversationId,
      runId: run.id,
    });
    // The human wrote the message and reads the answer in the chat: no notification on top.
    expect(listNotifications().some((n) => n.link === `/my-tasks?task=${task.id}`)).toBe(false);
    expect(listAttention().find((i) => i.id === `todo:${task.id}`)).toMatchObject({
      kind: "todo",
      title: "Ads Bot left you a decision: Should the store take real orders before a domain exists?",
      action: "Answer",
    });

    // An answer needs words.
    await expect(closeHumanTask(task.id, { outcome: "done" })).rejects.toThrow(/Write your answer/);
    const out = await closeHumanTask(task.id, { outcome: "done", note: "Yes, take orders. Use the company card." });
    expect(out.continued).toBe(true);
    expect(out.task).toMatchObject({ status: "done", response: { text: "Yes, take orders. Use the company card." } });
    let next: string | undefined;
    await until(() => !!(next = listRuns({ conversationId }).find((r) => r.id !== run.id)?.id), 10_000, "the chat to continue");
    await waitForRun(next!, 10_000);
    expect(lastPrompt()).toContain("<godmode-human-task>");
    expect(lastPrompt()).toContain("left this for Dana to decide: “Should the store take real orders before a domain exists?”");
    expect(lastPrompt()).toContain(`as H-${task.number}, and Dana answered:\nYes, take orders. Use the company card.`);
    const marker = getConversation(conversationId).messages.find((m) => m.role === "system" && m.blocks.some((b) => b.type === "human_task"));
    expect(marker?.blocks[0]).toMatchObject({ type: "human_task", id: task.id, kind: "decision", outcome: "done" } as Partial<MessageBlock>);
  }, 30_000);

  test("dismissed: it leaves the list and nobody is woken", async () => {
    const { conversationId, task } = await chatWithDecision();
    const res = await api("POST", `/api/human-tasks/${task.id}/close`, { outcome: "declined" });
    expect(res.json).toMatchObject({ continued: false });
    expect(res.json.notContinued).toBeUndefined();
    expect(getHumanTask(task.id).status).toBe("declined");
    expect(listRuns({ conversationId })).toHaveLength(1);
  }, 30_000);

  test("writing into the chat answers it", async () => {
    const { conversationId, task } = await chatWithDecision();
    const sent = await api("POST", `/api/conversations/${conversationId}/messages`, { content: "Not yet, wait for the domain" });
    expect(sent.status).toBe(201);
    expect(getHumanTask(task.id)).toMatchObject({ status: "done", closedReason: "Answered in the chat.", response: { text: "Not yet, wait for the domain" } });
    await until(() => listRuns({ conversationId }).every((r) => r.status === "succeeded"), 10_000, "the reply's run");
    // The human's message is the turn: no second one from the ticket.
    expect(listRuns({ conversationId })).toHaveLength(2);
  }, 30_000);

  test("a message that couldn't be sent answers nothing", async () => {
    const { conversationId, task } = await chatWithDecision();
    updateAgent(agent.id, { enabled: false });
    try {
      const sent = await api("POST", `/api/conversations/${conversationId}/messages`, { content: "Yes, go ahead" });
      expect(sent.status).toBe(409);
      expect(getHumanTask(task.id).status).toBe("open");
    } finally {
      updateAgent(agent.id, { enabled: true });
    }
    await closeHumanTask(task.id, { outcome: "declined" });
  }, 30_000);

  test("the chat went on: an answer to the human that no longer asks takes it back", async () => {
    const { conversationId, task } = await chatWithDecision();
    // Not through the API (that message would answer it): the human's turn was already waiting in the queue.
    const next = await sendMessage(conversationId, { content: "Hello" });
    await waitForRun(next.run.id, 10_000);
    expect(getHumanTask(task.id)).toMatchObject({ status: "withdrawn", closedReason: "The chat went on without it." });
  }, 30_000);

  test("one per chat: the same decision keeps its ticket, another one takes its place", async () => {
    const { conversationId, task } = await chatWithDecision();
    const again = await sendMessage(conversationId, { content: "LEAVE_DECISION once more", trigger: "followup" });
    await waitForRun(again.run.id, 10_000);
    expect(listHumanTasks({ status: "active", conversationId }).map((t) => t.id)).toEqual([task.id]);

    const other = await sendMessage(conversationId, { content: "ASK_IN_PROSE", trigger: "followup" });
    await waitForRun(other.run.id, 10_000);
    const open = listHumanTasks({ status: "active", conversationId });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: "Should I send it to the whole list on Monday?", kind: "decision", fromAnswer: true });
    expect(getHumanTask(task.id)).toMatchObject({ status: "withdrawn", closedReason: "A later answer took its place." });
    // Nobody wrote that message: the human is told.
    expect(listNotifications().some((n) => n.title === "Ads Bot left you a decision" && n.link === `/my-tasks?task=${open[0]!.id}`)).toBe(true);
  }, 30_000);

  test("an agent that got the task from another one: the decision is the human's, and the lead is told", async () => {
    const { conversationId, run } = await chatWithTask("HUMAN_TASK lead");
    const ctx = { runId: run.id, agentId: agent.id, conversationId, workspaceId: null, depth: 0 };
    const out = await callTool(ctx, "agent_delegate", { agentId: other.id, task: "LEAVE_DECISION build the store" });
    const text = out.content[0]!.text;
    const mine = listHumanTasks({ status: "active", agentId: other.id }).find((t) => t.fromAnswer)!;
    expect(mine).toMatchObject({ kind: "decision", title: "Should the store take real orders before a domain exists?" });
    expect(text).toContain(`on Dana's task list as H-${mine.number}`);
    expect(text).toContain("don't ask them the same thing again");
    // The agent is told how to say it.
    expect(invocations(env).at(-1)!.args.join(" ")).toContain("## Decision for Dana");
    await closeHumanTask(mine.id, { outcome: "declined" });
  }, 30_000);

  test("on a board task the work is delivered all the same, and the answer continues it", async () => {
    const t = createTask({ title: "LEAVE_DECISION open the store", agentId: agent.id });
    const settled = (statuses: Task["status"][]) =>
      until(() => statuses.includes(getTask(t.id).status) && !getTask(t.id).activity && !["running", "queued"].includes(getTask(t.id).runStatus ?? ""), 15_000, statuses.join("/"));
    await settled(["in_review"]);
    const human = listHumanTasks({ status: "active", conversationId: getTask(t.id).conversationId! })[0]!;
    expect(human).toMatchObject({ kind: "decision", fromAnswer: true, taskId: t.id });
    const asked = listTaskEvents(t.id).find((e) => e.kind === "asked")!;
    expect(taskEventText(asked, { you: "You", youObject: "you" })).toBe("Ads Bot asked you");
    const runs = listRuns({ conversationId: getTask(t.id).conversationId! }).length;
    await closeHumanTask(human.id, { outcome: "done", note: "Go ahead" });
    await until(() => listRuns({ conversationId: getTask(t.id).conversationId! }).length > runs, 10_000, "the ticket to continue");
    await settled(["in_review"]);
    expect(lastPrompt()).toContain("Dana answered:\nGo ahead");
  }, 40_000);
});

describe("the same thing twice", () => {
  beforeEach(() => {
    sql("UPDATE human_tasks SET status = 'withdrawn' WHERE status IN ('backlog', 'open', 'doing') AND question_id IS NULL");
  });

  test("titles that ask for the same thing match, different ones don't", () => {
    expect(
      sameAsk(
        "If an order comes in before CJ sources it, may we buy that one unit on AliExpress (WINOMO item 3256813118244875, about USD 18) and ship it straight to the customer?",
        "if a hoop order comes in before CJ finds a supplier, may we buy that one unit on AliExpress (WINOMO item, about USD 18) and ship it straight to the customer?",
      ),
    ).toBe(true);
    expect(sameAsk("Easyclean claim of 8,139 EUR: sue or write off?", "the Easyclean claim (8139 EUR): sue or write off")).toBe(true);
    expect(sameAsk("Log in to Higgsfield in the Godmode browser", "Log in to Twilio in the Godmode browser")).toBe(false);
    expect(sameAsk('Type the Scalable CAPTCHA and click "Anmelden"', 'financeAds: type the CAPTCHA and click "Jetzt kostenlos registrieren!"')).toBe(false);
    expect(sameAsk("Confirm on your phone", "Confirm the Google Ads sign-in on your phone")).toBe(false);
  });

  test("an agent can't put a task on the list that is already there, from whichever chat", async () => {
    const first = await chatWithTask("HUMAN_TASK passkey once");
    const second = await startChat({ agentId: other.id, content: "hello" });
    await waitForRun(second.run.id, 10_000);
    const ctx = { runId: second.run.id, agentId: other.id, conversationId: second.conversation.id, workspaceId: null, depth: 0 };
    const twice = await callTool(ctx, "human_task_create", { title: "Please create the passkey" });
    expect(twice.isError).toBe(true);
    expect(twice.content[0]!.text).toContain(`H-${first.task.number} “Create the passkey” is already on Dana's list`);
    expect(listHumanTasks({ status: "active", conversationId: second.conversation.id })).toHaveLength(0);
    expect((await callTool(ctx, "human_task_create", { title: "Scan the Google QR code for the YouTube channel" })).isError).toBeUndefined();

    // Once it is done, it may be asked again.
    await closeHumanTask(first.task.id, { outcome: "done" });
    expect((await callTool(ctx, "human_task_create", { title: "Create the passkey" })).isError).toBeUndefined();
    for (const t of listHumanTasks({ status: "active", conversationId: second.conversation.id })) await closeHumanTask(t.id, { outcome: "declined" });
  }, 30_000);

  test("an answer that only lists what is open, or asks what the list holds, adds nothing", async () => {
    const { conversationId, run, task } = await chatWithTask("HUMAN_TASK roll-up");
    const finished = { agentId: agent.id, conversationId, runId: run.id, workspaceId: null, attended: false };
    const rollUp = `Ops pulse done.\n\n## Decisions for you\n\nH-${task.number} (create the passkey) is still open.`;
    expect(noteOpenDecision(finished, rollUp)).toBeNull();
    expect(noteOpenDecision(finished, "I set it up.\n\nShould I create the passkey now?")).toBeNull();
    expect(listHumanTasks({ status: "active", conversationId }).map((t) => t.id)).toEqual([task.id]);
    await closeHumanTask(task.id, { outcome: "declined" });
  }, 30_000);
});

describe("questions and approvals have a ticket", () => {
  async function asking(content = "ASK_HUMAN which color") {
    const started = await startChat({ agentId: agent.id, content });
    await until(() => getRun(started.run.id).status === "paused", 15_000, "the run to stand still for its question");
    const question = openQuestionOf(started.conversation.id)!;
    const task = listHumanTasks({ status: "active", conversationId: started.conversation.id })[0]!;
    return { ...started, question, task };
  }

  test("answering the ticket answers the question, and the run continues", async () => {
    const { run, question, task } = await asking();
    expect(task).toMatchObject({
      kind: "decision",
      questionId: question.id,
      fromAnswer: false,
      title: "Which color should the header be?",
      body: "The brand guide allows two.",
      options: [{ id: "1", label: "Yellow", recommended: true }, { id: "2", label: "Blue", description: "Matches the logo" }],
    });
    // Needs you once: as the question.
    const attention = listAttention();
    expect(attention.some((i) => i.id === `question:${question.id}`)).toBe(true);
    expect(attention.some((i) => i.id === `todo:${task.id}`)).toBe(false);

    const declined = await api("POST", `/api/human-tasks/${task.id}/close`, { outcome: "declined" });
    expect(declined.status).toBe(400);
    // The run stands still for it: the ticket can't be dismissed or deleted from under it.
    expect((await api("DELETE", `/api/human-tasks/${task.id}`)).status).toBe(400);
    const res = await api("POST", `/api/human-tasks/${task.id}/close`, { outcome: "done", optionId: "2" });
    expect(res.status).toBe(200);
    expect(res.json.continued).toBe(true);
    expect(getQuestion(question.id)).toMatchObject({ status: "answered", answer: { optionId: "2", text: "Blue" } });
    expect(getHumanTask(task.id)).toMatchObject({ status: "done", response: { optionId: "2", text: "Blue" } });
    expect((await waitForRun(run.id, 10_000)).result).toBe("CONTINUED");
  }, 30_000);

  test("answering the question closes its ticket", async () => {
    const { run, question, task } = await asking();
    answerQuestion(question.id, { text: "Green, like the logo" }, { actor: "user", via: "app" });
    expect(getHumanTask(task.id)).toMatchObject({ status: "done", response: { text: "Green, like the logo", optionId: null } });
    await waitForRun(run.id, 10_000);
  }, 30_000);

  test("an approval is approved or declined from its ticket", async () => {
    const { run, question, task } = await asking("ASK_APPROVAL send it");
    expect(task).toMatchObject({ kind: "approval", questionId: question.id, title: "Send the payment reminder to billing@acme.com" });
    expect(task.body).toBe("The invoice is 30 days overdue.\n\n**What it changes:** ACME's billing team gets an email from you.");
    const out = await closeHumanTask(task.id, { outcome: "declined", note: "Call them first" });
    expect(out.task.status).toBe("declined");
    expect(getQuestion(question.id)).toMatchObject({ status: "declined", answer: { text: "Call them first" } });
    await waitForRun(run.id, 10_000);
  }, 30_000);

  test("stopping the run takes the ticket back", async () => {
    const { run, task } = await asking();
    await cancelRun(run.id);
    await until(() => getHumanTask(task.id).status === "withdrawn", 5_000, "the ticket to be withdrawn");
  }, 30_000);
});
