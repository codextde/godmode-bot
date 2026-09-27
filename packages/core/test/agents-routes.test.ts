import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentFileEntry, AgentTemplate, GitCommit, MissingLogin, Routine, Workspace } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { getSettings, resetSettingsCache, updateSettings } from "../src/services/settings";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { clearGrants, issueGrant } from "../src/server/grants";
import { reportMissingLogin } from "../src/services/missingLogins";
import * as repo from "../src/agents/repo";

let dataDir: string;
let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-agent-routes-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  app = createApp();
  token = getAccessToken();
});

afterAll(() => {
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call<T = unknown>(method: string, path: string, body?: unknown, grant?: string): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (grant) headers["x-godmode-grant"] = grant;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`http://127.0.0.1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

describe("agent routes", () => {
  let agent: Agent;

  test("requires auth", async () => {
    const res = await app.request("http://127.0.0.1/api/agents");
    expect(res.status).toBe(401);
  });

  test("GET /api/agent-templates", async () => {
    const { status, data } = await call<AgentTemplate[]>("GET", "/api/agent-templates");
    expect(status).toBe(200);
    expect(data.length).toBeGreaterThanOrEqual(9);
  });

  test("POST /api/agents validates and creates", async () => {
    const bad = await call<{ error: string }>("POST", "/api/agents", { avatar: "🤖" });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("Validation failed");
    const badSub = await call("POST", "/api/agents", { name: "X", subagents: [{ name: "Bad Name", description: "d", prompt: "p" }] });
    expect(badSub.status).toBe(400);

    const created = await call<Agent>("POST", "/api/agents", {
      name: "Route Bot",
      effort: "high",
      permissions: { secretAccess: "fill", delegateTo: [] },
      browser: { headless: true },
    });
    expect(created.status).toBe(200);
    agent = created.data;
    expect(agent.slug).toBe("route-bot");
    expect(agent.effort).toBe("high");
    expect(agent.browser.headless).toBe(true);

    const list = await call<Agent[]>("GET", "/api/agents?workspaceId=global");
    expect(list.data.map((a) => a.id)).toContain(agent.id);
    expect((await call<Agent>("GET", `/api/agents/${agent.id}`)).data.name).toBe("Route Bot");
    expect((await call("GET", "/api/agents/agt_missing")).status).toBe(404);
  });

  test("PATCH /api/agents/:id", async () => {
    const res = await call<Agent>("PATCH", `/api/agents/${agent.id}`, { description: "Handles routes", effort: null });
    expect(res.status).toBe(200);
    expect(res.data.description).toBe("Handles routes");
    expect(res.data.effort).toBeNull();
    expect((await call("PATCH", `/api/agents/${agent.id}`, { effort: "ludicrous" })).status).toBe(400);
  });

  test("repository file endpoints", async () => {
    const files = await call<AgentFileEntry[]>("GET", `/api/agents/${agent.id}/files?path=`);
    expect(files.status).toBe(200);
    expect(files.data.map((f) => f.path)).toContain("CLAUDE.md");

    const claudeMd = await call<{ path: string; content: string }>("GET", `/api/agents/${agent.id}/file?path=CLAUDE.md`);
    expect(claudeMd.data.content).toContain("Route Bot");

    const write = await call("PUT", `/api/agents/${agent.id}/file`, { path: "memory/people.md", content: "# People\n" });
    expect(write).toEqual({ status: 200, data: { ok: true } });
    const commits = await call<GitCommit[]>("GET", `/api/agents/${agent.id}/commits`);
    expect(commits.data[0]!.message).toBe("Edit memory/people.md");

    expect((await call("GET", `/api/agents/${agent.id}/file?path=${encodeURIComponent("../../godmode.db")}`)).status).toBe(403);
    expect((await call("PUT", `/api/agents/${agent.id}/file`, { path: ".git/config", content: "x" })).status).toBe(403);
  });

  test("routine endpoints", async () => {
    const bad = await call<{ error: string }>("POST", "/api/routines", { agentId: agent.id, name: "Bad", cron: "99 * * * *", prompt: "x" });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("Invalid cron expression");

    const created = await call<Routine>("POST", "/api/routines", {
      agentId: agent.id,
      name: "Daily",
      cron: "0 8 * * *",
      timezone: "Europe/Berlin",
      prompt: "Do the daily thing",
    });
    expect(created.status).toBe(200);
    expect(created.data.nextRunAt).not.toBeNull();

    const listed = await call<Routine[]>("GET", `/api/routines?agentId=${agent.id}`);
    expect(listed.data.map((r) => r.id)).toEqual([created.data.id]);

    const patched = await call<Routine>("PATCH", `/api/routines/${created.data.id}`, { enabled: false });
    expect(patched.data.enabled).toBe(false);
    expect(patched.data.nextRunAt).toBeNull();

    expect((await call("DELETE", `/api/routines/${created.data.id}`)).data).toEqual({ ok: true });
    expect((await call("POST", `/api/routines/${created.data.id}/run`)).status).toBe(404);
    await repo.repoIdle(agent.repoPath);
  });

  test("POST /api/agents/:id/run refuses disabled agents", async () => {
    await call("PATCH", `/api/agents/${agent.id}`, { enabled: false });
    const res = await call<{ error: string }>("POST", `/api/agents/${agent.id}/run`, { prompt: "hello" });
    expect(res.status).toBe(409);
    expect((await call("POST", `/api/agents/${agent.id}/run`, { prompt: "" })).status).toBe(400);
  });

  test("DELETE /api/agents/:id", async () => {
    expect((await call("DELETE", `/api/agents/${agent.id}`)).data).toEqual({ ok: true });
    expect((await call("GET", `/api/agents/${agent.id}`)).status).toBe(404);
  });
});

describe("workspace routes", () => {
  test("CRUD with conflict-protected delete", async () => {
    const created = await call<Workspace>("POST", "/api/workspaces", { name: "Client A", icon: "🏢" });
    expect(created.status).toBe(200);
    expect((await call("POST", "/api/workspaces", { name: "" })).status).toBe(400);

    const patched = await call<Workspace>("PATCH", `/api/workspaces/${created.data.id}`, { description: "Big client" });
    expect(patched.data.description).toBe("Big client");

    const member = await call<Agent>("POST", "/api/agents", { name: "Client A Bot", workspaceId: created.data.id });
    expect(member.status).toBe(200);
    const scoped = await call<Agent[]>("GET", `/api/agents?workspaceId=${created.data.id}`);
    expect(scoped.data.map((a) => a.id)).toContain(member.data.id);

    const conflict = await call<{ error: string; code: string; details: { counts: { agents: number } } }>(
      "DELETE",
      `/api/workspaces/${created.data.id}`,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.data.code).toBe("conflict");
    expect(conflict.data.details.counts.agents).toBe(1);

    expect((await call("DELETE", `/api/workspaces/${created.data.id}?force=1`)).data).toEqual({ ok: true });
    expect((await call<Workspace[]>("GET", "/api/workspaces")).data.some((w) => w.id === created.data.id)).toBe(false);
  });
});

describe("missing login routes", () => {
  test("list and update", async () => {
    const item = reportMissingLogin({ agentId: null, runId: null, workspaceId: null, kind: "missing_totp", service: "AWS", url: "https://aws.amazon.com" });
    const open = await call<MissingLogin[]>("GET", "/api/missing-logins?status=open");
    expect(open.data.map((i) => i.id)).toContain(item.id);
    const dismissed = await call<MissingLogin>("PATCH", `/api/missing-logins/${item.id}`, { status: "dismissed" });
    expect(dismissed.data.status).toBe("dismissed");
    expect((await call("PATCH", `/api/missing-logins/${item.id}`, { status: "nope" })).status).toBe(400);
  });
});

describe("secret access \"reveal\" needs a vault grant", () => {
  test("agents: create / switch to reveal → 403 without grant, 200 with; unchanged reveal needs none", async () => {
    clearGrants();
    const denied = await call<{ code: string }>("POST", "/api/agents", { name: "Reveal Bot", permissions: { secretAccess: "reveal" } });
    expect(denied.status).toBe(403);
    expect(denied.data.code).toBe("grant_required");

    const fill = await call<Agent>("POST", "/api/agents", { name: "Grant Bot", permissions: { secretAccess: "fill" } });
    expect(fill.status).toBe(200);
    const toReveal = await call<{ code: string }>("PATCH", `/api/agents/${fill.data.id}`, { permissions: { secretAccess: "reveal" } });
    expect(toReveal.status).toBe(403);
    expect(toReveal.data.code).toBe("grant_required");
    expect((await call<Agent>("GET", `/api/agents/${fill.data.id}`)).data.permissions.secretAccess).toBe("fill");

    const { grant } = issueGrant();
    const granted = await call<Agent>("PATCH", `/api/agents/${fill.data.id}`, { permissions: { secretAccess: "reveal" } }, grant);
    expect(granted.status).toBe(200);
    expect(granted.data.permissions.secretAccess).toBe("reveal");
    // Saving an agent that already reveals (the form always sends secretAccess) doesn't ask again.
    expect((await call("PATCH", `/api/agents/${fill.data.id}`, { description: "x", permissions: { secretAccess: "reveal" } })).status).toBe(200);

    const created = await call<Agent>("POST", "/api/agents", { name: "Reveal Bot", permissions: { secretAccess: "reveal" } }, grant);
    expect(created.status).toBe(200);
    expect(created.data.permissions.secretAccess).toBe("reveal");
    expect((await call("POST", "/api/agents", { name: "Bogus", permissions: { secretAccess: "reveal" } }, "bogus")).status).toBe(403);
  });

  test("settings: default secret access reveal → 403 without grant, 200 with", async () => {
    clearGrants();
    try {
      const denied = await call<{ code: string }>("PUT", "/api/settings", { security: { defaultSecretAccess: "reveal" } });
      expect(denied.status).toBe(403);
      expect(denied.data.code).toBe("grant_required");
      expect(getSettings().security.defaultSecretAccess).toBe("fill");
      expect((await call("PUT", "/api/settings", { security: { defaultSecretAccess: "fill" } })).status).toBe(200);

      const ok = await call("PUT", "/api/settings", { security: { defaultSecretAccess: "reveal" } }, issueGrant().grant);
      expect(ok.status).toBe(200);
      expect(getSettings().security.defaultSecretAccess).toBe("reveal");
      // Once reveal is the default, creating an agent with it (as the form does) needs no extra grant.
      expect((await call("POST", "/api/agents", { name: "Default Reveal", permissions: { secretAccess: "reveal" } })).status).toBe(200);
    } finally {
      updateSettings({ security: { defaultSecretAccess: "fill" } });
    }
  });
});
