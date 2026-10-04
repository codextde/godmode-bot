import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, Goal } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { getAccessToken } from "../src/server/auth";
import { callTool } from "../src/mcp/tools";
import { createWorkspace } from "../src/services/workspaces";
import { createGoal, deleteGoal, getGoal } from "../src/tasks/goals";
import { createTask, getTask, startTasks, stopTasks, updateTask } from "../src/tasks/service";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-goals-");
  agent = await makeAgent({ name: "Mia" });
  startTasks();
});

afterAll(async () => {
  stopTasks();
  await env.close();
});

describe("goals", () => {
  test("a ticket serving a goal tells its agent why; the goal counts its tickets and parts serve it too", async () => {
    const goal = createGoal({ title: "Launch the new pricing", why: "Raise revenue per customer by 20% this quarter", targetDate: "2026-12-31" });
    const ticket = createTask({ title: "Write the pricing page copy", agentId: agent.id, goalId: goal.id });
    await until(() => getTask(ticket.id).status === "in_review", 20_000, "the ticket to be delivered");
    const prompt = invocations(env).find((i) => i.prompt.includes("Write the pricing page copy"))!.prompt;
    expect(prompt).toContain("serves the goal “Launch the new pricing” (target: 2026-12-31)");
    expect(prompt).toContain("Raise revenue per customer by 20%");

    const part = createTask({ title: "Check competitor prices", parentId: ticket.id });
    expect(getTask(part.id).goalId).toBe(goal.id);
    expect(getGoal(goal.id).tickets).toEqual({ total: 2, done: 0, open: 2 });
    // Approving the whole settles its open part (cancelled): nothing left to do for the goal.
    updateTask(ticket.id, { status: "done" });
    expect(getGoal(goal.id).tickets).toEqual({ total: 2, done: 1, open: 0 });
  }, 60_000);

  test("over HTTP and for agents; a goal of another workspace is refused; deleting a goal frees its tickets", async () => {
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${env.baseUrl}${path}`, { ...init, headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" } });
    const created = (await (await call("/api/goals", { method: "POST", body: JSON.stringify({ title: "Hire a designer" }) })).json()) as Goal;
    expect((await (await call("/api/goals")).json() as Goal[]).map((g) => g.title)).toContain("Hire a designer");
    expect((await call(`/api/goals/${created.id}`, { method: "PATCH", body: JSON.stringify({ status: "achieved" }) })).status).toBe(200);

    const ws = createWorkspace({ name: "Client A" });
    const theirs = createGoal({ title: "Client A's launch", workspaceId: ws.id });
    expect(() => createTask({ title: "Global ticket", goalId: theirs.id })).toThrow("another workspace");

    const manager = await makeAgent({ name: "Boss", permissions: { canManageAgents: true } as never });
    const listed = await callTool({ runId: "run_x", agentId: manager.id, conversationId: "cnv_x", workspaceId: null, depth: 0 } as never, "goals_list", {});
    expect(listed.content[0]!.text).toContain("Launch the new pricing");
    expect(listed.content[0]!.text).not.toContain("Hire a designer");

    const t = createTask({ title: "Find candidates", goalId: created.id });
    deleteGoal(created.id);
    expect(getTask(t.id).goalId).toBeNull();
  }, 30_000);
});
