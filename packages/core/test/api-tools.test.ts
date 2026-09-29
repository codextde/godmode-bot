import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ApiTool, ApiToolTestResult } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import * as vault from "../src/vault/vault";
import { get } from "../src/db";
import { getAccessToken } from "../src/server/auth";
import { clearGrants, issueGrant } from "../src/server/grants";
import { issueRunToken, revokeRunToken } from "../src/mcp/tokens";
import { listAudit } from "../src/services/audit";
import { createWorkspace, deleteWorkspace } from "../src/services/workspaces";
import { updateAgent } from "../src/agents/service";
import { buildEnv } from "../src/runner/runner";
import { buildSystemPrompt, resumeContextPrefix } from "../src/runner/prompt";
import { getSettings } from "../src/services/settings";
import {
  apiToolEnv,
  apiToolKey,
  apiToolsForAgent,
  createApiTool,
  deleteApiTool,
  findApiToolForAgent,
  listApiTools,
  resolveApiUrl,
  updateApiTool,
} from "../src/integrations/apiTools";
import { callApiTool, sniffType, type CallPlaces } from "../src/integrations/apiToolRequest";
import { HttpError } from "../src/util";

const PASSPHRASE = "correct horse battery staple";
const KEY = "AIzaSy-test-key-1234567890";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(1200).fill(7)]);

let env: TestEnv;
let api: ReturnType<typeof Bun.serve>;
let apiUrl: string;
let places: CallPlaces;
let agentA: Agent;
let agentB: Agent;
let loner: Agent;
let wsId: string;
const seen: { method: string; url: URL; headers: Headers; body: string; contentType: string }[] = [];

function expectHttpError(fn: () => unknown, status: number): HttpError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
    return err as HttpError;
  }
  throw new Error(`expected HttpError ${status}`);
}

async function route<T>(method: string, path: string, body?: unknown, grant?: string): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${getAccessToken()}` };
  if (grant) headers["x-godmode-grant"] = grant;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${env.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as T };
}

async function gateway(agent: Agent, name: string, args: unknown = {}) {
  const token = issueRunToken({ runId: `run_tools_${agent.slug}`, agentId: agent.id, conversationId: "cnv_tools_test", workspaceId: agent.workspaceId, depth: 0 });
  try {
    const res = await fetch(`${env.baseUrl}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: name === "tools/list" ? "tools/list" : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } }),
    });
    return (await res.json()) as { result: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
  } finally {
    revokeRunToken(token);
  }
}

beforeAll(async () => {
  env = await setupEnv("godmode-api-tools-");
  await vault.setup(PASSPHRASE, false);
  api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const contentType = req.headers.get("content-type") ?? "";
      const body = contentType.startsWith("multipart/") ? JSON.stringify([...(await req.formData()).entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).name}:${(v as File).size}`])) : await req.text();
      seen.push({ method: req.method, url, headers: req.headers, body, contentType });
      const authed = req.headers.get("x-goog-api-key") === KEY || url.searchParams.get("key") === KEY || req.headers.get("authorization") === `Bearer ${KEY}`;
      switch (url.pathname) {
        case "/v1/models":
          return authed ? Response.json({ models: [{ name: "image-model" }] }) : Response.json({ error: { message: "API key not valid" } }, { status: 401 });
        case "/v1/generate":
          return Response.json({ candidates: [{ content: { parts: [{ text: "Here you go" }, { inlineData: { mimeType: "image/png", data: Buffer.from(PNG).toString("base64") } }] } }] });
        case "/v1/image.png":
          return new Response(PNG, { headers: { "content-type": "image/png" } });
        case "/v1/echo":
          return Response.json({ youSent: req.headers.get("x-goog-api-key"), body });
        case "/v1/bounce-out":
          return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
        case "/v1/bounce-in":
          return new Response(null, { status: 302, headers: { location: "/v1/models" } });
        case "/v1/report":
          return new Response(new TextEncoder().encode("%PDF-1.7 report"), { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="report 100%.pdf"' } });
        case "/v1/nested":
          return Response.json({ mimeType: "application/pdf", body: { attachmentId: "A".repeat(800) } });
        case "/v1/loop":
          return new Response(null, { status: 302, headers: { location: "/v1/loop" } });
        case "/v1/echo-url":
          return new Response(req.url, { headers: { "content-type": "text/plain" } });
        case "/admin":
          return Response.json({ secret: "admin" });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    },
  });
  apiUrl = `http://127.0.0.1:${api.port}`;
  wsId = createWorkspace({ name: "Design" }).id;
  agentA = await makeAgent({ name: "Designer", workspaceId: wsId });
  agentB = await makeAgent({ name: "Accountant" });
  loner = await makeAgent({ name: "Loner", workspaceId: wsId, inheritMcp: false });
  const out = join(agentA.repoPath, "workspace", "api-tools");
  places = { roots: [agentA.repoPath], cwd: agentA.repoPath, outputDir: out };
});

afterAll(async () => {
  api.stop(true);
  clearGrants();
  await env.close();
});

describe("CRUD + validation", () => {
  test("validates address, key placement and environment variable", () => {
    expectHttpError(() => createApiTool({ name: "x" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "ftp://example.com" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://user:pw@example.com" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://example.com/?a=1" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://example.com", auth: { in: "header", name: "Bad Header", prefix: "" } }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://example.com", envVar: "PATH" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://example.com", envVar: "ANTHROPIC_API_KEY" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://example.com", envVar: "1BAD" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://example.com", apiKey: "has space" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://example.com", apiKey: "short" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://example.com", envVar: "HTTPS_PROXY" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://example.com", envVar: "BASH_ENV" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://example.com", envVar: "NODE_AUTH_TOKEN" }), 400);
    expectHttpError(() => createApiTool({ name: "x", baseUrl: "https://example.com", testPath: "https://other.example/models" }), 403);
    expectHttpError(() => createApiTool({ name: "x", workspaceId: "ws_missing", baseUrl: "https://example.com" }), 400);
  });

  test("seals the key, never returns it, and normalizes the address", () => {
    const tool = createApiTool({ name: "Seal test", baseUrl: "https://api.example.com/v1/", apiKey: ` ${KEY} ` });
    expect(tool.baseUrl).toBe("https://api.example.com/v1");
    expect(tool.hasKey).toBe(true);
    expect(tool.auth).toEqual({ in: "header", name: "Authorization", prefix: "Bearer " });
    expect(JSON.stringify(tool)).not.toContain(KEY);
    const row = get<{ key_enc: string }>("SELECT key_enc FROM api_tools WHERE id = ?", tool.id)!;
    expect(row.key_enc).not.toContain(KEY);
    expect(apiToolKey(tool.id)).toBe(KEY);
    expect(vault.redact(`key=${KEY}`)).not.toContain(KEY);

    const kept = updateApiTool(tool.id, { description: "Images" });
    expect(kept.hasKey).toBe(true);
    expect(updateApiTool(tool.id, { apiKey: "" }).hasKey).toBe(false);
    deleteApiTool(tool.id);
    expect(listApiTools().some((t) => t.id === tool.id)).toBe(false);
  });

  test("an env-only tool needs no address", () => {
    const tool = createApiTool({ name: "CLI token", envVar: "SOME_CLI_TOKEN", apiKey: "cli-token-123456" });
    expect(tool.baseUrl).toBe("");
    deleteApiTool(tool.id);
  });
});

describe("resolveApiUrl", () => {
  test("paths stay under the address", () => {
    expect(resolveApiUrl("https://api.example.com/v1", "/models").toString()).toBe("https://api.example.com/v1/models");
    expect(resolveApiUrl("https://api.example.com/v1", "models?x=1").toString()).toBe("https://api.example.com/v1/models?x=1");
    expect(resolveApiUrl("https://api.example.com/v1", "/v1/models").toString()).toBe("https://api.example.com/v1/models");
    expect(resolveApiUrl("https://api.example.com", "/v1beta/models/a:generateContent").toString()).toBe("https://api.example.com/v1beta/models/a:generateContent");
    expect(resolveApiUrl("https://api.example.com/v1", "https://api.example.com/v1/files").toString()).toBe("https://api.example.com/v1/files");
  });

  test("everything else is refused", () => {
    for (const path of ["https://evil.example/v1/models", "//evil.example/v1", "/v1/../admin", "/v1/%2e%2e/admin", "http://api.example.com/v1/models", "https://api.example.com/v10/x", "https://u:p@api.example.com/v1/x"]) {
      expectHttpError(() => resolveApiUrl("https://api.example.com/v1", path), 403);
    }
  });
});

describe("scope", () => {
  let global: ApiTool;
  let workspace: ApiTool;
  let pinned: ApiTool;

  beforeAll(() => {
    global = createApiTool({ name: "Everyone", baseUrl: "https://a.example", envVar: "SHARED_KEY", apiKey: "global-key-111111" });
    workspace = createApiTool({ name: "Design only", workspaceId: wsId, baseUrl: "https://b.example", envVar: "SHARED_KEY", apiKey: "workspace-key-222222" });
    pinned = createApiTool({ name: "Loner only", agentId: loner.id, workspaceId: wsId, baseUrl: "https://c.example" });
  });

  afterAll(() => {
    for (const t of [global, workspace, pinned]) deleteApiTool(t.id);
  });

  test("global, workspace and pinned tools reach the right agents", () => {
    expect(apiToolsForAgent(agentA).map((t) => t.name)).toEqual(["Everyone", "Design only"]);
    expect(apiToolsForAgent(agentB).map((t) => t.name)).toEqual(["Everyone"]);
    expect(apiToolsForAgent(loner).map((t) => t.name)).toEqual(["Loner only"]);
  });

  test("the most specific tool wins an environment variable", () => {
    expect(apiToolEnv(agentA)).toEqual({ SHARED_KEY: "workspace-key-222222" });
    expect(apiToolEnv(agentB)).toEqual({ SHARED_KEY: "global-key-111111" });
    expect(buildEnv(agentA).SHARED_KEY).toBe("workspace-key-222222");
    expect(buildEnv(agentA, false, false).SHARED_KEY).toBeUndefined();
  });

  test("disabled tools and a locked vault leave keys out", async () => {
    updateApiTool(workspace.id, { enabled: false });
    expect(apiToolEnv(agentA)).toEqual({ SHARED_KEY: "global-key-111111" });
    updateApiTool(workspace.id, { enabled: true });
    vault.lock();
    try {
      expect(apiToolEnv(agentA)).toEqual({});
    } finally {
      await vault.unlock(PASSPHRASE);
    }
  });

  test("tools are found by id, name or slug", () => {
    expect(findApiToolForAgent(agentA, workspace.id).id).toBe(workspace.id);
    expect(findApiToolForAgent(agentA, "design ONLY").id).toBe(workspace.id);
    expect(findApiToolForAgent(agentA, "design-only").id).toBe(workspace.id);
    const err = expectHttpError(() => findApiToolForAgent(agentB, "Design only"), 404);
    expect(err.message).toContain("Everyone");
  });

  test("deleting a workspace takes its tools along", async () => {
    const other = createWorkspace({ name: "Temp" });
    const tool = createApiTool({ name: "Temp tool", workspaceId: other.id, baseUrl: "https://d.example" });
    await deleteWorkspace(other.id, true);
    expect(listApiTools().some((t) => t.id === tool.id)).toBe(false);
  });
});

describe("requests", () => {
  let gemini: ApiTool;

  beforeAll(() => {
    gemini = createApiTool({ name: "Nano Banana", baseUrl: `${apiUrl}/v1`, auth: { in: "header", name: "x-goog-api-key", prefix: "" }, apiKey: KEY, testPath: "/models" });
  });

  afterAll(() => deleteApiTool(gemini.id));

  test("adds the key and wins over a header the agent sends", async () => {
    seen.length = 0;
    const res = await callApiTool(gemini, KEY, { path: "/models", headers: { "X-Goog-Api-Key": "attacker", "X-Extra": "1" } }, places);
    expect(res.ok).toBe(true);
    expect(seen[0]!.headers.get("x-goog-api-key")).toBe(KEY);
    expect(seen[0]!.headers.get("x-extra")).toBe("1");
    expect(res.text).toContain("image-model");
    expect(res.text).toContain("200 OK");
  });

  test("never shows the key, even when the API echoes it", async () => {
    const res = await callApiTool(gemini, KEY, { method: "POST", path: "echo", json: { hello: "world" } }, places);
    expect(res.text).not.toContain(KEY);
    expect(res.text).toContain("••••••••");
    expect(seen.at(-1)!.contentType).toBe("application/json");
  });

  test("query placement keeps the key out of the shown URL", async () => {
    const tool = { ...gemini, auth: { in: "query" as const, name: "key", prefix: "" } };
    const res = await callApiTool(tool, KEY, { path: "models", query: { key: "attacker", pageSize: 5 } }, places);
    expect(res.ok).toBe(true);
    expect(seen.at(-1)!.url.searchParams.get("key")).toBe(KEY);
    expect(seen.at(-1)!.url.searchParams.get("pageSize")).toBe("5");
    expect(res.text).not.toContain(KEY);
  });

  test("base64 images in JSON are saved as files", async () => {
    const res = await callApiTool(gemini, KEY, { method: "POST", path: "generate", json: { prompt: "a fox" } }, places);
    expect(res.ok).toBe(true);
    expect(res.files).toHaveLength(1);
    const file = res.files[0]!;
    expect(file.type).toBe("image/png");
    expect(file.path.startsWith(places.outputDir)).toBe(true);
    expect(file.path.endsWith(".png")).toBe(true);
    expect(new Uint8Array(readFileSync(file.path))).toEqual(PNG);
    expect(res.text).toContain(`[saved to ${file.path}`);
    expect(res.text).toContain("Here you go");
    expect(res.text).not.toContain(Buffer.from(PNG).toString("base64").slice(0, 100));
  });

  test("binary responses are saved, saveAs picks the path", async () => {
    const res = await callApiTool(gemini, KEY, { path: "image.png", saveAs: "workspace/out/fox" }, places);
    expect(res.files[0]!.path).toBe(join(agentA.repoPath, "workspace", "out", "fox.png"));
    expect(existsSync(res.files[0]!.path)).toBe(true);
    const folder = await callApiTool(gemini, KEY, { path: "image.png", saveAs: "workspace/out/" }, places);
    expect(folder.files[0]!.path.startsWith(join(agentA.repoPath, "workspace", "out") + "/")).toBe(true);
  });

  test("files outside the run's folders can't be read or written", async () => {
    const outside = join(env.dataDir, "outside.txt");
    writeFileSync(outside, "private");
    await expect(callApiTool(gemini, KEY, { method: "POST", path: "echo", json: { f: { $file: outside } } }, places)).rejects.toThrow("outside the folders");
    await expect(callApiTool(gemini, KEY, { path: "image.png", saveAs: join(env.dataDir, "x.png") }, places)).rejects.toThrow("outside the folders");
    const link = join(agentA.repoPath, "workspace", "sneaky");
    symlinkSync(env.dataDir, link);
    await expect(callApiTool(gemini, KEY, { method: "POST", path: "echo", body: { $file: "workspace/sneaky/outside.txt" } }, places)).rejects.toThrow("outside the folders");
  });

  test("responses never go through a link, into hidden folders or over a file in a folder", async () => {
    const victim = join(env.dataDir, "victim.txt");
    writeFileSync(victim, "keep me");
    mkdirSync(join(agentA.repoPath, "workspace", "links"), { recursive: true });
    symlinkSync(victim, join(agentA.repoPath, "workspace", "links", "out.png"));
    await expect(callApiTool(gemini, KEY, { path: "image.png", saveAs: "workspace/links/out.png" }, places)).rejects.toThrow();
    expect(readFileSync(victim, "utf8")).toBe("keep me");

    const before = seen.length;
    await expect(callApiTool(gemini, KEY, { path: "image.png", saveAs: ".git/config" }, places)).rejects.toThrow("hidden");
    await expect(callApiTool(gemini, KEY, { path: "image.png", saveAs: "workspace/.claude/settings.json" }, places)).rejects.toThrow("hidden");
    await expect(callApiTool(gemini, KEY, { path: "image.png", saveAs: join(env.dataDir, "x.png") }, places)).rejects.toThrow("outside the folders");
    expect(seen.length).toBe(before);

    const first = await callApiTool(gemini, KEY, { path: "report", saveAs: "workspace/reports/" }, places);
    const second = await callApiTool(gemini, KEY, { path: "report", saveAs: "workspace/reports" }, places);
    expect(first.files[0]!.path.endsWith("report 100_.pdf")).toBe(true);
    expect(second.files[0]!.path.endsWith("report 100_-2.pdf")).toBe(true);
  });

  test("a type field only describes the strings next to it", async () => {
    const res = await callApiTool(gemini, KEY, { path: "nested" }, places);
    expect(res.files).toHaveLength(0);
    expect(res.text).toContain("A".repeat(800));
  });

  test("redirect loops stop", async () => {
    const res = await callApiTool(gemini, KEY, { path: "loop" }, places);
    expect(res.ok).toBe(false);
    expect(res.text).toContain("Stopped after 5 redirects");
  });

  test("a key that is URL-encoded in the query is masked too", async () => {
    const odd = "abc+def/ghi=jkl";
    const tool = { ...gemini, auth: { in: "query" as const, name: "key", prefix: "" } };
    const res = await callApiTool(tool, odd, { path: "echo-url" }, places);
    expect(res.text).not.toContain(encodeURIComponent(odd));
    expect(res.text).not.toContain("abc%2Bdef");
  });

  test("$file sends files as base64, form uploads and raw bodies", async () => {
    const dir = join(agentA.repoPath, "workspace", "in");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "logo.png"), PNG);
    await callApiTool(gemini, KEY, { method: "POST", path: "echo", json: { image: { $file: "workspace/in/logo.png" }, url: { $file: "workspace/in/logo.png", as: "dataUrl" } } }, places);
    const sent = JSON.parse(seen.at(-1)!.body) as { image: string; url: string };
    expect(sent.image).toBe(Buffer.from(PNG).toString("base64"));
    expect(sent.url.startsWith("data:image/png;base64,")).toBe(true);

    await callApiTool(gemini, KEY, { method: "POST", path: "echo", form: { prompt: "edit", image: { $file: join(dir, "logo.png") } } }, places);
    expect(seen.at(-1)!.body).toContain(`file:logo.png:${PNG.byteLength}`);

    await callApiTool(gemini, KEY, { method: "PUT", path: "echo", body: { $file: join(dir, "logo.png") } }, places);
    expect(seen.at(-1)!.contentType).toBe("image/png");
  });

  test("redirects are only followed inside the address", async () => {
    const inside = await callApiTool(gemini, KEY, { path: "bounce-in" }, places);
    expect(inside.ok).toBe(true);
    expect(inside.text).toContain("image-model");
    const outside = await callApiTool(gemini, KEY, { path: "bounce-out" }, places);
    expect(outside.ok).toBe(false);
    expect(outside.text).toContain("not followed");
  });

  test("paths outside the address are refused before anything is sent", async () => {
    const before = seen.length;
    await expect(callApiTool(gemini, KEY, { path: "../admin" }, places)).rejects.toThrow("outside this tool's API address");
    await expect(callApiTool(gemini, KEY, { path: `${apiUrl}/admin` }, places)).rejects.toThrow("outside this tool's API address");
    expect(seen.length).toBe(before);
  });

  test("errors come back with a hint", async () => {
    const res = await callApiTool(gemini, "wrong-key-000000", { path: "models" }, places);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.text).toContain("API key not valid");
    expect(res.text).toContain("Integrations → Tools");
  });

  test("sniffs common file types", () => {
    expect(sniffType(PNG)).toBe("image/png");
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffType(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffType(new TextEncoder().encode("RIFF1234WEBPVP8 "))).toBe("image/webp");
    expect(sniffType(new TextEncoder().encode("hello world"))).toBeNull();
  });
});

describe("routes", () => {
  test("create, list, test, update and delete", async () => {
    const created = await route<ApiTool>("POST", "/api/api-tools", {
      name: "Routed",
      baseUrl: `${apiUrl}/v1`,
      auth: { in: "header", name: "x-goog-api-key", prefix: "" },
      apiKey: KEY,
      testPath: "/models",
      preset: "gemini",
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.data)).not.toContain(KEY);

    const list = await route<ApiTool[]>("GET", "/api/api-tools");
    expect(list.data.some((t) => t.id === created.data.id)).toBe(true);

    const ok = await route<ApiToolTestResult>("POST", `/api/api-tools/${created.data.id}/test`);
    expect(ok.data.ok).toBe(true);
    expect(ok.data.status).toBe(200);

    await route("PATCH", `/api/api-tools/${created.data.id}`, { apiKey: "wrong-key-000000" });
    const bad = await route<ApiToolTestResult>("POST", `/api/api-tools/${created.data.id}/test`);
    expect(bad.data.ok).toBe(false);
    expect(bad.data.message).toContain("rejected the key");
    expect(bad.data.message).toContain("API key not valid");

    expect((await route("DELETE", `/api/api-tools/${created.data.id}`)).status).toBe(200);
  });

  test("a saved key only moves to new places with the passphrase", async () => {
    clearGrants();
    const { data: tool } = await route<ApiTool>("POST", "/api/api-tools", { name: "Guarded", baseUrl: "https://api.example.com/v1", apiKey: KEY });
    expect((await route("PATCH", `/api/api-tools/${tool.id}`, { envVar: "GUARDED_KEY" })).status).toBe(403);
    expect((await route("PATCH", `/api/api-tools/${tool.id}`, { baseUrl: "https://evil.example" })).status).toBe(403);
    expect((await route("PATCH", `/api/api-tools/${tool.id}`, { baseUrl: "https://api.example.com/v1/images" })).status).toBe(200);
    expect((await route("PATCH", `/api/api-tools/${tool.id}`, { baseUrl: "https://evil.example", apiKey: "a-new-key-999999" })).status).toBe(200);
    expect((await route("PATCH", `/api/api-tools/${tool.id}`, { envVar: "GUARDED_KEY" }, issueGrant().grant)).status).toBe(200);
    await route("DELETE", `/api/api-tools/${tool.id}`);
  });
});

describe("agents", () => {
  let tool: ApiTool;

  beforeAll(() => {
    tool = createApiTool({
      name: "Nano Banana",
      description: "Generate and edit images",
      docs: "POST /generate with { prompt }",
      baseUrl: `${apiUrl}/v1`,
      auth: { in: "header", name: "x-goog-api-key", prefix: "" },
      envVar: "GEMINI_API_KEY",
      apiKey: KEY,
      workspaceId: wsId,
    });
  });

  afterAll(() => deleteApiTool(tool.id));

  test("the gateway lists API tools only for agents that have some", async () => {
    const withTools = (await gateway(agentA, "tools/list")).result.tools!.map((t) => t.name);
    expect(withTools).toEqual(expect.arrayContaining(["api_tools_list", "api_tool_docs", "api_tool_request"]));
    const without = (await gateway(agentB, "tools/list")).result.tools!.map((t) => t.name);
    expect(without).not.toContain("api_tool_request");
  });

  test("agents read the docs and call the API without seeing the key", async () => {
    const list = (await gateway(agentA, "api_tools_list")).result.content![0]!.text;
    expect(list).toContain("Nano Banana");
    expect(list).toContain("GEMINI_API_KEY");
    expect(list).not.toContain(KEY);

    const docs = (await gateway(agentA, "api_tool_docs", { tool: "Nano Banana" })).result.content![0]!.text;
    expect(docs).toContain("POST /generate with { prompt }");
    expect(docs).toContain('in the header "x-goog-api-key"');

    const res = await gateway(agentA, "api_tool_request", { tool: tool.id, method: "POST", path: "generate", json: { prompt: "fox" } });
    expect(res.result.isError).toBeUndefined();
    const text = res.result.content![0]!.text;
    expect(text).toContain(join(agentA.repoPath, "workspace", "api-tools"));
    expect(text).not.toContain(KEY);

    const entry = listAudit(10, "api_tool.request")[0]!;
    expect(entry.actor).toBe(`agent:${agentA.id}`);
    expect(entry.target).toBe(tool.id);
    expect((await import("../src/integrations/apiTools")).getApiTool(tool.id).lastUsedAt).not.toBeNull();

    const denied = await gateway(agentB, "api_tool_request", { tool: tool.id, path: "models" });
    expect(denied.result.isError).toBe(true);

    const refused = await gateway(agentA, "api_tool_request", { tool: tool.id, path: "image.png", saveAs: ".git/hooks/pre-commit" });
    expect(refused.result.isError).toBe(true);
    expect(listAudit(10, "api_tool.request")[0]!.details).toMatchObject({ refused: true });
  });

  test("the system prompt introduces the tools", async () => {
    const settings = getSettings();
    const prompt = buildSystemPrompt({
      agent: agentA,
      settings,
      peers: [],
      browserAvailable: false,
      apiTools: [{ id: tool.id, name: tool.name, description: tool.description, baseUrl: tool.baseUrl, envVar: tool.envVar }],
    });
    expect(prompt).toContain("### API tools");
    expect(prompt).toContain(`**Nano Banana** (\`${tool.id}\`) — Generate and edit images`);
    expect(prompt).toContain("`$GEMINI_API_KEY`");
    expect(prompt).toContain("api_tool_request");
    expect(buildSystemPrompt({ agent: agentB, settings, peers: [], browserAvailable: false })).not.toContain("### API tools");
    expect(resumeContextPrefix(null, agentA.repoPath, { apiTools: [{ id: tool.id, name: tool.name, description: "", baseUrl: "", envVar: null }] })).toContain(
      `Nano Banana (\`${tool.id}\`)`,
    );
  });

  test("turning off inherited integrations removes shared tools", async () => {
    const updated = await updateAgent(agentA.id, { inheritMcp: false });
    expect(apiToolsForAgent(updated)).toHaveLength(0);
    await updateAgent(agentA.id, { inheritMcp: true });
  });
});
