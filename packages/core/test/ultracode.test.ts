import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Conversation, ConversationWithMessages, ModelCatalog, ServerEvent, Settings, StartChatResult } from "@godmode/shared";
import { WORKFLOW_TOOL } from "@godmode/shared";
import { argValue, captureEvents, invocations, makeAgent, setupEnv, until, type Invocation, type TestEnv } from "./fixtures/runner-harness";
import { getRun, startRun, waitForRun } from "../src/runner/runner";
import { __resetModelCatalogForTests, getModelCatalog, ultracodeFor } from "../src/runner/models";
import { createConversation, getConversation, sendMessage, startChat, updateConversation } from "../src/services/conversations";
import { getAgent, updateAgent } from "../src/agents/service";
import { getSettings, updateSettings } from "../src/services/settings";
import { ensureDreamListener, getDream, startDream } from "../src/memory/dreaming";
import { callTool } from "../src/mcp/tools";
import { buildLogReport } from "../src/diagnostics/logs";
import { getAccessToken } from "../src/server/auth";
import * as vault from "../src/vault/vault";
import { createCredential } from "../src/vault/credentials";

let env: TestEnv;
let agent: Agent;

const cacheFile = () => join(env.dataDir, "claude-models.json");
const probes = () => {
  const file = join(env.stateDir, "probes.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
};
const requestsFile = () => join(env.stateDir, "control-requests.jsonl");
/** What the last probe asked Claude Code, in order. */
const asked = () =>
  readFileSync(requestsFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { subtype: string; model?: string })
    .map((r) => (r.model ? `${r.subtype} ${r.model}` : r.subtype));
/** Ask Claude Code again, as on a first start. */
async function probe() {
  __resetModelCatalogForTests();
  rmSync(cacheFile(), { force: true });
  rmSync(requestsFile(), { force: true });
  return getModelCatalog();
}
const probeEnv = ["FAKE_CLAUDE_ULTRACODE", "FAKE_CLAUDE_SESSION_MODEL", "FAKE_CLAUDE_SET_MODEL"];

async function send(conversationId: string, content: string): Promise<{ inv: Invocation; conv: ConversationWithMessages }> {
  const { run } = await sendMessage(conversationId, { content });
  expect((await waitForRun(run.id, 20_000)).status).toBe("succeeded");
  return { inv: invocations(env).at(-1)!, conv: getConversation(conversationId) };
}

const allowedTools = (inv: Invocation) => (argValue(inv, "--allowedTools") ?? "").split(",");

beforeAll(async () => {
  env = await setupEnv("godmode-ultracode-");
  agent = await makeAgent({ name: "Ultra Bot" });
});

beforeEach(() => {
  for (const key of probeEnv) delete process.env[key];
});

afterAll(async () => {
  for (const key of probeEnv) delete process.env[key];
  __resetModelCatalogForTests();
  await env.close();
});

describe("Ultracode in the model catalog", () => {
  test("no catalog, no Ultracode", () => {
    __resetModelCatalogForTests();
    expect(ultracodeFor("opus", true)).toBe(false);
  });

  test("one probe asks for the models and the session's settings", async () => {
    const before = probes();
    const catalog = await probe();
    expect(probes()).toBe(before + 1);
    expect(catalog.source).toBe("claude");
    expect(catalog.models.map((m) => [m.id, m.ultracode])).toEqual([
      ["opus", true],
      ["sonnet", true],
      ["haiku", false],
      ["claude-opus-8", false],
    ]);
    expect(JSON.parse(readFileSync(cacheFile(), "utf8")).models[0].ultracode).toBe(true);
    expect(asked()).toEqual(["initialize", "get_settings"]);
  });

  test("ultracodeFor: off, per model, and custom ids", async () => {
    await getModelCatalog();
    expect(ultracodeFor("opus", true)).toBe(true);
    expect(ultracodeFor("claude-sonnet-9", true)).toBe(true);
    expect(ultracodeFor("haiku", true)).toBe(false);
    expect(ultracodeFor("claude-opus-8", true)).toBe(false);
    expect(ultracodeFor("us.anthropic.some-custom-model-v1:0", true)).toBe(true);
    expect(ultracodeFor("opus", false)).toBe(false);
    expect(ultracodeFor("us.anthropic.some-custom-model-v1:0", false)).toBe(false);
  });

  test("without dynamic workflows no model has it", async () => {
    process.env.FAKE_CLAUDE_ULTRACODE = "off";
    const catalog = await probe();
    expect(catalog.source).toBe("claude");
    expect(catalog.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku", "claude-opus-8"]);
    expect(catalog.models.some((m) => m.ultracode)).toBe(false);
    expect(ultracodeFor("opus", true)).toBe(false);
    expect(ultracodeFor("us.anthropic.some-custom-model-v1:0", true)).toBe(false);
    // The session's model has the level, so the answer is about the workflows: the model is left alone.
    expect(asked()).toEqual(["initialize", "get_settings"]);
  });

  test("a session model without the xhigh level: asked again with a model that has it", async () => {
    // One without effort levels, one without that level, one the list doesn't know.
    for (const session of ["haiku", "claude-opus-8", "claude-custom-1"]) {
      process.env.FAKE_CLAUDE_SESSION_MODEL = session;
      const catalog = await probe();
      expect(asked()).toEqual(["initialize", "get_settings", "set_model opus", "get_settings"]);
      expect(catalog.models.map((m) => m.ultracode)).toEqual([true, true, false, false]);
    }

    // The second answer decides: no dynamic workflows with a capable model either.
    process.env.FAKE_CLAUDE_ULTRACODE = "off";
    const off = await probe();
    expect(asked()).toEqual(["initialize", "get_settings", "set_model opus", "get_settings"]);
    expect(off.source).toBe("claude");
    expect(off.models.some((m) => m.ultracode)).toBe(false);
  });

  test("a model switch that fails or gets no answer leaves it off, and nothing more is asked", async () => {
    process.env.FAKE_CLAUDE_SESSION_MODEL = "haiku";
    for (const mode of ["error", "silent"]) {
      process.env.FAKE_CLAUDE_SET_MODEL = mode;
      const catalog = await probe();
      expect(asked()).toEqual(["initialize", "get_settings", "set_model opus"]);
      expect(catalog.source).toBe("claude");
      expect(catalog.error).toBeNull();
      expect(catalog.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku", "claude-opus-8"]);
      expect(catalog.models.some((m) => m.ultracode)).toBe(false);
    }
  }, 30_000);

  test("a Claude Code from before Ultracode still lists its models", async () => {
    // It rejects the request, answers without the fields, or never answers.
    for (const mode of ["error", "unknown", "silent"]) {
      process.env.FAKE_CLAUDE_ULTRACODE = mode;
      const catalog = await probe();
      expect(catalog.source).toBe("claude");
      expect(catalog.error).toBeNull();
      expect(catalog.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku", "claude-opus-8"]);
      expect(catalog.models.some((m) => m.ultracode)).toBe(false);
      expect(ultracodeFor("opus", true)).toBe(false);
    }
  }, 30_000);

  test("the built-in list has no Ultracode", async () => {
    process.env.FAKE_CLAUDE_MODELS = "silent";
    try {
      const catalog = await probe();
      expect(catalog.source).toBe("builtin");
      expect(catalog.models.some((m) => m.ultracode)).toBe(false);
      expect(ultracodeFor("claude-opus-5-5", true)).toBe(false);
    } finally {
      delete process.env.FAKE_CLAUDE_MODELS;
    }
  });

  test("a question about Ultracode that got no answer is asked again soon; a 'no' is kept", async () => {
    // Older than the short wait before another try, younger than a list that is good for a while.
    const age = (catalog: ModelCatalog) => (catalog.fetchedAt = new Date(Date.now() - 2 * 60_000).toISOString());
    const unanswered: Record<string, string>[] = [
      { FAKE_CLAUDE_ULTRACODE: "silent" },
      { FAKE_CLAUDE_ULTRACODE: "exit" },
      { FAKE_CLAUDE_SESSION_MODEL: "haiku", FAKE_CLAUDE_SET_MODEL: "silent" },
    ];
    for (const switches of unanswered) {
      Object.assign(process.env, switches);
      const unknown = await probe();
      // Not a failed probe: the list is Claude Code's, without Ultracode for now.
      expect(unknown.source).toBe("claude");
      expect(unknown.error).toBeNull();
      expect(unknown.models.some((m) => m.ultracode)).toBe(false);
      age(unknown);
      for (const key of probeEnv) delete process.env[key];
      const before = probes();
      const { events, stop } = captureEvents();
      try {
        expect((await getModelCatalog()).models.some((m) => m.ultracode)).toBe(false);
        await until(() => events.some((e: ServerEvent) => e.type === "entity.changed" && e.entity === "models"), 10_000, "models changed");
      } finally {
        stop();
      }
      expect(probes()).toBe(before + 1);
      expect((await getModelCatalog()).models.map((m) => m.ultracode)).toEqual([true, true, false, false]);
    }

    // Answered: no workflows, or a Claude Code that doesn't know the request or the field.
    for (const mode of ["off", "error", "unknown"]) {
      process.env.FAKE_CLAUDE_ULTRACODE = mode;
      age(await probe());
      const before = probes();
      expect((await getModelCatalog()).models.some((m) => m.ultracode)).toBe(false);
      await new Promise((r) => setTimeout(r, 500));
      expect(probes()).toBe(before);
    }
  }, 60_000);

  test("a cache from before Ultracode is served without it and asked for again", async () => {
    __resetModelCatalogForTests();
    const old = {
      models: [{ id: "opus", resolvedModel: "claude-opus-9", label: "Opus 9", description: "", efforts: ["low", "medium", "high", "xhigh", "max"], latest: true }],
      source: "claude",
      claudeVersion: "9.9.8",
      fetchedAt: new Date().toISOString(),
      error: null,
    };
    writeFileSync(cacheFile(), JSON.stringify(old));
    expect(ultracodeFor("opus", true)).toBe(false);
    const { events, stop } = captureEvents();
    try {
      const served = await getModelCatalog();
      expect(served.models).toEqual([{ ...old.models[0]!, efforts: ["low", "medium", "high", "xhigh", "max"], ultracode: false }]);
      await until(() => events.some((e: ServerEvent) => e.type === "entity.changed" && e.entity === "models"), 10_000, "models changed");
    } finally {
      stop();
    }
    expect((await getModelCatalog()).models.map((m) => m.ultracode)).toEqual([true, true, false, false]);
    expect(ultracodeFor("opus", true)).toBe(true);
  });
});

describe("Ultracode in runs", () => {
  let conversationId = "";

  beforeAll(async () => {
    await probe();
  });

  test("off by default: the run's settings hold the hooks only", async () => {
    expect(getSettings().runner.ultracode).toBe(false);
    const started = await startChat({ agentId: agent.id, content: "Hi" });
    conversationId = started.conversation.id;
    expect(started.conversation.ultracode).toBeNull();
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
    const inv = invocations(env).at(-1)!;
    expect(inv.args).toContain("--settings");
    expect(inv.settings!.hooks).toBeDefined();
    expect(inv.settings).not.toHaveProperty("ultracode");
  });

  test("the chat's choice wins over the agent's, the agent's over the setting", async () => {
    const on = async () => (await send(conversationId, "Again")).inv.settings!.ultracode === true;
    updateSettings({ runner: { ultracode: true } });
    try {
      expect(await on()).toBe(true);
      const { inv } = await send(conversationId, "Once more");
      // The hooks stay, and with full access nothing needs to be allowed.
      expect(inv.settings!.hooks).toBeDefined();
      expect(inv.args).toContain("--dangerously-skip-permissions");
      expect(inv.args).not.toContain("--allowedTools");

      await updateAgent(agent.id, { ultracode: false });
      expect(await on()).toBe(false);
      updateConversation(conversationId, { ultracode: true });
      expect(await on()).toBe(true);

      await updateAgent(agent.id, { ultracode: true });
      updateConversation(conversationId, { ultracode: false });
      expect(await on()).toBe(false);
      updateConversation(conversationId, { ultracode: null });
      expect(await on()).toBe(true);

      updateSettings({ runner: { ultracode: false } });
      expect(await on()).toBe(true);
      await updateAgent(agent.id, { ultracode: null });
      expect(await on()).toBe(false);
    } finally {
      updateSettings({ runner: { ultracode: false } });
      await updateAgent(agent.id, { ultracode: null });
      updateConversation(conversationId, { ultracode: null });
    }
  });

  test("a model without it runs without it", async () => {
    updateConversation(conversationId, { ultracode: true, model: "haiku" });
    try {
      const { inv } = await send(conversationId, "Again");
      expect(argValue(inv, "--model")).toBe("haiku");
      expect(inv.settings!.hooks).toBeDefined();
      expect(inv.settings).not.toHaveProperty("ultracode");

      updateConversation(conversationId, { model: "us.anthropic.some-custom-model-v1:0" });
      expect((await send(conversationId, "Again")).inv.settings!.ultracode).toBe(true);
    } finally {
      updateConversation(conversationId, { ultracode: null, model: null });
    }
  });

  test("without full access, workflows are allowed up front — only with Ultracode", async () => {
    updateSettings({ runner: { bypassPermissions: false } });
    try {
      const off = (await send(conversationId, "Again")).inv;
      expect(argValue(off, "--permission-mode")).toBe("acceptEdits");
      expect(allowedTools(off)).toEqual(["mcp__godmode"]);

      updateConversation(conversationId, { ultracode: true });
      const on = (await send(conversationId, "Again")).inv;
      expect(on.settings!.ultracode).toBe(true);
      expect(allowedTools(on)).toEqual(["mcp__godmode", WORKFLOW_TOOL]);
    } finally {
      updateSettings({ runner: { bypassPermissions: true } });
      updateConversation(conversationId, { ultracode: null });
    }
  });

  test("condition checks and dreams never get it", async () => {
    updateSettings({ runner: { ultracode: true, bypassPermissions: false } });
    try {
      const checks = createConversation({ agentId: agent.id, title: "Checks", origin: "routine", ultracode: true });
      const check = await startRun({ agentId: agent.id, conversationId: checks.id, prompt: "Is the report there?", trigger: "check" });
      expect((await waitForRun(check.id, 20_000)).status).toBe("succeeded");
      let inv = invocations(env).at(-1)!;
      expect(inv.prompt).toBe("Is the report there?");
      expect(inv.settings).toBeNull();
      expect(inv.args).not.toContain("--settings");
      expect(allowedTools(inv)).not.toContain(WORKFLOW_TOOL);

      ensureDreamListener();
      const dream = await startDream((await makeAgent({ name: "Ultra Dreamer" })).id);
      await until(() => !!getDream(dream.id).runId, 10_000, "dream run");
      await waitForRun(getDream(dream.id).runId!, 20_000);
      await until(() => !["queued", "running"].includes(getDream(dream.id).status), 10_000, "dream settled");
      inv = invocations(env).findLast((i) => i.prompt.startsWith("Dream: consolidate"))!;
      // The dreaming model would have it.
      expect(ultracodeFor(argValue(inv, "--model")!, true)).toBe(true);
      expect(inv.settings).toBeNull();
      expect(inv.args).not.toContain("--settings");
      expect(inv.args).not.toContain(WORKFLOW_TOOL);
    } finally {
      updateSettings({ runner: { ultracode: false, bypassPermissions: true } });
    }
  }, 30_000);

  test("/effort ultracode on and off stick to the chat", async () => {
    const on = await send(conversationId, "/effort ultracode");
    expect(on.conv.messages.at(-1)!.content).toStartWith("Ultracode on (this session only): ");
    expect(on.conv.ultracode).toBe(true);
    expect(on.conv.effort).toBeNull();
    expect((await send(conversationId, "Hi again")).inv.settings!.ultracode).toBe(true);

    const off = await send(conversationId, "/effort ultracode off");
    expect(off.conv.messages.at(-1)!.content).toBe("Ultracode off. Effort stays high.");
    expect(off.conv.ultracode).toBe(false);
    expect((await send(conversationId, "Hi again")).inv.settings).not.toHaveProperty("ultracode");

    expect((await send(conversationId, "/effort ultracode on")).conv.ultracode).toBe(true);
  });

  test("a new effort level ends the chat's Ultracode", async () => {
    const high = await send(conversationId, "/effort max");
    expect(high.conv.messages.at(-1)!.content).toBe("Set effort level to max (this session only) · Ultracode off");
    expect(high.conv.effort).toBe("max");
    expect(high.conv.ultracode).toBe(false);
    // Without Ultracode a level leaves the chat's choice alone.
    updateConversation(conversationId, { ultracode: null });
    expect((await send(conversationId, "/effort low")).conv).toMatchObject({ effort: "low", ultracode: null });

    updateConversation(conversationId, { ultracode: true });
    const auto = await send(conversationId, "/effort auto");
    expect(auto.conv.messages.at(-1)!.content).toBe("Effort level set to auto (this session only) · Ultracode off");
    expect(auto.conv.effort).toBeNull();
    expect(auto.conv.ultracode).toBe(false);
  });

  test("an Ultracode that Claude Code refuses is not stored", async () => {
    updateConversation(conversationId, { ultracode: null, model: "haiku" });
    try {
      const model = await send(conversationId, "/effort ultracode");
      expect(model.conv.messages.at(-1)!.content).toStartWith("Ultracode isn't available on Haiku 9.");
      expect(model.conv.ultracode).toBeNull();

      updateConversation(conversationId, { model: null });
      process.env.FAKE_CLAUDE_ULTRACODE = "off";
      const workflows = await send(conversationId, "/effort ultracode on");
      expect(workflows.conv.messages.at(-1)!.content).toStartWith("Ultracode needs dynamic workflows enabled (see /config).");
      expect(workflows.conv.ultracode).toBeNull();
    } finally {
      updateConversation(conversationId, { model: null });
    }
  });

  test("a workflow that outlives its turn: the answer, the task and the sums of both results", async () => {
    const { events, stop } = captureEvents();
    let started: StartChatResult;
    const startedAt = Date.now();
    try {
      started = await startChat({ agentId: agent.id, content: "USE_WORKFLOW" });
      expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
    } finally {
      stop();
    }
    const elapsed = Date.now() - startedAt;
    const run = getRun(started.run.id);
    expect(run.result).toBe("The total is **2 words**: a.txt has 1 word and b.txt has 1 word.");
    expect(run.numTurns).toBe(3);
    // The time the run took by the clock: the two results (4494 + 1706 ms) leave out the wait for the workflow.
    expect(run.durationMs).toBeGreaterThan(0);
    expect(run.durationMs).toBeLessThanOrEqual(elapsed);
    expect(run.durationMs).not.toBe(4494 + 1706);
    expect(run.costUsd).toBeCloseTo(0.1025937);
    expect(run.usage).toEqual({ inputTokens: 8, outputTokens: 354, cacheReadTokens: 58139, cacheWriteTokens: 12179 });

    const answer = getConversation(started.conversation.id).messages.at(-1)!;
    expect(answer.content).toBe(run.result!);
    expect(answer.blocks.map((b) => b.type)).toEqual(["tool_use", "text", "text"]);
    const tool = answer.blocks[0]!;
    expect(tool.type === "tool_use" && tool.task).toMatchObject({ kind: "local_workflow", status: "completed", totalTokens: 18556, agents: [{ label: "a.txt", state: "done" }, { label: "b.txt", state: "done" }] });

    const labels = events.flatMap((e) => (e.type === "run.activity" && e.runId === run.id ? [e.label] : []));
    expect(labels).toContain("Running workflow · Count words in a.txt and b.txt with two agents");
    expect(labels).toContain("Running workflow · Count: a.txt");
    expect(labels.at(-1)).toBe("Done");

    // A run with one result keeps the time Claude Code reports for it.
    const plain = await startChat({ agentId: agent.id, content: "Hi" });
    expect((await waitForRun(plain.run.id, 20_000)).durationMs).toBe(2941);
  });
});

describe("Ultracode in routes and tools", () => {
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${env.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("agents: set, switch off, back to the default; no other values", async () => {
    const created = (await (await api("POST", "/api/agents", { name: "Ultra Route Bot", ultracode: true, browser: { enabled: false } })).json()) as Agent;
    expect(created.ultracode).toBe(true);
    expect(getAgent(created.id).ultracode).toBe(true);
    expect(JSON.parse(readFileSync(join(created.repoPath, "state/agent.json"), "utf8")).ultracode).toBe(true);

    const off = (await (await api("PATCH", `/api/agents/${created.id}`, { ultracode: false })).json()) as Agent;
    expect(off.ultracode).toBe(false);
    // Other changes leave it alone.
    expect(((await (await api("PATCH", `/api/agents/${created.id}`, { description: "Routes" })).json()) as Agent).ultracode).toBe(false);
    const cleared = (await (await api("PATCH", `/api/agents/${created.id}`, { ultracode: null })).json()) as Agent;
    expect(cleared.ultracode).toBeNull();
    expect(((await (await api("GET", `/api/agents/${created.id}`)).json()) as Agent).ultracode).toBeNull();

    expect((await api("PATCH", `/api/agents/${created.id}`, { ultracode: "on" })).status).toBe(400);
    expect((await api("POST", "/api/agents", { name: "Bad Ultra Bot", ultracode: 1 })).status).toBe(400);
    expect(((await (await api("POST", "/api/agents", { name: "Plain Bot", browser: { enabled: false } })).json()) as Agent).ultracode).toBeNull();
  });

  test("chats: set when created or started, switch off, back to the agent's; no other values", async () => {
    const created = (await (await api("POST", "/api/conversations", { agentId: agent.id, ultracode: true })).json()) as Conversation;
    expect(created.ultracode).toBe(true);
    const off = (await (await api("PATCH", `/api/conversations/${created.id}`, { ultracode: false })).json()) as Conversation;
    expect(off.ultracode).toBe(false);
    expect(((await (await api("PATCH", `/api/conversations/${created.id}`, { pinned: true })).json()) as Conversation).ultracode).toBe(false);
    const cleared = (await (await api("PATCH", `/api/conversations/${created.id}`, { ultracode: null })).json()) as Conversation;
    expect(cleared.ultracode).toBeNull();
    expect(getConversation(created.id).ultracode).toBeNull();

    expect((await api("PATCH", `/api/conversations/${created.id}`, { ultracode: "on" })).status).toBe(400);
    expect((await api("POST", "/api/conversations", { agentId: agent.id, ultracode: 1 })).status).toBe(400);
    expect((await api("POST", "/api/chat", { agentId: agent.id, content: "Hi", ultracode: "yes" })).status).toBe(400);

    const started = (await (await api("POST", "/api/chat", { agentId: agent.id, content: "Hi", ultracode: true })).json()) as StartChatResult;
    expect(started.conversation.ultracode).toBe(true);
    expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
    expect(invocations(env).at(-1)!.settings!.ultracode).toBe(true);
  });

  test("settings: on or off, nothing else", async () => {
    expect((await api("PUT", "/api/settings", { runner: { ultracode: "yes" } })).status).toBe(400);
    expect((await api("PUT", "/api/settings", { runner: { ultracode: null } })).status).toBe(400);
    expect(getSettings().runner.ultracode).toBe(false);
    expect(buildLogReport()).not.toContain("Ultracode");
    try {
      const saved = (await (await api("PUT", "/api/settings", { runner: { ultracode: true } })).json()) as Settings;
      expect(saved.runner.ultracode).toBe(true);
      expect(buildLogReport()).toContain("effort high, Ultracode on, up to");
    } finally {
      updateSettings({ runner: { ultracode: false } });
    }
  });

  test("a managing agent can set it on another agent and sees it", async () => {
    const manager = await makeAgent({ name: "Ultra Manager", permissions: { canManageAgents: true } });
    const ctx = { runId: "run_ultra", agentId: manager.id, conversationId: "", workspaceId: null, depth: 0 };
    const updated = await callTool(ctx, "agent_update", { agentId: agent.id, ultracode: true });
    expect(updated.isError).toBeUndefined();
    try {
      expect(getAgent(agent.id).ultracode).toBe(true);
      const detail = JSON.parse((await callTool(ctx, "agent_get", { agentId: agent.id })).content[0]!.text) as { ultracode: boolean | null };
      expect(detail.ultracode).toBe(true);
      expect((await callTool(ctx, "agent_update", { agentId: agent.id, ultracode: "always" })).isError).toBe(true);
    } finally {
      await updateAgent(agent.id, { ultracode: null });
    }
  });
});

describe("Ultracode and saved secrets", () => {
  test("the workflow label masks them, like the blocks do", async () => {
    // Part of the description the captured workflow gave itself.
    const secret = "a.txt and b.txt";
    await vault.setup("ultracode test passphrase", false);
    createCredential({ name: "Portal", url: "https://portal.example.com", username: "dana", password: secret });
    const { events, stop } = captureEvents();
    try {
      const started = await startChat({ agentId: agent.id, content: "USE_WORKFLOW" });
      expect((await waitForRun(started.run.id, 20_000)).status).toBe("succeeded");
      const labels = events.flatMap((e) => (e.type === "run.activity" && e.runId === started.run.id ? [e.label] : []));
      expect(labels).toContain("Running workflow · Count words in •••••••• with two agents");
      expect(labels).toContain("Running workflow · Count: a.txt");
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(JSON.stringify(getConversation(started.conversation.id))).not.toContain(secret);
    } finally {
      stop();
      vault.lock();
    }
  });
});
