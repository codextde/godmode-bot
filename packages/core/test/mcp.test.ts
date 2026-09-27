import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, Credential } from "@godmode/shared";
import { fillFailure, fills, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import * as vault from "../src/vault/vault";
import { createCredential } from "../src/vault/credentials";
import { createTotp } from "../src/vault/totp";
import { listAudit } from "../src/services/audit";
import { listMissingLogins } from "../src/services/missingLogins";
import { listNotifications } from "../src/services/notifications";
import { getConversation } from "../src/services/conversations";
import { issueRunToken, resolveRunToken, revokeRunToken } from "../src/mcp/tokens";
import { getRun, listRuns } from "../src/runner/runner";
import { getAgent, listAgents } from "../src/agents/service";
import { listRoutines } from "../src/services/routines";

const PASSPHRASE = "correct horse battery staple";
const PASSWORD = "s3cret-Pass-9876";

let env: TestEnv;
let worker: Agent;
let manager: Agent;
let revealer: Agent;
let delegator: Agent;
let cred: Credential;
const tokens: Record<string, string> = {};

function tokenFor(agent: Agent, depth = 0): string {
  return issueRunToken({ runId: `run_mcp_${agent.slug}_${depth}`, agentId: agent.id, conversationId: "cnv_mcp_test", workspaceId: agent.workspaceId, depth });
}

async function post(token: string | null, body: unknown, accept = "application/json, text/event-stream") {
  return fetch(`${env.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      Accept: accept,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** POST and decode either a JSON or an SSE (text/event-stream) response. */
async function rpc(token: string, method: string, params?: unknown, id: number | string = 1) {
  const res = await post(token, { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  expect(res.status).toBe(200);
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (type.includes("text/event-stream")) {
    const data = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(data!.slice(6));
  }
  return JSON.parse(text);
}

async function call(token: string, name: string, args: unknown = {}) {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  expect(res.error).toBeUndefined();
  return res.result as { content: { type: string; text: string }[]; isError?: boolean };
}

beforeAll(async () => {
  env = await setupEnv("godmode-mcp-");
  worker = await makeAgent({ name: "Worker", description: "Does browser work", browser: { enabled: true }, permissions: { allowDelegation: false } });
  manager = await makeAgent({ name: "Boss", permissions: { canManageAgents: true, allowDelegation: true } });
  revealer = await makeAgent({ name: "Revealer", permissions: { secretAccess: "reveal", allowDelegation: false } });
  delegator = await makeAgent({ name: "Delegator", permissions: { allowDelegation: true } });
  for (const a of [worker, manager, revealer, delegator]) tokens[a.id] = tokenFor(a);
  await vault.setup(PASSPHRASE, false);
  cred = createCredential({ name: "Example", url: "https://example.com/login", username: "alice", password: PASSWORD });
  createTotp({ issuer: "Example", accountName: "alice", secret: "JBSWY3DPEHPK3PXP", credentialId: cred.id });
});

afterAll(async () => {
  for (const t of Object.values(tokens)) revokeRunToken(t);
  await env.close();
});

describe("transport", () => {
  test("rejects missing and unknown tokens", async () => {
    expect((await post(null, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await post("nope", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });

  test("revoked tokens stop working", async () => {
    const t = tokenFor(worker, 9);
    expect(resolveRunToken(t)?.agentId).toBe(worker.id);
    revokeRunToken(t);
    expect(resolveRunToken(t)).toBeNull();
    expect((await post(t, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });

  test("initialize echoes the protocol version", async () => {
    const res = await rpc(tokens[worker.id]!, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(res.result.protocolVersion).toBe("2025-03-26");
    expect(res.result.serverInfo.name).toBe("godmode");
    expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(typeof res.result.instructions).toBe("string");
  });

  test("notifications get 202, ping gets {}", async () => {
    const n = await post(tokens[worker.id]!, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(n.status).toBe(202);
    expect(await n.text()).toBe("");
    expect((await rpc(tokens[worker.id]!, "ping")).result).toEqual({});
  });

  test("unknown method, parse error, invalid request", async () => {
    expect((await rpc(tokens[worker.id]!, "resources/list")).error.code).toBe(-32601);
    const bad = await post(tokens[worker.id]!, "{not json");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
    const inv = await (await post(tokens[worker.id]!, { jsonrpc: "1.0", id: 5, method: "ping" })).json();
    expect(inv.error.code).toBe(-32600);
  });

  test("batches answer requests only", async () => {
    const res = await post(tokens[worker.id]!, [
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    const body = await res.json();
    expect(body).toEqual([{ jsonrpc: "2.0", id: "a", result: {} }]);
  });

  test("GET is 405, DELETE is 200", async () => {
    expect((await fetch(`${env.baseUrl}/mcp`)).status).toBe(405);
    expect((await fetch(`${env.baseUrl}/mcp`, { method: "DELETE" })).status).toBe(200);
  });

  test("tools/call answers over SSE when accepted, JSON otherwise", async () => {
    const body = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "vault_list_logins", arguments: {} } };
    const sse = await post(tokens[worker.id]!, body);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const json = await post(tokens[worker.id]!, body, "application/json");
    expect(json.headers.get("content-type")).toContain("application/json");
    expect((await json.json()).id).toBe(7);
  });
});

describe("tools/list permissions", () => {
  const names = async (a: Agent) => ((await rpc(tokens[a.id]!, "tools/list")).result.tools as { name: string; inputSchema: { type: string } }[]);

  test("regular agents get vault + reporting tools only", async () => {
    const tools = await names(worker);
    const list = tools.map((t) => t.name);
    for (const n of ["vault_list_logins", "vault_fill_login", "vault_fill_totp", "report_missing_login", "notify_user"]) expect(list).toContain(n);
    for (const n of ["vault_get_login", "vault_get_totp", "agents_list", "agent_delegate", "agent_create", "runs_list"]) expect(list).not.toContain(n);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  test("delegation tools need allowDelegation", async () => {
    const list = (await names(delegator)).map((t) => t.name);
    expect(list).toContain("agent_delegate");
    expect(list).toContain("agents_list");
    expect(list).not.toContain("agent_create");
  });

  test("management tools only for canManageAgents", async () => {
    const list = (await names(manager)).map((t) => t.name);
    for (const n of ["agent_create", "agent_update", "agent_delete", "routine_create", "routine_list", "runs_list", "workspaces_list", "logins_overview", "missing_logins_list", "agent_delegate"]) {
      expect(list).toContain(n);
    }
  });

  test("reveal tools only in reveal mode", async () => {
    const list = (await names(revealer)).map((t) => t.name);
    expect(list).toContain("vault_get_login");
    expect(list).toContain("vault_get_totp");
  });

  test("unknown tool → -32602, unlisted tool → isError", async () => {
    const res = await rpc(tokens[worker.id]!, "tools/call", { name: "does_not_exist", arguments: {} });
    expect(res.error.code).toBe(-32602);
    const forbidden = await call(tokens[worker.id]!, "vault_get_login", { credentialId: cred.id });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.content[0]!.text).toContain("not available");
  });

  test("invalid arguments → isError", async () => {
    const r = await call(tokens[worker.id]!, "vault_fill_login", { credentialId: cred.id, field: "email" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^Invalid arguments/);
  });
});

describe("vault tools", () => {
  test("vault_list_logins never includes passwords", async () => {
    const r = await call(tokens[worker.id]!, "vault_list_logins", { domain: "https://www.example.com/path" });
    const text = r.content[0]!.text;
    expect(text).toContain("alice");
    expect(text).toContain(cred.id);
    expect(text).toContain('"has2fa": true');
    expect(text).not.toContain(PASSWORD);
    const none = await call(tokens[worker.id]!, "vault_list_logins", { domain: "nothing.test" });
    expect(none.content[0]!.text).toContain("report_missing_login");
  });

  test("vault_fill_login types secrets into the page without returning them", async () => {
    fills.length = 0;
    const u = await call(tokens[worker.id]!, "vault_fill_login", { credentialId: cred.id, field: "username" });
    const p = await call(tokens[worker.id]!, "vault_fill_login", { credentialId: cred.id, field: "password", submit: true });
    expect(u.isError).toBeUndefined();
    expect(p.content[0]!.text).toBe('Filled password for "Example" into https://example.com/login and submitted.');
    expect(p.content[0]!.text).not.toContain(PASSWORD);
    expect(fills.map((f) => [f.text, f.kind, f.submit])).toEqual([
      ["alice", "username", undefined],
      [PASSWORD, "password", true],
    ]);
    const audits = listAudit(50, "credential.fill").filter((a) => a.target === cred.id);
    expect(audits.length).toBe(2);
    expect(audits[0]!.actor).toBe(`agent:${worker.id}`);
    expect(audits[0]!.details.runId).toBe(`run_mcp_${worker.slug}_0`);
  });

  test("vault_fill_totp fills the linked 2FA code", async () => {
    fills.length = 0;
    const r = await call(tokens[worker.id]!, "vault_fill_totp", { credentialId: cred.id });
    expect(r.isError).toBeUndefined();
    expect(fills).toHaveLength(1);
    expect(fills[0]!.kind).toBe("totp");
    expect(fills[0]!.text).toMatch(/^\d{6}$/);
    expect(r.content[0]!.text).not.toContain(fills[0]!.text);
    expect(listAudit(50, "totp.fill").length).toBeGreaterThan(0);
  });

  test("fill errors never echo the filled value", async () => {
    fillFailure.echoText = true;
    try {
      for (const field of ["username", "password"] as const) {
        const r = await call(tokens[worker.id]!, "vault_fill_login", { credentialId: cred.id, field });
        expect(r.isError).toBe(true);
        expect(r.content[0]!.text).toContain("Could not fill");
        expect(r.content[0]!.text).not.toContain(PASSWORD);
        expect(r.content[0]!.text).not.toContain("alice");
      }
      fills.length = 0;
      const t = await call(tokens[worker.id]!, "vault_fill_totp", { credentialId: cred.id });
      expect(t.isError).toBe(true);
      expect(t.content[0]!.text).not.toContain(fills[0]!.text);
    } finally {
      fillFailure.echoText = false;
    }
    const audits = listAudit(200).filter((a) => ["credential.fill", "totp.fill"].includes(a.action));
    expect(audits.every((a) => typeof a.details.field === "string" && typeof a.details.runId === "string")).toBe(true);
  });

  test("filling needs the browser", async () => {
    const r = await call(tokens[revealer.id]!, "vault_fill_login", { credentialId: cred.id, field: "username" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("browser is disabled");
  });

  test("reveal mode returns secrets and audits them", async () => {
    const r = await call(tokens[revealer.id]!, "vault_get_login", { credentialId: cred.id });
    expect(JSON.parse(r.content[0]!.text)).toEqual({ username: "alice", password: PASSWORD, url: "https://example.com/login" });
    const reveal = listAudit(50, "credential.reveal").find((a) => a.target === cred.id && a.actor === `agent:${revealer.id}`)!;
    expect(reveal.details).toEqual({ field: "username+password", runId: `run_mcp_${revealer.slug}_0` });
    const code = await call(tokens[revealer.id]!, "vault_get_totp", { credentialId: cred.id });
    expect(JSON.parse(code.content[0]!.text).code).toMatch(/^\d{6}$/);
    expect(listAudit(50, "totp.reveal")[0]!.details).toEqual({ field: "totp", runId: `run_mcp_${revealer.slug}_0` });
  });

  test("locked vault gives a helpful error", async () => {
    vault.lock();
    try {
      const r = await call(tokens[worker.id]!, "vault_fill_login", { credentialId: cred.id, field: "password" });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe("The vault is locked; ask the human to unlock Godmode.");
    } finally {
      await vault.unlock(PASSPHRASE);
    }
  });
});

describe("reporting + notifications", () => {
  test("report_missing_login records the report for the run", async () => {
    const r = await call(tokens[worker.id]!, "report_missing_login", {
      service: "Acme",
      url: "https://acme.test/login",
      kind: "missing_totp",
      reason: "2FA code required",
    });
    expect(r.content[0]!.text).toContain("Reported to the human");
    const item = listMissingLogins({}).find((m) => m.service === "Acme")!;
    expect(item.kind).toBe("missing_totp");
    expect(item.agentId).toBe(worker.id);
    expect(item.runId).toBe(`run_mcp_${worker.slug}_0`);
  });

  test("notify_user creates a notification linking to the conversation", async () => {
    await call(tokens[worker.id]!, "notify_user", { title: "Invoice ready", body: "Saved to workspace/", level: "success" });
    const n = listNotifications(10).find((x) => x.title === "Worker: Invoice ready")!;
    expect(n.kind).toBe("success");
    expect(n.link).toBe("/chat/cnv_mcp_test");
  });
});

describe("agents + delegation", () => {
  test("agents_list shows peers", async () => {
    const r = await call(tokens[delegator.id]!, "agents_list");
    const list = JSON.parse(r.content[0]!.text) as { id: string; name: string }[];
    expect(list.map((a) => a.id)).toContain(worker.id);
    expect(list.map((a) => a.id)).not.toContain(delegator.id);
    const detail = await call(tokens[delegator.id]!, "agent_get", { agentId: worker.id });
    expect(JSON.parse(detail.content[0]!.text).name).toBe("Worker");
  });

  test("agent_delegate runs the task on the peer and returns its answer", async () => {
    const r = await call(tokens[delegator.id]!, "agent_delegate", { agentId: worker.id, task: "Say hello", timeoutSeconds: 60 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("Worker finished the task");
    expect(r.content[0]!.text).toContain("Hello, nice to meet you!");
    const child = listRuns({ agentId: worker.id }).find((x) => x.trigger === "delegation")!;
    expect(child.parentRunId).toBe(`run_mcp_${delegator.slug}_0`);
    const conv = getConversation(child.conversationId);
    expect(conv.origin).toBe("delegation");
    expect(conv.title).toBe("Task from Delegator");
    expect(conv.messages[0]!.content).toBe("[Delegated by Delegator]\n\nSay hello");
  });

  test("agent_delegate without waiting + delegation_status", async () => {
    const r = await call(tokens[delegator.id]!, "agent_delegate", { agentId: worker.id, task: "Background job", wait: false });
    const runId = /run (run_[A-Za-z0-9]+)/.exec(r.content[0]!.text)![1]!;
    const status = await call(tokens[delegator.id]!, "delegation_status", { runId, wait: true, timeoutSeconds: 30 });
    expect(status.content[0]!.text).toContain("Hello, nice to meet you!");
    expect(getRun(runId).status).toBe("succeeded");
    const other = await call(tokens[worker.id]!, "vault_list_logins", {});
    expect(other.isError).toBeUndefined();
  });

  test("delegation limits: depth, self, non-peers", async () => {
    const deep = tokenFor(delegator, 3);
    const tooDeep = await call(deep, "agent_delegate", { agentId: worker.id, task: "x" });
    expect(tooDeep.isError).toBe(true);
    expect(tooDeep.content[0]!.text).toContain("depth limit");
    revokeRunToken(deep);
    const self = await call(tokens[delegator.id]!, "agent_delegate", { agentId: delegator.id, task: "x" });
    expect(self.isError).toBe(true);
    const missing = await call(tokens[delegator.id]!, "agent_delegate", { agentId: "agt_missing", task: "x" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("not one of your peers");
  });
});

describe("management tools", () => {
  test("agent_create with a routine, update, runs_list, logins_overview", async () => {
    const created = await call(tokens[manager.id]!, "agent_create", {
      name: "Invoice Bot",
      description: "Downloads invoices",
      instructions: "Download all invoices monthly.",
      routine: { name: "Monthly", cron: "0 9 1 * *", prompt: "Download last month's invoices" },
    });
    expect(created.isError).toBeUndefined();
    const out = JSON.parse(created.content[0]!.text) as { created: { id: string }; routine: { id: string } };
    const agent = getAgent(out.created.id);
    expect(agent.name).toBe("Invoice Bot");
    expect(agent.permissions.canManageAgents).toBe(false);
    expect(listRoutines({ agentId: agent.id }).map((r) => r.cron)).toEqual(["0 9 1 * *"]);

    const updated = await call(tokens[manager.id]!, "agent_update", { agentId: agent.id, description: "Downloads invoices monthly" });
    expect(updated.isError).toBeUndefined();
    expect(getAgent(agent.id).description).toBe("Downloads invoices monthly");

    const runs = await call(tokens[manager.id]!, "runs_list", { limit: 5 });
    expect(Array.isArray(JSON.parse(runs.content[0]!.text))).toBe(true);

    const overview = await call(tokens[manager.id]!, "logins_overview");
    const o = JSON.parse(overview.content[0]!.text) as { logins: { name: string; has2fa: boolean }[] };
    expect(o.logins.find((l) => l.name === "Example")?.has2fa).toBe(true);
    expect(overview.content[0]!.text).not.toContain(PASSWORD);

    const del = await call(tokens[manager.id]!, "agent_delete", { agentId: agent.id });
    expect(del.content[0]!.text).toContain("Deleted");
    expect(listAgents({ workspaceId: "all" }).some((a) => a.id === agent.id)).toBe(false);
    const selfDelete = await call(tokens[manager.id]!, "agent_delete", { agentId: manager.id });
    expect(selfDelete.isError).toBe(true);
  });
});
