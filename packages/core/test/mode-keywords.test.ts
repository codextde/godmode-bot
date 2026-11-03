import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, RunTrigger } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { waitForRun } from "../src/runner/runner";
import { modeKeywordsOff, skipKeywordDetector } from "../src/runner/modeKeywords";
import { createConversation, sendMessage } from "../src/services/conversations";

const HAND_OVER = "Test AI end to end on a seeded marketplace ticket";
const AUTOPILOT_SKILL = "Skill(oh-my-claudecode:autopilot)";

describe("modeKeywordsOff", () => {
  test("the human's own words keep the keywords", () => {
    expect(modeKeywordsOff(true, HAND_OVER)).toBe(false);
  });

  test("words nobody typed lose them, also when they name a mode", () => {
    expect(modeKeywordsOff(false, HAND_OVER)).toBe(true);
    expect(modeKeywordsOff(false, "The bug: autopilot starts by accident, see /oh-my-claudecode:autopilot in the docs")).toBe(true);
    expect(modeKeywordsOff(false, "/autopilots are not a command")).toBe(true);
  });

  test("a mode's slash command on its own line is a real request", () => {
    for (const line of ["/oh-my-claudecode:autopilot build it", "/autopilot build it", "/omc:ralph fix it", "/oh-my-claudecode:team 2 go", "/ultragoal", "/ralplan x"]) {
      expect(modeKeywordsOff(false, line)).toBe(false);
      expect(modeKeywordsOff(false, `[Delegated by a teammate.]\n\n${line}`)).toBe(false);
    }
  });
});

describe("skipKeywordDetector", () => {
  test("keeps what the human already skips", () => {
    const env: Record<string, string | undefined> = { OMC_SKIP_HOOKS: "notepad, keyword-detector" };
    skipKeywordDetector(env);
    expect(env.OMC_SKIP_HOOKS).toBe("notepad,keyword-detector");
    const empty: Record<string, string | undefined> = {};
    skipKeywordDetector(empty);
    expect(empty.OMC_SKIP_HOOKS).toBe("keyword-detector");
  });
});

describe("runs", () => {
  let env: TestEnv;
  let agent: Agent;

  beforeAll(async () => {
    env = await setupEnv();
    agent = await makeAgent({ name: "Keyword Bot" });
  });

  afterAll(async () => {
    await env.close();
  });

  async function runWith(input: Parameters<typeof sendMessage>[1]) {
    const conversation = createConversation({ agentId: agent.id });
    const { run } = await sendMessage(conversation.id, input);
    await waitForRun(run.id, 20_000);
    const inv = invocations(env).at(-1)!;
    return { skip: inv.env.OMC_SKIP_HOOKS, disallowed: argValue(inv, "--disallowedTools") ?? "" };
  }

  test("oh-my-claudecode's read gate is off, Claude Code's Read sets the limit", async () => {
    const conversation = createConversation({ agentId: agent.id });
    const { run } = await sendMessage(conversation.id, { content: "Read the notes", trigger: "chat" });
    await waitForRun(run.id, 20_000);
    expect(invocations(env).at(-1)!.env.OMC_READ_BUDGET).toBe("off");
  });

  test("typed in a chat: the detector stays on", async () => {
    const { skip, disallowed } = await runWith({ content: HAND_OVER, trigger: "chat" });
    expect(skip).toBeNull();
    expect(disallowed).not.toContain(AUTOPILOT_SKILL);
  });

  for (const trigger of ["delegation", "routine", "heartbeat", "followup", "task", "check", "call"] as RunTrigger[]) {
    test(`${trigger}: the detector is off`, async () => {
      const { skip, disallowed } = await runWith({ content: HAND_OVER, trigger });
      expect(skip).toBe("keyword-detector");
      expect(disallowed).toContain(AUTOPILOT_SKILL);
    });
  }

  test("a chat run with a text nobody typed there: the detector is off", async () => {
    for (const extra of [{ marker: [{ type: "retry", mode: "again", runId: "r", at: "t" }] }, { source: "offer" }, { fromOther: true }] as Partial<Parameters<typeof sendMessage>[1]>[]) {
      const { skip } = await runWith({ content: "Try again", prompt: HAND_OVER, trigger: "chat", ...extra });
      expect(skip).toBe("keyword-detector");
    }
  });

  test("a delegated slash command keeps the detector and may start the skill", async () => {
    const { skip, disallowed } = await runWith({ content: `[Delegated]\n/oh-my-claudecode:autopilot ${HAND_OVER}`, trigger: "delegation" });
    expect(skip).toBeNull();
    expect(disallowed).not.toContain(AUTOPILOT_SKILL);
  });
});
