import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, MessageBlock, Task } from "@godmode/shared";
import { taskEventText } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { callTool } from "../src/mcp/tools";
import { getAccessToken } from "../src/server/auth";
import { deleteConversation, getConversation, sendMessage, startChat } from "../src/services/conversations";
import { listAttention } from "../src/services/attention";
import { listNotifications } from "../src/services/notifications";
import { updateSettings } from "../src/services/settings";
import { closeHumanTask, getHumanTask, listHumanTasks, startHumanTasks, stopHumanTasks } from "../src/services/humanTasks";
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

  test("an agent's words stay as they were", async () => {
    const { task } = await chatWithTask();
    const res = await api("PATCH", `/api/human-tasks/${task.id}`, { title: "Something else" });
    expect(res.status).toBe(400);
  }, 20_000);
});
