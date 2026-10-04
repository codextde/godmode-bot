import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, AwaySummary } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { insert } from "../src/db";
import { getAccessToken } from "../src/server/auth";
import { deviceMayCall } from "../src/mobile/scope";
import { waitForRun } from "../src/runner/runner";
import { startChat } from "../src/services/conversations";
import { awaySummary } from "../src/services/away";
import { createRoutine } from "../src/services/routines";
import { createTask } from "../src/tasks/service";
import { newId, now } from "../src/util";

let env: TestEnv;
let mia: Agent;
let bo: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-away-");
  mia = await makeAgent({ name: "Mia" });
  bo = await makeAgent({ name: "Bo" });
});

afterAll(async () => {
  await env.close();
});

describe("while you were away", () => {
  test("what the team did since: replies, problems, delivered tickets, failed automations and what it cost", async () => {
    const before = new Date(Date.now() - 1000).toISOString();
    const replied = await startChat({ agentId: mia.id, content: "Say hello", title: "Q4 plan" });
    await waitForRun(replied.run.id, 20_000);
    const broke = await startChat({ agentId: bo.id, content: "CRASH now", title: "Invoices" });
    await waitForRun(broke.run.id, 20_000);
    const routine = createRoutine({ agentId: bo.id, name: "Nightly report", cron: "0 3 * * *", prompt: "CRASH again" });
    const { triggerRoutine } = await import("../src/scheduler/scheduler");
    await waitForRun((await triggerRoutine(routine.id, { scheduled: true })).id, 20_000);
    const ticket = createTask({ title: "Write the summary" });
    insert("task_events", { id: newId("tev"), task_id: ticket.id, kind: "delivered", actor: "agent", actor_name: "Mia", body: "", data: "{}", created_at: now() });

    const away = awaySummary(before);
    expect(away.finished).toBe(3);
    expect(away.failed).toBe(2);
    expect(away.delivered).toBe(1);
    expect(away.costUsd).toBeGreaterThan(0);
    expect(away.agents.map((a) => a.name).sort()).toEqual(["Bo", "Mia"]);
    // Who worked adds up to what finished.
    expect(away.agents.reduce((n, a) => n + a.runs, 0)).toBe(away.finished);
    expect(away.highlights.map((h) => h.text)).toEqual([
      `Mia delivered #${ticket.number} Write the summary`,
      "“Nightly report” failed",
      "Bo ran into a problem in “Invoices”",
      "Mia replied in “Q4 plan”",
    ]);
    expect(away.highlights[3]!.link).toBe(`/chat/${replied.conversation.id}`);

    // Nothing happened since.
    const after = new Date(Date.now() + 1).toISOString();
    await new Promise((r) => setTimeout(r, 20));
    const quiet = awaySummary(after);
    expect(quiet).toMatchObject({ finished: 0, delivered: 0, highlights: [] });
  }, 60_000);

  test("over HTTP, only with a time in the past; the phone can't ask", async () => {
    const get = (since: string) => fetch(`${env.baseUrl}/api/away?since=${encodeURIComponent(since)}`, { headers: { Authorization: `Bearer ${getAccessToken()}` } });
    const ok = await get(new Date(Date.now() - 3_600_000).toISOString());
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as AwaySummary).finished).toBeGreaterThanOrEqual(3);
    expect((await get("yesterday-ish")).status).toBe(400);
    expect((await get(new Date(Date.now() + 60_000).toISOString())).status).toBe(400);
    expect(deviceMayCall("GET", "/api/away")).toBe(false);
  });
});
