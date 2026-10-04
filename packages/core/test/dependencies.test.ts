import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { waitsForTickets } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { listActiveRuns } from "../src/runner/runner";
import { createTask, deleteTask, getTask, startTasks, stopTasks, updateTask } from "../src/tasks/service";

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
});
