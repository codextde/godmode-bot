import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, get, insert, openDb, run } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import { resetSettingsCache } from "../src/services/settings";
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, updateWorkspace } from "../src/services/workspaces";
import { createAgent, ensureDefaultAgent, getAgent } from "../src/agents/service";
import { createProfile, ensureDefaultProfile, getProfile, shutdownBrowsers } from "../src/browser/manager";
import * as repo from "../src/agents/repo";
import { HttpError } from "../src/util";

let dataDir: string;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-workspaces-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
});

afterAll(async () => {
  await shutdownBrowsers();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

async function catchHttp(p: Promise<unknown> | (() => unknown)): Promise<HttpError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected an HttpError");
}

function addCredential(workspaceId: string) {
  const ts = new Date().toISOString();
  insert("credentials", { id: `crd_${Math.random().toString(36).slice(2)}`, workspace_id: workspaceId, name: "Vendor", created_at: ts, updated_at: ts });
}

describe("workspaces", () => {
  test("create assigns unique slugs and defaults", () => {
    const a = createWorkspace({ name: "Acme Corp" });
    const b = createWorkspace({ name: "Acme Corp", color: "emerald", icon: "🏢", description: " Client work " });
    expect(a.slug).toBe("acme-corp");
    expect(b.slug).toBe("acme-corp-2");
    expect(a.color).toBe("violet");
    expect(a.icon).toBe("🗂️");
    expect(b.description).toBe("Client work");
    expect(listWorkspaces().map((w) => w.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  test("create validates the name", async () => {
    expect((await catchHttp(() => createWorkspace({ name: "  " }))).status).toBe(400);
  });

  test("update changes fields but keeps the slug", () => {
    const ws = createWorkspace({ name: "Side Project" });
    const updated = updateWorkspace(ws.id, { name: "Main Project", color: "rose" });
    expect(updated.name).toBe("Main Project");
    expect(updated.slug).toBe("side-project");
    expect(updated.color).toBe("rose");
    expect(updated.description).toBe("");
  });

  test("agent context is trimmed and editable", () => {
    const ws = createWorkspace({ name: "Context", instructions: "  Bill in EUR.\n" });
    expect(ws.instructions).toBe("Bill in EUR.");
    expect(updateWorkspace(ws.id, { color: "rose" }).instructions).toBe("Bill in EUR.");
    expect(updateWorkspace(ws.id, { instructions: "" }).instructions).toBe("");
  });

  test("a browser profile can be assigned on create and changed on update", async () => {
    const globalDefault = ensureDefaultProfile();
    const shared = createProfile({ name: "Shared", workspaceId: null });
    const ws = createWorkspace({ name: "Browsing", browserProfileId: shared.id });
    expect(ws.browserProfileId).toBe(shared.id);
    expect(getProfile(shared.id)).toMatchObject({ workspaceId: ws.id, isDefault: true });

    const own = createProfile({ name: "Own", workspaceId: ws.id });
    expect(getWorkspace(ws.id).browserProfileId).toBe(shared.id);
    expect(updateWorkspace(ws.id, { browserProfileId: own.id }).browserProfileId).toBe(own.id);
    expect(getProfile(shared.id).isDefault).toBe(false);

    const cleared = updateWorkspace(ws.id, { browserProfileId: null });
    expect(cleared.browserProfileId).toBeNull();
    expect(getProfile(own.id)).toMatchObject({ workspaceId: ws.id, isDefault: false });
    expect(updateWorkspace(ws.id, { color: "rose" }).browserProfileId).toBeNull();

    expect((await catchHttp(() => createWorkspace({ name: "Rejected", browserProfileId: globalDefault.id }))).status).toBe(400);
    expect(listWorkspaces().some((w) => w.name === "Rejected")).toBe(false);
    expect((await catchHttp(() => updateWorkspace(ws.id, { name: "Renamed", browserProfileId: "bpr_missing" }))).status).toBe(404);
    expect(getWorkspace(ws.id).name).toBe("Browsing");
  });

  test("renaming a workspace refreshes its agents' CLAUDE.md", async () => {
    const ws = createWorkspace({ name: "Old Name" });
    const agent = await createAgent({ name: "Member", workspaceId: ws.id });
    expect(readFileSync(join(agent.repoPath, "CLAUDE.md"), "utf8")).toContain("**Old Name** workspace");
    updateWorkspace(ws.id, { name: "New Name" });
    // The refresh is asynchronous; wait until it has been queued and completed.
    for (let i = 0; i < 50 && !readFileSync(join(agent.repoPath, "CLAUDE.md"), "utf8").includes("New Name"); i++) {
      await repo.repoIdle(agent.repoPath);
      await Bun.sleep(10);
    }
    expect(readFileSync(join(agent.repoPath, "CLAUDE.md"), "utf8")).toContain("**New Name** workspace");
  });

  test("unknown workspace is a 404", async () => {
    expect((await catchHttp(() => getWorkspace("wsp_nope"))).status).toBe(404);
    expect((await catchHttp(deleteWorkspace("wsp_nope"))).status).toBe(404);
  });

  test("deleting an empty workspace works without force", async () => {
    const ws = createWorkspace({ name: "Empty" });
    await deleteWorkspace(ws.id);
    expect(listWorkspaces().some((w) => w.id === ws.id)).toBe(false);
  });

  test("forced delete clears links from global logins and 2FA entries to deleted items", async () => {
    const ws = createWorkspace({ name: "Linked" });
    const ts = new Date().toISOString();
    insert("credentials", { id: "crd_ws", workspace_id: ws.id, name: "WS login", created_at: ts, updated_at: ts });
    insert("totp", { id: "totp_ws", workspace_id: ws.id, issuer: "WS", secret_enc: "x", created_at: ts, updated_at: ts });
    insert("credentials", { id: "crd_global", name: "Global login", totp_id: "totp_ws", created_at: ts, updated_at: ts });
    insert("totp", { id: "totp_global", issuer: "Global", secret_enc: "x", credential_id: "crd_ws", created_at: ts, updated_at: ts });

    await deleteWorkspace(ws.id, true);

    expect(get<{ totp_id: string | null }>("SELECT totp_id FROM credentials WHERE id = ?", "crd_global")!.totp_id).toBeNull();
    expect(get<{ credential_id: string | null }>("SELECT credential_id FROM totp WHERE id = ?", "totp_global")!.credential_id).toBeNull();
    expect(get("SELECT id FROM credentials WHERE id = ?", "crd_ws")).toBeNull();
    expect(get("SELECT id FROM totp WHERE id = ?", "totp_ws")).toBeNull();
  });

  test("deleting a non-empty workspace needs force; force trashes agent repos", async () => {
    const defaultAgent = await ensureDefaultAgent();
    const ws = createWorkspace({ name: "Client X" });
    const agent = await createAgent({ name: "Client X Bot", workspaceId: ws.id });
    addCredential(ws.id);
    addCredential(ws.id);

    const err = await catchHttp(deleteWorkspace(ws.id));
    expect(err.status).toBe(409);
    expect(err.message).toContain("1 agent");
    expect(err.message).toContain("2 logins");
    expect((err.details as { counts: Record<string, number> }).counts).toMatchObject({ agents: 1, credentials: 2, totp: 0 });
    expect(getWorkspace(ws.id).id).toBe(ws.id);

    // Simulate a corrupted row: the default agent must survive a forced delete.
    run("UPDATE agents SET workspace_id = ? WHERE id = ?", ws.id, defaultAgent.id);

    const events: ServerEvent[] = [];
    const off = bus.on((e) => events.push(e));
    try {
      await deleteWorkspace(ws.id, true);
    } finally {
      off();
    }

    expect(listWorkspaces().some((w) => w.id === ws.id)).toBe(false);
    expect((await catchHttp(() => getAgent(agent.id))).status).toBe(404);
    expect(get<{ c: number }>("SELECT COUNT(*) AS c FROM credentials WHERE workspace_id = ?", ws.id)!.c).toBe(0);
    expect(getAgent(defaultAgent.id).workspaceId).toBeNull();

    expect(existsSync(agent.repoPath)).toBe(false);
    const trashed = readdirSync(join(dataDir, "agents", ".trash")).filter((d) => d.startsWith(`${agent.slug}-`));
    expect(trashed).toHaveLength(1);
    expect(existsSync(join(dataDir, "agents", ".trash", trashed[0]!, "MEMORY.md"))).toBe(true);

    expect(events.some((e) => e.type === "agent.deleted" && e.id === agent.id)).toBe(true);
    expect(events.some((e) => e.type === "entity.changed" && e.entity === "workspaces")).toBe(true);
    expect(events.some((e) => e.type === "entity.changed" && e.entity === "credentials")).toBe(true);
  });
});
