import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Agent, Artifact, ArtifactSummary, ArtifactVersion } from "@godmode/shared";
import { invocations, makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { callTool } from "../src/mcp/tools";
import { deleteConversation, getConversation, startChat } from "../src/services/conversations";
import { applyEdits, getArtifact, listArtifacts, listArtifactVersions } from "../src/services/artifacts";
import { listActiveRuns, listRuns, waitForRun } from "../src/runner/runner";
import { getAccessToken } from "../src/server/auth";

let env: TestEnv;
let agent: Agent;
let other: Agent;

beforeAll(async () => {
  env = await setupEnv("godmode-artifacts-");
  agent = await makeAgent({ name: "Builder" });
  other = await makeAgent({ name: "Other" });
});

afterAll(async () => {
  for (const r of listActiveRuns()) await waitForRun(r.runId, 10_000).catch(() => undefined);
  await env.close();
});

const ctxFor = (conversationId: string, a: Agent = agent) => ({ runId: "run_artifact_test", agentId: a.id, conversationId, workspaceId: null, depth: 0 });

async function chat(content = "Build me a sales dashboard"): Promise<string> {
  const { conversation, run } = await startChat({ agentId: agent.id, content });
  await waitForRun(run.id, 10_000);
  return conversation.id;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

const HTML = `<!doctype html><html><body><h1 id="t">Sales</h1><div id="total"></div><script>godmode.onData((d) => { document.getElementById("total").textContent = d.total; });</script></body></html>`;

async function created(conversationId: string): Promise<Artifact> {
  const out = await callTool(ctxFor(conversationId), "artifact_create", {
    title: "Sales dashboard",
    description: "Revenue of the last 30 days",
    html: HTML,
    data: { total: 1200 },
    refreshPrompt: "Read the revenue from Stripe",
  });
  expect(out.isError).toBeFalsy();
  const id = /\(id (art_\w+)/.exec(out.content[0]!.text)?.[1];
  expect(id).toBeTruthy();
  return getArtifact(id!);
}

describe("an agent builds an artifact", () => {
  test("artifact_create saves code, data and the first version, linked to the chat", async () => {
    const conversationId = await chat();
    const a = await created(conversationId);
    expect(a).toMatchObject({
      title: "Sales dashboard",
      version: 1,
      data: { total: 1200 },
      agentId: agent.id,
      agentName: "Builder",
      conversationId,
      refreshPrompt: "Read the revenue from Stripe",
      pinned: false,
    });
    expect(a.html).toBe(HTML);
    expect(listArtifactVersions(a.id).map((v) => v.version)).toEqual([1]);
    expect(listArtifacts({ conversationId }).map((x) => x.id)).toEqual([a.id]);
  });

  test("data passed as a JSON string is stored as JSON", async () => {
    const conversationId = await chat();
    const out = await callTool(ctxFor(conversationId), "artifact_create", { title: "KPIs", html: "<p>x</p>", data: '{"kpis":[1,2]}' });
    const id = /\(id (art_\w+)/.exec(out.content[0]!.text)![1]!;
    expect(getArtifact(id).data).toEqual({ kpis: [1, 2] });
  });

  test("edits make a new version, data alone doesn't", async () => {
    const conversationId = await chat();
    const a = await created(conversationId);
    const edit = await callTool(ctxFor(conversationId), "artifact_update", { id: a.id, edits: [{ find: "<h1 id=\"t\">Sales</h1>", replace: "<h1 id=\"t\">Revenue</h1>" }], note: "Renamed the heading" });
    expect(edit.isError).toBeFalsy();
    expect(edit.content[0]!.text).toContain("version 2");
    const data = await callTool(ctxFor(conversationId), "artifact_update", { id: a.id, data: { total: 5000 } });
    expect(data.content[0]!.text).toContain("data is saved");
    const now = getArtifact(a.id);
    expect(now.version).toBe(2);
    expect(now.html).toContain("Revenue");
    expect(now.data).toEqual({ total: 5000 });
    expect(listArtifactVersions(a.id).map((v) => [v.version, v.note])).toEqual([
      [2, "Renamed the heading"],
      [1, "First version"],
    ]);
  });

  test("an edit that doesn't match exactly once is refused with a hint", async () => {
    const conversationId = await chat();
    const a = await created(conversationId);
    const missing = await callTool(ctxFor(conversationId), "artifact_update", { id: a.id, edits: [{ find: "<h2>", replace: "x" }] });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("isn't in the current HTML");
    expect(() => applyEdits("a a", [{ find: "a", replace: "b" }])).toThrow("more than once");
    expect(applyEdits("a a", [{ find: "a", replace: "b", all: true }])).toBe("b b");
    expect(getArtifact(a.id).version).toBe(1);
  });

  test("another agent can't change it, a manager can read it", async () => {
    const conversationId = await chat();
    const a = await created(conversationId);
    const foreign = await callTool(ctxFor(conversationId, other), "artifact_update", { id: a.id, data: {} });
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]!.text).toContain("belongs to another agent");
    const unknown = await callTool(ctxFor(conversationId), "artifact_get", { id: "art_nope" });
    expect(unknown.isError).toBe(true);
    const read = await callTool(ctxFor(conversationId), "artifact_get", { id: a.id, part: "data" });
    expect(JSON.parse(read.content[0]!.text)).toMatchObject({ id: a.id, data: { total: 1200 } });
  });

  test("artifact_list shows the agent's own", async () => {
    const conversationId = await chat();
    const a = await created(conversationId);
    const out = await callTool(ctxFor(conversationId), "artifact_list", { thisChat: true });
    const list = JSON.parse(out.content[0]!.text) as { id: string; thisChat?: boolean }[];
    expect(list).toEqual([expect.objectContaining({ id: a.id, thisChat: true })]);
  });
});

describe("the human uses an artifact", () => {
  test("list, read, pin, save data, restore a version and delete over HTTP", async () => {
    const conversationId = await chat();
    const a = await created(conversationId);
    await callTool(ctxFor(conversationId), "artifact_update", { id: a.id, html: "<p>v2</p>", note: "Rewrote it" });

    const list = await api<ArtifactSummary[]>("GET", "/api/artifacts");
    expect(list.status).toBe(200);
    const row = list.json.find((x) => x.id === a.id)!;
    expect(row).toMatchObject({ title: "Sales dashboard", version: 2 });
    expect("html" in row).toBe(false);

    const pinned = await api<ArtifactSummary>("PATCH", `/api/artifacts/${a.id}`, { pinned: true, title: "Revenue" });
    expect(pinned.json).toMatchObject({ pinned: true, title: "Revenue" });
    expect((await api<ArtifactSummary[]>("GET", "/api/artifacts")).json[0]!.id).toBe(a.id);

    const saved = await api<{ dataUpdatedAt: string }>("PUT", `/api/artifacts/${a.id}/data`, { data: { total: 1, deals: [{ name: "ACME" }] }, version: 2 });
    expect(saved.status).toBe(200);
    expect(getArtifact(a.id).data).toEqual({ total: 1, deals: [{ name: "ACME" }] });

    const versions = await api<ArtifactVersion[]>("GET", `/api/artifacts/${a.id}/versions`);
    expect(versions.json.map((v) => v.version)).toEqual([2, 1]);
    const v1 = await api<{ html: string }>("GET", `/api/artifacts/${a.id}/versions/1`);
    expect(v1.json.html).toBe(HTML);

    const restored = await api<Artifact>("POST", `/api/artifacts/${a.id}/restore`, { version: 1 });
    expect(restored.json).toMatchObject({ version: 3, html: HTML, data: { total: 1, deals: [{ name: "ACME" }] } });

    const gone = await api<{ ok: boolean }>("DELETE", `/api/artifacts/${a.id}`);
    expect(gone.json.ok).toBe(true);
    expect((await api("GET", `/api/artifacts/${a.id}`)).status).toBe(404);
  });

  test("a change request and a refresh go to the artifact's chat", async () => {
    const conversationId = await chat();
    const a = await created(conversationId);
    const asked = await api<{ conversationId: string; queued: boolean }>("POST", `/api/artifacts/${a.id}/message`, { content: "Make the chart blue" });
    expect(asked.json.conversationId).toBe(conversationId);
    const runs = () => listRuns({ conversationId });
    await waitForRun(runs()[0]!.id, 10_000);
    const prompt = invocations(env).at(-1)!.prompt;
    expect(prompt).toContain(`[About the artifact "Sales dashboard" (${a.id})]`);
    expect(prompt).toContain("Make the chart blue");

    const refreshed = await api<{ conversationId: string }>("POST", `/api/artifacts/${a.id}/refresh`);
    expect(refreshed.json.conversationId).toBe(conversationId);
    await waitForRun(runs()[0]!.id, 10_000);
    const again = invocations(env).at(-1)!.prompt;
    expect(again).toContain("Refresh its data: Read the revenue from Stripe");
    expect(getConversation(conversationId).messages.filter((m) => m.role === "user")).toHaveLength(3);
  });

  test("when its chat is gone, a new chat with its agent takes the message", async () => {
    const conversationId = await chat();
    const a = await created(conversationId);
    await deleteConversation(conversationId);
    expect(getArtifact(a.id).conversationId).toBeNull();
    const asked = await api<{ conversationId: string }>("POST", `/api/artifacts/${a.id}/message`, { content: "Add a filter" });
    expect(asked.json.conversationId).not.toBe(conversationId);
    expect(getArtifact(a.id).conversationId).toBe(asked.json.conversationId);
    expect(getConversation(asked.json.conversationId).agentId).toBe(agent.id);
  });

  test("starting from a description opens a chat that asks for an artifact", async () => {
    const started = await api<{ conversationId: string }>("POST", "/api/artifacts/start", { prompt: "A KPI tracker", agentId: agent.id });
    expect(started.status).toBe(201);
    const conv = getConversation(started.json.conversationId);
    expect(conv.messages[0]!.content).toContain("Build it as an artifact (artifact_create)");
  });

  test("the system prompt tells agents about artifacts", async () => {
    await chat();
    const inv = invocations(env).at(-1)!;
    expect(JSON.stringify(inv)).toContain("### Artifacts");
  });
});

describe("the sandbox page", () => {
  test("answers without sign-in, may be framed and sandboxes itself", async () => {
    const res = await fetch(`${env.baseUrl}/api/artifacts/frame`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBeNull();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toStartWith("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src https: wss:");
    expect(await res.text()).toContain("gm:load");
    const api = await fetch(`${env.baseUrl}/api/artifacts`);
    expect(api.status).toBe(401);
  });
});

describe("through a real run", () => {
  test("the agent's artifact_create call lands in the chat and links the artifact to it", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "gm-art-")), "spec.json");
    writeFileSync(file, JSON.stringify({ tool: "artifact_create", args: { title: "Pipeline", html: "<p>deals</p>", data: { deals: [] } } }));
    const { conversation, run } = await startChat({ agentId: agent.id, content: `ARTIFACT_FROM:${file}` });
    const done = await waitForRun(run.id, 10_000);
    expect(done.result).toContain('Created the artifact \\"Pipeline\\"');
    const [a] = listArtifacts({ conversationId: conversation.id });
    expect(a).toMatchObject({ title: "Pipeline", agentId: agent.id, version: 1 });
    const blocks = getConversation(conversation.id).messages.at(-1)!.blocks ?? [];
    expect(blocks.some((b) => b.type === "tool_use" && b.name === "mcp__godmode__artifact_create" && (b.result ?? "").includes(a!.id))).toBe(true);
  });
});

describe("review fixes", () => {
  test("an artifact without an owner is for managers only, a save needs data, the app's strings stay strings", async () => {
    const conversationId = await chat();
    const a = await created(conversationId);
    const { run: sqlRun } = await import("../src/db");
    sqlRun("UPDATE artifacts SET agent_id = NULL WHERE id = ?", a.id);
    const refused = await callTool(ctxFor(conversationId, other), "artifact_get", { id: a.id });
    expect(refused.isError).toBe(true);
    expect((await api("PUT", `/api/artifacts/${a.id}/data`, {})).status).toBe(400);
    await api("PUT", `/api/artifacts/${a.id}/data`, { data: "[1,2]" });
    expect(getArtifact(a.id).data).toBe("[1,2]");
  });

  test("text from the artifact's code is marked, and a second refresh while the agent works adds nothing", async () => {
    const conversationId = await chat();
    const a = await created(conversationId);
    await api("POST", `/api/artifacts/${a.id}/message`, { content: "Add a chart", source: "app" });
    await waitForRun(listRuns({ conversationId })[0]!.id, 10_000);
    expect(invocations(env).at(-1)!.prompt).toContain("Sent from the artifact's own code");
    const users = () => getConversation(conversationId).messages.filter((m) => m.role === "user").length;
    const before = users();
    const first = await api<{ queued: boolean }>("POST", `/api/artifacts/${a.id}/refresh`);
    const second = await api<{ queued: boolean }>("POST", `/api/artifacts/${a.id}/refresh`);
    expect(first.status).toBe(200);
    expect(second.json.queued).toBe(true);
    await waitForRun(listRuns({ conversationId })[0]!.id, 10_000);
    expect(users()).toBe(before + 1);
  });

  test("only the last 50 versions are kept", async () => {
    const conversationId = await chat();
    const a = await created(conversationId);
    for (let i = 2; i <= 53; i++) await callTool(ctxFor(conversationId), "artifact_update", { id: a.id, html: `<p>${i}</p>` });
    const versions = listArtifactVersions(a.id);
    expect(versions).toHaveLength(50);
    expect(versions[0]!.version).toBe(53);
    expect(versions.at(-1)!.version).toBe(4);
  });
});
