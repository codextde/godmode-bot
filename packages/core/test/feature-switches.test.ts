import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { getDb, insert, run as sql } from "../src/db";
import { FEATURE_SWITCHES_SQL, MIGRATIONS } from "../src/db/migrations";
import { getAccessToken } from "../src/server/auth";
import { getSettings, resetSettingsCache, updateSettings } from "../src/services/settings";
import { callTool, listToolsFor } from "../src/mcp/tools";
import { createApiTool, deleteApiTool } from "../src/integrations/apiTools";
import { mcpServersForAgent } from "../src/integrations/mcpServers";
import * as vault from "../src/vault/vault";
import { newId, now } from "../src/util";

let env: TestEnv;
let manager: Agent;

const FEATURES = ["artifacts", "integrations", "messaging", "android"] as const;
type Feature = (typeof FEATURES)[number];

const api = (method: string, path: string, body?: unknown) =>
  fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const switches = () => Object.fromEntries(FEATURES.map((f) => [f, getSettings()[f].enabled])) as Record<Feature, boolean>;
const allOff = { artifacts: false, integrations: false, messaging: false, android: false };

/** Runs the migration again on whatever the tables hold now, the way an upgrade or a restore does. */
function migrate(): Record<Feature, boolean> {
  getDb().run(FEATURE_SWITCHES_SQL);
  resetSettingsCache();
  return switches();
}

function clear() {
  for (const table of ["artifacts", "api_tools", "mcp_servers", "composio_connections", "messaging_connections", "android_devices"]) sql(`DELETE FROM ${table}`);
  sql("DELETE FROM secrets WHERE key = 'composio_api_key'");
  sql("DELETE FROM settings WHERE key IN ('artifacts', 'integrations', 'messaging', 'android')");
  resetSettingsCache();
}

function chatRun(agent: Agent) {
  const conversationId = newId("cnv");
  insert("conversations", { id: conversationId, agent_id: agent.id, title: "x", origin: "chat", created_at: now(), updated_at: now() });
  const runId = newId("run");
  insert("runs", { id: runId, agent_id: agent.id, conversation_id: conversationId, trigger: "chat", status: "running", prompt: "x", created_at: now() });
  return { runId, agentId: agent.id, conversationId, workspaceId: null, depth: 0 };
}

const toolNames = (agent: Agent) => listToolsFor(agent, chatRun(agent)).map((t) => t.name);

beforeAll(async () => {
  env = await setupEnv("godmode-features-");
  await vault.setup("correct horse battery staple", false);
  manager = await makeAgent({ name: "Boss", permissions: { canManageAgents: true, allowDelegation: true } });
});

afterAll(async () => {
  await env.close();
});

describe("new installs", () => {
  test("start with every optional feature off", () => {
    clear();
    expect(switches()).toEqual(allOff);
    expect(migrate()).toEqual(allOff);
  });
});

describe("existing installs", () => {
  test("migration 105 is the backfill", () => {
    expect(MIGRATIONS.find((m) => m.name === "feature_switches")!.sql).toBe(FEATURE_SWITCHES_SQL);
    expect(MIGRATIONS.find((m) => m.name === "feature_switches")!.id).toBe(105);
  });

  test("keep artifacts on when there are artifacts", () => {
    clear();
    insert("artifacts", { id: "art_1", title: "Sales", html: "<p>hi</p>", created_at: now(), updated_at: now() });
    expect(migrate()).toEqual({ ...allOff, artifacts: true });
  });

  test("keep integrations on for API tools, MCP servers, Composio apps or a Composio key", () => {
    const cases: [string, () => void][] = [
      ["api tool", () => insert("api_tools", { id: "api_1", name: "Gemini", created_at: now(), updated_at: now() })],
      ["mcp server", () => insert("mcp_servers", { id: "mcp_1", name: "Linear", created_at: now(), updated_at: now() })],
      ["composio app", () => insert("composio_connections", { id: "cmp_1", connected_account_id: "ca_1", toolkit: "gmail", user_id: "u", created_at: now(), updated_at: now() })],
      ["composio key", () => insert("secrets", { key: "composio_api_key", value_enc: "sealed", updated_at: now() })],
    ];
    for (const [what, seed] of cases) {
      clear();
      seed();
      expect({ what, ...migrate() }).toEqual({ what, ...allOff, integrations: true });
    }
  });

  test("keep messaging on when a bot is connected", () => {
    clear();
    insert("messaging_connections", { id: "msg_1", provider: "telegram", name: "Bot", created_at: now(), updated_at: now() });
    expect(migrate()).toEqual({ ...allOff, messaging: true });
  });

  test("keep Android on when a phone was seen", () => {
    clear();
    insert("android_devices", { id: "adr_1", serial: "R58M", name: "Pixel", created_at: now(), updated_at: now() });
    expect(migrate()).toEqual({ ...allOff, android: true });
    expect(getSettings().android.adbPath).toBe("");
  });

  test("a switch the human set stays as it is, and the backfill is idempotent", () => {
    clear();
    insert("artifacts", { id: "art_1", title: "Sales", html: "<p>hi</p>", created_at: now(), updated_at: now() });
    insert("android_devices", { id: "adr_1", serial: "R58M", name: "Pixel", created_at: now(), updated_at: now() });
    updateSettings({ artifacts: { enabled: false }, android: { enabled: false, adbPath: "/opt/adb" } });
    expect(migrate()).toEqual(allOff);
    expect(migrate()).toEqual(allOff);
    expect(getSettings().android.adbPath).toBe("/opt/adb");
  });

  test("an Android section saved without the switch gets it from the phones seen", () => {
    clear();
    sql("INSERT INTO settings (key, value) VALUES ('android', ?)", JSON.stringify({ adbPath: "/opt/adb" }));
    expect(migrate().android).toBe(false);
    sql("DELETE FROM settings WHERE key = 'android'");
    sql("INSERT INTO settings (key, value) VALUES ('android', ?)", JSON.stringify({ adbPath: "/opt/adb" }));
    insert("android_devices", { id: "adr_1", serial: "R58M", name: "Pixel", created_at: now(), updated_at: now() });
    expect(migrate().android).toBe(true);
  });
});

describe("agents only get a feature's tools while it is on", () => {
  test("artifacts", async () => {
    clear();
    expect(toolNames(manager).filter((n) => n.startsWith("artifact_"))).toEqual([]);
    const refused = await callTool(chatRun(manager), "artifact_list", {});
    expect(refused.isError).toBe(true);
    updateSettings({ artifacts: { enabled: true } });
    expect(toolNames(manager).filter((n) => n.startsWith("artifact_")).sort()).toEqual(["artifact_create", "artifact_get", "artifact_list", "artifact_update"]);
  });

  test("Android phones", () => {
    clear();
    expect(toolNames(manager).filter((n) => n.startsWith("android_"))).toEqual([]);
    updateSettings({ android: { enabled: true } });
    expect(toolNames(manager).filter((n) => n.startsWith("android_")).sort()).toEqual(["android_assign", "android_devices_list"]);
  });

  test("integrations: API tools and MCP servers", async () => {
    clear();
    const tool = createApiTool({ name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "gemini-key-123" });
    insert("mcp_servers", { id: "mcp_1", name: "Linear", transport: "http", url: "https://mcp.linear.app/mcp", created_at: now(), updated_at: now() });
    try {
      expect(toolNames(manager).filter((n) => n.startsWith("api_tool"))).toEqual([]);
      expect(await mcpServersForAgent(manager)).toEqual({});
      updateSettings({ integrations: { enabled: true } });
      expect(toolNames(manager).filter((n) => n.startsWith("api_tool")).sort()).toEqual(["api_tool_docs", "api_tool_request", "api_tools_list"]);
      expect(Object.keys(await mcpServersForAgent(manager))).toEqual(["linear"]);
    } finally {
      deleteApiTool(tool.id);
    }
  });
});

describe("the human switches them", () => {
  test("in the settings, as true or false", async () => {
    clear();
    for (const feature of ["artifacts", "integrations", "messaging"] as const) {
      expect((await api("PUT", "/api/settings", { [feature]: { enabled: "yes" } })).status).toBe(400);
      expect((await api("PUT", "/api/settings", { [feature]: { enabled: true } })).status).toBe(200);
      expect(getSettings()[feature].enabled).toBe(true);
    }
    const boot = (await (await api("GET", "/api/bootstrap")).json()) as { settings: Record<Feature, { enabled: boolean }> };
    expect(boot.settings.artifacts.enabled).toBe(true);
    expect(boot.settings.messaging.enabled).toBe(true);
  });

  test("starting an artifact needs artifacts on", async () => {
    clear();
    const off = await api("POST", "/api/artifacts/start", { prompt: "A sales dashboard" });
    expect(off.status).toBe(409);
    expect(((await off.json()) as { error: string }).error).toContain("Settings → Artifacts");
  });
});
