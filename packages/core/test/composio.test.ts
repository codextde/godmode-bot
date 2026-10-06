import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { Hono } from "hono";
import { loadConfig } from "../src/config";
import { closeDb, get, getMeta, insert, openDb, run } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import * as vault from "../src/vault/vault";
import * as composio from "../src/integrations/composio";
import { createMcpServer, mcpServersForAgent } from "../src/integrations/mcpServers";
import { registerIntegrationRoutes } from "../src/server/routes/integrations";
import { HttpError } from "../src/util";

const PASSPHRASE = "correct horse battery staple";
const API_KEY = "ak_test_0123456789abcdef";
let dataDir: string;

/* ------------------------------ fetch mock ------------------------------ */

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}
type Handler = (call: Call) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let routes: { method: string; path: string | RegExp; handler: Handler }[] = [];

function route(method: string, path: string | RegExp, handler: Handler | Record<string, unknown>) {
  routes.unshift({ method, path, handler: typeof handler === "function" ? handler : () => Response.json(handler) });
}

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const text = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
    const call: Call = { method: req.method, url: new URL(req.url), headers: req.headers, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const match = routes.find(
      (r) => r.method === call.method && (typeof r.path === "string" ? call.url.pathname === r.path : r.path.test(call.url.pathname)),
    );
    if (!match) return new Response(JSON.stringify({ error: { message: `unmocked ${call.method} ${call.url.pathname}` } }), { status: 500 });
    return match.handler(call);
  }) as typeof fetch;
}

const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.pathname === path);

/* ------------------------------- fixtures ------------------------------- */

function agentModel(p: Partial<Agent> & { id: string }): Agent {
  return {
    id: p.id,
    workspaceId: p.workspaceId ?? null,
    name: p.id,
    slug: p.id,
    avatar: "🤖",
    color: "violet",
    character: { body: "blob", eyes: "dots", mouth: "smile", top: "none", face: "none", neck: "none" },
    personality: "",
    description: "",
    instructions: "",
    role: "",
    reportsTo: null,
    failedRunId: null,
    model: "",
    effort: null,
    ultracode: null,
    isDefault: false,
    enabled: true,
    status: "idle",
    permissions: {
      canManageAgents: false,
      allowDelegation: false,
      delegateTo: [],
      secretAccess: "fill",
      credentialIds: null,
      totpIds: null,
      maxBudgetUsd: null,
    },
    browser: { profileId: null, enabled: false, headless: null },
    computer: { enabled: false, target: null },
    mcpServerIds: [],
    inheritMcp: p.inheritMcp ?? true,
    subagents: [],
    workingDirectory: null,
    vmId: null,
    sshServerIds: [],
    heartbeat: { enabled: false, intervalMinutes: 60, hours: null, weekdays: false, checklist: "", since: null },
    repoPath: "",
    lastRunAt: null,
    createdAt: "",
    updatedAt: "",
  };
}

async function expectHttpError(fn: () => unknown, status: number): Promise<HttpError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    return err as HttpError;
  }
  throw new Error(`expected HttpError ${status}`);
}

beforeAll(async () => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-composio-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  composio.resetComposioState();
  vault.lock();
  await vault.setup(PASSPHRASE, false);
  const ts = new Date().toISOString();
  insert("workspaces", { id: "ws_sales", name: "Sales", slug: "sales", created_at: ts, updated_at: ts });
  insert("agents", { id: "agt_x", workspace_id: "ws_sales", name: "X", slug: "x", repo_path: join(dataDir, "agents", "x"), created_at: ts, updated_at: ts });
  installFetchMock();
});

beforeEach(() => {
  calls = [];
  routes = [];
  route("GET", "/api/v3.1/toolkits", { items: [], next_cursor: null });
});

afterEach(() => {
  composio.resetComposioState();
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vault.lock();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

/* --------------------------------- tests -------------------------------- */

describe("API key + status", () => {
  test("not configured until a key is set", async () => {
    expect(await composio.getStatus()).toEqual({ configured: false, valid: null });
    await expectHttpError(() => composio.listToolkits(), 400);
    expect(calls).toHaveLength(0);
  });

  test("setApiKey stores the key encrypted, validates it and caches the verdict", async () => {
    const status = await composio.setApiKey(API_KEY);
    expect(status).toEqual({ configured: true, valid: true });
    const check = callsTo("GET", "/api/v3.1/toolkits")[0]!;
    expect(check.url.origin).toBe("https://backend.composio.dev");
    expect(check.url.searchParams.get("limit")).toBe("1");
    expect(check.headers.get("x-api-key")).toBe(API_KEY);
    const stored = get<{ value_enc: string }>("SELECT value_enc FROM secrets WHERE key = 'composio_api_key'")!;
    expect(stored.value_enc).not.toContain(API_KEY);
    expect(get<{ action: string }>("SELECT action FROM audit_log WHERE action = 'composio.key.set'")).not.toBeNull();

    calls = [];
    expect(await composio.getStatus()).toEqual({ configured: true, valid: true });
    expect(calls).toHaveLength(0); // cached
  });

  test("an invalid key is reported (never as HTTP 401)", async () => {
    route("GET", "/api/v3.1/toolkits", () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
    expect(await composio.getStatus(true)).toEqual({ configured: true, valid: false, error: "Invalid Composio API key" });
    const err = await expectHttpError(() => composio.listToolkits(), 400);
    expect(err.message).toBe("Invalid Composio API key");
  });

  test("locked vault → status without verdict", async () => {
    vault.lock();
    try {
      expect(await composio.getStatus()).toEqual({ configured: true, valid: null, error: "Unlock the vault to use Composio" });
    } finally {
      await vault.unlock(PASSPHRASE);
    }
  });
});

describe("toolkits", () => {
  test("maps v3.1 items and forwards search/category/cursor", async () => {
    route("GET", "/api/v3.1/toolkits", {
      items: [
        {
          slug: "github",
          name: "GitHub",
          auth_schemes: ["OAUTH2", "BEARER_TOKEN"],
          composio_managed_auth_schemes: ["OAUTH2"],
          no_auth: false,
          meta: {
            logo: "https://logos.composio.dev/github.png",
            description: "Code hosting",
            categories: [{ id: "dev", name: "Developer Tools" }],
            tools_count: 800,
          },
        },
        { slug: "composio_search", name: "Composio Search", no_auth: true, meta: { logo: "", description: "Search", categories: [] } },
      ],
      next_cursor: "cur_2",
      total_pages: 3,
      current_page: 1,
      total_items: 100,
    });
    const page = await composio.listToolkits({ search: "git", category: "dev", cursor: "cur_1" });
    expect(page.nextCursor).toBe("cur_2");
    expect(page.items).toEqual([
      {
        slug: "github",
        name: "GitHub",
        logo: "https://logos.composio.dev/github.png",
        description: "Code hosting",
        categories: ["Developer Tools"],
        authSchemes: ["OAUTH2", "BEARER_TOKEN"],
        noAuth: false,
      },
      { slug: "composio_search", name: "Composio Search", logo: null, description: "Search", categories: [], authSchemes: [], noAuth: true },
    ]);
    const q = callsTo("GET", "/api/v3.1/toolkits")[0]!.url.searchParams;
    expect(q.get("search")).toBe("git");
    expect(q.get("category")).toBe("dev");
    expect(q.get("cursor")).toBe("cur_1");
  });

  test("honors 429 Retry-After: one short automatic retry, clear message for long waits", async () => {
    let n = 0;
    route("GET", "/api/v3.1/toolkits", () =>
      ++n === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : Response.json({ items: [], next_cursor: null }),
    );
    expect((await composio.listToolkits()).items).toEqual([]);
    expect(n).toBe(2);

    route("GET", "/api/v3.1/toolkits", () => new Response("{}", { status: 429, headers: { "retry-after": "120" } }));
    const err = await expectHttpError(() => composio.listToolkits(), 429);
    expect(err.message).toContain("120 seconds");
  });
});

describe("connect flow", () => {
  test("creates a managed auth config when none exists, then links the account", async () => {
    route("GET", "/api/v3.1/toolkits/github", {
      slug: "github",
      name: "GitHub",
      composio_managed_auth_schemes: ["OAUTH2"],
      auth_config_details: [{ mode: "OAUTH2" }],
    });
    route("GET", "/api/v3.1/auth_configs", { items: [], next_cursor: null });
    route("POST", "/api/v3.1/auth_configs", { toolkit: { slug: "github" }, auth_config: { id: "ac_new", auth_scheme: "OAUTH2", is_composio_managed: true } });
    route("POST", "/api/v3.1/connected_accounts/link", {
      link_token: "lt",
      redirect_url: "https://connect.composio.dev/link/lk_1",
      expires_at: "2030-01-01T00:00:00Z",
      connected_account_id: "ca_github_1",
    });

    const result = await composio.connect({ toolkit: "GitHub", workspaceId: "ws_sales", agentId: null });
    expect(result).toMatchObject({ redirectUrl: "https://connect.composio.dev/link/lk_1", connectedAccountId: "ca_github_1", status: "INITIATED" });
    expect(callsTo("GET", "/api/v3.1/auth_configs")[0]!.url.searchParams.get("toolkit_slug")).toBe("github");
    expect(callsTo("POST", "/api/v3.1/auth_configs")[0]!.body).toEqual({
      toolkit: { slug: "github" },
      auth_config: { type: "use_composio_managed_auth" },
    });
    expect(callsTo("POST", "/api/v3.1/connected_accounts/link")[0]!.body).toEqual({ auth_config_id: "ac_new", user_id: "ws_ws_sales" });

    const conn = composio.listConnections().find((c) => c.id === result.connectionId)!;
    expect(conn).toMatchObject({ connectedAccountId: "ca_github_1", toolkit: "github", workspaceId: "ws_sales", agentId: null, userId: "ws_ws_sales", status: "INITIATED" });
  });

  test("reuses an existing enabled auth config (custom preferred)", async () => {
    route("GET", "/api/v3.1/toolkits/gmail", { slug: "gmail", name: "Gmail", composio_managed_auth_schemes: ["OAUTH2"] });
    route("GET", "/api/v3.1/auth_configs", {
      items: [
        { id: "ac_disabled", toolkit: { slug: "gmail" }, is_composio_managed: false, status: "DISABLED" },
        { id: "ac_managed", toolkit: { slug: "gmail" }, is_composio_managed: true, status: "ENABLED" },
        { id: "ac_custom", toolkit: { slug: "gmail" }, is_composio_managed: false, status: "ENABLED" },
      ],
    });
    route("POST", "/api/v3.1/connected_accounts/link", { redirect_url: "https://connect.composio.dev/link/g", connected_account_id: "ca_gmail_1" });
    const result = await composio.connect({ toolkit: "gmail", workspaceId: null, agentId: "agt_x" });
    expect(callsTo("POST", "/api/v3.1/auth_configs")).toHaveLength(0);
    expect(callsTo("POST", "/api/v3.1/connected_accounts/link")[0]!.body).toEqual({ auth_config_id: "ac_custom", user_id: "agent_agt_x" });
    const conn = composio.listConnections().find((c) => c.id === result.connectionId)!;
    // Agent-scoped connection records the agent's workspace for display.
    expect(conn).toMatchObject({ agentId: "agt_x", workspaceId: "ws_sales", userId: "agent_agt_x" });
  });

  test("toolkit without Composio-managed auth → clear 400", async () => {
    route("GET", "/api/v3.1/toolkits/acme", { slug: "acme", name: "Acme CRM", composio_managed_auth_schemes: [], auth_config_details: [{ mode: "API_KEY" }] });
    route("GET", "/api/v3.1/auth_configs", { items: [] });
    const err = await expectHttpError(() => composio.connect({ toolkit: "acme", workspaceId: null, agentId: null }), 400);
    expect(err.code).toBe("composio_auth_config_required");
    expect(err.message).toContain("Composio dashboard");
    expect(callsTo("POST", "/api/v3.1/connected_accounts/link")).toHaveLength(0);
  });

  test("no-auth toolkit becomes ACTIVE immediately without a link", async () => {
    route("GET", "/api/v3.1/toolkits/composio_search", { slug: "composio_search", name: "Search", no_auth: true });
    const result = await composio.connect({ toolkit: "composio_search", workspaceId: null, agentId: null });
    expect(result).toMatchObject({ redirectUrl: null, connectedAccountId: "", status: "ACTIVE" });
    expect(callsTo("POST", "/api/v3.1/connected_accounts/link")).toHaveLength(0);
    // Idempotent.
    const again = await composio.connect({ toolkit: "composio_search", workspaceId: null, agentId: null });
    expect(again.connectionId).toBe(result.connectionId);
  });

  test("no-auth detection falls back to the catalog listing", async () => {
    route("GET", "/api/v3.1/toolkits/hackernews", { slug: "hackernews", name: "Hacker News" });
    route("GET", "/api/v3.1/toolkits", { items: [{ slug: "hackernews", name: "Hacker News", no_auth: true }] });
    const result = await composio.connect({ toolkit: "hackernews", workspaceId: "ws_sales", agentId: null });
    expect(result.status).toBe("ACTIVE");
  });

  test("unknown toolkit / unknown scope", async () => {
    route("GET", "/api/v3.1/toolkits/nope", () => new Response(JSON.stringify({ error: { message: "Toolkit not found" } }), { status: 404 }));
    await expectHttpError(() => composio.connect({ toolkit: "nope", workspaceId: null, agentId: null }), 404);
    await expectHttpError(() => composio.connect({ toolkit: "github", workspaceId: "ws_missing", agentId: null }), 400);
  });

  test("refresh updates status from upstream; disconnect deletes upstream and locally", async () => {
    const row = composio.listConnections().find((c) => c.connectedAccountId === "ca_github_1")!;
    route("GET", "/api/v3.1/connected_accounts/ca_github_1", { id: "ca_github_1", status: "ACTIVE", toolkit: { slug: "github" } });
    const refreshed = await composio.refreshConnection(row.id);
    expect(refreshed.status).toBe("ACTIVE");
    // Also addressable by the Composio account id.
    expect((await composio.refreshConnection("ca_github_1")).id).toBe(row.id);

    route("GET", "/api/v3.1/connected_accounts/ca_gone", () => new Response("{}", { status: 404 }));
    const ts = new Date().toISOString();
    insert("composio_connections", { id: "cmp_gone", connected_account_id: "ca_gone", toolkit: "slack", user_id: "global", status: "ACTIVE", created_at: ts, updated_at: ts });
    expect((await composio.refreshConnection("cmp_gone")).status).toBe("DELETED");

    route("DELETE", "/api/v3.1/connected_accounts/ca_gone", () => new Response("{}", { status: 404 }));
    await composio.disconnect("cmp_gone");
    expect(get("SELECT id FROM composio_connections WHERE id = 'cmp_gone'")).toBeNull();
  });
});

describe("Tool Router MCP servers", () => {
  const agent = agentModel({ id: "agt_x", workspaceId: "ws_sales" });

  test("one session per scope with ACTIVE connections, cached and reused", async () => {
    let created = 0;
    route("POST", "/api/v3.1/tool_router/session", (call) => {
      created++;
      const body = call.body as { user_id: string };
      return Response.json(
        { session_id: `trs_${body.user_id}_${created}`, mcp: { type: "http", url: `https://backend.composio.dev/tool_router/trs_${created}/mcp` }, tool_router_tools: [] },
        { status: 201 },
      );
    });

    // agent scope: gmail is still INITIATED → no agent session; workspace: github ACTIVE + hackernews (no auth).
    const servers = await composio.composioMcpServersForAgent(agent);
    expect(Object.keys(servers).sort()).toEqual(["composio-global", "composio-workspace"]);
    expect(servers["composio-workspace"]).toEqual({
      type: "http",
      url: expect.stringMatching(/^https:\/\/backend\.composio\.dev\/tool_router\/trs_\d\/mcp$/),
      headers: { "x-api-key": API_KEY },
    });
    const wsBody = callsTo("POST", "/api/v3.1/tool_router/session")
      .map((c) => c.body as Record<string, unknown>)
      .find((b) => b.user_id === "ws_ws_sales")!;
    expect(wsBody).toEqual({
      user_id: "ws_ws_sales",
      toolkits: { enable: ["github", "hackernews"] },
      connected_accounts: { github: ["ca_github_1"] },
      manage_connections: { enable: false },
    });
    expect(getMeta("composio.session.ws_ws_sales")).toContain("trs_ws_ws_sales");

    // Second resolution: cached + recently verified → no upstream calls.
    calls = [];
    await composio.composioMcpServersForAgent(agent);
    expect(calls).toHaveLength(0);

    // After the verification window: GET the session, reuse it.
    composio.resetComposioState();
    route("GET", /^\/api\/v3\.1\/tool_router\/session\/.+/, (call) =>
      Response.json({ session_id: call.url.pathname.split("/").pop(), mcp: { type: "http", url: "https://backend.composio.dev/tool_router/reused/mcp" } }),
    );
    const reused = await composio.composioMcpServersForAgent(agent);
    expect(callsTo("POST", "/api/v3.1/tool_router/session")).toHaveLength(0);
    expect((reused["composio-workspace"] as { url: string }).url).toBe("https://backend.composio.dev/tool_router/reused/mcp");

    // Session vanished upstream → recreated.
    composio.resetComposioState();
    route("GET", /^\/api\/v3\.1\/tool_router\/session\/.+/, () => new Response("{}", { status: 404 }));
    await composio.composioMcpServersForAgent(agent);
    expect(callsTo("POST", "/api/v3.1/tool_router/session").length).toBeGreaterThan(0);
  });

  test("toolkit set change → new session; inheritMcp=false → agent scope only", async () => {
    run("UPDATE composio_connections SET status = 'ACTIVE' WHERE connected_account_id = 'ca_gmail_1'");
    let n = 100;
    route("POST", "/api/v3.1/tool_router/session", (call) =>
      Response.json({ session_id: `trs_${++n}`, mcp: { type: "http", url: `https://backend.composio.dev/tool_router/trs_${n}/mcp` }, _u: (call.body as { user_id: string }).user_id }),
    );
    const servers = await composio.composioMcpServersForAgent(agentModel({ id: "agt_x", workspaceId: "ws_sales", inheritMcp: false }));
    expect(Object.keys(servers)).toEqual(["composio-agent"]);
    expect(callsTo("POST", "/api/v3.1/tool_router/session")[0]!.body).toMatchObject({ user_id: "agent_agt_x", toolkits: { enable: ["gmail"] } });
  });

  test("API key is only attached to composio.dev origins", async () => {
    expect(composio.isComposioOrigin("https://backend.composio.dev/tool_router/x/mcp")).toBe(true);
    expect(composio.isComposioOrigin("https://mcp.composio.dev/x")).toBe(true);
    expect(composio.isComposioOrigin("http://mcp.composio.dev/x")).toBe(false);
    expect(composio.isComposioOrigin("https://composio.dev.evil.example/x")).toBe(false);
    expect(composio.isComposioOrigin("https://evilcomposio.dev/x")).toBe(false);
    expect(composio.isComposioOrigin("not a url")).toBe(false);

    run("DELETE FROM meta WHERE key LIKE 'composio.session.%'");
    route("POST", "/api/v3.1/tool_router/session", () =>
      Response.json({ session_id: "trs_evil", mcp: { type: "http", url: "https://evil.example/mcp" } }),
    );
    const servers = await composio.composioMcpServersForAgent(agent);
    for (const entry of Object.values(servers)) {
      expect(entry).toEqual({ type: "http", url: "https://evil.example/mcp" });
    }
  });

  test("mcpServersForAgent merges custom and Composio servers; Composio failures don't break runs", async () => {
    await createMcpServer({ workspaceId: null, agentId: null, name: "Local FS", transport: "stdio", command: "npx" });
    run("DELETE FROM meta WHERE key LIKE 'composio.session.%'");
    route("POST", "/api/v3.1/tool_router/session", () =>
      Response.json({ session_id: "trs_ok", mcp: { type: "http", url: "https://backend.composio.dev/tool_router/ok/mcp" } }),
    );
    const merged = await mcpServersForAgent(agent);
    expect(Object.keys(merged)).toEqual(expect.arrayContaining(["local-fs", "composio-global", "composio-workspace", "composio-agent"]));

    composio.resetComposioState();
    run("DELETE FROM meta WHERE key LIKE 'composio.session.%'");
    route("POST", "/api/v3.1/tool_router/session", () => new Response("{}", { status: 503 }));
    const degraded = await mcpServersForAgent(agent);
    expect(Object.keys(degraded)).toEqual(["local-fs"]);
  });
});

describe("routes", () => {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status as 400);
    return c.json({ error: String(err) }, 500);
  });
  registerIntegrationRoutes(app);

  test("composio + mcp endpoints", async () => {
    let res = await app.request("/api/composio/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: true });

    res = await app.request("/api/composio/connections");
    expect(Array.isArray(await res.json())).toBe(true);

    res = await app.request("/api/composio/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolkit: "" }),
    });
    expect(res.status).toBe(400);

    res = await app.request("/api/mcp-servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Route test", transport: "http", url: "https://x.example/mcp", headers: { Authorization: "Bearer abcdef" } }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; headerKeys: string[]; workspaceId: null };
    expect(created.headerKeys).toEqual(["Authorization"]);
    expect(created.workspaceId).toBeNull();

    res = await app.request(`/api/mcp-servers/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);

    res = await app.request("/api/mcp-servers?workspaceId=global");
    expect(((await res.json()) as { id: string }[]).some((s) => s.id === created.id)).toBe(true);

    res = await app.request(`/api/mcp-servers/${created.id}`, { method: "DELETE" });
    expect(await res.json()).toEqual({ ok: true });
    res = await app.request(`/api/mcp-servers/${created.id}/test`, { method: "POST" });
    expect(res.status).toBe(404);

    route("GET", "/api/v3.1/toolkits", () => new Response("{}", { status: 401 }));
    res = await app.request("/api/composio/key", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "ak_other_key_123456" }),
    });
    expect(await res.json()).toEqual({ configured: true, valid: false, error: "Invalid Composio API key" });
    // Key change invalidates cached Tool Router sessions.
    expect(getMeta("composio.session.global")).toBeNull();

    res = await app.request("/api/composio/key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: null }) });
    expect(await res.json()).toEqual({ configured: false, valid: null });
  });
});
