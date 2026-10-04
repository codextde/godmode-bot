import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { taskEventText, waitsForSubtasks } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { callTool } from "../src/mcp/tools";
import { createTask, getTask, listTaskEvents, listTasks, startTasks, stopTasks, updateTask } from "../src/tasks/service";

let env: TestEnv;
let lead: Agent;
let writer: Agent;
let outsider: Agent;
let parentChat = "";

beforeAll(async () => {
  env = await setupEnv("godmode-subtasks-");
  lead = await makeAgent({ name: "Mia", role: "Marketing lead" });
  writer = await makeAgent({ name: "Lena", role: "Writer", reportsTo: lead.id });
  outsider = await makeAgent({ name: "Bo", role: "Bookkeeper" });
  startTasks();
});

afterAll(async () => {
  stopTasks();
  await env.close();
});

const text = (e: Parameters<typeof taskEventText>[0]) => taskEventText(e, { you: "you", youObject: "you" });

describe("a lead splits its ticket into parts for its team", () => {
  test("the parts run, the ticket waits for them, then the lead continues with their results and delivers", async () => {
    const parent = createTask({ title: `Launch page SPLIT_TO:${writer.id}`, agentId: lead.id });
    await until(() => (getTask(parent.id).subtasks?.total ?? 0) === 2, 20_000, "the parts");
    const parts = listTasks().filter((t) => t.parentId === parent.id);
    expect(parts.map((p) => p.title).sort()).toEqual(["Pick the images", "Write the copy"]);
    expect(parts.every((p) => p.agentId === writer.id && p.parentNumber === parent.number && p.createdBy === `agent:${lead.id}`)).toBe(true);
    // A part's agent is told what it is part of.
    await until(() => invocations(env).some((i) => i.prompt.includes("Write the copy") && i.prompt.includes(`part of #${parent.number}`)), 20_000, "a part's prompt");

    // Both parts delivered: the lead picks its ticket up again with them, then delivers the whole.
    await until(() => getTask(parent.id).status === "in_review", 40_000, "the whole ticket to be delivered");
    const continued = invocations(env).find((i) => i.prompt.includes("<godmode-subtasks>"));
    expect(continued?.prompt).toContain("Write the copy");
    expect(continued?.prompt).toContain("delivered — yours to review");
    const timeline = listTaskEvents(parent.id).map(text);
    expect(timeline.some((t) => /^Mia is waiting for #\d+ and #\d+$/.test(t))).toBe(true);
    expect(timeline.some((t) => /^Mia picked it up again — #\d+ and #\d+ are done$/.test(t))).toBe(true);
    expect(getTask(parent.id).subtasks).toEqual({ total: 2, open: 0 });

    // Approving the whole approves its delivered parts.
    updateTask(parent.id, { status: "done" });
    expect(listTasks().filter((t) => t.parentId === parent.id).every((p) => p.status === "done")).toBe(true);
    parentChat = getTask(parent.id).conversationId!;
  }, 90_000);

  test("a part that is still open keeps the ticket waiting; only reports get parts", async () => {
    const parent = createTask({ title: "Quarterly review", agentId: lead.id, status: "backlog" });
    const open = createTask({ title: "Collect the numbers", parentId: parent.id });
    expect(getTask(parent.id).subtasks).toEqual({ total: 1, open: 1 });
    expect(waitsForSubtasks({ ...getTask(parent.id), status: "in_progress", runStatus: "succeeded" })).toBe(true);
    updateTask(open.id, { status: "cancelled" });
    expect(getTask(parent.id).subtasks).toEqual({ total: 1, open: 0 });

    // Splitting is for the ticket's own agent, giving parts to its reports.
    const ctx = { runId: "run_x", agentId: lead.id, conversationId: "cnv_none", workspaceId: null, depth: 0 };
    const notOnTicket = await callTool(ctx as never, "task_split", { parts: [{ title: "x", agentId: writer.id }] });
    expect(notOnTicket.isError).toBe(true);
    const onTicket = { ...ctx, conversationId: parentChat };
    const notMine = await callTool(onTicket as never, "task_split", { parts: [{ title: "Book it", agentId: outsider.id }] });
    expect(notMine.isError).toBe(true);
    expect(notMine.content[0]!.text).toContain("doesn't report to you");
    expect(() => createTask({ title: "Lost", parentId: "tsk_missing" })).toThrow("doesn't exist");
  });
});
