import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, MessageBlock, Run, RunTrigger } from "@godmode/shared";
import { RUN_INTERRUPTED, RUN_SHUT_DOWN, RUN_STOPPED_BY_USER } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { all, get, insert, run as sql, setMeta } from "../src/db";
import { ensureDefaultAgent } from "../src/agents/service";
import { callTool } from "../src/mcp/tools";
import { getRun, listRuns, waitForRun } from "../src/runner/runner";
import { brokeOffOffline, brokeOffOnError, continueAfterOutage, continueCutOffRun, interruptedWork, latestContinuation, leaveInterruptedWork, offlineRetryAt, resumeInterruptedWork } from "../src/services/resume";
import { createRoutine } from "../src/services/routines";
import { updateSettings } from "../src/services/settings";
import { createTask } from "../src/tasks/service";
import { newId, now } from "../src/util";

let env: TestEnv;
let agent: Agent;
let helper: Agent;
let godmode: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-resume-");
  agent = await makeAgent({ name: "Worker" });
  helper = await makeAgent({ name: "Helper" });
  godmode = await ensureDefaultAgent();
});

afterAll(async () => {
  await env.close();
});

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
let clock = Date.now() - HOUR;
const tick = () => new Date((clock += 1000)).toISOString();

beforeEach(() => {
  updateSettings({ runner: { resumeAfterRestart: true } });
  // Everything earlier was looked at by an earlier start.
  setMeta("runs.resumeCheckedAt", ago(10 * 60_000));
});

/** A chat whose Claude session exists (the fake Claude refuses to resume an unknown one). */
function chat(owner: Agent, origin = "chat", session = true): string {
  const id = newId("cnv");
  const sessionId = session ? crypto.randomUUID() : null;
  if (sessionId) {
    mkdirSync(join(env.stateDir, "sessions"), { recursive: true });
    writeFileSync(join(env.stateDir, "sessions", sessionId), "");
  }
  insert("conversations", { id, agent_id: owner.id, title: "Work", origin, claude_session_id: sessionId, created_at: now(), updated_at: now() });
  return id;
}

function cutOff(
  owner: Agent,
  conversationId: string,
  opts: { trigger?: RunTrigger; status?: Run["status"]; error?: string; finishedAt?: string; parent?: string; routineId?: string; prompt?: string; blocks?: MessageBlock[] } = {},
): string {
  const id = newId("run");
  const at = tick();
  insert("runs", {
    id,
    agent_id: owner.id,
    conversation_id: conversationId,
    trigger: opts.trigger ?? "chat",
    status: opts.status ?? "cancelled",
    error: opts.error ?? RUN_SHUT_DOWN,
    prompt: opts.prompt ?? "Write the report",
    parent_run_id: opts.parent ?? null,
    routine_id: opts.routineId ?? null,
    created_at: at,
    started_at: at,
    finished_at: opts.finishedAt ?? now(),
  });
  insert("messages", { id: newId("msg"), conversation_id: conversationId, role: "user", content: opts.prompt ?? "Write the report", run_id: id, created_at: at });
  const blocks = opts.blocks ?? [{ type: "text", text: "Halfway there" }];
  if (blocks.length) insert("messages", { id: newId("msg"), conversation_id: conversationId, role: "assistant", blocks: JSON.stringify(blocks), run_id: id, created_at: at });
  return id;
}

function marker(runId: string): Extract<MessageBlock, { type: "retry" }> | undefined {
  const row = get<{ blocks: string }>("SELECT blocks FROM messages WHERE run_id = ? AND role = 'system'", runId);
  return row ? (JSON.parse(row.blocks) as MessageBlock[]).find((b) => b.type === "retry") as Extract<MessageBlock, { type: "retry" }> : undefined;
}

function next(conversationId: string, after: string): Run | undefined {
  return listRuns({ conversationId }).find((r) => r.id !== after && r.createdAt > getRun(after).createdAt);
}

async function resumeNow(): Promise<string[]> {
  const work = interruptedWork();
  await resumeInterruptedWork(work);
  return work.runs.map((r) => r.id);
}

function ctxOf(owner: Agent) {
  const conv = chat(owner);
  const runId = newId("run");
  insert("runs", { id: runId, agent_id: owner.id, conversation_id: conv, trigger: "chat", status: "running", prompt: "x", created_at: now() });
  return { runId, agentId: owner.id, conversationId: conv, workspaceId: owner.workspaceId, depth: 0 };
}

describe("continuing after a restart", () => {
  test("a chat cut off by the shutdown continues in its session, once", async () => {
    const conv = chat(agent);
    const cut = cutOff(agent, conv);
    expect(await resumeNow()).toContain(cut);

    const run = next(conv, cut)!;
    expect(run).toMatchObject({ trigger: "chat", agentId: agent.id });
    expect(run.prompt).toContain("<godmode-continue>");
    expect(run.prompt).toContain("Godmode restarted on");
    expect(marker(run.id)).toMatchObject({ type: "retry", mode: "continue", runId: cut, auto: true });
    expect(get<{ content: string }>("SELECT content FROM messages WHERE run_id = ? AND role = 'system'", run.id)?.content).toBe("Continued after Godmode restarted");
    expect(latestContinuation(cut)).toBe(run.id);
    await waitForRun(run.id, 10_000);

    // The next start looks only at what was cut off after this one.
    expect(interruptedWork().runs.map((r) => r.id)).not.toContain(cut);
  }, 20_000);

  test("a crash's interrupted run counts too; a turn that never got going gets its prompt again", async () => {
    const conv = chat(agent);
    const cut = cutOff(agent, conv, { status: "failed", error: RUN_INTERRUPTED, blocks: [], prompt: "Send the weekly numbers" });
    await resumeNow();
    const run = next(conv, cut)!;
    expect(marker(run.id)).toMatchObject({ mode: "again", auto: true });
    expect(run.prompt).toContain("before you got this turn");
    expect(run.prompt).toEndWith("Send the weekly numbers");
    await waitForRun(run.id, 10_000);
  }, 20_000);

  test("a chat the human archived continues like any other", async () => {
    const conv = chat(agent);
    sql("UPDATE conversations SET archived = 1 WHERE id = ?", conv);
    const cut = cutOff(agent, conv);
    expect(await resumeNow()).toContain(cut);
    const run = next(conv, cut)!;
    expect(marker(run.id)).toMatchObject({ mode: "continue", runId: cut, auto: true });
    expect((await waitForRun(run.id, 10_000)).status).toBe("succeeded");
  }, 20_000);

  test("leaves alone what the human stopped, what is older than the last look, what moved on and tickets", async () => {
    const stopped = cutOff(agent, chat(agent), { error: RUN_STOPPED_BY_USER });
    const old = cutOff(agent, chat(agent), { finishedAt: ago(HOUR) });
    const movedOn = chat(agent);
    const superseded = cutOff(agent, movedOn);
    cutOff(agent, movedOn, { status: "succeeded", error: "" });
    const dream = cutOff(agent, chat(agent), { trigger: "dream" });
    const check = cutOff(agent, chat(agent), { trigger: "check" });
    const ticketConv = chat(agent, "task");
    const task = createTask({ title: "Ticket" });
    sql("UPDATE tasks SET conversation_id = ? WHERE id = ?", ticketConv, task.id);
    const ticket = cutOff(agent, ticketConv, { trigger: "task" });
    const ticketChat = cutOff(agent, chat(agent, "task"));
    sql("UPDATE tasks SET conversation_id = ? WHERE id = ?", getRun(ticketChat).conversationId, createTask({ title: "Other ticket" }).id);
    const ids = interruptedWork().runs.map((r) => r.id);
    for (const id of [stopped, old, superseded, dream, check, ticket, ticketChat]) expect(ids).not.toContain(id);
  });

  test("the first start looks back a few minutes; nothing older than a day continues by itself", async () => {
    sql("DELETE FROM meta WHERE key = 'runs.resumeCheckedAt'");
    const recent = cutOff(agent, chat(agent), { finishedAt: ago(5 * 60_000) });
    const earlier = cutOff(agent, chat(agent), { finishedAt: ago(30 * 60_000) });
    let ids = interruptedWork().runs.map((r) => r.id);
    expect(ids).toContain(recent);
    expect(ids).not.toContain(earlier);

    setMeta("runs.resumeCheckedAt", ago(3 * 24 * HOUR));
    const yesterday = cutOff(agent, chat(agent), { finishedAt: ago(2 * 24 * HOUR) });
    ids = interruptedWork().runs.map((r) => r.id);
    expect(ids).toContain(recent);
    expect(ids).not.toContain(yesterday);
  });

  test("turned off: nothing continues, and turning it on later doesn't bring old work back", async () => {
    updateSettings({ runner: { resumeAfterRestart: false } });
    const conv = chat(agent);
    const cut = cutOff(agent, conv);
    expect(await resumeNow()).toEqual([]);
    expect(next(conv, cut)).toBeUndefined();
    updateSettings({ runner: { resumeAfterRestart: true } });
    expect(interruptedWork().runs.map((r) => r.id)).not.toContain(cut);
  });

  test("handed-over work continues after the run that handed it over, which is told where to wait", async () => {
    const parentConv = chat(agent);
    const parent = cutOff(agent, parentConv);
    const childConv = chat(helper, "delegation");
    const child = cutOff(helper, childConv, { trigger: "delegation", parent, prompt: "[Delegated by Worker]\n\nFind three suppliers" });
    await resumeNow();

    const parentRun = next(parentConv, parent)!;
    const childRun = next(childConv, child)!;
    expect(childRun).toMatchObject({ trigger: "delegation", parentRunId: parentRun.id });
    expect(parentRun.prompt).toContain(`delegation_status({ runId: "${childRun.id}", wait: true })`);
    expect(parentRun.prompt).toContain("Helper");
    expect(childRun.prompt).toContain("Your answer goes back to the agent that handed you the task");

    // The old run id leads to the turn that has the answer.
    const status = await callTool({ runId: parentRun.id, agentId: agent.id, conversationId: parentConv, workspaceId: null, depth: 0 }, "delegation_status", {
      runId: child,
      wait: true,
      timeoutSeconds: 10,
    });
    expect(status.content[0]!.text).toContain(childRun.id);
    expect(status.content[0]!.text).toContain("finished the task");
    await waitForRun(parentRun.id, 10_000);
  }, 30_000);

  test("handed-over work goes on only when the run that handed it over does, or had already finished", async () => {
    // The ticket's run is the board's to pick up again: what it handed over would be handed over twice.
    const ticketConv = chat(agent, "task");
    sql("UPDATE tasks SET conversation_id = ? WHERE id = ?", ticketConv, createTask({ title: "Find suppliers" }).id);
    const ticketRun = cutOff(agent, ticketConv, { trigger: "task" });
    const orphanConv = chat(helper, "delegation");
    const orphan = cutOff(helper, orphanConv, { trigger: "delegation", parent: ticketRun });

    // Handed over without waiting: the run that did it had finished long before.
    const doneConv = chat(agent);
    const done = cutOff(agent, doneConv, { status: "succeeded", error: "" });
    const backgroundConv = chat(helper, "delegation");
    const background = cutOff(helper, backgroundConv, { trigger: "delegation", parent: done });

    await resumeNow();
    expect(next(orphanConv, orphan)).toBeUndefined();
    const run = next(backgroundConv, background)!;
    expect(run).toMatchObject({ trigger: "delegation", parentRunId: done });
    await waitForRun(run.id, 10_000);
  }, 20_000);

  test("an automation that already runs again isn't continued a second time", async () => {
    const routine = createRoutine({ agentId: agent.id, name: "Inbox triage", cron: "0 * * * *", prompt: "Triage the inbox" });
    const conv = chat(agent, "routine");
    const cut = cutOff(agent, conv, { trigger: "routine", routineId: routine.id });
    insert("runs", { id: newId("run"), agent_id: agent.id, conversation_id: chat(agent, "routine"), trigger: "routine", routine_id: routine.id, status: "queued", prompt: "x", created_at: now() });
    await resumeNow();
    expect(next(conv, cut)).toBeUndefined();
    sql("UPDATE runs SET status = 'cancelled' WHERE routine_id = ? AND status = 'queued'", routine.id);
  });

  test("a restored backup's interrupted runs stay for the human", () => {
    const cut = cutOff(agent, chat(agent), { status: "failed", error: RUN_INTERRUPTED });
    leaveInterruptedWork();
    expect(interruptedWork().runs.map((r) => r.id)).not.toContain(cut);
  });

  test("an automation's turn keeps its automation", async () => {
    const routine = createRoutine({ agentId: agent.id, name: "Morning report", cron: "0 8 * * *", prompt: "Write the morning report" });
    const conv = chat(agent, "routine");
    const cut = cutOff(agent, conv, { trigger: "routine", routineId: routine.id });
    await resumeNow();
    const run = next(conv, cut)!;
    expect(run).toMatchObject({ trigger: "routine", routineId: routine.id });
    const events = all<{ title: string; run_id: string }>("SELECT title, run_id FROM automation_events WHERE routine_id = ?", routine.id);
    expect(events).toContainEqual({ title: "Continued after Godmode restarted", run_id: run.id });
    await waitForRun(run.id, 10_000);
  }, 20_000);

  test("a turn continued three times in a row by itself is left for the human", async () => {
    const conv = chat(agent);
    let cut = cutOff(agent, conv);
    for (let i = 0; i < 3; i++) {
      expect(await resumeNow()).toContain(cut);
      const run = await waitForRun(next(conv, cut)!.id, 10_000);
      // The next restart cuts the continued turn off again.
      sql("UPDATE runs SET status = 'cancelled', error = ?, finished_at = ? WHERE id = ?", RUN_SHUT_DOWN, now(), run.id);
      setMeta("runs.resumeCheckedAt", ago(60_000));
      cut = run.id;
    }
    expect(await resumeNow()).not.toContain(cut);
    expect(next(conv, cut)).toBeUndefined();
  }, 60_000);

  test("run_continue picks up older work for a manager, and refuses what wasn't cut off", async () => {
    const conv = chat(agent);
    const cut = cutOff(agent, conv, { finishedAt: ago(3 * 24 * HOUR) });
    expect(interruptedWork().runs.map((r) => r.id)).not.toContain(cut);

    const res = await callTool(ctxOf(godmode), "run_continue", { runId: cut });
    expect(res.isError).toBeFalsy();
    const run = next(conv, cut)!;
    expect(res.content[0]!.text).toContain(run.id);
    expect(marker(run.id)).toMatchObject({ auto: true, runId: cut });
    await waitForRun(run.id, 10_000);

    const done = cutOff(agent, chat(agent), { status: "failed", error: "Timed out after 60 minutes" });
    await expect(continueCutOffRun(done)).rejects.toThrow("wasn't cut off by a restart");
    const again = await callTool(ctxOf(godmode), "run_continue", { runId: cut });
    expect(again.isError).toBe(true);
  }, 20_000);
});

describe("continuing once Claude can be reached again", () => {
  const OFFLINE = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
  const online = async () => true;
  const offline = async () => false;

  test("knows Claude Code's answer for a missing connection from other failures", () => {
    expect(brokeOffOffline(OFFLINE)).toBe(true);
    expect(brokeOffOffline("API Error: Connection error.")).toBe(true);
    expect(brokeOffOffline("API Error: Connection dropped (ECONNRESET)")).toBe(true);
    expect(brokeOffOffline("API Error: socket hang up")).toBe(true);
    expect(brokeOffOffline("API Error: 400 invalid_request_error")).toBe(false);
    expect(brokeOffOffline("The site answered ENOTFOUND, so I stopped")).toBe(false);
    expect(brokeOffOffline(null)).toBe(false);
  });

  test("a turn that broke off offline waits for the connection, then continues in its session, once", async () => {
    const conv = chat(agent);
    const cut = cutOff(agent, conv, { status: "failed", error: OFFLINE });
    expect(await continueAfterOutage(offline)).toBe(0);
    expect(next(conv, cut)).toBeUndefined();

    expect(await continueAfterOutage(online)).toBe(1);
    const run = next(conv, cut)!;
    expect(run).toMatchObject({ trigger: "chat", agentId: agent.id });
    expect(run.prompt).toContain("Claude's API couldn't be reached");
    expect(marker(run.id)).toMatchObject({ type: "retry", mode: "continue", runId: cut, auto: true });
    expect(get<{ content: string }>("SELECT content FROM messages WHERE run_id = ? AND role = 'system'", run.id)?.content).toBe("Continued once Claude could be reached again");
    await waitForRun(run.id, 10_000);
    expect(await continueAfterOutage(online)).toBe(0);
  }, 20_000);

  test("an archived chat's turn continues too", async () => {
    const conv = chat(agent);
    sql("UPDATE conversations SET archived = 1 WHERE id = ?", conv);
    const cut = cutOff(agent, conv, { status: "failed", error: OFFLINE });
    expect(await continueAfterOutage(online)).toBe(1);
    expect((await waitForRun(next(conv, cut)!.id, 10_000)).status).toBe("succeeded");
  }, 20_000);

  test("a connection that drops again waits a little longer before each try, then gives up", async () => {
    const conv = chat(agent);
    let last = cutOff(agent, conv, { status: "failed", error: "API Error: Connection dropped (ECONNRESET)" });
    for (const waitMin of [2, 5, 15, 30]) {
      expect(await continueAfterOutage(online)).toBe(1);
      const run = next(conv, last)!;
      await waitForRun(run.id, 10_000);
      sql("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", "API Error: Connection dropped (ECONNRESET)", now(), run.id);
      last = run.id;
      expect(await continueAfterOutage(online)).toBe(0);
      expect(Date.parse(offlineRetryAt(last)!)).toBeGreaterThan(Date.now() + (waitMin - 1) * 60_000);
      sql("UPDATE runs SET finished_at = ? WHERE id = ?", ago(waitMin * 60_000 + 1000), last);
    }
    expect(await continueAfterOutage(online)).toBe(1);
    const fifth = next(conv, last)!;
    await waitForRun(fifth.id, 10_000);
    sql("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", OFFLINE, ago(HOUR), fifth.id);
    expect(offlineRetryAt(fifth.id)).toBeNull();
    expect(await continueAfterOutage(online)).toBe(0);
  }, 60_000);

  test("knows the errors Claude Code drops a turn with", () => {
    expect(brokeOffOnError("Claude Code exited without a result")).toBe(true);
    expect(brokeOffOnError("Claude Code exited with code 1")).toBe(true);
    expect(brokeOffOnError('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}')).toBe(true);
    expect(brokeOffOnError("API Error: 529 Overloaded")).toBe(true);
    expect(brokeOffOnError("Failed to authenticate. API Error: 403 Request not allowed")).toBe(true);
    expect(brokeOffOnError("Failed to authenticate. API Error: 401 Invalid bearer token")).toBe(false);
    expect(brokeOffOnError("API Error: 400 invalid_request_error")).toBe(false);
    expect(brokeOffOnError("Timed out after 60 minutes")).toBe(false);
    expect(brokeOffOnError(null)).toBe(false);
  });

  test("a turn Claude Code dropped goes on without waiting for the connection, three times at most", async () => {
    const conv = chat(agent);
    let last = cutOff(agent, conv, { status: "failed", error: "Claude Code exited without a result" });
    expect(offlineRetryAt(last)).not.toBeNull();
    for (const waitMin of [2, 5]) {
      expect(await continueAfterOutage(offline)).toBe(1);
      const run = next(conv, last)!;
      expect(run.prompt).toContain("Claude Code stopped with an error");
      expect(marker(run.id)).toMatchObject({ type: "retry", runId: last, auto: true, cause: "error" });
      await waitForRun(run.id, 10_000);
      sql("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", "Claude Code exited with code 1", now(), run.id);
      last = run.id;
      expect(await continueAfterOutage(offline)).toBe(0);
      sql("UPDATE runs SET finished_at = ? WHERE id = ?", ago(waitMin * 60_000 + 1000), last);
    }
    expect(await continueAfterOutage(offline)).toBe(1);
    const third = next(conv, last)!;
    await waitForRun(third.id, 10_000);
    sql("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", "Claude Code exited without a result", ago(HOUR), third.id);
    expect(offlineRetryAt(third.id)).toBeNull();
    expect(await continueAfterOutage(offline)).toBe(0);
  }, 40_000);

  test("a turn Claude's API refused with a 403 goes on after a pause, not right away, three times at most", async () => {
    const refused = "Failed to authenticate. API Error: 403 Request not allowed";
    const conv = chat(agent, "routine");
    let last = cutOff(agent, conv, { status: "failed", error: refused, trigger: "routine" });
    for (const waitMin of [2, 5, 15]) {
      expect(await continueAfterOutage(offline)).toBe(0);
      expect(Date.parse(offlineRetryAt(last)!)).toBeGreaterThan(Date.now() + (waitMin - 1) * 60_000);
      sql("UPDATE runs SET finished_at = ? WHERE id = ?", ago(waitMin * 60_000 + 1000), last);
      expect(await continueAfterOutage(offline)).toBe(1);
      const run = next(conv, last)!;
      expect(marker(run.id)).toMatchObject({ type: "retry", runId: last, auto: true, cause: "error" });
      await waitForRun(run.id, 10_000);
      sql("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", refused, now(), run.id);
      last = run.id;
    }
    expect(offlineRetryAt(last)).toBeNull();
    expect(await continueAfterOutage(offline)).toBe(0);
  }, 40_000);

  test("work handed over without waiting continues; work someone waited for is left to them", async () => {
    const parentChat = chat(agent);
    const parent = cutOff(agent, parentChat, { status: "succeeded", error: "", finishedAt: ago(60_000) });
    const handed = chat(helper);
    const cut = cutOff(helper, handed, { status: "failed", error: OFFLINE, trigger: "delegation", parent });
    const waited = cutOff(agent, chat(agent), { status: "failed", error: OFFLINE, finishedAt: now() });
    cutOff(helper, chat(helper), { status: "failed", error: OFFLINE, trigger: "delegation", parent: waited, finishedAt: ago(60_000) });
    sql("UPDATE runs SET status = 'succeeded', error = NULL WHERE id = ?", waited);
    expect(offlineRetryAt(cut)).not.toBeNull();
    expect(await continueAfterOutage(online)).toBe(1);
    const run = next(handed, cut)!;
    expect(run).toMatchObject({ trigger: "delegation", agentId: helper.id, parentRunId: parent });
    await waitForRun(run.id, 10_000);
  }, 20_000);

  test("leaves other failures, handed-over work, tickets, old turns and automations that came round again", async () => {
    cutOff(agent, chat(agent), { status: "failed", error: "API Error: 400 invalid_request_error" });
    cutOff(helper, chat(helper), { status: "failed", error: OFFLINE, trigger: "delegation" });
    cutOff(agent, chat(agent), { status: "failed", error: OFFLINE, finishedAt: ago(13 * HOUR) });
    const ticketChat = chat(agent, "task");
    sql("UPDATE tasks SET conversation_id = ? WHERE id = ?", ticketChat, createTask({ title: "Fix it" }).id);
    cutOff(agent, ticketChat, { status: "failed", error: OFFLINE });
    const routine = createRoutine({ agentId: agent.id, name: "Post the news", cron: "0 * * * *", prompt: "Post the news" });
    cutOff(agent, chat(agent, "routine"), { status: "failed", error: OFFLINE, trigger: "routine", routineId: routine.id });
    insert("runs", { id: newId("run"), agent_id: agent.id, conversation_id: chat(agent, "routine"), trigger: "routine", routine_id: routine.id, status: "succeeded", prompt: "x", created_at: tick() });
    updateSettings({ runner: { resumeAfterRestart: false } });
    const off = chat(agent);
    cutOff(agent, off, { status: "failed", error: OFFLINE });
    expect(await continueAfterOutage(online)).toBe(0);
    updateSettings({ runner: { resumeAfterRestart: true } });
    sql("UPDATE runs SET status = 'succeeded' WHERE conversation_id = ?", off);
    expect(await continueAfterOutage(online)).toBe(0);
  });
});
