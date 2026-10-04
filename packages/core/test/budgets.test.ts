import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { all, get, getDb, insert, run as sql } from "../src/db";
import { SPEND_BACKFILL_SQL } from "../src/db/migrations";
import { getAccessToken } from "../src/server/auth";
import { deviceMayCall } from "../src/mobile/scope";
import { ensureDefaultAgent, getAgent, updateAgent } from "../src/agents/service";
import { getRun, waitForRun } from "../src/runner/runner";
import { getConversation, startChat } from "../src/services/conversations";
import { createRoutine, runRoutineNow } from "../src/services/routines";
import { continueAgent, continueConversation, startPauses, stopPauses } from "../src/services/pauses";
import { listNotifications } from "../src/services/notifications";
import { updateSettings } from "../src/services/settings";
import { budgetOverview, checkThresholds, exhaustedBudget, monthStart, startBudgets, stopBudgets } from "../src/services/budgets";
import { periodStart, spendReport } from "../src/services/spend";
import { callTool } from "../src/mcp/tools";
import { newId, now } from "../src/util";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-budgets-");
  await ensureDefaultAgent();
  agent = await makeAgent({ name: "Spender" });
  updateSettings({ general: { userName: "Dana" } });
  startPauses();
  startBudgets();
});

afterAll(async () => {
  stopBudgets();
  stopPauses();
  await env.close();
});

beforeEach(() => {
  sql("DELETE FROM spend");
  updateSettings({ runner: { monthlyBudgetUsd: null } });
});

const api = (method: string, path: string, body?: unknown) =>
  fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Spend booked this month by hand (a run elsewhere). */
function spent(costUsd: number, agentId = agent.id, at = new Date()) {
  insert("spend", { run_id: newId("run"), agent_id: agentId, agent_name: "Someone", trigger: "chat", at: at.toISOString(), cost_usd: costUsd, duration_ms: 60_000, failed: 0 });
}

describe("what the team spent", () => {
  test("each run's cost is booked when it ends, per agent and kind of work", async () => {
    const chat = await startChat({ agentId: agent.id, content: "Say hello" });
    await waitForRun(chat.run.id, 20_000);
    const rows = all<{ run_id: string; cost_usd: number; trigger: string }>("SELECT run_id, cost_usd, trigger FROM spend");
    expect(rows).toEqual([{ run_id: chat.run.id, cost_usd: 0.00896, trigger: "chat" }]);
    const report = spendReport("month");
    expect(report.periods.today).toMatchObject({ runs: 1, costUsd: 0.00896 });
    expect(report.periods.all.costUsd).toBe(0.00896);
    expect(report.byAgent).toEqual([expect.objectContaining({ agentId: agent.id, name: "Spender", deleted: false, runs: 1 })]);
    expect(report.byKind).toEqual([expect.objectContaining({ kind: "chat", runs: 1 })]);
    const res = await api("GET", "/api/spend?period=week");
    expect(res.status).toBe(200);
    expect((await api("GET", "/api/spend?period=year")).status).toBe(400);
    expect(deviceMayCall("GET", "/api/spend")).toBe(false);
    expect(deviceMayCall("GET", "/api/budgets")).toBe(false);
  }, 30_000);

  test("periods start at midnight, on Monday and on the 1st", () => {
    const wed = new Date(2026, 9, 7, 15, 30);
    expect(periodStart("today", wed)).toEqual(new Date(2026, 9, 7));
    expect(periodStart("week", wed)).toEqual(new Date(2026, 9, 5));
    expect(periodStart("month", wed)).toEqual(new Date(2026, 9, 1));
    expect(periodStart("all", wed)).toBeNull();
  });

  test("old runs that stored their session's total count only what they added", () => {
    const conv = newId("cnv");
    insert("conversations", { id: conv, agent_id: agent.id, title: "Old", origin: "chat", created_at: now(), updated_at: now() });
    for (const [i, cost] of [0.5, 0.8, 1.0].entries()) {
      insert("runs", { id: newId("run"), agent_id: agent.id, conversation_id: conv, trigger: "chat", status: "succeeded", prompt: "x", cost_usd: cost, duration_ms: 1000, created_at: `2000-01-0${i + 1}T00:00:00.000Z`, finished_at: `2000-01-0${i + 1}T00:01:00.000Z` });
    }
    getDb().run(SPEND_BACKFILL_SQL);
    getDb().run(SPEND_BACKFILL_SQL);
    expect(get<{ c: number; n: number }>("SELECT ROUND(SUM(cost_usd), 6) AS c, COUNT(*) AS n FROM spend WHERE at < '2001'")).toEqual({ c: 1, n: 3 });
  });
});

describe("monthly budgets", () => {
  test("80% and 100% are told once each per month and amount", () => {
    updateSettings({ runner: { monthlyBudgetUsd: 10 } });
    const before = listNotifications().length;
    spent(8.5);
    checkThresholds(agent.id);
    checkThresholds(agent.id);
    spent(2);
    checkThresholds(agent.id);
    const told = listNotifications().slice(0, listNotifications().length - before).map((n) => n.title);
    expect(told.filter((t) => t.startsWith("Your team has used 85%"))).toHaveLength(1);
    expect(told.filter((t) => t.startsWith("The team's") && t.endsWith("budget is used up"))).toHaveLength(1);
    expect(budgetOverview().team).toMatchObject({ budgetUsd: 10, state: "exhausted" });
  });

  test("used up: automations wait as held runs, chats still run with a notice, a raise lets them go on", async () => {
    updateSettings({ runner: { monthlyBudgetUsd: 5 } });
    spent(6);
    expect(exhaustedBudget(agent)).toMatchObject({ scope: "team", budgetUsd: 5 });

    const routine = createRoutine({ agentId: agent.id, name: "Nightly", cron: "0 3 * * *", prompt: "Say hello" });
    // Started the way the schedule starts it (not the human's Run now).
    const { triggerRoutine } = await import("../src/scheduler/scheduler");
    const held = await triggerRoutine(routine.id, { scheduled: true });
    await until(() => getRun(held.id).status === "paused", 10_000, "the automation run to be held");
    const conv = getConversation(held.conversationId);
    expect(conv.paused).toMatchObject({ reason: "budget", auto: true, budget: { scope: "team", limitUsd: 5 } });
    expect(new Date(conv.paused!.resumeAt!).getTime()).toBeGreaterThan(monthStart().getTime());
    expect(getAgent(agent.id)).toMatchObject({ heldRuns: 1, pausedRuns: 0 });
    // The agent's Continue doesn't let it through.
    expect(continueAgent(agent.id)).toBe(0);

    const chat = await startChat({ agentId: agent.id, content: "Say hello" });
    await waitForRun(chat.run.id, 20_000);
    const answer = getConversation(chat.conversation.id).messages.findLast((m) => m.role === "assistant")!;
    expect(answer.blocks.some((b) => b.type === "notice" && b.text.includes("This still runs because you started it"))).toBe(true);
    expect(getRun(chat.run.id).status).toBe("succeeded");

    // The human raises the budget: the held run continues by itself.
    updateSettings({ runner: { monthlyBudgetUsd: 50 } });
    await until(() => getRun(held.id).status === "succeeded", 15_000, "the held run to continue");
    expect(getAgent(agent.id).heldRuns).toBe(0);
  }, 60_000);

  test("the human lets held work run, and Run now isn't held", async () => {
    const own = await makeAgent({ name: "Capped", permissions: { monthlyBudgetUsd: 1 } });
    spent(2, own.id);
    expect(exhaustedBudget(getAgent(own.id))).toMatchObject({ scope: "agent", budgetUsd: 1 });
    const routine = createRoutine({ agentId: own.id, name: "Daily", cron: "0 9 * * *", prompt: "Say hello" });
    const { triggerRoutine } = await import("../src/scheduler/scheduler");
    const held = await triggerRoutine(routine.id, { scheduled: true });
    await until(() => getRun(held.id).status === "paused", 10_000, "held");
    const res = await api("POST", "/api/budgets/release", { scope: "agent", agentId: own.id });
    expect(await res.json()).toEqual({ continued: 1 });
    await until(() => getRun(held.id).status === "succeeded", 15_000, "let through");
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'budget.release'")!.n).toBe(1);
    expect((await api("POST", "/api/budgets/release", { scope: "agent", agentId: own.id })).status).toBe(409);

    const now = await runRoutineNow(routine.id, { byHuman: true });
    await waitForRun(now.id, 20_000);
    expect(getRun(now.id).status).toBe("succeeded");

    // Let it run from the chat's pause bar.
    const again = await triggerRoutine(routine.id, { scheduled: true });
    await until(() => getRun(again.id).status === "paused", 10_000, "held again");
    continueConversation(again.conversationId);
    await until(() => getRun(again.id).status === "succeeded", 15_000, "continued by the human");
  }, 60_000);

  test("only the human sets an agent's monthly budget", async () => {
    const godmode = await ensureDefaultAgent();
    const updated = await updateAgent(agent.id, { permissions: { monthlyBudgetUsd: 25 } });
    expect(updated.permissions.monthlyBudgetUsd).toBe(25);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'budget.set' AND target = ?", agent.id)!.n).toBe(1);
    const byAgent = await updateAgent(agent.id, { permissions: { monthlyBudgetUsd: 1000 } }, `agent:${godmode.id}`);
    expect(byAgent.permissions.monthlyBudgetUsd).toBe(25);
    expect((await api("PUT", "/api/settings", { runner: { monthlyBudgetUsd: -3 } })).status).toBe(400);
  });

  test("unattended work can't hand work to an agent whose budget is used up; a chat can", async () => {
    const helper = await makeAgent({ name: "Busy helper", permissions: { monthlyBudgetUsd: 1 } });
    spent(5, helper.id);
    const caller = await makeAgent({ name: "Caller" });
    const ctx = (trigger: string) => {
      const conv = newId("cnv");
      insert("conversations", { id: conv, agent_id: caller.id, title: "x", origin: "chat", created_at: now(), updated_at: now() });
      const runId = newId("run");
      insert("runs", { id: runId, agent_id: caller.id, conversation_id: conv, trigger, status: "running", prompt: "x", created_at: now() });
      return { runId, agentId: caller.id, conversationId: conv, workspaceId: null, depth: 0 };
    };
    const refused = await callTool(ctx("routine"), "agent_delegate", { agentId: helper.id, task: "Say hello", wait: false });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("budget is used up");
    const allowed = await callTool(ctx("chat"), "agent_delegate", { agentId: helper.id, task: "Say hello", wait: false });
    expect(allowed.isError).toBeUndefined();
    const child = /run (run_[A-Za-z0-9]+)/.exec(allowed.content[0]!.text)![1]!;
    await waitForRun(child, 20_000);
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);
});
