import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { DEFAULT_MODEL, GLM_MODELS, ZAI_ANTHROPIC_BASE_URL, modelProvider } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import * as vault from "../src/vault/vault";
import { callTool } from "../src/mcp/tools";
import { buildSystemPrompt } from "../src/runner/prompt";
import { getModelCatalog } from "../src/runner/models";
import { waitForRun } from "../src/runner/runner";
import { getConversation, startChat } from "../src/services/conversations";
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
    expect(inv.env.ANTHROPIC_API_KEY).toBeNull();
    expect(inv.env.ANTHROPIC_AUTH_TOKEN).toBe("zai-test-key");
    expect(inv.env.ANTHROPIC_BASE_URL).toBe(ZAI_ANTHROPIC_BASE_URL);
    expect(inv.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(GLM);
    expect(argValue(inv, "--append-system-prompt")).toContain(`This run uses ${GLM} on Z.ai`);
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

    vault.setAppSecret("zai_api_key", null);
    const noKey = await callTool(ctx, "agent_delegate", { agentId: agent.id, task: "Hello there", model: GLM });
    expect(noKey.isError).toBe(true);
    expect(noKey.content[0]!.text).toContain("needs a Z.ai API key");
    expect(getConversation(started.conversation.id).model).toBeNull();
  }, 30_000);
});
