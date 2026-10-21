import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Conversation, Run } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, get, insert, openDb, run as exec } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import * as conversations from "../src/services/conversations";
import { createAgent, updateAgent } from "../src/agents/service";
import * as repo from "../src/agents/repo";
import * as routines from "../src/services/routines";
import { createRoutine, getRoutine, runRoutineNow, updateRoutine } from "../src/services/routines";
import { catchUpMissed, dueSlot, reloadSchedules, runMissedSince, scheduledRoutines, startScheduler, stopScheduler, triggerRoutine } from "../src/scheduler/scheduler";
import { HttpError, newId, now } from "../src/util";
import { Cron } from "croner";

let dataDir: string;
let agent: Agent;

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-scheduler-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  agent = await createAgent({ name: "Monitor" });
});

afterAll(async () => {
  stopScheduler();
  await repo.repoIdle(agent.repoPath);
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

async function catchHttp(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected an HttpError");
}

describe("scheduling", () => {
  afterEach(() => stopScheduler());

  test("schedules enabled routines of enabled agents and persists nextRunAt", async () => {
    const offAgent = await createAgent({ name: "Sleeping", enabled: false });
    const active = createRoutine({ agentId: agent.id, name: "Active", cron: "0 8 * * *", timezone: "UTC", prompt: "go" });
    const paused = createRoutine({ agentId: agent.id, name: "Paused", cron: "0 8 * * *", prompt: "go", enabled: false });
    const ofDisabled = createRoutine({ agentId: offAgent.id, name: "Of disabled", cron: "0 8 * * *", prompt: "go" });
    expect(ofDisabled.nextRunAt).toBeNull();

    startScheduler();
    const ids = scheduledRoutines().map((s) => s.routineId);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(paused.id);
    expect(ids).not.toContain(ofDisabled.id);
    const scheduled = scheduledRoutines().find((s) => s.routineId === active.id)!;
    expect(getRoutine(active.id).nextRunAt).toBe(scheduled.nextRunAt);

    updateRoutine(active.id, { enabled: false });
    expect(scheduledRoutines().map((s) => s.routineId)).not.toContain(active.id);
    expect(getRoutine(active.id).nextRunAt).toBeNull();

    updateRoutine(active.id, { enabled: true, cron: "30 9 * * *" });
    expect(scheduledRoutines().find((s) => s.routineId === active.id)!.nextRunAt).toBe(getRoutine(active.id).nextRunAt);
    expect(new Date(getRoutine(active.id).nextRunAt!).getUTCHours()).toBe(9);

    await updateAgent(offAgent.id, { enabled: true });
    expect(scheduledRoutines().map((s) => s.routineId)).toContain(ofDisabled.id);
    await updateAgent(offAgent.id, { enabled: false });
    expect(scheduledRoutines().map((s) => s.routineId)).not.toContain(ofDisabled.id);

    stopScheduler();
    expect(scheduledRoutines()).toEqual([]);
    reloadSchedules(); // no-op while stopped
    expect(scheduledRoutines()).toEqual([]);
    await repo.repoIdle(offAgent.repoPath);
  });

  test("startup repairs routine statuses left behind by an interrupted process", () => {
    const routine = createRoutine({ agentId: agent.id, name: "Interrupted", cron: "0 5 * * *", prompt: "x" });
    const ts = now();
    insert("runs", {
      id: newId("run"),
      agent_id: agent.id,
      conversation_id: "cnv_gone",
      routine_id: routine.id,
      trigger: "routine",
      status: "cancelled",
      prompt: "x",
      created_at: ts,
    });
    exec("UPDATE routines SET last_status = 'running' WHERE id = ?", routine.id);
    const orphan = createRoutine({ agentId: agent.id, name: "Orphan", cron: "0 5 * * *", prompt: "x" });
    exec("UPDATE routines SET last_status = 'queued' WHERE id = ?", orphan.id);

    startScheduler();
    expect(getRoutine(routine.id).lastStatus).toBe("cancelled");
    expect(getRoutine(orphan.id).lastStatus).toBe("failed");
  });
});

describe("triggering", () => {
  const createdConversations: { agentId: string; title?: string; origin?: string; fillOnly?: boolean }[] = [];
  const sent: { conversationId: string; content: string; trigger?: string; routineId?: string | null }[] = [];
  let failNext: Error | null = null;
  let createSpy: ReturnType<typeof spyOn>;
  let sendSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createdConversations.length = 0;
    sent.length = 0;
    failNext = null;
    createSpy = spyOn(conversations, "createConversation").mockImplementation(((input: {
      agentId: string;
      title?: string;
      origin?: Conversation["origin"];
    }) => {
      const ts = now();
      const id = newId("cnv");
      insert("conversations", {
        id,
        agent_id: input.agentId,
        title: input.title ?? "New chat",
        origin: input.origin ?? "chat",
        created_at: ts,
        updated_at: ts,
      });
      createdConversations.push(input);
      return {
        id,
        agentId: input.agentId,
        title: input.title ?? "New chat",
        origin: input.origin ?? "chat",
        claudeSessionId: null,
        model: null,
        effort: null,
        ultracode: null,
        workingDirectory: null,
        computerTarget: null,
        vmId: null,
        browserProfileId: null,
        workspaceId: null,
        projectId: null,
        sshServerIds: [],
        androidDeviceIds: [],
        instructions: "",
        runnerId: null,
        runnerToolsId: null,
        pinned: false,
        archived: false,
        lastMessageAt: null,
        createdAt: ts,
        updatedAt: ts,
      } satisfies Conversation;
    }) as typeof conversations.createConversation);
    sendSpy = spyOn(conversations, "sendMessage").mockImplementation((async (
      conversationId: string,
      input: { content: string; trigger?: Run["trigger"]; routineId?: string | null },
    ) => {
      if (failNext) throw failNext;
      const ts = now();
      const conv = get<{ agent_id: string }>("SELECT agent_id FROM conversations WHERE id = ?", conversationId)!;
      const run: Run = {
        id: newId("run"),
        agentId: conv.agent_id,
        conversationId,
        routineId: input.routineId ?? null,
        parentRunId: null,
        trigger: input.trigger ?? "chat",
        status: "running",
        prompt: input.content,
        result: null,
        error: null,
        costUsd: null,
        durationMs: null,
        numTurns: null,
        usage: null,
        model: null,
        startedAt: ts,
        finishedAt: null,
        createdAt: ts,
      };
      insert("runs", {
        id: run.id,
        agent_id: run.agentId,
        conversation_id: conversationId,
        routine_id: run.routineId,
        trigger: run.trigger,
        status: run.status,
        prompt: run.prompt,
        created_at: ts,
      });
      sent.push({ conversationId, ...input });
      const message = {
        id: newId("msg"),
        conversationId,
        role: "user" as const,
        content: input.content,
        blocks: [],
        runId: run.id,
        attachments: [],
        createdAt: ts,
      };
      return { message, run };
    }) as typeof conversations.sendMessage);
  });

  afterEach(() => {
    createSpy.mockRestore();
    sendSpy.mockRestore();
  });

  function finish(run: Run, status: Run["status"] = "succeeded") {
    exec("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?", status, now(), run.id);
    bus.emit({ type: "run.finished", run: { ...run, status, finishedAt: now() } });
  }

  test("reuses one conversation per routine and tracks the run status", async () => {
    const routine = createRoutine({ agentId: agent.id, name: "Price check", cron: "0 7 * * *", prompt: "Check prices" });

    const first = await runRoutineNow(routine.id);
    expect(first.routineId).toBe(routine.id);
    expect(first.trigger).toBe("routine");
    expect(createdConversations).toEqual([{ agentId: agent.id, title: "Price check", origin: "routine", fillOnly: false }]);
    expect(sent[0]).toMatchObject({ content: "Check prices", trigger: "routine", routineId: routine.id });
    let current = getRoutine(routine.id);
    expect(current.conversationId).toBe(first.conversationId);
    expect(current.lastRunAt).not.toBeNull();
    expect(current.lastStatus).toBe("running");

    const busy = await catchHttp(triggerRoutine(routine.id));
    expect(busy.status).toBe(409);
    expect(busy.message).toContain("already running");

    finish(first);
    expect(getRoutine(routine.id).lastStatus).toBe("succeeded");

    const second = await triggerRoutine(routine.id);
    expect(second.conversationId).toBe(first.conversationId);
    expect(createdConversations).toHaveLength(1);
    finish(second, "failed");
    expect(getRoutine(routine.id).lastStatus).toBe("failed");

    // The stored conversation disappeared (deleted by the user): a new one is created and remembered.
    exec("DELETE FROM runs WHERE conversation_id = ?", first.conversationId);
    exec("DELETE FROM conversations WHERE id = ?", first.conversationId);
    const third = await triggerRoutine(routine.id);
    expect(third.conversationId).not.toBe(first.conversationId);
    expect(getRoutine(routine.id).conversationId).toBe(third.conversationId);
    finish(third);
  });

  test("a paused run keeps its automation busy until it continues", async () => {
    const routine = createRoutine({ agentId: agent.id, name: "Paused check", cron: "0 7 * * *", prompt: "Check" });
    const run = await runRoutineNow(routine.id);
    exec("UPDATE runs SET status = 'paused' WHERE id = ?", run.id);
    bus.emit({ type: "run.paused", run: { ...run, status: "paused" } });
    expect(getRoutine(routine.id).lastStatus).toBe("paused");
    // Not over: the next tick is skipped, like while it runs.
    expect((await catchHttp(triggerRoutine(routine.id, { scheduled: true }))).status).toBe(409);

    // Continued: queued again, then running.
    exec("UPDATE runs SET status = 'queued' WHERE id = ?", run.id);
    bus.emit({ type: "run.started", run: { ...run, status: "queued" } });
    expect(getRoutine(routine.id).lastStatus).toBe("queued");
    exec("UPDATE runs SET status = 'running' WHERE id = ?", run.id);
    bus.emit({ type: "run.started", run: { ...run, status: "running" } });
    expect(getRoutine(routine.id).lastStatus).toBe("running");
    finish(run);
    expect(getRoutine(routine.id).lastStatus).toBe("succeeded");
  });

  test("creates a dated conversation per run when reuse is off", async () => {
    const routine = createRoutine({
      agentId: agent.id,
      name: "Smoke test",
      cron: "0 6 * * *",
      prompt: "Run the smoke test",
      reuseConversation: false,
    });
    const a = await triggerRoutine(routine.id);
    finish(a);
    const b = await triggerRoutine(routine.id);
    finish(b);
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(createdConversations).toHaveLength(2);
    expect(createdConversations[0]!.title).toMatch(/^Smoke test · .+/);
    expect(getRoutine(routine.id).conversationId).toBeNull();
  });

  test("refuses routines of disabled agents and records start failures", async () => {
    const other = await createAgent({ name: "Flaky" });
    const routine = createRoutine({ agentId: other.id, name: "Flaky job", cron: "0 6 * * *", prompt: "x" });

    failNext = new Error("claude CLI not found");
    let thrown: unknown;
    try {
      await triggerRoutine(routine.id);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toBe("claude CLI not found");
    expect(getRoutine(routine.id).lastStatus).toBe("failed");

    await updateAgent(other.id, { enabled: false });
    const err = await catchHttp(triggerRoutine(routine.id));
    expect(err.status).toBe(409);
    expect(err.message).toContain("disabled");
    expect(sent).toHaveLength(0);
    await repo.repoIdle(other.repoPath);
  });

  test("a random start fires at its drawn time and plans the next slot", async () => {
    const routine = createRoutine({
      agentId: agent.id,
      name: "Coworker",
      trigger: { type: "schedule", startWindowMinutes: 60 },
      cron: "0 8 * * *",
      timezone: "UTC",
      prompt: "Good morning",
    });
    const soon = { slot: new Date(Date.now() - 60_000), at: new Date(Date.now() + 100) };
    const draw = spyOn(routines, "nextRandomStart").mockImplementationOnce(() => soon);
    try {
      startScheduler();
      expect(scheduledRoutines().find((s) => s.routineId === routine.id)!.nextRunAt).toBe(soon.at.toISOString());
      for (let i = 0; i < 50 && !sent.some((m) => m.routineId === routine.id); i++) await Bun.sleep(50);
      expect(sent.find((m) => m.routineId === routine.id)).toMatchObject({ content: "Good morning", trigger: "routine" });

      const next = scheduledRoutines().find((s) => s.routineId === routine.id)!.nextRunAt!;
      expect(draw).toHaveBeenLastCalledWith(routine.id, "0 8 * * *", "UTC", 60, expect.any(Date), soon.slot.getTime(), 1);
      expect(Date.parse(next)).toBeGreaterThan(Date.now());
      expect(new Date(next).getUTCHours()).toBe(8);
      expect(getRoutine(routine.id).nextRunAt).toBe(next);
      expect(get<{ source: string }>("SELECT source FROM automation_events WHERE routine_id = ?", routine.id)?.source).toBe("schedule");

      updateRoutine(routine.id, { trigger: { type: "schedule", startWindowMinutes: 45 } });
      const [, , , minutes, , handled] = draw.mock.calls.at(-1)!;
      expect(minutes).toBe(45);
      expect(handled).toBeGreaterThanOrEqual(soon.slot.getTime());
    } finally {
      draw.mockRestore();
      stopScheduler();
    }
  });

  test("scheduled ticks skip disabled routines", async () => {
    const routine = createRoutine({ agentId: agent.id, name: "Off", cron: "0 6 * * *", prompt: "x", enabled: false });
    expect((await catchHttp(triggerRoutine(routine.id, { scheduled: true }))).status).toBe(409);
    const manual = await triggerRoutine(routine.id);
    finish(manual);
    expect(sent).toHaveLength(1);
  });

  test("a computer that starts standing in runs the automations that came due since the primary went, once", async () => {
    const hourly = createRoutine({ agentId: agent.id, name: "Hourly", cron: "0 * * * *", timezone: "UTC", prompt: "hourly" });
    const ranThere = createRoutine({ agentId: agent.id, name: "Ran there", cron: "0 * * * *", timezone: "UTC", prompt: "done there" });
    const before = createRoutine({ agentId: agent.id, name: "Before", cron: "0 0 1 1 *", timezone: "UTC", prompt: "yearly" });
    const slot = dueSlot(new Cron("0 * * * *", { timezone: "UTC", paused: true }), new Date())!;
    // The primary ran this one in the current slot already (its copy says so).
    exec("UPDATE routines SET last_run_at = ? WHERE id = ?", new Date(slot.getTime() + 5_000).toISOString(), ranThere.id);
    startScheduler();
    const lostAt = new Date(slot.getTime() - 5 * 60_000).toISOString();
    expect(await runMissedSince(lostAt)).toBe(1);
    expect(sent.map((m) => m.routineId)).toEqual([hourly.id]);
    expect(sent.some((m) => m.routineId === before.id)).toBe(false);
    for (const r of [hourly, ranThere, before]) updateRoutine(r.id, { enabled: false });
  });

  describe("slots missed while the scheduler wasn't running", () => {
    // Tuesday, 16:06 in Berlin: Godmode was off from 14:38 to 16:06.
    const wentAt = "2026-10-20T12:38:00.000Z";
    const backAt = "2026-10-20T14:06:01.000Z";

    beforeEach(() => {
      stopScheduler();
      exec("UPDATE routines SET enabled = 0");
    });

    afterEach(() => {
      stopScheduler();
      setSystemTime();
    });

    /** The scheduler ran until `until`, then Godmode was off until `back`. */
    function offline(until: string) {
      setSystemTime(new Date(until));
      startScheduler();
      stopScheduler();
    }

    function routine(cron: string, trigger: { type: "schedule"; startWindowMinutes?: number } = { type: "schedule" }) {
      const r = createRoutine({ agentId: agent.id, name: `Replies ${cron}`, trigger, cron, timezone: "Europe/Berlin", prompt: "answer replies" });
      exec("UPDATE routines SET created_at = ? WHERE id = ?", "2026-10-01T00:00:00.000Z", r.id);
      return r;
    }

    async function back(at = backAt) {
      setSystemTime(new Date(at));
      startScheduler();
      await Bun.sleep(20);
    }

    const runsOf = (id: string) => sent.filter((m) => m.routineId === id).length;

    test("a slot that fell while Godmode was off runs once when it starts", async () => {
      offline(wentAt);
      const r = routine("0 15 * * 1-5");
      await back();
      expect(runsOf(r.id)).toBe(1);
      const event = get<{ source: string; note: string | null }>("SELECT source, note FROM automation_events WHERE routine_id = ?", r.id);
      expect(event?.source).toBe("schedule");
      expect(event?.note).toContain("Caught up");
      expect(await catchUpMissed("start", Date.parse(wentAt))).toBe(0);
      expect(await catchUpMissed("wake", Date.parse(wentAt))).toBe(0);
      expect(runsOf(r.id)).toBe(1);
    });

    test("a late tick for a slot that was caught up already is skipped", async () => {
      offline(wentAt);
      const r = routine("0 15 * * 1-5");
      await back();
      expect(runsOf(r.id)).toBe(1);
      exec("UPDATE runs SET status = 'succeeded', finished_at = ? WHERE routine_id = ?", now(), r.id);
      exec("UPDATE routines SET last_run_at = NULL WHERE id = ?", r.id);
      exec("DELETE FROM automation_events WHERE routine_id = ?", r.id);
      expect(await catchUpMissed("wake", Date.parse(wentAt))).toBe(0);
      expect(runsOf(r.id)).toBe(1);
    });

    test("no catch-up when the next slot comes within 2 hours or the slot is older than 12 hours", async () => {
      offline("2026-10-19T20:00:00.000Z");
      const soon = routine("0 * * * *");
      const old = routine("0 3 * * *");
      await back();
      expect(runsOf(soon.id)).toBe(0);
      expect(runsOf(old.id)).toBe(0);
    });

    test("slots the running scheduler saw are not caught up", async () => {
      offline("2026-10-20T13:05:00.000Z");
      const r = routine("0 15 * * 1-5");
      await back();
      expect(runsOf(r.id)).toBe(0);
    });

    test("a routine created after its slot doesn't catch it up", async () => {
      offline(wentAt);
      const r = routine("0 15 * * 1-5");
      exec("UPDATE routines SET created_at = ? WHERE id = ?", "2026-10-20T13:30:00.000Z", r.id);
      await back();
      expect(runsOf(r.id)).toBe(0);
    });

    test("a slot that ran already (here or on another computer) is not caught up", async () => {
      offline(wentAt);
      const r = routine("0 15 * * 1-5");
      exec("UPDATE routines SET last_run_at = ? WHERE id = ?", "2026-10-20T13:00:05.000Z", r.id);
      await back();
      expect(runsOf(r.id)).toBe(0);
    });

    test("a start window whose drawn start passed while Godmode was off runs once now", async () => {
      offline(wentAt);
      const r = routine("0 16 * * 1-5", { type: "schedule", startWindowMinutes: 45 });
      const at = routines.drawnStart(r.id, new Date("2026-10-20T14:00:00.000Z"), 45);
      await back(new Date(at.getTime() + 1_000).toISOString());
      expect(runsOf(r.id)).toBe(1);
      expect(Date.parse(scheduledRoutines().find((s) => s.routineId === r.id)!.nextRunAt!)).toBeGreaterThan(Date.parse("2026-10-21T14:00:00.000Z") - 1);
      expect(await catchUpMissed("start", Date.parse(wentAt))).toBe(0);
      expect(runsOf(r.id)).toBe(1);
    });

    test("a start window whose drawn start is still to come is left to its random start", async () => {
      offline(wentAt);
      const slot = new Date("2026-10-20T14:00:00.000Z");
      let r = routine("0 16 * * 1-5", { type: "schedule", startWindowMinutes: 45 });
      // A start drawn right at the slot leaves no time before it.
      while (routines.drawnStart(r.id, slot, 45).getTime() - slot.getTime() < 2_000) {
        updateRoutine(r.id, { enabled: false });
        r = routine("0 16 * * 1-5", { type: "schedule", startWindowMinutes: 45 });
      }
      const at = routines.drawnStart(r.id, slot, 45);
      await back(new Date(at.getTime() - 1_000).toISOString());
      expect(runsOf(r.id)).toBe(0);
      expect(scheduledRoutines().find((s) => s.routineId === r.id)!.nextRunAt).toBe(at.toISOString());
    });

    test("without a heartbeat (the first start) nothing is caught up", async () => {
      const r = routine("0 15 * * 1-5");
      setSystemTime(new Date(backAt));
      expect(await catchUpMissed("start", Number.NaN)).toBe(0);
      expect(runsOf(r.id)).toBe(0);
    });
  });
});

describe("when a tick was due", () => {
  const job = new Cron("0 9 * * *", { timezone: "UTC", paused: true });
  const at = (iso: string) => new Date(iso);

  test("a tick on time is due now, not the day before", () => {
    expect(dueSlot(job, at("2026-10-20T09:00:00.004Z"))?.toISOString()).toBe("2026-10-20T09:00:00.000Z");
    expect(dueSlot(job, at("2026-10-20T08:59:59.600Z"))?.toISOString()).toBe("2026-10-20T09:00:00.000Z");
  });

  test("a tick a Mac fires after waking up is due at its time slot", () => {
    expect(dueSlot(job, at("2026-10-20T09:31:00.000Z"))?.toISOString()).toBe("2026-10-20T09:00:00.000Z");
  });
});
