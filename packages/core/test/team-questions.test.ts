import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { ensureDefaultAgent } from "../src/agents/service";
import { getConversation, startChat } from "../src/services/conversations";
import { listNotifications } from "../src/services/notifications";
import { isHeld, listQuestions, openQuestionCount, openQuestionOf, releaseQuestion } from "../src/services/questions";
import { getRun, waitForRun } from "../src/runner/runner";
import { callTool, listToolsFor } from "../src/mcp/tools";
import { updateSettings } from "../src/services/settings";
import { buildTeamPrompt, startTeam, stopTeam, teamLookNow } from "../src/review/teamQuestions";
import { all } from "../src/db";

let env: TestEnv;
let main: Agent;
let asker: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-team-");
  main = await ensureDefaultAgent();
  asker = await makeAgent({ name: "Ask Bot" });
  updateSettings({ general: { userName: "Dana" } });
  startTeam();
});

afterAll(async () => {
  stopTeam();
  await env.close();
});

async function asking() {
  const started = await startChat({ agentId: asker.id, content: "ASK_HUMAN please" });
  await until(() => getRun(started.run.id).status === "paused", 15_000, "the run to stand still for its question");
  return { ...started, question: openQuestionOf(started.conversation.id)! };
}

async function mainRun() {
  const started = await startChat({ agentId: main.id, content: "hello" });
  await waitForRun(started.run.id, 20_000);
  return { runId: started.run.id, agentId: main.id, conversationId: started.conversation.id, workspaceId: null, depth: 0 };
}

const questionNotices = (title: string) => listNotifications().filter((n) => n.kind === "question" && n.title.includes(title));

describe("Godmode answers the team first", () => {
  test("a team question is held from the human, and Godmode's answer continues the run", async () => {
    const { run, conversation, question } = await asking();
    expect(isHeld(question.id)).toBe(true);
    expect(questionNotices("Which color").length).toBe(0);
    expect(listQuestions({ status: "open" }).some((q) => q.id === question.id)).toBe(false);
    expect(openQuestionCount()).toBe(0);

    const ctx = await mainRun();
    const names = listToolsFor(main, ctx).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["team_questions_list", "team_question_answer", "task_approve"]));
    expect(names).toContain("ask_human");
    expect(listToolsFor(asker, { ...ctx, agentId: asker.id }).map((t) => t.name)).not.toContain("team_question_answer");

    const listed = await callTool(ctx, "team_questions_list", {});
    expect(listed.content[0]!.text).toContain(question.id);

    const asked = invocations(env).length;
    const out = await callTool(ctx, "team_question_answer", { id: question.id, option: "2" });
    expect(out.isError).toBeFalsy();
    const finished = await waitForRun(run.id, 20_000);
    expect(finished.status).toBe("succeeded");
    const prompt = invocations(env).slice(asked).find((i) => i.prompt.includes("<godmode-continue>"))!.prompt;
    expect(prompt).toContain("who leads the team for Dana, picked one of the answers you suggested");
    expect(isHeld(question.id)).toBe(false);
    const block = getConversation(conversation.id).messages.flatMap((m) => m.blocks).find((b) => b.type === "question" && b.id === question.id);
    expect(block).toMatchObject({ status: "answered", answer: { via: "agent", text: "Blue" } });
    expect(questionNotices("Which color").length).toBe(0);
  }, 60_000);

  test("what Godmode leaves reaches the human", async () => {
    const { question } = await asking();
    expect(questionNotices("Which color").length).toBe(0);
    releaseQuestion(question.id);
    expect(isHeld(question.id)).toBe(false);
    expect(questionNotices("Which color").length).toBe(1);
    expect(listQuestions({ status: "open" }).some((q) => q.id === question.id)).toBe(true);
  }, 30_000);

  test("Godmode looks in its archived Team questions chat; what it leaves reaches the human when it ends", async () => {
    const { question } = await asking();
    const asked = invocations(env).length;
    await teamLookNow();
    const run = all<{ id: string; conversation_id: string }>("SELECT id, conversation_id FROM runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1", main.id)[0]!;
    const conv = getConversation(run.conversation_id);
    expect(conv.title).toBe("Team questions");
    expect(conv.archived).toBe(true);
    await waitForRun(run.id, 20_000);
    const prompt = invocations(env).slice(asked).find((i) => i.prompt.includes("Team questions"))!.prompt;
    expect(prompt).toContain(question.id);
    await until(() => !isHeld(question.id), 5_000, "the question to be handed on");
    expect(questionNotices("Which color").length).toBe(2);
  }, 60_000);

  test("off: questions go straight to the human", async () => {
    updateSettings({ review: { team: false } });
    const { question } = await asking();
    expect(isHeld(question.id)).toBe(false);
    expect(questionNotices("Which color").length).toBe(3);
    updateSettings({ review: { team: true } });
  }, 30_000);

  test("the prompt lists questions and tickets as data", () => {
    const text = buildTeamPrompt({ human: "Dana", questions: [], tickets: [] });
    expect(text).toContain("Dana wants fewer questions");
    expect(text).toContain("task_approve");
  });
});
