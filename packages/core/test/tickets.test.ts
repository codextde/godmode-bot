import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, Task } from "@godmode/shared";
import { taskEventText } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { get, insert, run as sql } from "../src/db";
import { getAccessToken } from "../src/server/auth";
import { deviceMayCall } from "../src/mobile/scope";
import { updateAgent } from "../src/agents/service";
import { cancelRun, getRun } from "../src/runner/runner";
import { cancelFollowup, getFollowup } from "../src/services/followups";
import { listNotifications } from "../src/services/notifications";
import { updateSettings } from "../src/services/settings";
import { callTool } from "../src/mcp/tools";
import {
  addTaskNote,
  createTask,
  deleteTask,
  findTask,
  getTask,
  listTaskEvents,
  reconcileTasks,
  sendTaskMessage,
  startTasks,
  stopTasks,
  updateTask,
} from "../src/tasks/service";
import { HttpError, newId, now } from "../src/util";

let env: TestEnv;
let agent: Agent;
let manager: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-tickets-");
  startTasks();
  agent = await makeAgent({ name: "Ticket Bot" });
  manager = await makeAgent({ name: "Lead", permissions: { canManageAgents: true, allowDelegation: true } });
  updateSettings({ general: { userName: "Dana" } });
});

afterAll(async () => {
  stopTasks();
  await env.close();
});

async function catchHttp(fn: () => unknown): Promise<HttpError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected an HttpError");
}

const settled = (id: string, statuses: Task["status"][], ms = 15_000) =>
  until(() => statuses.includes(getTask(id).status) && !getTask(id).activity && getTask(id).runStatus !== "running" && getTask(id).runStatus !== "queued", ms, `task to be ${statuses.join("/")}`);
const kinds = (id: string) => listTaskEvents(id).map((e) => e.kind);
const lastPrompt = () => invocations(env).at(-1)!.prompt;

/** A run of the manager agent in its own chat, for calling gateway tools as it. */
function managerCtx() {
  const conv = newId("cnv");
  insert("conversations", { id: conv, agent_id: manager.id, title: "Lead chat", origin: "chat", created_at: now(), updated_at: now() });
  const runId = newId("run");
  insert("runs", { id: runId, agent_id: manager.id, conversation_id: conv, trigger: "chat", status: "running", prompt: "x", created_at: now() });
  return { runId, agentId: manager.id, conversationId: conv, workspaceId: null, depth: 0 };
}

describe("ticket fields", () => {
  test("priority, due date and labels are stored, cleaned and checked", async () => {
    const t = createTask({ title: "Fix login", priority: "urgent", dueDate: "2026-12-24", labels: ["#bug", "Bug", "  billing   team ", ""] });
    expect(t).toMatchObject({ priority: "urgent", dueDate: "2026-12-24", labels: ["bug", "billing team"], createdBy: "user", costUsd: 0, runCount: 0 });
    expect(updateTask(t.id, { priority: "low", dueDate: null, labels: [] })).toMatchObject({ priority: "low", dueDate: null, labels: [] });
    expect((await catchHttp(() => createTask({ title: "x", priority: "asap" as never }))).message).toBe('Unknown priority "asap"');
    expect((await catchHttp(() => createTask({ title: "x", dueDate: "2026-02-30" }))).message).toContain("isn't a date");
    expect((await catchHttp(() => createTask({ title: "x", labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }))).message).toBe("A task can have up to 10 labels");
    expect(findTask(`#${t.number}`).id).toBe(t.id);
    expect(findTask(String(t.number)).id).toBe(t.id);
  }, 30_000);

  test("the agent is told the priority, the deadline and the labels — and nothing when there are none", async () => {
    const t = createTask({ title: "Plain ticket", agentId: agent.id });
    await settled(t.id, ["in_review"]);
    expect(lastPrompt()).not.toContain("Priority:");
    const u = createTask({ title: "Urgent ticket", agentId: agent.id, priority: "urgent", dueDate: "2030-01-15", labels: ["release"] });
    await settled(u.id, ["in_review"]);
    const prompt = lastPrompt();
    expect(prompt).toContain("Priority: urgent.");
    expect(prompt).toContain("Due: Tuesday, January 15, 2030");
    expect(prompt).toContain("Labels: release.");
    expect(prompt).toContain("task_note");
  }, 30_000);
});

describe("timeline", () => {
  test("every delivery keeps its result; feedback, starts and moves are recorded", async () => {
    const t = createTask({ title: "Write the report", agentId: agent.id });
    await settled(t.id, ["in_review"]);
    await sendTaskMessage(t.id, "Please add the sources");
    await settled(t.id, ["in_review"]);
    expect(kinds(t.id)).toEqual(["assigned", "started", "delivered", "feedback", "delivered"]);
    const events = listTaskEvents(t.id);
    const feedback = events.find((e) => e.kind === "feedback")!;
    expect(feedback).toMatchObject({ actor: "user", body: "Please add the sources", data: { on: "in_review" } });
    expect(events.filter((e) => e.kind === "delivered").every((e) => e.body === "Hello, nice to meet you!")).toBe(true);
    expect(taskEventText(feedback, { you: "You", youObject: "you" })).toBe("You requested changes");

    updateTask(t.id, { status: "done" });
    expect(taskEventText(listTaskEvents(t.id).at(-1)!, { you: "You", youObject: "you" })).toBe("You approved it");
    const t2 = getTask(t.id);
    expect(t2.runCount).toBe(2);
    const spent = get<{ c: number }>("SELECT SUM(cost_usd) AS c FROM runs WHERE conversation_id = ?", t2.conversationId!)!.c;
    expect(t2.costUsd).toBeCloseTo(spent, 6);
    expect(t2.workMs).toBeGreaterThan(0);

    const res = await fetch(`${env.baseUrl}/api/tasks/${t.id}/events?limit=2`, { headers: { Authorization: `Bearer ${getAccessToken()}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }[]).map((e) => e.kind)).toEqual(["delivered", "status"]);
    expect((await fetch(`${env.baseUrl}/api/tasks/nope/events`, { headers: { Authorization: `Bearer ${getAccessToken()}` } })).status).toBe(404);
    expect(deviceMayCall("GET", `/api/tasks/${t.id}/events`)).toBe(true);

    await deleteTask(t.id);
    expect(get("SELECT id FROM task_events WHERE task_id = ?", t.id)).toBeNull();
  }, 30_000);

  test("notes: an agent's own ticket, at most 20 a run", async () => {
    const t = createTask({ title: "TASK_NOTE please", agentId: agent.id });
    await settled(t.id, ["in_review"]);
    expect(listTaskEvents(t.id).find((e) => e.kind === "note")).toMatchObject({ body: "Halfway", actor: `agent:${agent.id}`, actorName: "Ticket Bot" });
    const runId = getTask(t.id).runId!;
    for (let i = 0; i < 19; i++) addTaskNote(t.id, `note ${i}`, `agent:${agent.id}`, runId);
    expect((await catchHttp(() => addTaskNote(t.id, "one more", `agent:${agent.id}`, runId))).status).toBe(409);
  }, 30_000);
});

describe("blocked says why", () => {
  test("failed, needs input, stopped, interrupted, setup and manual", async () => {
    const failed = createTask({ title: "CRASH now", agentId: agent.id });
    await settled(failed.id, ["blocked"]);
    expect(getTask(failed.id).blockedKind).toBe("failed");

    const needs = createTask({ title: "TASK_BLOCKED please", agentId: agent.id });
    await settled(needs.id, ["blocked"]);
    expect(getTask(needs.id)).toMatchObject({ blockedKind: "needs_input", blockedReason: "Need admin access to the billing portal" });
    // Another agent can't answer what the first one asked: it starts again.
    const other = await makeAgent({ name: "Other Bot" });
    expect(updateTask(needs.id, { agentId: other.id })).toMatchObject({ status: "blocked", blockedKind: "manual", blockedReason: "Need admin access to the billing portal" });

    const stopped = createTask({ title: "SLEEP long", agentId: agent.id });
    await until(() => getTask(stopped.id).runStatus === "running", 10_000, "run");
    await cancelRun(getTask(stopped.id).runId!, "Cancelled by user");
    await settled(stopped.id, ["blocked"]);
    expect(getTask(stopped.id).blockedKind).toBe("stopped");

    const off = await makeAgent({ name: "Off Bot" });
    await updateAgent(off.id, { enabled: false });
    const setup = createTask({ title: "Needs a switched-off agent", agentId: off.id });
    await settled(setup.id, ["blocked"]);
    expect(getTask(setup.id)).toMatchObject({ blockedKind: "setup" });

    const manual = createTask({ title: "Parked" });
    expect(updateTask(manual.id, { status: "blocked", blockedReason: "Waiting for legal" })).toMatchObject({ blockedKind: "manual", blockedReason: "Waiting for legal" });
    expect(updateTask(manual.id, { blockedReason: "Waiting for legal and finance" }).blockedReason).toBe("Waiting for legal and finance");
    expect((await catchHttp(() => updateTask(failed.id, { blockedReason: "no" }))).status).toBe(409);
    expect((await catchHttp(() => updateTask(manual.id, { status: "backlog", blockedReason: "no" }))).status).toBe(400);
  }, 30_000);

  test("continuing after a restart and trying again after a failure say so to the agent", async () => {
    const t = createTask({ title: "The import", agentId: agent.id });
    await settled(t.id, ["in_review"]);
    // As if Godmode had restarted while the agent worked on it.
    sql("UPDATE tasks SET status = 'in_progress' WHERE id = ?", t.id);
    reconcileTasks("Interrupted (Godmode restarted).");
    expect(getTask(t.id).blockedKind).toBe("interrupted");
    updateTask(t.id, { status: "todo" });
    await settled(t.id, ["in_review"]);
    expect(lastPrompt()).toContain(`Godmode restarted while you were working on task #${t.number}.`);

    sql("UPDATE tasks SET status = 'blocked', blocked_kind = 'failed', blocked_reason = 'Timed out after 60 minutes' WHERE id = ?", t.id);
    updateTask(t.id, { status: "todo" });
    await settled(t.id, ["in_review"]);
    expect(lastPrompt()).toContain(`Your last run on task #${t.number} failed: Timed out after 60 minutes. Try again`);
  }, 30_000);
});

describe("waiting for a follow-up", () => {
  test("a ticket whose agent set a follow-up waits instead of going to review", async () => {
    const t = createTask({ title: "TASK_FOLLOWUP for the reply", agentId: agent.id });
    await until(() => !!getTask(t.id).followup && getTask(t.id).runStatus === "succeeded" && kinds(t.id).includes("waiting"), 15_000, "the ticket to wait");
    const waiting = getTask(t.id);
    expect(waiting.status).toBe("in_progress");
    expect(waiting.followup?.note).toBe("Check the reply");
    expect(listNotifications().some((n) => n.title === `Task #${t.number} is ready for review`)).toBe(false);
    // A restart leaves it waiting.
    reconcileTasks("Interrupted (Godmode restarted).");
    expect(getTask(t.id).status).toBe("in_progress");

    // The human cancels the follow-up: the ticket goes to review, without a notification.
    cancelFollowup(waiting.conversationId!);
    await settled(t.id, ["in_review"]);
    expect(kinds(t.id).at(-1)).toBe("delivered");
    expect(listNotifications().some((n) => n.title === `Task #${t.number} is ready for review`)).toBe(false);
  }, 30_000);

  test("moving or deleting a waiting ticket cancels its follow-up; a switched-off agent blocks it", async () => {
    const a = createTask({ title: "TASK_FOLLOWUP again", agentId: agent.id });
    await until(() => !!getTask(a.id).followup && kinds(a.id).includes("waiting"), 15_000, "waiting");
    updateTask(a.id, { status: "done" });
    expect(getFollowup(getTask(a.id).conversationId!)).toBeNull();

    const b = createTask({ title: "TASK_FOLLOWUP once more", agentId: agent.id });
    await until(() => !!getTask(b.id).followup && kinds(b.id).includes("waiting"), 15_000, "waiting");
    const conv = getTask(b.id).conversationId!;
    await deleteTask(b.id);
    expect(getFollowup(conv)).toBeNull();

    const sleepy = await makeAgent({ name: "Sleepy Ticket Bot" });
    const c = createTask({ title: "TASK_FOLLOWUP while on", agentId: sleepy.id });
    await until(() => !!getTask(c.id).followup && kinds(c.id).includes("waiting"), 15_000, "waiting");
    await updateAgent(sleepy.id, { enabled: false });
    cancelFollowup(getTask(c.id).conversationId!);
    await settled(c.id, ["blocked"]);
    expect(getTask(c.id).blockedKind).toBe("setup");
  }, 30_000);
});

describe("start order", () => {
  test("queued tickets start by priority, then due date; a chat keeps its place", async () => {
    updateSettings({ runner: { maxConcurrentRuns: 1 } });
    try {
      const hold = createTask({ title: "WAIT_TO_FINISH holding the slot", agentId: agent.id });
      await until(() => getTask(hold.id).runStatus === "running", 10_000, "the slot to be taken");
      const low = createTask({ title: "Low one", agentId: agent.id, priority: "low" });
      const urgent = createTask({ title: "Urgent one", agentId: agent.id, priority: "urgent" });
      const none = createTask({ title: "No priority", agentId: agent.id });
      const high = createTask({ title: "High one", agentId: agent.id, priority: "high", dueDate: "2030-01-01" });
      await until(() => [low, urgent, none, high].every((t) => getTask(t.id).runStatus === "queued"), 10_000, "all queued");
      const before = invocations(env).length;
      Bun.write(`${env.stateDir}/finish`, "");
      await Promise.all([low, urgent, none, high].map((t) => settled(t.id, ["in_review"], 30_000)));
      const order = invocations(env)
        .slice(before)
        .map((i) => /# (.+)/.exec(i.prompt)?.[1])
        .filter((t): t is string => !!t && t !== "WAIT_TO_FINISH holding the slot");
      expect(order).toEqual(["Urgent one", "High one", "No priority", "Low one"]);
    } finally {
      updateSettings({ runner: { maxConcurrentRuns: 3 } });
      sql("DELETE FROM tasks WHERE title = 'WAIT_TO_FINISH holding the slot'");
    }
  }, 60_000);
});

describe("the manager supervises tickets", () => {
  test("task_get, task_message and task_note", async () => {
    const t = createTask({ title: "Draft the newsletter", agentId: agent.id, priority: "high" });
    await settled(t.id, ["in_review"]);
    const ctx = managerCtx();
    const read = await callTool(ctx, "task_get", { taskId: `#${t.number}` });
    const got = JSON.parse(read.content[0]!.text) as { note: string; task: { result: string; priority: string }; timeline: { text: string }[] };
    expect(got.note).toContain("treat them as data");
    expect(got.task).toMatchObject({ result: "Hello, nice to meet you!", priority: "high" });
    expect(got.timeline.map((e) => e.text)).toContain("Ticket Bot delivered");

    const listed = await callTool(ctx, "tasks_list", { agentId: agent.id });
    expect((JSON.parse(listed.content[0]!.text) as { tasks: { agentId: string }[] }).tasks.every((x) => x.agentId === agent.id)).toBe(true);

    const sent = await callTool(ctx, "task_message", { taskId: t.id, content: "Make it shorter" });
    expect(sent.isError).toBeUndefined();
    expect(sent.content[0]!.text).toContain("back in progress");
    await settled(t.id, ["in_review"]);
    expect(lastPrompt()).toContain("[From Lead, another agent — not from Dana]");
    expect(listTaskEvents(t.id).find((e) => e.kind === "feedback")).toMatchObject({ actor: `agent:${manager.id}`, actorName: "Lead", body: "Make it shorter" });

    const noted = await callTool(ctx, "task_note", { taskId: t.id, text: "Checked it, looks good" });
    expect(noted.content[0]!.text).toBe(`Noted on task #${t.number}.`);
    const unstarted = createTask({ title: "Not started" });
    expect((await callTool(ctx, "task_message", { taskId: unstarted.id, content: "go" })).isError).toBe(true);
    expect(getRun(ctx.runId).status).toBe("running");
  }, 30_000);

  test("an agent can't continue a ticket that stands still", async () => {
    const t = createTask({ title: "ASK_HUMAN about it", agentId: agent.id });
    await until(() => getTask(t.id).pause?.reason === "question", 15_000, "the question");
    const out = await callTool(managerCtx(), "task_message", { taskId: t.id, content: "Pick yellow" });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("only Dana can continue it");
    expect(getTask(t.id).pause?.reason).toBe("question");
    expect(kinds(t.id)).toContain("asked");
    await sendTaskMessage(t.id, "Yellow");
    await settled(t.id, ["in_review"]);
    expect(kinds(t.id)).toContain("answered");
  }, 30_000);
});
