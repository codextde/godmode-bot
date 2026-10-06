import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, MessageBlock, Task } from "@godmode/shared";
import { RUN_WATCHDOG, heartbeatAllowedAt, nextAllowedAt, nextHeartbeatAt, normalizeHeartbeat, runEndOf } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { get, run as sql } from "../src/db";
import { getAgent, updateAgent } from "../src/agents/service";
import { getRun, listRuns, waitForRun } from "../src/runner/runner";
import { __setWatchdogForTests, assess, checkRuns, listWatchdogEvents } from "../src/runner/watchdog";
import { __setHeartbeatsForTests, beat, heartbeatState, listBeats, sweepHeartbeats } from "../src/services/heartbeats";
import { startChat } from "../src/services/conversations";
import { listNotifications } from "../src/services/notifications";
import { updateSettings } from "../src/services/settings";
import { getAccessToken } from "../src/server/auth";
import { createTask, getTask, listTaskEvents, sendTaskMessage, startTasks, stopTasks } from "../src/tasks/service";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-heartbeats-");
  startTasks();
  updateSettings({ general: { userName: "Dana" } });
  agent = await makeAgent({ name: "Pulse" });
  __setHeartbeatsForTests({ settleMs: 0 });
});

afterAll(async () => {
  stopTasks();
  __setWatchdogForTests({ stallMs: null });
  await env.close();
});

const settled = (id: string, statuses: Task["status"][], ms = 15_000) =>
  until(
    () => statuses.includes(getTask(id).status) && !getTask(id).activity && getTask(id).runStatus !== "running" && getTask(id).runStatus !== "queued",
    ms,
    `task to be ${statuses.join("/")}`,
  );

async function withHeartbeat(a: Agent, patch: Parameters<typeof updateAgent>[1]["heartbeat"] = {}): Promise<Agent> {
  return updateAgent(a.id, { heartbeat: { enabled: true, intervalMinutes: 60, ...patch } });
}

describe("heartbeat rhythm", () => {
  test("normalizes what it gets", () => {
    const hb = normalizeHeartbeat({ enabled: true, intervalMinutes: 50, hours: { from: 9, to: 9 }, checklist: "x".repeat(5000) });
    expect(hb.intervalMinutes).toBe(60);
    expect(hb.hours).toBeNull();
    expect(hb.checklist.length).toBe(4000);
    expect(normalizeHeartbeat({ hours: { from: 0, to: 24 } }).hours).toBeNull();
  });

  test("keeps to its hours and weekdays", () => {
    const hb = { hours: { from: 8, to: 18 }, weekdays: true };
    const saturday = new Date(2026, 9, 10, 10, 0);
    const mondayEarly = new Date(2026, 9, 12, 6, 30);
    expect(heartbeatAllowedAt(hb, saturday)).toBe(false);
    expect(heartbeatAllowedAt(hb, new Date(2026, 9, 12, 9, 0))).toBe(true);
    expect(heartbeatAllowedAt(hb, new Date(2026, 9, 12, 18, 0))).toBe(false);
    expect(nextAllowedAt(hb, saturday)!.getTime()).toBe(new Date(2026, 9, 12, 8, 0).getTime());
    expect(nextAllowedAt(hb, mondayEarly)!.getTime()).toBe(new Date(2026, 9, 12, 8, 0).getTime());
    expect(heartbeatAllowedAt({ hours: { from: 22, to: 6 }, weekdays: false }, new Date(2026, 9, 12, 2, 0))).toBe(true);
  });

  test("beats one interval after the last beat, or after it was switched on", () => {
    const since = new Date(2026, 9, 12, 9, 0).toISOString();
    const hb = normalizeHeartbeat({ enabled: true, intervalMinutes: 30, since });
    expect(nextHeartbeatAt(hb, null)!.getTime()).toBe(Date.parse(since) + 30 * 60_000);
    expect(nextHeartbeatAt(hb, new Date(2026, 9, 12, 11, 0).toISOString())!.getTime()).toBe(new Date(2026, 9, 12, 11, 30).getTime());
    expect(nextHeartbeatAt({ ...hb, enabled: false }, null)).toBeNull();
  });

  test("switching it on starts the clock; turning it off clears it", async () => {
    const a = await makeAgent({ name: "Clock" });
    expect(a.heartbeat.enabled).toBe(false);
    const on = await withHeartbeat(a, { checklist: "  Look at the inbox  " });
    expect(on.heartbeat.since).not.toBeNull();
    expect(on.heartbeat.checklist).toBe("  Look at the inbox  ");
    const same = await updateAgent(a.id, { heartbeat: { checklist: "Inbox" } });
    expect(same.heartbeat.since).toBe(on.heartbeat.since);
    const off = await updateAgent(a.id, { heartbeat: { enabled: false } });
    expect(off.heartbeat.since).toBeNull();
  });
});

describe("beats", () => {
  test("a beat with nothing to do is quiet and starts no run", async () => {
    const a = await withHeartbeat(await makeAgent({ name: "Idle" }));
    const runsBefore = listRuns({ agentId: a.id }).length;
    const b = await beat(a.id);
    expect(b.outcome).toBe("quiet");
    expect(b.summary).toBe("Nothing to move forward");
    expect(listRuns({ agentId: a.id }).length).toBe(runsBefore);
  });

  test("wakes the agent on a ticket that stands still, with what changed since", async () => {
    const a = await withHeartbeat(await makeAgent({ name: "Mover" }));
    const t = createTask({ title: "Draft the newsletter", description: "Write it.", agentId: a.id });
    await settled(t.id, ["in_review"]);
    await sendTaskMessage(t.id, "Shorter intro, please");
    await settled(t.id, ["in_review"]);
    // Something went wrong between two runs: in progress, nothing running, nothing it waits for.
    sql("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?", new Date(Date.now() - 3_600_000).toISOString(), t.id);
    sql("INSERT INTO task_events (id, task_id, kind, actor, actor_name, body, data, run_id, created_at) VALUES (?, ?, 'note', 'user', '', 'Use the October numbers', '{}', NULL, ?)", "tev_hb_note", t.id, new Date().toISOString());

    const b = await beat(a.id);
    expect(b.outcome).toBe("woke");
    expect(b.wakes).toEqual([{ taskId: t.id, number: t.number, title: t.title, why: "stalled", changes: 1 }]);
    expect(b.summary).toBe(`Woke on #${t.number}`);
    await settled(t.id, ["in_review"]);

    const wake = listRuns({ conversationId: getTask(t.id).conversationId! }).find((r) => r.trigger === "heartbeat")!;
    expect(wake).toBeDefined();
    const prompt = invocations(env).at(-1)!.prompt;
    expect(prompt).toContain("<godmode-heartbeat>");
    expect(prompt).toContain(`task #${t.number}`);
    expect(prompt).toContain("Use the October numbers");
    expect(prompt).toContain("durable progress");
    const started = listTaskEvents(t.id).filter((e) => e.kind === "started").at(-1)!;
    expect(started.data).toMatchObject({ trigger: "heartbeat" });
    expect(started.body).toContain("In progress");
  });

  test("tries a failed ticket again once per block", async () => {
    const a = await withHeartbeat(await makeAgent({ name: "Retrier" }));
    const t = createTask({ title: "Import the orders", description: "CRASH while importing", agentId: a.id });
    await settled(t.id, ["blocked"], 20_000);
    expect(getTask(t.id).blockedKind).toBe("failed");
    sql("UPDATE tasks SET updated_at = ? WHERE id = ?", new Date(Date.now() - 3_600_000).toISOString(), t.id);

    const b = await beat(a.id);
    expect(b.wakes.map((w) => [w.number, w.why])).toEqual([[t.number, "retry"]]);
    await settled(t.id, ["in_review", "blocked"], 20_000);

    // Blocked again without a new block on its timeline: the heartbeat already had its go.
    sql("UPDATE tasks SET status = 'blocked', blocked_kind = 'failed', blocked_reason = 'boom', updated_at = ? WHERE id = ?", new Date(Date.now() - 3_600_000).toISOString(), t.id);
    const again = await beat(a.id);
    expect(again.wakes).toEqual([]);
  });

  test("lists what waits for the human and leaves it alone", async () => {
    const a = await withHeartbeat(await makeAgent({ name: "Reviewer" }));
    const t = createTask({ title: "Write the summary", agentId: a.id });
    await settled(t.id, ["in_review"]);
    const b = await beat(a.id);
    expect(b.outcome).toBe("quiet");
    expect(b.waitingOnYou.map((w) => w.number)).toEqual([t.number]);
    expect(b.summary).toBe("Nothing to move forward · 1 waiting on you");
    expect(heartbeatState(a.id).board.waitingOnYou).toBe(1);
  });

  test("runs the checklist in the agent's heartbeat chat with its board", async () => {
    const a = await withHeartbeat(await makeAgent({ name: "Checker" }), { checklist: "Check the shared inbox for new orders." });
    const t = createTask({ title: "Answer Acme", agentId: a.id });
    await settled(t.id, ["in_review"]);
    const b = await beat(a.id);
    expect(b.outcome).toBe("woke");
    expect(b.summary).toBe("Ran the checklist · 1 waiting on you");
    expect(b.runId).not.toBeNull();
    const run = await waitForRun(b.runId!, 10_000);
    expect(run.trigger).toBe("heartbeat");
    const conv = get<{ origin: string; title: string }>("SELECT origin, title FROM conversations WHERE id = ?", run.conversationId)!;
    expect(conv).toEqual({ origin: "heartbeat", title: "Heartbeat" });
    const prompt = invocations(env).at(-1)!.prompt;
    expect(prompt).toContain("Check the shared inbox for new orders.");
    expect(prompt).toContain(`#${t.number} “Answer Acme” · In review`);
    expect(prompt).toContain("This is your first heartbeat. Since it was switched on:");
    expect(prompt).toContain("Dana assigned it to Checker");

    const latest = listBeats(a.id)[0]!;
    expect(latest.runStatus).toBe("succeeded");
    expect(latest.result).toBeTruthy();

    // The next beat reuses the chat and only reports what changed since.
    const next = await beat(a.id);
    await waitForRun(next.runId!, 10_000);
    expect(getRun(next.runId!).conversationId).toBe(run.conversationId);
    expect(invocations(env).at(-1)!.prompt).toContain("Nothing changed on your tickets since your last heartbeat.");
  });

  test("the sweep beats what is due, once", async () => {
    const a = await withHeartbeat(await makeAgent({ name: "Sweeper" }));
    sql("UPDATE agents SET heartbeat = json_set(heartbeat, '$.since', ?) WHERE id = ?", new Date(Date.now() - 2 * 3_600_000).toISOString(), a.id);
    await sweepHeartbeats();
    expect(listBeats(a.id).length).toBe(1);
    await sweepHeartbeats();
    expect(listBeats(a.id).length).toBe(1);
    const state = heartbeatState(a.id);
    expect(Date.parse(state.nextAt!)).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  test("a switched-off agent doesn't beat", async () => {
    const a = await withHeartbeat(await makeAgent({ name: "Sleeper" }));
    await updateAgent(a.id, { enabled: false });
    expect((await beat(a.id)).outcome).toBe("skipped");
    expect(heartbeatState(a.id).nextAt).toBeNull();
  });

  test("the API reads the state and wakes on demand", async () => {
    const a = await makeAgent({ name: "Api Pulse" });
    const headers = { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" };
    const patched = await fetch(`${env.baseUrl}/api/agents/${a.id}`, { method: "PATCH", headers, body: JSON.stringify({ heartbeat: { enabled: true, intervalMinutes: 30, weekdays: true } }) });
    expect(patched.status).toBe(200);
    expect(getAgent(a.id).heartbeat).toMatchObject({ enabled: true, intervalMinutes: 30, weekdays: true });
    const bad = await fetch(`${env.baseUrl}/api/agents/${a.id}`, { method: "PATCH", headers, body: JSON.stringify({ heartbeat: { intervalMinutes: 0 } }) });
    expect(bad.status).toBe(400);
    const beatRes = await fetch(`${env.baseUrl}/api/agents/${a.id}/heartbeat/beat`, { method: "POST", headers });
    expect(beatRes.status).toBe(200);
    expect(((await beatRes.json()) as { reason: string }).reason).toBe("now");
    const state = (await (await fetch(`${env.baseUrl}/api/agents/${a.id}/heartbeat`, { headers })).json()) as { beats: unknown[]; heartbeat: { intervalMinutes: number } };
    expect(state.beats.length).toBe(1);
    expect(state.heartbeat.intervalMinutes).toBe(30);
  });
});

describe("watchdog", () => {
  const tool = (id: string, name: string, input: unknown, result?: string): MessageBlock => ({ type: "tool_use", id, name, input, ...(result === undefined ? {} : { result }) });
  const limits = { stallMs: 20 * 60_000, loopRepeats: 4 };
  const t0 = Date.parse("2026-10-06T08:00:00Z");

  test("a run that writes is fine; one that is silent too long stalls", () => {
    const blocks = [tool("a", "Read", { file_path: "/x" }, "ok")];
    expect(assess({ blocks, lastOutputAt: t0, startedAt: t0, waiting: false }, t0 + 19 * 60_000, limits)).toBeNull();
    const v = assess({ blocks, lastOutputAt: t0, startedAt: t0 - 60_000, waiting: false }, t0 + 21 * 60_000, limits)!;
    expect(v.kind).toBe("stalled");
    expect(v.report.startsWith(RUN_WATCHDOG)).toBe(true);
    expect(v.report).toContain("no sign of life for 21 minutes after its last step");
    expect(v.report).toContain("(Read: /x)");
    expect(runEndOf(v.report)?.kind).toBe("stalled");
  });

  test("a running step gets longer, waiting on purpose never stalls", () => {
    const building = [tool("b", "Bash", { command: "pnpm build" })];
    expect(assess({ blocks: building, lastOutputAt: t0, startedAt: t0, waiting: false }, t0 + 40 * 60_000, limits)).toBeNull();
    const v = assess({ blocks: building, lastOutputAt: t0, startedAt: t0, waiting: false }, t0 + 61 * 60_000, limits)!;
    expect(v.report).toContain("while this step ran");
    expect(v.report).toContain("pnpm build");
    const delegating = [tool("c", "mcp__godmode__agent_delegate", { agentId: "agt_x", task: "Go" })];
    expect(assess({ blocks: delegating, lastOutputAt: t0, startedAt: t0, waiting: false }, t0 + 5 * 3_600_000, limits)).toBeNull();
    expect(assess({ blocks: building, lastOutputAt: t0, startedAt: t0, waiting: true }, t0 + 5 * 3_600_000, limits)).toBeNull();
  });

  test("the same step with the same answer again and again goes in circles", () => {
    const same = (i: number) => tool(`l${i}`, "mcp__browser__browser_click", { index: 3 }, "Nothing happened");
    const blocks = [same(1), { type: "text", text: "Trying again" } as MessageBlock, same(2), same(3), same(4)];
    const v = assess({ blocks, lastOutputAt: t0, startedAt: t0, waiting: false }, t0 + 1000, limits)!;
    expect(v.kind).toBe("looping");
    expect(v.report).toContain("4 times in a row");
    const varied = [same(1), same(2), tool("l3", "mcp__browser__browser_click", { index: 4 }, "Nothing happened"), same(4)];
    expect(assess({ blocks: varied, lastOutputAt: t0, startedAt: t0, waiting: false }, t0 + 1000, limits)).toBeNull();
  });

  test("stops a stalled chat run with its report and tells the human", async () => {
    const a = await makeAgent({ name: "Stuck" });
    __setWatchdogForTests({ stallMs: 300 });
    try {
      const { run, conversation } = await startChat({ agentId: a.id, content: "SLEEP until done" });
      await until(() => getRun(run.id).status === "running", 10_000, "run to start");
      await new Promise((r) => setTimeout(r, 700));
      expect(checkRuns()).toBe(1);
      const done = await waitForRun(run.id, 10_000);
      expect(done.status).toBe("failed");
      expect(done.error!.startsWith(RUN_WATCHDOG)).toBe(true);
      const [event] = listWatchdogEvents(a.id);
      expect(event).toMatchObject({ runId: run.id, kind: "stalled", action: "escalated", conversationId: conversation.id, taskId: null });
      expect(listNotifications().some((n) => n.link === `/chat/${conversation.id}` && n.title.includes("watchdog"))).toBe(true);
    } finally {
      __setWatchdogForTests({ stallMs: null });
    }
  });

  test("a stalled ticket tries again once, then waits blocked", async () => {
    const a = await makeAgent({ name: "Stuck Ticket" });
    __setWatchdogForTests({ stallMs: 300 });
    try {
      const t = createTask({ title: "Sync the catalogue", description: "SLEEP while syncing", agentId: a.id });
      for (let i = 0; i < 2; i++) {
        await until(() => getTask(t.id).runStatus === "running" && listWatchdogEvents(a.id).length === i, 15_000, `run ${i + 1}`);
        await new Promise((r) => setTimeout(r, 700));
        expect(checkRuns()).toBe(1);
      }
      await settled(t.id, ["blocked"], 15_000);
      expect(getTask(t.id).blockedReason).toContain(RUN_WATCHDOG);
      expect(listWatchdogEvents(a.id).map((e) => e.action)).toEqual(["escalated", "retry"]);
      expect(listTaskEvents(t.id).some((e) => e.kind === "started" && (e.data as { retry?: number }).retry === 1)).toBe(true);
    } finally {
      __setWatchdogForTests({ stallMs: null });
    }
  });

  test("turned off, it leaves runs alone", () => {
    updateSettings({ runner: { watchdog: false } });
    try {
      expect(checkRuns(Date.now() + 10 * 3_600_000)).toBe(0);
    } finally {
      updateSettings({ runner: { watchdog: true } });
    }
  });
});
