import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { DEFAULT_MODEL, GLM_MODELS, ZAI_ANTHROPIC_BASE_URL, modelProvider } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import * as vault from "../src/vault/vault";
import { callTool } from "../src/mcp/tools";
import { buildSystemPrompt } from "../src/runner/prompt";
import { getModelCatalog } from "../src/runner/models";
import { waitForRun } from "../src/runner/runner";
import { chatFillOnly, getConversation, sendMessage, startChat, updateConversation } from "../src/services/conversations";
import { updateAgent } from "../src/agents/service";
import { ensureDreamListener, getDream, startDream } from "../src/memory/dreaming";
import { until } from "./fixtures/runner-harness";
import { getSettings } from "../src/services/settings";
import { checkSettingsPatch } from "../src/services/settingsPatch";

const GLM = GLM_MODELS[0]!.id;
let env: TestEnv;
let agent: Agent;
let boss: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-glm-");
  await vault.setup("correct horse battery staple", false);
  agent = await makeAgent({ name: "GLM Bot", description: "test agent" });
  boss = await makeAgent({ name: "Boss", permissions: { canManageAgents: true, allowDelegation: true } });
});

afterAll(async () => {
  await env.close();
});

async function chat(model: string | null) {
  const started = await startChat({ agentId: agent.id, content: "Hello there", model });
  return waitForRun(started.run.id, 20_000);
}

describe("GLM on Z.ai", () => {
  test("only glm-* ids run on Z.ai; Claude stays the default", () => {
    expect(modelProvider(GLM)).toBe("zai");
    expect(modelProvider("GLM-5.3")).toBe("zai");
    expect(modelProvider(DEFAULT_MODEL)).toBe("anthropic");
    expect(modelProvider("opus")).toBe("anthropic");
    expect(modelProvider(null)).toBe("anthropic");
  });

  test("the catalog lists GLM after Claude's models, without effort or Ultracode", async () => {
    const { models } = await getModelCatalog();
    const glm = models.find((m) => m.id === GLM)!;
    expect(glm).toMatchObject({ provider: "zai", efforts: [], ultracode: false });
    expect(models.at(-1)!.id).toBe(GLM);
    expect(models.filter((m) => m.id === GLM)).toHaveLength(1);
  });

  test("without a Z.ai key a GLM run fails with a clear message and never starts Claude Code", async () => {
    const before = invocations(env).length;
    const run = await chat(GLM);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("needs a Z.ai API key");
    expect(invocations(env).length).toBe(before);
  });

  test("a GLM run talks to Z.ai with the Z.ai key only, no effort, no Claude fallback", async () => {
    vault.setAppSecret("anthropic_api_key", "sk-ant-must-not-leak");
    vault.setAppSecret("zai_api_key", "zai-test-key");
    const run = await chat(GLM);
    expect(run.status).toBe("succeeded");
    const inv = invocations(env).at(-1)!;
    expect(argValue(inv, "--model")).toBe(GLM);
    expect(inv.args).not.toContain("--effort");
    expect(inv.args).not.toContain("--fallback-model");
    // Every credential Claude Code could send is the Z.ai key.
    expect(inv.env.ANTHROPIC_API_KEY).toBe("zai-test-key");
    expect(inv.env.ANTHROPIC_AUTH_TOKEN).toBe("zai-test-key");
    expect(inv.env.ANTHROPIC_BASE_URL).toBe(ZAI_ANTHROPIC_BASE_URL);
    expect(inv.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(GLM);
    expect(argValue(inv, "--append-system-prompt")).toContain(`This run uses ${GLM} on Z.ai`);
    expect(argValue(inv, "--append-system-prompt")).toContain("Vault secrets and API keys stay out of this run");
    const hidden = argValue(inv, "--disallowedTools")!.split(",");
    for (const tool of ["mcp__computer", "mcp__cua", "mcp__android", "mcp__vm__screen", "WebSearch"]) expect(hidden).toContain(tool);
    expect(run.model).toBe(GLM);
    expect(getConversation(run.conversationId).messages.at(-1)!.blocks.some((b) => b.type === "notice" && b.text.includes("on Z.ai, not Claude"))).toBe(true);
    expect(chatFillOnly(run.conversationId)).toBe(true);
  });

  test("switching a chat between Claude and GLM goes on in a new session with a recap", async () => {
    const first = await chat(null);
    const sessionId = getConversation(first.conversationId).claudeSessionId;
    expect(chatFillOnly(first.conversationId)).toBe(false);

    // GLM has a Claude Code config of its own: Claude's session isn't there, so the chat goes on with a recap.
    updateConversation(first.conversationId, { model: GLM });
    const { run: onGlm } = await sendMessage(first.conversationId, { content: "Second question" });
    expect((await waitForRun(onGlm.id, 20_000)).status).toBe("succeeded");
    let inv = invocations(env).at(-1)!;
    expect(argValue(inv, "--session-id")).not.toBe(sessionId);
    expect(inv.prompt).toContain("could not be restored");
    expect(inv.prompt).toContain("Hello there");
    expect(chatFillOnly(first.conversationId)).toBe(true);

    const { run: again } = await sendMessage(first.conversationId, { content: "Third question" });
    await waitForRun(again.id, 20_000);
    inv = invocations(env).at(-1)!;
    expect(inv.args).toContain("--resume");
    expect(inv.prompt).not.toContain("could not be restored");

    updateConversation(first.conversationId, { model: null });
    const { run: back } = await sendMessage(first.conversationId, { content: "Fourth question" });
    expect((await waitForRun(back.id, 20_000)).status).toBe("succeeded");
    inv = invocations(env).at(-1)!;
    expect(inv.args).not.toContain("--resume");
    expect(inv.prompt).toContain("could not be restored");
    expect(inv.prompt).toContain("Third question");
    expect(inv.env.ANTHROPIC_BASE_URL).toBeNull();
  }, 60_000);

  test("subagents and dreams stay on Claude", async () => {
    const updated = await updateAgent(agent.id, {
      subagents: [
        { name: "a", description: "d", prompt: "p", model: GLM },
        { name: "b", description: "d", prompt: "p", model: "sonnet" },
      ],
    });
    expect(updated.subagents.map((s) => s.model ?? null)).toEqual([null, "sonnet"]);
    expect(() => checkSettingsPatch({ memory: { dreaming: { model: GLM } } }, () => {})).toThrow(/dreaming model must be a Claude model/);
  });

  test("Claude runs are untouched by a saved Z.ai key", async () => {
    const run = await chat(null);
    expect(run.status).toBe("succeeded");
    const inv = invocations(env).at(-1)!;
    expect(argValue(inv, "--model")).toBe(DEFAULT_MODEL);
    expect(argValue(inv, "--fallback-model")).toBe("claude-sonnet-5");
    expect(inv.env.ANTHROPIC_API_KEY).toBe("sk-ant-must-not-leak");
    expect(inv.env.ANTHROPIC_BASE_URL).toBeNull();
    expect(inv.env.ANTHROPIC_AUTH_TOKEN).toBeNull();
    expect(argValue(inv, "--append-system-prompt")).not.toContain("on Z.ai, not Claude");
  });

  test("the default and the fallback model must be Claude", () => {
    const grant = () => {};
    expect(() => checkSettingsPatch({ runner: { model: GLM } }, grant)).toThrow(/must be a Claude model/);
    expect(() => checkSettingsPatch({ runner: { fallbackModel: GLM } }, grant)).toThrow(/must be a Claude model/);
    expect(() => checkSettingsPatch({ runner: { model: DEFAULT_MODEL, fallbackModel: "" } }, grant)).not.toThrow();
  });

  test("an agent on GLM still dreams on Claude", async () => {
    ensureDreamListener();
    const dreamer = await makeAgent({ name: "GLM Dreamer", model: GLM });
    const dream = await startDream(dreamer.id);
    await until(() => !!getDream(dream.id).runId, 10_000, "dream run");
    await waitForRun(getDream(dream.id).runId!, 20_000);
    const inv = invocations(env).findLast((i) => i.prompt.startsWith("Dream: consolidate"))!;
    expect(modelProvider(argValue(inv, "--model"))).toBe("anthropic");
    expect(inv.env.ANTHROPIC_BASE_URL).toBeNull();
  }, 30_000);

  test("managers learn GLM only as the exception, and only with a key", () => {
    const prompt = (glmDelegation: string | null) =>
      buildSystemPrompt({ agent: boss, settings: getSettings(), peers: [boss, agent], browserAvailable: false, glmDelegation });
    expect(prompt(GLM)).toContain(`agent_delegate({ agentId, task, model: "${GLM}" })`);
    expect(prompt(GLM)).toContain("Never for ordinary work");
    expect(prompt(null)).not.toContain("Z.ai");
  });

  test("agent_delegate hands one task to GLM without changing the agent", async () => {
    const started = await startChat({ agentId: boss.id, content: "Hello there" });
    await waitForRun(started.run.id, 20_000);
    const ctx = { runId: started.run.id, agentId: boss.id, conversationId: started.conversation.id, workspaceId: null, depth: 0 };
    const out = await callTool(ctx, "agent_delegate", { agentId: agent.id, task: "Hello there", model: GLM });
    expect(out.isError).toBeFalsy();
    const inv = invocations(env).at(-1)!;
    expect(argValue(inv, "--model")).toBe(GLM);
    expect(inv.env.ANTHROPIC_BASE_URL).toBe(ZAI_ANTHROPIC_BASE_URL);
    expect(agent.model ?? "").not.toBe(GLM);

    const bad = await callTool(ctx, "agent_delegate", { agentId: agent.id, task: "Hello there", model: "claude-opus-5-5" });
    expect(bad.isError).toBe(true);

    // Only managers route work to GLM.
    const helper = await makeAgent({ name: "Helper", permissions: { allowDelegation: true } });
    const own = await startChat({ agentId: helper.id, content: "Hello there" });
    await waitForRun(own.run.id, 20_000);
    const helperCtx = { runId: own.run.id, agentId: helper.id, conversationId: own.conversation.id, workspaceId: null, depth: 0 };
    const refused = await callTool(helperCtx, "agent_delegate", { agentId: agent.id, task: "Hello there", model: GLM, wait: false });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("Only a manager agent");

    vault.setAppSecret("zai_api_key", null);
    const noKey = await callTool(ctx, "agent_delegate", { agentId: agent.id, task: "Hello there", model: GLM });
    expect(noKey.isError).toBe(true);
    expect(noKey.content[0]!.text).toContain("needs a Z.ai API key");
    expect(getConversation(started.conversation.id).model).toBeNull();
  }, 30_000);
});
