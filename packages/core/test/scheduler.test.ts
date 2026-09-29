import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { createRoutine, getRoutine, runRoutineNow, updateRoutine } from "../src/services/routines";
import { reloadSchedules, scheduledRoutines, startScheduler, stopScheduler, triggerRoutine } from "../src/scheduler/scheduler";
import { HttpError, newId, now } from "../src/util";

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
  const createdConversations: { agentId: string; title?: string; origin?: string }[] = [];
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
        workingDirectory: null,
        computerTarget: null,
        vmId: null,
        browserProfileId: null,
        sshServerIds: [],
        instructions: "",
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
    expect(createdConversations).toEqual([{ agentId: agent.id, title: "Price check", origin: "routine" }]);
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

  test("scheduled ticks skip disabled routines", async () => {
    const routine = createRoutine({ agentId: agent.id, name: "Off", cron: "0 6 * * *", prompt: "x", enabled: false });
    expect((await catchHttp(triggerRoutine(routine.id, { scheduled: true }))).status).toBe(409);
    const manual = await triggerRoutine(routine.id);
    finish(manual);
    expect(sent).toHaveLength(1);
  });
});
