/**
 * `goal_clear`: an agent ends its chat's `/goal` itself when the human dropped it, instead of handing them a task to
 * type `/goal clear`. The goal's check no longer holds the turn up, and Godmode clears the goal in the session after it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, MessageBlock } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { callTool } from "../src/mcp/tools";
import { chatGoal, getConversation, sendMessage, startChat } from "../src/services/conversations";
import { waitForRun } from "../src/runner/runner";

let env: TestEnv;
let agent: Agent;
let configDir: string;
const configBefore = process.env.CLAUDE_CONFIG_DIR;

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "godmode-goal-claude-"));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  env = await setupEnv("godmode-goal-clear-");
  agent = await makeAgent({ name: "Goal Bot", description: "test agent" });
});

afterAll(async () => {
  await env.close();
  if (configBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configBefore;
  rmSync(configDir, { recursive: true, force: true });
});

const notices = (blocks: MessageBlock[]) => blocks.flatMap((b) => (b.type === "notice" ? [b.text] : []));
const clears = () => (existsSync(join(env.stateDir, "goal-clears")) ? readFileSync(join(env.stateDir, "goal-clears"), "utf8").split("\n").filter(Boolean).length : 0);

async function chat(): Promise<{ conversationId: string; sessionId: string }> {
  const started = await startChat({ agentId: agent.id, content: "hello" });
  await waitForRun(started.run.id, 20_000);
  const conversationId = started.conversation.id;
  return { conversationId, sessionId: getConversation(conversationId).claudeSessionId! };
}

function goalStatus(sessionId: string, status: Record<string, unknown>) {
  const dir = join(configDir, "projects", "-tmp-somewhere");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "attachment", attachment: { type: "goal_status", ...status } })}\n`);
}

describe("the chat's goal", () => {
  test("is the latest goal status of its Claude session: none once it was met, failed or cleared", async () => {
    const { conversationId, sessionId } = await chat();
    expect(chatGoal(conversationId)).toBeNull();
    goalStatus(sessionId, { met: false, sentinel: true, condition: "ship the report" });
    expect(chatGoal(conversationId)).toBe("ship the report");
    goalStatus(sessionId, { met: false, condition: "ship the report", reason: "Not yet." });
    expect(chatGoal(conversationId)).toBe("ship the report");
    goalStatus(sessionId, { met: true, sentinel: true, condition: "ship the report" });
    expect(chatGoal(conversationId)).toBeNull();
    goalStatus(sessionId, { met: false, sentinel: true, condition: "and the invoice" });
    expect(chatGoal(conversationId)).toBe("and the invoice");
    goalStatus(sessionId, { met: false, failed: true, condition: "and the invoice" });
    expect(chatGoal(conversationId)).toBeNull();
  });
});

describe("goal_clear", () => {
  test("the agent ends the goal: the run ends at the goal's check, the goal is cleared and the chat says why", async () => {
    const { conversationId, sessionId } = await chat();
    const before = clears();
    rmSync(join(env.stateDir, "goal-clear-idled"), { force: true });
    const run = await waitForRun((await sendMessage(conversationId, { content: "GOAL_CLEAR" })).run.id, 20_000);
    expect(run.status).toBe("succeeded");
    expect(run.error).toBeNull();
    // It doesn't sit out the continuation the goal's check forced.
    expect(existsSync(join(env.stateDir, "goal-clear-idled"))).toBe(false);

    const called = JSON.parse(readFileSync(join(env.stateDir, "goal-clear-result.json"), "utf8")) as { isError?: boolean; content: { text: string }[] };
    expect(called.isError).toBeFalsy();
    expect(called.content[0]!.text).toContain("sell the course and make the first sale");

    const message = getConversation(conversationId).messages.at(-1)!;
    expect(message.content).toBe("The line is closed, the site stays live.");
    expect(notices(message.blocks)).toContain("Goal ended: “sell the course and make the first sale” — Daniel decided to end it.");
    expect(notices(message.blocks).some((t) => t.startsWith("Goal still open"))).toBe(false);

    expect(clears()).toBe(before + 1);
    const clear = invocations(env).at(-1)!;
    expect(clear.prompt).toBe("/goal clear");
    expect(argValue(clear, "--resume")).toBe(sessionId);
    expect(chatGoal(conversationId)).toBeNull();
    // The chat goes on in the same session.
    expect(getConversation(conversationId).claudeSessionId).toBe(sessionId);
  });

  test("called in a continuation the goal's check forced, it waits for the next check: the answer stays", async () => {
    const { conversationId } = await chat();
    rmSync(join(env.stateDir, "goal-clear-idled"), { force: true });
    const run = await waitForRun((await sendMessage(conversationId, { content: "GOAL_CLEAR_LATE" })).run.id, 20_000);
    expect(run.status).toBe("succeeded");
    expect(existsSync(join(env.stateDir, "goal-clear-idled"))).toBe(false);
    const message = getConversation(conversationId).messages.at(-1)!;
    expect(message.content).toContain("The line is closed, the site stays live.");
    expect(notices(message.blocks).filter((t) => t.startsWith("Goal ended"))).toHaveLength(1);
    expect(chatGoal(conversationId)).toBeNull();
  });

  test("a chat without a goal has nothing to end", async () => {
    const { conversationId } = await chat();
    const out = await callTool({ runId: "run_goal_test", agentId: agent.id, conversationId, workspaceId: null, depth: 0 }, "goal_clear", { reason: "Daniel ended it." });
    expect(out.isError).toBeFalsy();
    expect(out.content[0]!.text).toBe("This chat has no active /goal — nothing to end.");
  });

  test("a run that isn't working anymore keeps the goal", async () => {
    const { conversationId, sessionId } = await chat();
    goalStatus(sessionId, { met: false, sentinel: true, condition: "ship the report" });
    const out = await callTool({ runId: "run_gone", agentId: agent.id, conversationId, workspaceId: null, depth: 0 }, "goal_clear", { reason: "Daniel ended it." });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain("the goal stays");
    expect(chatGoal(conversationId)).toBe("ship the report");
  });
});
