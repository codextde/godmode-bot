import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, insert, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import * as vault from "../src/vault/vault";
import { getAgent } from "../src/agents/service";
import { createMcpServer } from "../src/integrations/mcpServers";
import { appForTool, callAppTool, closeMcpAppSessions, readAppResource } from "../src/integrations/mcpApps";
import { resetComposioState } from "../src/integrations/composio";
import { mcpAppFramePolicy } from "../src/server/mcpAppFrame";
import { HttpError } from "../src/util";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");
let dataDir: string;
let agent: Agent;

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-mcp-apps-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  resetComposioState();
  vault.lock();
  await vault.setup("correct horse battery staple", false);
  updateSettings({ integrations: { enabled: true } });
  const ts = new Date().toISOString();
  insert("agents", { id: "agt_apps", workspace_id: null, name: "Apps", slug: "apps", repo_path: join(dataDir, "agents", "apps"), created_at: ts, updated_at: ts });
  createMcpServer({ workspaceId: null, agentId: null, name: "Orders", transport: "stdio", command: process.execPath, args: [FIXTURE], env: { FAKE_MODE: "app" } });
  agent = getAgent("agt_apps");
});

afterAll(() => {
  closeMcpAppSessions();
  vault.lock();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return (err as HttpError).status;
  }
  return 200;
}

describe("MCP apps", () => {
  test("a tool with a view: the client advertises the extension, gets the HTML and a cleaned policy", async () => {
    const app = await appForTool(agent, "mcp__orders__show_order");
    expect(app?.server).toBe("orders");
    expect(app?.uri).toBe("ui://orders/card");
    expect(app?.html).toContain("order card");
    expect(app?.csp).toEqual({ connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.example.com"] });
    expect(app?.prefersBorder).toBe(true);
    expect(app?.appTools).toEqual([
      { name: "show_order", readOnly: false },
      { name: "refresh_order", readOnly: true },
      { name: "create_delivery", readOnly: false },
      { name: "legacy_view", readOnly: false },
    ]);
    expect((await appForTool(agent, "mcp__orders__legacy_view"))?.uri).toBe("ui://orders/card");
  });

  test("tools without a view, unknown servers and built-in tools have none", async () => {
    expect(await appForTool(agent, "mcp__orders__create_delivery")).toBeNull();
    expect(await appForTool(agent, "mcp__nope__show_order")).toBeNull();
    expect(await appForTool(agent, "mcp__godmode__ask_human")).toBeNull();
    expect(await appForTool(agent, "Bash")).toBeNull();
  });

  test("views call app-visible tools over one kept connection, never model-only ones", async () => {
    const first = (await callAppTool(agent, "orders", "refresh_order", { id: 1 })) as { content: { text: string }[] };
    const second = (await callAppTool(agent, "orders", "create_delivery", { id: 2 })) as { content: { text: string }[] };
    expect(first.content[0]!.text).toStartWith('refresh_order {"id":1}');
    const pid = (r: { content: { text: string }[] }) => r.content[0]!.text.split(" pid ")[1];
    expect(pid(second)).toBe(pid(first));
    expect(await status(callAppTool(agent, "orders", "model_only", {}))).toBe(403);
    expect(await status(callAppTool(agent, "orders", "missing", {}))).toBe(404);
    expect(await status(callAppTool(agent, "other", "refresh_order", {}))).toBe(404);
  });

  test("resource reads pass through and server errors come back as errors", async () => {
    const read = (await readAppResource(agent, "orders", "ui://orders/card")) as { contents: unknown[] };
    expect(read.contents).toHaveLength(1);
    expect(await status(readAppResource(agent, "orders", "ui://orders/none"))).toBe(502);
  });

  test("the frame's policy allows only the declared origins", () => {
    const policy = mcpAppFramePolicy({ connectDomains: ["https://api.example.com"] });
    expect(policy).toContain("sandbox allow-scripts allow-forms");
    expect(policy).toContain("connect-src https://api.example.com");
    expect(policy).toContain("frame-src 'none'");
    expect(mcpAppFramePolicy(null)).toContain("connect-src 'none'");
  });
});
