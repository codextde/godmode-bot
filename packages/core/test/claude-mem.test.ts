import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { argValue, invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { updateSettings } from "../src/services/settings";
import { startChat } from "../src/services/conversations";
import { waitForRun } from "../src/runner/runner";
import { getConversation } from "../src/services/conversations";
import { CLAUDE_MEM_VERSION, claudeMemEnv, claudeMemPluginDir, claudeMemPort } from "../src/memory/claudeMem";

let env: TestEnv;
let agent: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-claude-mem-");
  agent = await makeAgent({ name: "Memory Bot" });
});

afterAll(async () => {
  updateSettings({ memory: { backend: "files" } });
  await env.close();
});

describe("claude-mem backend", () => {
  test("each agent gets an isolated store and a stable worker port", () => {
    const e = claudeMemEnv(agent);
    expect(e.CLAUDE_MEM_DATA_DIR).toBe(join(agent.repoPath, ".claude-mem"));
    expect(e.CLAUDE_MEM_WORKER_PORT).toBe(String(claudeMemPort(agent.id)));
    expect(e.CLAUDE_MEM_CHROMA_ENABLED).toBe("false");
    const port = claudeMemPort(agent.id);
    expect(port).toBeGreaterThanOrEqual(38_100);
    expect(port).toBeLessThan(38_900);
    expect(claudeMemPort(agent.id)).toBe(port);
  });

  test("selected but not installed: run falls back to file memory with a visible notice", async () => {
    updateSettings({ memory: { backend: "claude-mem" } });
    expect(claudeMemPluginDir()).toBeNull();
    const before = invocations(env).length;
    const { run, conversation } = await startChat({ agentId: agent.id, content: "hello" });
    expect((await waitForRun(run.id, 20_000)).status).toBe("succeeded");
    const inv = invocations(env).slice(before)[0]!;
    expect(inv.args).not.toContain("--plugin-dir");
    const last = getConversation(conversation.id).messages.at(-1)!;
    expect(last.blocks.some((b) => b.type === "notice" && b.text.includes("claude-mem"))).toBe(true);
  });

  test("installed: the plugin is loaded with --plugin-dir", async () => {
    const dir = join(env.dataDir, "plugins", "claude-mem", CLAUDE_MEM_VERSION, "plugin", ".claude-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "claude-mem" }));
    expect(claudeMemPluginDir()).not.toBeNull();
    const before = invocations(env).length;
    const { run } = await startChat({ agentId: agent.id, content: "hello again" });
    expect((await waitForRun(run.id, 20_000)).status).toBe("succeeded");
    const inv = invocations(env).slice(before)[0]!;
    expect(argValue(inv, "--plugin-dir")).toBe(claudeMemPluginDir());
  });
});
