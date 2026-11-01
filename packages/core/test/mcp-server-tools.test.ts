import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent } from "@godmode/shared";
import { SECRET_MASK } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { get, insert, run as sql } from "../src/db";
import { updateSettings } from "../src/services/settings";
import { callTool, listToolsFor } from "../src/mcp/tools";
import { getMcpServer, mcpServerSecrets } from "../src/integrations/mcpServers";
import { createWorkspace } from "../src/services/workspaces";
import * as vault from "../src/vault/vault";
import { newId, now } from "../src/util";

let env: TestEnv;
let manager: Agent;
let worker: Agent;

const TOOLS = ["mcp_servers_list", "mcp_server_save", "mcp_server_delete"];

function chatRun(agent: Agent) {
  const conversationId = newId("cnv");
  insert("conversations", { id: conversationId, agent_id: agent.id, title: "x", origin: "chat", created_at: now(), updated_at: now() });
  const runId = newId("run");
  insert("runs", { id: runId, agent_id: agent.id, conversation_id: conversationId, trigger: "chat", status: "running", prompt: "x", created_at: now() });
  return { runId, agentId: agent.id, conversationId, workspaceId: agent.workspaceId, depth: 0 };
}

async function call(agent: Agent, name: string, args: unknown) {
  const out = await callTool(chatRun(agent), name, args);
  return { text: out.content[0]!.text, isError: out.isError === true };
}

beforeAll(async () => {
  env = await setupEnv("godmode-mcp-tools-");
  await vault.setup("correct horse battery staple", false);
  manager = await makeAgent({ name: "Boss", permissions: { canManageAgents: true, allowDelegation: true } });
  worker = await makeAgent({ name: "Worker" });
});

afterAll(async () => {
  await env.close();
});

describe("mcp server tools", () => {
  test("only managers get them, and only while integrations are on", () => {
    updateSettings({ integrations: { enabled: false } });
    expect(listToolsFor(manager, chatRun(manager)).filter((t) => TOOLS.includes(t.name))).toEqual([]);
    updateSettings({ integrations: { enabled: true } });
    expect(listToolsFor(manager, chatRun(manager)).map((t) => t.name).filter((n) => TOOLS.includes(n)).sort()).toEqual([...TOOLS].sort());
    expect(listToolsFor(worker, chatRun(worker)).filter((t) => TOOLS.includes(t.name))).toEqual([]);
  });

  test("save creates a server with sealed env, lists key names only and audits the agent", async () => {
    const saved = await call(manager, "mcp_server_save", {
      name: "GitHub",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_supersecret" },
      agentId: worker.id,
    });
    expect(saved.isError).toBe(false);
    const { id } = JSON.parse(saved.text) as { id: string };
    expect(mcpServerSecrets(id).env).toEqual({ GITHUB_TOKEN: "ghp_supersecret" });
    expect(get<{ actor: string }>("SELECT actor FROM audit_log WHERE action = 'mcp_server.create' AND target = ?", id)?.actor).toBe(`agent:${manager.id}`);

    const listed = await call(manager, "mcp_servers_list", { scope: "agent", agentId: worker.id });
    expect(listed.text).not.toContain("ghp_supersecret");
    const servers = JSON.parse(listed.text) as { id: string; envKeys: string[]; scope: string }[];
    expect(servers.map((s) => [s.id, s.envKeys, s.scope])).toEqual([[id, ["GITHUB_TOKEN"], "agent"]]);
    expect(JSON.parse((await call(manager, "mcp_servers_list", { scope: "global" })).text)).toEqual([]);
  });

  test("update keeps masked secrets, but won't carry them to a new command unless they are given again", async () => {
    const id = getMcpServerId("GitHub");
    const renamed = await call(manager, "mcp_server_save", { serverId: id, description: "Repos and issues", env: { GITHUB_TOKEN: SECRET_MASK } });
    expect(renamed.isError).toBe(false);
    expect(mcpServerSecrets(id).env).toEqual({ GITHUB_TOKEN: "ghp_supersecret" });

    const moved = await call(manager, "mcp_server_save", { serverId: id, command: "node", args: ["steal.js"] });
    expect(moved.isError).toBe(true);
    expect(moved.text).toContain("stored secrets");
    expect(getMcpServer(id).command).toBe("npx");

    const given = await call(manager, "mcp_server_save", { serverId: id, command: "node", args: ["server.js"], env: { GITHUB_TOKEN: "ghp_new" } });
    expect(given.isError).toBe(false);
    expect(getMcpServer(id).command).toBe("node");
    expect(mcpServerSecrets(id).env).toEqual({ GITHUB_TOKEN: "ghp_new" });
  });

  test("a server for every agent is refused while one that controls the computer would get it", async () => {
    const operator = await makeAgent({ name: "Operator", computer: { enabled: true, target: null } });
    const global = await call(manager, "mcp_server_save", { name: "Docs", transport: "http", url: "https://mcp.example.com/mcp", workspaceId: null, agentId: null });
    expect(global.isError).toBe(true);
    expect(global.text).toContain("Operator");
    const off = await call(manager, "mcp_server_save", { name: "Docs", transport: "http", url: "https://mcp.example.com/mcp", workspaceId: null, agentId: null, enabled: false });
    expect(off.isError).toBe(false);
    sql("DELETE FROM agents WHERE id = ?", operator.id);
  });

  test("a workspace manager stays in its workspace", async () => {
    const ws = createWorkspace({ name: "Client" });
    const local = await makeAgent({ name: "Local Boss", workspaceId: ws.id, permissions: { canManageAgents: true, allowDelegation: true } });
    const global = await call(local, "mcp_server_save", { name: "Wide", transport: "http", url: "https://x.example.com/mcp", workspaceId: null });
    expect(global.isError).toBe(true);
    const own = await call(local, "mcp_server_save", { name: "Narrow", transport: "http", url: "https://x.example.com/mcp", headers: { Authorization: "Bearer abc" } });
    expect(own.isError).toBe(false);
    expect(JSON.parse(own.text)).toMatchObject({ scope: "workspace", workspaceId: ws.id, headerKeys: ["Authorization"] });
    const seen = (JSON.parse((await call(local, "mcp_servers_list", {})).text) as { name: string }[]).map((s) => s.name);
    expect(seen).toContain("Narrow");
    expect(seen).not.toContain("GitHub");
    expect((await call(local, "mcp_server_delete", { serverId: getMcpServerId("Docs") })).isError).toBe(true);
  });

  test("delete removes the server", async () => {
    const id = getMcpServerId("GitHub");
    const out = await call(manager, "mcp_server_delete", { serverId: id });
    expect(out.isError).toBe(false);
    expect(get("SELECT id FROM mcp_servers WHERE id = ?", id)).toBeNull();
    expect((await call(manager, "mcp_server_delete", { serverId: id })).isError).toBe(true);
  });
});

function getMcpServerId(name: string): string {
  return get<{ id: string }>("SELECT id FROM mcp_servers WHERE name = ?", name)!.id;
}
