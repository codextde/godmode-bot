import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { get, getDb, getMeta, insert, run as sql, setMeta } from "../src/db";
import { MIGRATIONS, REMOVE_COSTS_SQL } from "../src/db/migrations";
import { getSettings, resetSettingsCache } from "../src/services/settings";
import { pausedRun, startPauses, stopPauses } from "../src/services/pauses";
import { getRun, waitForRun } from "../src/runner/runner";
import { newId, now } from "../src/util";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-remove-costs-");
  agent = await makeAgent({ name: "Held Bot" });
});

afterAll(async () => {
  stopPauses();
  await env.close();
});

/** A run the removed budgets held before it started, stored the way they stored it. */
function heldRun(agentId: string): string {
  const conversationId = newId("cnv");
  insert("conversations", { id: conversationId, agent_id: agentId, title: "Nightly report", origin: "chat", created_at: now(), updated_at: now() });
  const runId = newId("run");
  insert("runs", { id: runId, agent_id: agentId, conversation_id: conversationId, trigger: "routine", status: "paused", prompt: "Say hello", created_at: now() });
  const messageId = newId("msg");
  const pause = { type: "pause", reason: "budget", at: now(), budget: { scope: "team", limitUsd: 5 } };
  insert("messages", { id: messageId, conversation_id: conversationId, role: "assistant", content: "", blocks: JSON.stringify([pause]), run_id: runId, attachments: "[]", created_at: now() });
  const nextMonth = new Date(Date.now() + 20 * 86_400_000).toISOString();
  insert("paused_runs", {
    run_id: runId,
    conversation_id: conversationId,
    agent_id: agentId,
    message_id: messageId,
    also_answers: "[]",
    reason: "budget",
    resume_at: nextMonth,
    auto: 1,
    delivered: 0,
    redo: "Say hello",
    retries: 0,
    depth: 0,
    voice: 0,
    budget_scope: "team",
    budget_usd: 5,
    exempt: 0,
    created_at: now(),
  });
  return runId;
}

describe("migration 108 removes costs", () => {
  test("embeds the SQL", () => {
    expect(MIGRATIONS.find((m) => m.name === "remove_costs")).toMatchObject({ id: 108, sql: REMOVE_COSTS_SQL });
  });

  test("strips the spend settings and the agents' budgets", () => {
    sql(
      "INSERT INTO settings (key, value) VALUES ('runner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify({ effort: "high", spendTracking: true, defaultMaxBudgetUsd: 2, monthlyBudgetUsd: 50 }),
    );
    sql("UPDATE agents SET permissions = json_set(permissions, '$.maxBudgetUsd', 5, '$.monthlyBudgetUsd', 20) WHERE id = ?", agent.id);
    setMeta(`budget.told.${agent.id}`, JSON.stringify({ month: "2026-10", budget: 20, level: 100 }));

    getDb().run(REMOVE_COSTS_SQL);
    resetSettingsCache();

    const runner = JSON.parse(get<{ value: string }>("SELECT value FROM settings WHERE key = 'runner'")!.value) as Record<string, unknown>;
    expect(runner).toEqual({ effort: "high" });
    expect(getSettings().runner.effort).toBe("high");
    expect("spendTracking" in getSettings().runner).toBe(false);
    const permissions = JSON.parse(get<{ permissions: string }>("SELECT permissions FROM agents WHERE id = ?", agent.id)!.permissions) as Record<string, unknown>;
    expect(permissions).not.toHaveProperty("maxBudgetUsd");
    expect(permissions).not.toHaveProperty("monthlyBudgetUsd");
    expect(permissions.allowDelegation).toBe(true);
    expect(getMeta(`budget.told.${agent.id}`)).toBeNull();
  });

  test("work a budget held continues by itself", async () => {
    const runId = heldRun(agent.id);
    getDb().run(REMOVE_COSTS_SQL);
    const row = pausedRun(runId)!;
    expect(row).toMatchObject({ reason: "user", auto: 1, budget_scope: null, budget_usd: null });
    expect(Date.parse(row.resume_at!)).toBeLessThanOrEqual(Date.now());

    startPauses();
    const finished = await waitForRun(runId, 20_000);
    expect(finished.status).toBe("succeeded");
    expect(finished.result).toBe("Hello, nice to meet you!");
    expect(pausedRun(runId)).toBeNull();
  });

  test("a switched-off agent's held work waits for the human instead", async () => {
    const off = await makeAgent({ name: "Off Bot" });
    sql("UPDATE agents SET enabled = 0 WHERE id = ?", off.id);
    const runId = heldRun(off.id);
    getDb().run(REMOVE_COSTS_SQL);
    expect(pausedRun(runId)).toMatchObject({ reason: "user", auto: 0 });
    expect(getRun(runId).status).toBe("paused");
  });
});
