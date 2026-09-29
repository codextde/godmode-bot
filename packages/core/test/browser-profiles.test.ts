import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentBrowserConfig, ServerEvent } from "@godmode/shared";
import { loadConfig } from "../src/config";
import { closeDb, insert, openDb } from "../src/db";
import { bus } from "../src/events/bus";
import { setLogLevel } from "../src/log";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { HttpError } from "../src/util";
import * as manager from "../src/browser/manager";

let dataDir: string;

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-browser-profiles-"));
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
});

afterAll(async () => {
  await manager.shutdownBrowsers();
  closeDb();
  resetSettingsCache();
  rmSync(dataDir, { recursive: true, force: true });
});

function workspace(id: string) {
  const ts = new Date().toISOString();
  insert("workspaces", { id, name: id, slug: id, created_at: ts, updated_at: ts });
}

function agent(partial: Omit<Partial<Agent>, "browser"> & { browser?: Partial<AgentBrowserConfig> }): Agent {
  return {
    id: "agt_x",
    workspaceId: null,
    repoPath: join(dataDir, "agents", "x"),
    ...partial,
    browser: { profileId: null, enabled: true, headless: null, ...partial.browser },
  } as Agent;
}

async function httpError(fn: () => unknown): Promise<HttpError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected an HttpError");
}

describe("browser profiles", () => {
  test("ensureDefaultProfile creates exactly one global default with its own user-data-dir", () => {
    const events: ServerEvent[] = [];
    const off = bus.on((e) => events.push(e));
    const a = manager.ensureDefaultProfile();
    const b = manager.ensureDefaultProfile();
    off();
    expect(a.id).toBe(b.id);
    expect(a.name).toBe("Default");
    expect(a.isDefault).toBe(true);
    expect(a.workspaceId).toBeNull();
    expect(a.running).toBe(false);
    expect(a.cdpUrl).toBeNull();
    expect(a.userDataDir).toBe(join(dataDir, "browser", a.id));
    expect(existsSync(a.userDataDir)).toBe(true);
    expect(events.some((e) => e.type === "browser.updated")).toBe(true);
  });

  test("create / rename / default switching per scope", async () => {
    workspace("ws_a");
    const global2 = manager.createProfile({ name: "Work", workspaceId: null });
    expect(global2.isDefault).toBe(false);
    const wsFirst = manager.createProfile({ name: "WS main", workspaceId: "ws_a" });
    expect(wsFirst.isDefault).toBe(true); // first profile of a workspace becomes its default
    const wsSecond = manager.createProfile({ name: "WS alt", workspaceId: "ws_a" });
    expect(wsSecond.isDefault).toBe(false);

    manager.updateProfile(wsSecond.id, { isDefault: true, name: "WS alt 2" });
    expect(manager.getProfile(wsSecond.id)).toMatchObject({ isDefault: true, name: "WS alt 2" });
    expect(manager.getProfile(wsFirst.id).isDefault).toBe(false);
    // Global default is untouched by workspace default changes.
    expect(manager.listProfiles().filter((p) => p.isDefault && p.workspaceId === null)).toHaveLength(1);

    expect((await httpError(() => manager.createProfile({ name: "  ", workspaceId: null }))).status).toBe(400);
    expect((await httpError(() => manager.createProfile({ name: "x", workspaceId: "ws_missing" }))).status).toBe(404);
    expect((await httpError(() => manager.getProfile("bpr_missing"))).status).toBe(404);
  });

  test("the global default can't be unset or deleted, others can be deleted", async () => {
    const def = manager.ensureDefaultProfile();
    expect((await httpError(() => manager.updateProfile(def.id, { isDefault: false }))).status).toBe(400);
    expect((await httpError(() => manager.deleteProfile(def.id))).status).toBe(400);

    const work = manager.listProfiles().find((p) => p.name === "Work")!;
    manager.updateProfile(work.id, { isDefault: true });
    expect(manager.getProfile(def.id).isDefault).toBe(false);
    await manager.deleteProfile(def.id);
    expect(existsSync(def.userDataDir)).toBe(false);
    expect(manager.ensureDefaultProfile().id).toBe(work.id);
  });

  test("resolveProfileForAgent: pinned → workspace default → global default", () => {
    const globalDefault = manager.ensureDefaultProfile();
    const wsDefault = manager.listProfiles().find((p) => p.workspaceId === "ws_a" && p.isDefault)!;
    const other = manager.listProfiles().find((p) => p.name === "WS main")!;
    expect(manager.resolveProfileForAgent(agent({ browser: { profileId: other.id } })).id).toBe(other.id);
    expect(manager.resolveProfileForAgent(agent({ workspaceId: "ws_a" })).id).toBe(wsDefault.id);
    expect(manager.resolveProfileForAgent(agent({ workspaceId: "ws_without_profiles" })).id).toBe(globalDefault.id);
    expect(manager.resolveProfileForAgent(agent({ browser: { profileId: "bpr_deleted" } })).id).toBe(globalDefault.id);
  });

  test("browserMcpServer returns null when browser tools are disabled", async () => {
    const run = { runId: "run_disabled", conversationId: "cnv_disabled" };
    expect(await manager.browserMcpServer(agent({ browser: { enabled: false } }), run)).toBeNull();
    updateSettings({ browser: { enabled: false } });
    expect(await manager.browserMcpServer(agent({}), run)).toBeNull();
    updateSettings({ browser: { enabled: true } });
  });

  test("fill and page helpers report a stopped browser instead of throwing", async () => {
    const p = manager.ensureDefaultProfile();
    const res = await manager.fillIntoPage(p.id, { text: "secret-value", kind: "password", allowedHosts: ["example.com"] });
    expect(res.ok).toBe(false);
    expect(res.detail).not.toContain("secret-value");
    const unbound = await manager.fillIntoPage(p.id, { text: "secret-value", kind: "password", allowedHosts: [] });
    expect(unbound.ok).toBe(false);
    expect(unbound.detail).toContain("Refusing");
    expect(await manager.currentPage(p.id)).toBeNull();
    await manager.stopBrowser(p.id); // no-op
    expect((await httpError(() => manager.navigate(p.id, "file:///etc/passwd"))).status).toBe(400);
    expect((await httpError(() => manager.navigate(p.id, "javascript:alert(1)"))).status).toBe(400);
  });
});
