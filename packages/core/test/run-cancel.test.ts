import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, Run } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { get, insert } from "../src/db";
import { ensureDefaultAgent } from "../src/agents/service";
import { callTool } from "../src/mcp/tools";
import { getRun } from "../src/runner/runner";
import { newId, now } from "../src/util";

let env: TestEnv;
let worker: Agent;
let godmode: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-run-cancel-");
  worker = await makeAgent({ name: "Worker" });
  godmode = await ensureDefaultAgent();
});

afterAll(async () => {
  await env.close();
});

function chat(owner: Agent, runnerId: string | null = null): string {
  const id = newId("cnv");
  insert("conversations", { id, agent_id: owner.id, title: "Work", origin: "chat", runner_id: runnerId, created_at: now(), updated_at: now() });
  return id;
}

function addRun(owner: Agent, status: Run["status"], opts: { conversationId?: string; parent?: string } = {}): string {
  const id = newId("run");
  const conversationId = opts.conversationId ?? chat(owner);
  insert("runs", { id, agent_id: owner.id, conversation_id: conversationId, trigger: "chat", status, prompt: "Post the video", parent_run_id: opts.parent ?? null, created_at: now(), started_at: now() });
  return id;
}

function ctxOf(owner: Agent, runId = addRun(owner, "running")) {
  return { runId, agentId: owner.id, conversationId: getRun(runId).conversationId, workspaceId: owner.workspaceId, depth: 0 };
}

describe("run_cancel", () => {
  test("a manager stops a paused run of a teammate for good", async () => {
    const paused = addRun(worker, "paused");
    const res = await callTool(ctxOf(godmode), "run_cancel", { runId: paused, reason: "the work was redone elsewhere" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain("Stopped run");
    const run = getRun(paused);
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe("Stopped by Godmode: the work was redone elsewhere");
  });

  test("a queued run without a live job is closed too", async () => {
    const queued = addRun(worker, "queued");
    const res = await callTool(ctxOf(godmode), "run_cancel", { runId: queued });
    expect(res.isError).toBeFalsy();
    expect(getRun(queued).status).toBe("cancelled");
  });

  test("a run that already ended is left as it is", async () => {
    const done = addRun(worker, "succeeded");
    const res = await callTool(ctxOf(godmode), "run_cancel", { runId: done });
    expect(res.content[0]!.text).toContain("already ended");
    expect(getRun(done).status).toBe("succeeded");
  });

  test("it refuses the caller's own run and the run that handed it its task", async () => {
    const parent = addRun(godmode, "running");
    const own = addRun(godmode, "running", { parent });
    const ctx = ctxOf(godmode, own);
    for (const runId of [own, parent]) {
      const res = await callTool(ctx, "run_cancel", { runId });
      expect(res.isError).toBe(true);
      expect(getRun(runId).status).toBe("running");
    }
  });

  test("a run of a chat on an unknown computer is not closed here", async () => {
    const remote = addRun(worker, "paused", { conversationId: chat(worker, "rnr_gone") });
    const res = await callTool(ctxOf(godmode), "run_cancel", { runId: remote });
    expect(res.isError).toBe(true);
    expect(get<{ status: string }>("SELECT status FROM runs WHERE id = ?", remote)?.status).toBe("paused");
  });

  test("agents that manage nobody don't get the tool", async () => {
    const res = await callTool(ctxOf(worker), "run_cancel", { runId: addRun(godmode, "paused") });
    expect(res.isError).toBe(true);
  });
});
