import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Conversation, ModelCatalog, ServerEvent } from "@godmode/shared";
import { effortForModel, findModel } from "@godmode/shared";
import { FAKE_CLAUDE, argValue, captureEvents, invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { __setClaudeBinaryForTests, waitForRun } from "../src/runner/runner";
import { __resetModelCatalogForTests, effortFor, getModelCatalog, parseModels } from "../src/runner/models";
import { createConversation, sendMessage, startChat, updateConversation } from "../src/services/conversations";
import { run as sql } from "../src/db";
import { getAccessToken } from "../src/server/auth";

/** Abbreviated `initialize` response of Claude Code 2.1. */
const CLAUDE_CODE_MODELS = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable for ambitious work", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "For your toughest challenges", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", description: "Most efficient for everyday tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus 5.5 (1M context)", description: "For long sessions", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5", description: "Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ["max", "low", "high", "medium"] },
];

describe("parseModels", () => {
  test("keeps Claude Code's order, drops 'default', flags the newest of each family", () => {
    const models = parseModels(CLAUDE_CODE_MODELS);
    expect(models.map((m) => m.id)).toEqual(["opus", "claude-fable-5-1", "sonnet", "opus[1m]", "haiku", "claude-opus-5", "claude-opus-4-6"]);
    expect(models.filter((m) => m.latest).map((m) => m.id)).toEqual(["opus", "claude-fable-5-1", "sonnet", "opus[1m]", "haiku"]);
    expect(models[0]).toEqual({
      id: "opus",
      resolvedModel: "claude-opus-5-5",
      label: "Opus 5.5",
      description: "Most capable for ambitious work",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      ultracode: false,
      latest: true,
    });
    expect(findModel(models, "haiku")!.efforts).toEqual([]);
    expect(findModel(models, "claude-opus-4-6")!.efforts).toEqual(["low", "medium", "high", "max"]);
  });

  test("CLIs without effort info accept every level; junk is ignored", () => {
    const models = parseModels([{ value: "opus", displayName: "Opus" }, null, 42, { value: "" }, { value: "--evil" }, { value: "a&b" }, { value: "opus" }]);
    expect(models).toEqual([{ id: "opus", resolvedModel: "opus", label: "Opus", description: "", efforts: ["low", "medium", "high", "xhigh", "max"], ultracode: false, latest: true }]);
    expect(parseModels(undefined)).toEqual([]);
    expect(parseModels({ models: [] })).toEqual([]);
  });

  test("with dynamic workflows, the models that have the xhigh level get Ultracode", () => {
    expect(parseModels(CLAUDE_CODE_MODELS).some((m) => m.ultracode)).toBe(false);
    const models = parseModels(CLAUDE_CODE_MODELS, true);
    expect(models.filter((m) => m.ultracode).map((m) => m.id)).toEqual(["opus", "claude-fable-5-1", "sonnet", "opus[1m]", "claude-opus-5"]);
    expect(findModel(models, "haiku")!.ultracode).toBe(false);
    expect(findModel(models, "claude-opus-4-6")!.ultracode).toBe(false);
  });

  test("findModel matches aliases and resolved ids; effortForModel clamps to supported levels", () => {
    const models = parseModels(CLAUDE_CODE_MODELS);
    expect(findModel(models, "claude-opus-5-5")?.id).toBe("opus");
    expect(findModel(models, " sonnet ")?.id).toBe("sonnet");
    expect(findModel(models, "")).toBeUndefined();
    expect(findModel(models, null)).toBeUndefined();

    expect(effortForModel(["low", "medium", "high", "max"], "xhigh")).toBe("high");
    expect(effortForModel(["low", "medium", "high", "max"], "max")).toBe("max");
    expect(effortForModel(["high", "max"], "low")).toBe("high");
    expect(effortForModel([], "high")).toBeNull();
    expect(effortForModel(["low"], null)).toBeNull();
  });
});

describe("catalog from the Claude Code CLI", () => {
  let env: TestEnv;
  let agent: Agent;
  const probes = () => {
    const file = join(env.stateDir, "probes.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; cwd: string }) : [];
  };
  const cacheFile = () => join(env.dataDir, "claude-models.json");

  beforeAll(async () => {
    env = await setupEnv("godmode-models-");
    agent = await makeAgent({ name: "Model Bot" });
  });

  beforeEach(() => {
    delete process.env.FAKE_CLAUDE_MODELS;
  });

  afterAll(async () => {
    delete process.env.FAKE_CLAUDE_MODELS;
    __resetModelCatalogForTests();
    await env.close();
  });

  test("asks the CLI once, then serves the cache", async () => {
    __resetModelCatalogForTests();
    const catalog = await getModelCatalog();
    expect(catalog.source).toBe("claude");
    expect(catalog.error).toBeNull();
    expect(catalog.claudeVersion).toBe("9.9.9");
    expect(catalog.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku", "claude-opus-8"]);
    expect(catalog.models.map((m) => m.latest)).toEqual([true, true, true, false]);

    const [probe] = probes();
    expect(probes()).toHaveLength(1);
    expect(probe!.args[probe!.args.indexOf("--setting-sources") + 1]).toBe("project,local");
    expect(probe!.args).toContain("--strict-mcp-config");
    expect(realpathSync(probe!.cwd)).toBe(realpathSync(join(env.dataDir, "claude-probe")));
    expect(existsSync(cacheFile())).toBe(true);

    await getModelCatalog();
    expect(probes()).toHaveLength(1);

    __resetModelCatalogForTests();
    const fromDisk = await getModelCatalog();
    expect(fromDisk.models).toEqual(catalog.models);
    expect(probes()).toHaveLength(1);
  });

  test("effortFor uses the cached catalog", async () => {
    await getModelCatalog();
    expect(effortFor("opus", "max")).toBe("max");
    expect(effortFor("claude-sonnet-9", "low")).toBe("low");
    expect(effortFor("claude-opus-8", "xhigh")).toBe("high");
    expect(effortFor("haiku", "high")).toBeNull();
    expect(effortFor("some-custom-model", "high")).toBe("high");
    expect(effortFor("opus", null)).toBeNull();
  });

  test("a failed refresh keeps the last list Claude Code reported", async () => {
    process.env.FAKE_CLAUDE_MODELS = "error";
    const catalog = await getModelCatalog({ refresh: true });
    expect(catalog.source).toBe("claude");
    expect(catalog.error).toContain("initialize failed");
    expect(catalog.models.map((m) => m.id)).toContain("opus");
  });

  test("falls back to the built-in list without a cache", async () => {
    __resetModelCatalogForTests();
    rmSync(cacheFile(), { force: true });
    process.env.FAKE_CLAUDE_MODELS = "silent";
    const catalog = await getModelCatalog();
    expect(catalog.source).toBe("builtin");
    expect(catalog.error).toContain("exited without answering");
    expect(catalog.error).toContain("not today");
    expect(catalog.models.map((m) => m.id)).toContain("claude-opus-5-5");
    expect(catalog.models.every((m) => m.efforts.length === 5)).toBe(true);

    __setClaudeBinaryForTests(false);
    try {
      const missing = await getModelCatalog({ refresh: true });
      expect(missing.source).toBe("builtin");
      expect(missing.error).toBe("Claude Code CLI not found");
    } finally {
      __setClaudeBinaryForTests([process.execPath, FAKE_CLAUDE]);
    }
  });

  test.skipIf(process.platform === "win32")("a hanging CLI times out and its whole process tree is killed", async () => {
    __resetModelCatalogForTests({ probeTimeoutMs: 800 });
    rmSync(cacheFile(), { force: true });
    rmSync(join(env.stateDir, "hang.pid"), { force: true });
    process.env.FAKE_CLAUDE_MODELS = "hang";
    const started = Date.now();
    const catalog = await getModelCatalog();
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(catalog.source).toBe("builtin");
    expect(catalog.error).toContain("did not answer within 1s");
    const pid = Number(readFileSync(join(env.stateDir, "hang.pid"), "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await until(() => !alive(), 5_000, "grandchild killed");
    __resetModelCatalogForTests();
  });

  test("a stale cache is served at once and refreshed in the background", async () => {
    __resetModelCatalogForTests();
    const stale: ModelCatalog = {
      models: [{ id: "claude-opus-1", resolvedModel: "claude-opus-1", label: "Opus 1", description: "", efforts: [], ultracode: false, latest: true }],
      source: "claude",
      claudeVersion: "1.0.0",
      fetchedAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
      error: null,
    };
    writeFileSync(cacheFile(), JSON.stringify(stale));
    const { events, stop } = captureEvents();
    try {
      const served = await getModelCatalog();
      expect(served.models.map((m) => m.id)).toEqual(["claude-opus-1"]);
      await until(() => events.some((e: ServerEvent) => e.type === "entity.changed" && e.entity === "models"), 10_000, "models changed");
    } finally {
      stop();
    }
    const fresh = await getModelCatalog();
    expect(fresh.models.map((m) => m.id)).toContain("opus");
    expect(JSON.parse(readFileSync(cacheFile(), "utf8")).claudeVersion).toBe("9.9.9");
  });

  test("GET /api/models", async () => {
    const res = await fetch(`${env.baseUrl}/api/models`, { headers: { Authorization: `Bearer ${getAccessToken()}` } });
    expect(res.status).toBe(200);
    const catalog = (await res.json()) as ModelCatalog;
    expect(catalog.source).toBe("claude");
    expect(catalog.models.map((m) => m.id)).toContain("sonnet");
    expect((await fetch(`${env.baseUrl}/api/models`)).status).toBe(401);
  });

  test("a chat's model and effort override the agent's", async () => {
    await getModelCatalog();
    const before = invocations(env).length;
    const started = await startChat({ agentId: agent.id, content: "Hi", model: "sonnet", effort: "low" });
    expect(started.conversation.model).toBe("sonnet");
    expect(started.conversation.effort).toBe("low");
    await waitForRun(started.run.id, 20_000);
    let inv = invocations(env).slice(before).at(-1)!;
    expect(argValue(inv, "--model")).toBe("sonnet");
    expect(argValue(inv, "--effort")).toBe("low");

    // Models without effort support get no --effort flag.
    updateConversation(started.conversation.id, { model: "haiku", effort: null });
    let sent = await sendMessage(started.conversation.id, { content: "Again" });
    await waitForRun(sent.run.id, 20_000);
    inv = invocations(env).at(-1)!;
    expect(argValue(inv, "--model")).toBe("haiku");
    expect(inv.args).not.toContain("--effort");

    // Clearing the override falls back to the agent / settings default.
    const cleared = updateConversation(started.conversation.id, { model: null });
    expect(cleared.model).toBeNull();
    sent = await sendMessage(started.conversation.id, { content: "Once more" });
    await waitForRun(sent.run.id, 20_000);
    inv = invocations(env).at(-1)!;
    expect(argValue(inv, "--model")).toBe("claude-opus-5-5");
    expect(argValue(inv, "--effort")).toBe("high");
  });

  test("routes validate model and effort", async () => {
    const api = (method: string, path: string, body: unknown) =>
      fetch(`${env.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const conv = createConversation({ agentId: agent.id });
    const ok = await api("PATCH", `/api/conversations/${conv.id}`, { model: "claude-opus-4-6[1m]", effort: "max" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Conversation).model).toBe("claude-opus-4-6[1m]");
    const reset = (await (await api("PATCH", `/api/conversations/${conv.id}`, { model: "", effort: null })).json()) as Conversation;
    expect(reset.model).toBeNull();
    expect(reset.effort).toBeNull();

    expect((await api("PATCH", `/api/conversations/${conv.id}`, { model: "--dangerously-skip-permissions" })).status).toBe(400);
    expect((await api("PATCH", `/api/conversations/${conv.id}`, { effort: "ultra" })).status).toBe(400);
    expect((await api("POST", "/api/conversations", { agentId: agent.id, model: "a b" })).status).toBe(400);
    expect((await api("POST", "/api/agents", { name: "Shell Bot", model: "opus & calc" })).status).toBe(400);
    expect((await api("PATCH", `/api/agents/${agent.id}`, { model: "--help" })).status).toBe(400);

    const created = (await (await api("POST", "/api/conversations", { agentId: agent.id, model: "opus", effort: "xhigh" })).json()) as Conversation;
    expect(created.model).toBe("opus");
    expect(created.effort).toBe("xhigh");
  });

  test("the runner refuses model ids that could be misread as flags or shell syntax", async () => {
    const bad = await makeAgent({ name: "Bad Model Bot" });
    sql("UPDATE agents SET model = ? WHERE id = ?", "opus & calc.exe", bad.id);
    const before = invocations(env).length;
    const started = await startChat({ agentId: bad.id, content: "Hi" });
    const finished = await waitForRun(started.run.id, 20_000);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("Invalid model id");
    expect(invocations(env).length).toBe(before);
  });
});
