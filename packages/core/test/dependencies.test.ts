import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { waitsForTickets } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { listActiveRuns } from "../src/runner/runner";
import { createTask, deleteTask, getTask, sendTaskMessage, startTasks, stopTasks, updateTask } from "../src/tasks/service";
import { createWorkspace } from "../src/services/workspaces";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-deps-");
  agent = await makeAgent({ name: "Mia" });
  startTasks();
});

afterAll(async () => {
  stopTasks();
  await until(() => listActiveRuns().length === 0, 15_000, "runs to end").catch(() => {});
  await env.close();
});

describe("a ticket that waits for others", () => {
  test("stays in Todo until they are delivered, then starts on its own with their results in its brief", async () => {
    const finish = join(env.stateDir, "finish");
    const research = createTask({ title: "Research the pricing", description: "WAIT_TO_FINISH", agentId: agent.id });
    await until(() => getTask(research.id).runStatus === "running", 20_000, "the research to start");
    const write = createTask({ title: "Write the announcement", agentId: agent.id, waitsFor: [research.id] });
    await new Promise((r) => setTimeout(r, 300));
    const waiting = getTask(write.id);
    expect(waiting.status).toBe("todo");
    expect(waiting.runId).toBeNull();
    expect(waiting.waitsFor).toEqual([{ id: research.id, number: research.number, title: "Research the pricing", finished: false }]);
    expect(waitsForTickets(waiting)).toBe(true);

    writeFileSync(finish, "");
    try {
      await until(() => getTask(write.id).status === "in_review", 30_000, "the announcement to be written");
    } finally {
      rmSync(finish, { force: true });
    }
    const brief = invocations(env).find((i) => i.prompt.includes("# Write the announcement"))!.prompt;
    expect(brief).toContain("builds on these tickets");
    expect(brief).toContain(`#${research.number} “Research the pricing”`);
    expect(getTask(write.id).waitsFor[0]!.finished).toBe(true);
  }, 60_000);

  test("no loops; deleting what it waits for lets it start; clearing the list starts it", async () => {
    const a = createTask({ title: "A" });
    const b = createTask({ title: "B", waitsFor: [a.id] });
    expect(() => updateTask(a.id, { waitsFor: [b.id] })).toThrow("loop");
    expect(() => updateTask(a.id, { waitsFor: [a.id] })).toThrow("itself");

    const blocker = createTask({ title: "Blocker" });
    const held = createTask({ title: "Held back", agentId: agent.id, waitsFor: [blocker.id] });
    expect(getTask(held.id).status).toBe("todo");
    await deleteTask(blocker.id);
    await until(() => getTask(held.id).status !== "todo", 20_000, "the held ticket to start");

    const other = createTask({ title: "Other blocker" });
    const second = createTask({ title: "Also held", agentId: agent.id, waitsFor: [other.id] });
    expect(getTask(second.id).runId).toBeNull();
    updateTask(second.id, { waitsFor: [] });
    await until(() => getTask(second.id).status !== "todo", 20_000, "the ticket to start once nothing holds it");
    await until(() => listActiveRuns().length === 0, 20_000, "runs to end");
  }, 60_000);

  test("a part can't wait for its own ticket; tickets of another workspace are refused; a refused update changes nothing", async () => {
    const parent = createTask({ title: "Launch" });
    const part = createTask({ title: "Write the post", parentId: parent.id });
    expect(() => updateTask(part.id, { waitsFor: [parent.id] })).toThrow("loop");

    const ws = createWorkspace({ name: "Client B" });
    const theirs = createTask({ title: "Their ticket", workspaceId: ws.id });
    expect(() => createTask({ title: "Ours", waitsFor: [theirs.id] })).toThrow("another workspace");

    const blocker = createTask({ title: "Blocker" });
    const t = createTask({ title: "Waits" });
    expect(() => updateTask(t.id, { title: " ", waitsFor: [blocker.id] })).toThrow();
    expect(getTask(t.id).waitsFor).toEqual([]);
  });

  test("a run the human starts in a waiting ticket's chat makes it work; what it waited for finishing doesn't restart it", async () => {
    const finish = join(env.stateDir, "finish");
    const t = createTask({ title: "Summarize the quarter", agentId: agent.id });
    await until(() => getTask(t.id).status === "in_review", 20_000, "the first delivery");
    const blocker = createTask({ title: "Get the last numbers" });
    updateTask(t.id, { waitsFor: [blocker.id] });
    updateTask(t.id, { status: "todo" });
    expect(getTask(t.id).status).toBe("todo");
    await sendTaskMessage(t.id, "WAIT_TO_FINISH Use what you have for now");
    await until(() => getTask(t.id).status === "in_progress" && getTask(t.id).runStatus === "running", 20_000, "the human's run to work");
    const runId = getTask(t.id).runId!;
    updateTask(blocker.id, { status: "done" });
    await new Promise((r) => setTimeout(r, 300));
    expect(getTask(t.id).runId).toBe(runId);
    writeFileSync(finish, "");
    try {
      await until(() => getTask(t.id).status === "in_review", 20_000, "the human's run to deliver");
    } finally {
      rmSync(finish, { force: true });
    }
    expect(getTask(t.id).runStatus).toBe("succeeded");
  }, 60_000);

  test("started without waiting, the brief says so instead of claiming it waited", async () => {
    const blocker = createTask({ title: "Find the supplier" });
    const t = createTask({ title: "Order the parts", agentId: agent.id, status: "backlog", waitsFor: [blocker.id] });
    updateTask(t.id, { status: "in_progress" });
    await until(() => invocations(env).some((i) => i.prompt.includes("# Order the parts")), 20_000, "the brief");
    const brief = invocations(env).find((i) => i.prompt.includes("# Order the parts"))!.prompt;
    expect(brief).toContain(`#${blocker.number} “Find the supplier” — not finished: you started without it`);
    await until(() => listActiveRuns().length === 0, 20_000, "runs to end");
  }, 60_000);
});
