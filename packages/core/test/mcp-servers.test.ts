import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@godmode/shared";
import { SECRET_MASK } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, get, insert, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import * as vault from "../src/vault/vault";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  mcpServerSecrets,
  mcpServersForAgent,
  updateMcpServer,
} from "../src/integrations/mcpServers";
import { probeMcpServer, probeMcpTarget, sseEvents } from "../src/integrations/mcpProbe";
import { resetComposioState } from "../src/integrations/composio";
import { HttpError } from "../src/util";

const PASSPHRASE = "correct horse battery staple";
const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");
let dataDir: string;

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
    mcpServerIds: p.mcpServerIds ?? [],
    inheritMcp: p.inheritMcp ?? true,
    subagents: [],
    workingDirectory: null,
    vmId: null,
    sshServerIds: [],
    repoPath: "",
    lastRunAt: null,
    createdAt: "",
    updatedAt: "",
  };
}

function seedWorkspace(id: string) {
  const ts = new Date().toISOString();
  insert("workspaces", { id, name: id, slug: id, created_at: ts, updated_at: ts });
}

function seedAgent(id: string, workspaceId: string | null) {
  const ts = new Date().toISOString();
  insert("agents", { id, workspace_id: workspaceId, name: id, slug: id, repo_path: join(dataDir, "agents", id), created_at: ts, updated_at: ts });
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
  dataDir = mkdtempSync(join(tmpdir(), "godmode-mcp-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  resetComposioState();
  vault.lock();
  await vault.setup(PASSPHRASE, false);
  seedWorkspace("ws_one");
  seedWorkspace("ws_two");
  seedAgent("agt_a", "ws_one");
  seedAgent("agt_b", "ws_two");
  seedAgent("agt_global", null);
});

afterAll(() => {
  vault.lock();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("CRUD + validation", () => {
  test("validates transport-specific fields", async () => {
    await expectHttpError(() => createMcpServer({ workspaceId: null, agentId: null, name: "x", transport: "stdio" }), 400);
    await expectHttpError(() => createMcpServer({ workspaceId: null, agentId: null, name: "x", transport: "http" }), 400);
    await expectHttpError(
      () => createMcpServer({ workspaceId: null, agentId: null, name: "x", transport: "sse", url: "ftp://example.com" }),
      400,
    );
    await expectHttpError(() => createMcpServer({ workspaceId: "ws_missing", agentId: null, name: "x", transport: "stdio", command: "npx" }), 400);
    await expectHttpError(
      () => createMcpServer({ workspaceId: null, agentId: null, name: "x", transport: "stdio", command: "npx", env: { "BAD KEY": "1" } }),
      400,
    );
    await expectHttpError(
      () => createMcpServer({ workspaceId: null, agentId: null, name: "x", transport: "http", url: "https://a.example", headers: { "X-Y": "a\r\nb" } }),
      400,
    );
  });

  test("stores env/headers encrypted, exposes only key names, and keeps masked values", async () => {
    const created = await createMcpServer({
      workspaceId: null,
      agentId: null,
      name: "Secrets",
      transport: "stdio",
      command: "npx",
      args: ["-y", "some-mcp"],
      env: { API_TOKEN: "s3cret-token-value", MODE: "fast" },
    });
    expect(created.envKeys).toEqual(["API_TOKEN", "MODE"]);
    expect(created.source).toBe("custom");
    const row = get<{ env_enc: string | null }>("SELECT env_enc FROM mcp_servers WHERE id = ?", created.id)!;
    expect(row.env_enc).toBeTruthy();
    expect(row.env_enc).not.toContain("s3cret-token-value");
    expect(JSON.stringify(listMcpServers())).not.toContain("s3cret-token-value");

    // Creating with the mask is meaningless → rejected.
    await expectHttpError(
      () => createMcpServer({ workspaceId: null, agentId: null, name: "Bad", transport: "stdio", command: "npx", env: { A: SECRET_MASK } }),
      400,
    );

    const updated = await updateMcpServer(created.id, { env: { API_TOKEN: SECRET_MASK, NEW_VAR: "v2" } });
    expect(updated.envKeys).toEqual(["API_TOKEN", "NEW_VAR"]);
    expect(mcpServerSecrets(created.id).env).toEqual({ API_TOKEN: "s3cret-token-value", NEW_VAR: "v2" });

    await expectHttpError(() => updateMcpServer(created.id, { env: { NOT_STORED: SECRET_MASK } }), 400);

    // Non-secret updates don't touch secrets.
    const renamed = await updateMcpServer(created.id, { name: "Secrets renamed", args: ["-y", "other"] });
    expect(renamed.args).toEqual(["-y", "other"]);
    expect(mcpServerSecrets(created.id).env.API_TOKEN).toBe("s3cret-token-value");

    // Clearing secrets.
    const cleared = await updateMcpServer(created.id, { env: {} });
    expect(cleared.envKeys).toEqual([]);
    expect(get<{ env_enc: string | null }>("SELECT env_enc FROM mcp_servers WHERE id = ?", created.id)!.env_enc).toBeNull();

    // Switching transport requires the new transport's fields.
    await expectHttpError(() => updateMcpServer(created.id, { transport: "http" }), 400);
    const http = await updateMcpServer(created.id, { transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer abcdef123" } });
    expect(http.command).toBe("");
    expect(http.args).toEqual([]);
    expect(http.headerKeys).toEqual(["Authorization"]);

    deleteMcpServer(created.id);
    await expectHttpError(() => getMcpServer(created.id), 404);
  });

  test("list filters by workspace scope and agent", async () => {
    const g = await createMcpServer({ workspaceId: null, agentId: null, name: "Filter global", transport: "stdio", command: "npx" });
    const w = await createMcpServer({ workspaceId: "ws_one", agentId: null, name: "Filter ws", transport: "stdio", command: "npx" });
    const a = await createMcpServer({ workspaceId: "ws_one", agentId: "agt_a", name: "Filter agent", transport: "stdio", command: "npx" });
    const ids = (list: { id: string }[]) => list.map((s) => s.id);
    expect(ids(listMcpServers({ workspaceId: "global" }))).toContain(g.id);
    expect(ids(listMcpServers({ workspaceId: "global" }))).not.toContain(w.id);
    expect(ids(listMcpServers({ workspaceId: "ws_one" }))).toEqual(expect.arrayContaining([w.id, a.id]));
    expect(ids(listMcpServers({ agentId: "agt_a" }))).toEqual([a.id]);
    expect(ids(listMcpServers({ workspaceId: "all" }))).toEqual(expect.arrayContaining([g.id, w.id, a.id]));
    for (const s of [g, w, a]) deleteMcpServer(s.id);
  });
});

describe("mcpServersForAgent scoping", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const mk = async (key: string, input: Parameters<typeof createMcpServer>[0]) => {
      ids[key] = (await createMcpServer(input)).id;
    };
    await mk("global", { workspaceId: null, agentId: null, name: "Global Tool", transport: "http", url: "https://g.example/mcp", headers: { "X-Api-Key": "global-key-123" } });
    await mk("ws1", { workspaceId: "ws_one", agentId: null, name: "WS One Tool", transport: "stdio", command: "npx", args: ["ws1"], env: { TOKEN: "ws1-token-abc" } });
    await mk("ws2", { workspaceId: "ws_two", agentId: null, name: "WS Two Tool", transport: "stdio", command: "npx" });
    await mk("pinnedA", { workspaceId: null, agentId: "agt_a", name: "Pinned A", transport: "sse", url: "https://sse.example/sse" });
    await mk("pinnedB", { workspaceId: null, agentId: "agt_b", name: "Pinned B", transport: "stdio", command: "npx" });
    await mk("disabled", { workspaceId: null, agentId: null, name: "Disabled Tool", transport: "stdio", command: "npx", enabled: false });
    await mk("explicit", { workspaceId: "ws_two", agentId: null, name: "Explicit", transport: "stdio", command: "uvx" });
    await mk("dup1", { workspaceId: null, agentId: null, name: "GitHub", transport: "stdio", command: "npx" });
    await mk("dup2", { workspaceId: null, agentId: null, name: "GitHub", transport: "stdio", command: "npx" });
    await mk("reserved", { workspaceId: null, agentId: null, name: "Browser", transport: "stdio", command: "npx" });
    await mk("reserved2", { workspaceId: null, agentId: null, name: "godmode", transport: "stdio", command: "npx" });
  });

  test("workspace agent inheriting: global + own workspace + pinned (explicit ids never widen the scope)", async () => {
    // "explicit" belongs to ws_two and "pinned-b" to agt_b: listing their ids must not hand them to agt_a.
    const servers = await mcpServersForAgent(agentModel({ id: "agt_a", workspaceId: "ws_one", mcpServerIds: [ids.explicit!, ids.pinnedB!] }));
    expect(Object.keys(servers).sort()).toEqual(["browser-2", "github", "github-2", "global-tool", "godmode-2", "pinned-a", "ws-one-tool"].sort());
    expect(servers["global-tool"]).toEqual({ type: "http", url: "https://g.example/mcp", headers: { "X-Api-Key": "global-key-123" } });
    expect(servers["ws-one-tool"]).toEqual({ type: "stdio", command: "npx", args: ["ws1"], env: { TOKEN: "ws1-token-abc" } });
    expect(servers["pinned-a"]).toEqual({ type: "sse", url: "https://sse.example/sse" });
    expect(servers).not.toHaveProperty("browser");
    expect(servers).not.toHaveProperty("godmode");
  });

  test("inheritMcp=false: only pinned + in-scope explicit ids", async () => {
    const servers = await mcpServersForAgent(
      agentModel({ id: "agt_a", workspaceId: "ws_one", inheritMcp: false, mcpServerIds: [ids.explicit!, ids.ws1!, ids.global!] }),
    );
    expect(Object.keys(servers).sort()).toEqual(["global-tool", "pinned-a", "ws-one-tool"]);
    const b = await mcpServersForAgent(agentModel({ id: "agt_b", workspaceId: "ws_two", inheritMcp: false, mcpServerIds: [ids.explicit!] }));
    expect(Object.keys(b).sort()).toEqual(["explicit", "pinned-b"]);
  });

  test("global agent sees only global servers; other workspace agent sees its own", async () => {
    const global = await mcpServersForAgent(agentModel({ id: "agt_global", workspaceId: null }));
    expect(Object.keys(global)).not.toContain("ws-one-tool");
    expect(Object.keys(global)).not.toContain("ws-two-tool");
    expect(Object.keys(global)).toContain("global-tool");
    const b = await mcpServersForAgent(agentModel({ id: "agt_b", workspaceId: "ws_two" }));
    expect(Object.keys(b)).toEqual(expect.arrayContaining(["ws-two-tool", "explicit", "pinned-b", "global-tool"]));
    expect(Object.keys(b)).not.toContain("pinned-a");
    expect(Object.keys(b)).not.toContain("disabled-tool");
  });

  test("servers whose secrets need the locked vault are skipped, others stay", async () => {
    vault.lock();
    try {
      const servers = await mcpServersForAgent(agentModel({ id: "agt_a", workspaceId: "ws_one" }));
      expect(servers).not.toHaveProperty("global-tool");
      expect(servers).not.toHaveProperty("ws-one-tool");
      expect(servers).toHaveProperty("pinned-a");
    } finally {
      await vault.unlock(PASSPHRASE);
    }
  });

  afterAll(() => {
    for (const id of Object.values(ids)) deleteMcpServer(id);
  });
});

describe("redaction of MCP secrets", () => {
  test("each stored header/env value is redacted, also after the vault was locked and unlocked", async () => {
    const server = await createMcpServer({
      workspaceId: null,
      agentId: null,
      name: "Redacted",
      transport: "http",
      url: "https://redact.example/mcp",
      headers: { Authorization: "Bearer tok_live_7f3a9c2e", "X-Api-Key": "hdr-key-5566778" },
    });
    const envServer = await createMcpServer({ workspaceId: null, agentId: null, name: "Redacted env", transport: "stdio", command: "npx", env: { API_TOKEN: "env-token-99887766" } });
    const leak = "auth=Bearer tok_live_7f3a9c2e token=tok_live_7f3a9c2e key=hdr-key-5566778 env=env-token-99887766";
    const check = () => {
      const out = vault.redact(leak);
      for (const v of ["tok_live_7f3a9c2e", "hdr-key-5566778", "env-token-99887766"]) expect(out).not.toContain(v);
    };
    try {
      check();
      // lock() forgets every known secret; unlock() must reload them from mcp_servers too.
      vault.lock();
      await vault.unlock(PASSPHRASE);
      check();
    } finally {
      deleteMcpServer(server.id);
      deleteMcpServer(envServer.id);
    }
  });
});

describe("probe", () => {
  test("stdio: handshake, pagination, env passing, server→client ping", async () => {
    const server = await createMcpServer({
      workspaceId: null,
      agentId: null,
      name: "Fake stdio",
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: { FAKE_TOOL_PREFIX: "demo" },
    });
    const result = await probeMcpServer(server.id);
    expect(result).toEqual({ ok: true, tools: ["demo_a", "demo_b", "demo_c"] });
    deleteMcpServer(server.id);
  }, 30_000);

  test("stdio: early exit reports stderr with secrets redacted", async () => {
    const result = await probeMcpTarget({
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: { FAKE_MODE: "exit", FAKE_SECRET: "super-secret-value-42" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited with code 3");
    expect(result.error).toContain("missing token");
    expect(result.error).not.toContain("super-secret-value-42");
  }, 30_000);

  test("stdio: JSON-RPC error and timeout", async () => {
    const refused = await probeMcpTarget({ transport: "stdio", command: process.execPath, args: [FIXTURE], env: { FAKE_MODE: "init-error" } });
    expect(refused).toEqual({ ok: false, error: "initialize failed: initialization refused (code -32000)" });
    const hung = await probeMcpTarget({ transport: "stdio", command: process.execPath, args: [FIXTURE], env: { FAKE_MODE: "hang" } }, 1_500);
    expect(hung.ok).toBe(false);
    expect(hung.error).toContain("No response within");
  }, 30_000);

  test("stdio: unknown command", async () => {
    const result = await probeMcpTarget({ transport: "stdio", command: "definitely-not-a-real-mcp-binary-xyz" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Command not found");
  });

  test("streamable http: session id, SSE responses, auth header", async () => {
    const seen: { method: string; session: string | null; version: string | null }[] = [];
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (req.method === "DELETE") return new Response(null, { status: 200 });
        if (req.headers.get("authorization") !== "Bearer good-token") return new Response("nope", { status: 401 });
        const msg = (await req.json()) as { id?: number; method: string };
        seen.push({ method: msg.method, session: req.headers.get("mcp-session-id"), version: req.headers.get("mcp-protocol-version") });
        if (msg.method === "initialize") {
          return Response.json(
            { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "h", version: "1" } } },
            { headers: { "mcp-session-id": "sess-123" } },
          );
        }
        if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
        const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search" }, { name: "fetch" }] } });
        return new Response(`: keep-alive\n\nevent: message\ndata: ${payload}\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const url = `http://127.0.0.1:${srv.port}/mcp`;
      const ok = await probeMcpTarget({ transport: "http", url, headers: { Authorization: "Bearer good-token" } });
      expect(ok).toEqual({ ok: true, tools: ["fetch", "search"] });
      expect(seen.map((s) => s.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
      expect(seen[0]!.session).toBeNull();
      expect(seen[2]).toEqual({ method: "tools/list", session: "sess-123", version: "2025-06-18" });

      const denied = await probeMcpTarget({ transport: "http", url, headers: { Authorization: "Bearer wrong-token" } });
      expect(denied.ok).toBe(false);
      expect(denied.error).toContain("401");
      expect(denied.error).not.toContain("wrong-token");
    } finally {
      srv.stop(true);
    }
  });

  test("legacy sse: endpoint event, responses over the stream", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const enc = new TextEncoder();
    const push = (s: string) => controller?.enqueue(enc.encode(s));
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/sse") {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
              push("event: endpoint\r\ndata: /messages?sessionId=abc\r\n\r\n");
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        if (req.method === "POST" && url.pathname === "/messages") {
          const msg = (await req.json()) as { id?: number; method: string };
          if (msg.id !== undefined) {
            const result =
              msg.method === "initialize"
                ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "legacy", version: "1" } }
                : { tools: [{ name: "legacy_tool" }] };
            setTimeout(() => push(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`), 5);
          }
          return new Response("Accepted", { status: 202 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await probeMcpTarget({ transport: "sse", url: `http://127.0.0.1:${srv.port}/sse` });
      expect(result).toEqual({ ok: true, tools: ["legacy_tool"] });
    } finally {
      srv.stop(true);
    }
  });

  test("sse parser handles CRLF, multi-line data, comments and chunk splits", async () => {
    const enc = new TextEncoder();
    const parts = [": hello\r\n\r\nev", "ent: a\r", "\ndata: line1\ndata: line2\n\n", "data: {\"x\":1}"];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    const events = [];
    for await (const ev of sseEvents(stream)) events.push(ev);
    expect(events).toEqual([
      { event: "a", data: "line1\nline2", id: undefined },
      { event: "message", data: '{"x":1}', id: undefined },
    ]);
  });
});
