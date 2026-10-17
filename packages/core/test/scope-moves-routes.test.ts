import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ScopeMoveResult } from "@godmode/shared";
import { setupEnv, type TestEnv } from "./fixtures/runner-harness";
import * as vault from "../src/vault/vault";
import { getAccessToken } from "../src/server/auth";
import { createWorkspace } from "../src/services/workspaces";
import { createProject } from "../src/services/projects";
import { createCredential } from "../src/vault/credentials";

const PASSPHRASE = "scope moves routes passphrase";
let env: TestEnv;

async function api<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${getAccessToken()}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T & { code?: string } };
}

async function grant(): Promise<Record<string, string>> {
  const res = await api<{ grant: string }>("POST", "/api/vault/grant", { passphrase: PASSPHRASE });
  return { "x-godmode-grant": res.data.grant };
}

beforeAll(async () => {
  env = await setupEnv("godmode-scope-routes-");
  await vault.setup(PASSPHRASE, false);
});

afterAll(async () => {
  await env.close();
});

test("a workspace with logins becomes a project only with the passphrase, and so does its undo", async () => {
  const host = createWorkspace({ name: "Host" });
  const guest = createWorkspace({ name: "Guest" });
  createCredential({ workspaceId: guest.id, name: "Shop", username: "owner@shop.test", password: "a long shop password" });
  const refused = await api("POST", `/api/workspaces/${guest.id}/move`, { workspaceId: host.id });
  expect(refused).toMatchObject({ status: 403, data: { code: "grant_required" } });

  const moved = await api<ScopeMoveResult>("POST", `/api/workspaces/${guest.id}/move`, { workspaceId: host.id }, await grant());
  expect(moved.status).toBe(200);
  expect(moved.data.moved.credentials).toBe(1);
  const undo = moved.data.undo as { projectId: string; input: unknown };
  expect((await api("POST", `/api/projects/${undo.projectId}/move`, undo.input)).data.code).toBe("grant_required");
  expect((await api<ScopeMoveResult>("POST", `/api/projects/${undo.projectId}/move`, undo.input, await grant())).data.workspace.name).toBe("Guest");
});

test("moves without vault items need no passphrase; an agent-written context needs a check", async () => {
  const a = createWorkspace({ name: "Plain A" });
  const b = createWorkspace({ name: "Plain B" });
  const nested = await api<ScopeMoveResult>("POST", `/api/workspaces/${b.id}/move`, { workspaceId: a.id });
  expect(nested.status).toBe(200);
  const written = createProject({ workspaceId: a.id, name: "Written", instructions: "Hi" }, { offComputer: true });
  expect((await api("POST", `/api/projects/${written.id}/move`, { workspaceId: null })).data.code).toBe("context_review");
  expect((await api("POST", `/api/projects/${written.id}/move`, { workspaceId: null, contextReviewed: true })).status).toBe(200);
});
