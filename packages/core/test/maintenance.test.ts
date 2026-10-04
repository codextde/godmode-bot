import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FixReport, MaintenanceStatus, PermissionReport, Settings, ToolUpdateResult, UpdateReport } from "@godmode/shared";
import { BROWSER_USE_VERSION } from "../src/browser/browserUse";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { createApp } from "../src/server/app";
import { getAccessToken } from "../src/server/auth";
import { CLAUDE_RELEASES_URL } from "../src/services/claudeUpdate";
import { __setUvxForTests, runDoctor } from "../src/services/doctor";
import { __resetMaintenanceForTests, fixAll, installUpdates, maintenanceStatus, retryPostponedUpdates, runMaintenance, startMaintenance, stopMaintenance } from "../src/services/maintenance";
import { applyRuntimeSettings } from "../src/services/runtime";
import { getSettings, resetSettingsCache, updateSettings } from "../src/services/settings";
import { UV_RELEASE_URL, __resetUpdatesForTests } from "../src/services/updates";
import { managedTartPath, setVmSupportForTests } from "../src/vm/tart";
import { fakeTools, type FakeTools } from "./fixtures/fake-tools";

// Mode bits are POSIX, and root may do everything.
const suite = process.platform !== "win32" && process.getuid?.() !== 0 ? describe : describe.skip;

let dataDir: string;
let tools: FakeTools;
let latest: { claude: string; uv: string };
let busy = false;
/** Release feeds asked so far. */
let fetched: string[] = [];
const realFetch = globalThis.fetch;
const realEnv = { claude: process.env.CLAUDE_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY };

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * "Fix all" installs missing tools with their real installers. Make sure the fakes are what the system check sees
 * before letting it loose, so a broken fixture can never download something onto the machine running the tests.
 */
async function assertFakesInPlace() {
  const report = await runDoctor(true);
  for (const id of ["claude", "uv", "chrome"] as const) expect(report.dependencies.find((d) => d.id === id)).toMatchObject({ ok: true });
  expect(report.dependencies.find((d) => d.id === "claude")!.path).toBe(tools.claude);
  expect(report.dependencies.find((d) => d.id === "uv")!.path).toBe(tools.uvx);
}

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-maintenance-"));
  process.env.CLAUDE_CONFIG_DIR = join(dataDir, "claude-config");
  delete process.env.ANTHROPIC_API_KEY;
  loadConfig({ dataDir, token: "test-token" });
  openDb(join(dataDir, "godmode.db"));
  resetSettingsCache();
  tools = fakeTools(join(dataDir, "fake-bin"));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (url === UV_RELEASE_URL) return Response.json({ info: { version: latest.uv } });
    if (url.startsWith(`${CLAUDE_RELEASES_URL}/`)) return new Response(`${latest.claude}\n`);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterAll(() => {
  stopMaintenance();
  globalThis.fetch = realFetch;
  __setUvxForTests(undefined);
  __resetMaintenanceForTests();
  setVmSupportForTests(null);
  restoreEnv("CLAUDE_CONFIG_DIR", realEnv.claude);
  restoreEnv("ANTHROPIC_API_KEY", realEnv.key);
  closeDb();
  resetSettingsCache();
  __resetUpdatesForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  stopMaintenance();
  latest = { claude: "2.1.274", uv: "0.9.0" };
  busy = false;
  fetched = [];
  tools.set("claude-version", "2.1.274");
  tools.set("uv-version", "0.9.0");
  tools.set("browser-use-ready", "");
  for (const name of ["claude-target", "uv-target", "uv-offline", "browser-use-broken", "browser-use-noop", "logged-out", "calls.log"]) tools.set(name, null);
  rmSync(join(dataDir, "tools.json"), { force: true });
  rmSync(join(dataDir, "claude-config"), { recursive: true, force: true });
  rmSync(join(dataDir, "vm"), { recursive: true, force: true });
  loadConfig({ dataDir, token: "test-token" });
  __setUvxForTests(tools.uvx);
  setVmSupportForTests(false);
  updateSettings({
    runner: { claudePath: tools.claude },
    browser: { enabled: true, chromePath: tools.browser, browserUseCommand: "" },
    computer: { enabled: false },
    maintenance: { autoFix: true, autoUpdate: true, autoCleanup: false },
    onboardingComplete: true,
  });
  __resetUpdatesForTests();
  __resetMaintenanceForTests({ busy: () => busy });
  await assertFakesInPlace();
});

suite("fix all", () => {
  test("a healthy system needs nothing", async () => {
    const report = await fixAll();
    expect(report.ok).toBe(true);
    expect(report.results).toEqual([]);
    expect(tools.calls()).toEqual([]);
  });

  test("repairs permissions and installs required tools that are missing", async () => {
    chmodSync(dataDir, 0o755);
    tools.set("browser-use-ready", null);
    const report = await fixAll();
    expect(report.results.map((r) => [r.kind, r.id, r.outcome])).toEqual([
      ["permission", "data-private", "fixed"],
      ["dependency", "browser-use", "fixed"],
    ]);
    expect(report.ok).toBe(true);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(tools.calls()).toEqual([`uvx browser-use==${BROWSER_USE_VERSION}`]);
    expect((await runDoctor()).ok).toBe(true);
  });

  test("what only the human can do comes back with how", async () => {
    tools.set("logged-out", "");
    const report = await fixAll();
    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ kind: "dependency", id: "claude-auth", outcome: "manual" });
    expect(report.results[0]!.output).toContain("log in");
    expect(tools.calls()).toEqual([]);
  });

  test("fixed means it works now, whatever the installer said", async () => {
    tools.set("browser-use-ready", null);
    tools.set("browser-use-noop", "");
    const report = await fixAll();
    expect(report.ok).toBe(false);
    expect(report.results.map((r) => [r.id, r.outcome])).toEqual([["browser-use", "failed"]]);
    expect(report.results[0]!.output).toContain("still doesn't work");
  });

  test("tools a turned-off feature would need are left alone", async () => {
    tools.set("browser-use-ready", null);
    updateSettings({ browser: { enabled: false } });
    expect((await fixAll()).results).toEqual([]);
    expect(tools.calls()).toEqual([]);
  });
});

suite("background upkeep", () => {
  test("does nothing before onboarding is done, or when it is turned off", async () => {
    tools.set("browser-use-ready", null);
    latest.uv = "0.9.3";
    tools.set("uv-target", "0.9.3");

    updateSettings({ onboardingComplete: false });
    expect(await runMaintenance()).toMatchObject({ lastRunAt: null, fixes: [], updates: [] });
    updateSettings({ onboardingComplete: true, maintenance: { autoFix: false, autoUpdate: false } });
    expect(await runMaintenance()).toMatchObject({ lastRunAt: null, fixes: [], updates: [] });
    expect(tools.calls()).toEqual([]);
  });

  test("repairs without updating when only repairs are on", async () => {
    tools.set("browser-use-ready", null);
    latest.uv = "0.9.3";
    tools.set("uv-target", "0.9.3");
    updateSettings({ maintenance: { autoFix: true, autoUpdate: false } });

    const status = await runMaintenance();
    expect(status.fixes.map((f) => [f.id, f.outcome])).toEqual([["browser-use", "fixed"]]);
    expect(status.updates).toEqual([]);
    expect(status.lastRunAt).not.toBeNull();
    expect(tools.calls()).toEqual([`uvx browser-use==${BROWSER_USE_VERSION}`]);
  });

  test("updates without repairing when only updates are on", async () => {
    tools.set("browser-use-ready", null);
    latest.uv = "0.9.3";
    tools.set("uv-target", "0.9.3");
    updateSettings({ maintenance: { autoFix: false, autoUpdate: true } });

    const status = await runMaintenance();
    expect(status.fixes).toEqual([]);
    expect(status.updates.map((u) => [u.id, u.ok, u.version])).toEqual([["uv", true, "0.9.3"]]);
    expect(tools.calls()).toEqual(["uv self update"]);
  });

  test("updates wait while agents are working", async () => {
    latest = { claude: "2.1.283", uv: "0.9.3" };
    tools.set("claude-target", "2.1.283");
    tools.set("uv-target", "0.9.3");

    busy = true;
    const waiting = await runMaintenance();
    expect(waiting.updates).toEqual([]);
    expect(waiting.postponed).toContain("Agents are working");
    expect(tools.calls()).toEqual([]);

    busy = false;
    const done = await runMaintenance();
    expect(done.postponed).toBeNull();
    expect(done.updates.map((u) => [u.id, u.ok])).toEqual([
      ["claude", true],
      ["uv", true],
    ]);
    expect(maintenanceStatus()).toBe(done);
    // Nothing left to do.
    expect((await runMaintenance()).updates).toEqual([]);
    expect(tools.calls()).toEqual(["claude update", "uv self update"]);
  });

  test("an update that failed isn't tried again until there is a newer version, or the human asks", async () => {
    latest.uv = "0.9.3";
    tools.set("uv-offline", "");
    const first = await runMaintenance();
    expect(first.updates.map((u) => [u.id, u.ok])).toEqual([["uv", false]]);
    expect((await runMaintenance()).updates).toEqual([]);
    expect(tools.calls()).toEqual(["uv self update"]);

    latest.uv = "0.9.4";
    expect((await runMaintenance()).updates.map((u) => u.id)).toEqual(["uv"]);
    expect((await runMaintenance()).updates).toEqual([]);
    expect(tools.calls()).toEqual(["uv self update", "uv self update"]);

    // By hand it works (the network is back), which also clears the grudge.
    tools.set("uv-offline", null);
    tools.set("uv-target", "0.9.4");
    expect((await installUpdates("uv")).map((u) => u.ok)).toEqual([true]);
    latest.uv = "0.9.5";
    tools.set("uv-target", "0.9.5");
    expect((await runMaintenance()).updates.map((u) => [u.id, u.ok, u.version])).toEqual([["uv", true, "0.9.5"]]);
  });

  test("an install that failed isn't run again by every pass", async () => {
    tools.set("browser-use-ready", null);
    tools.set("browser-use-broken", "");
    updateSettings({ maintenance: { autoFix: true, autoUpdate: false } });

    expect((await runMaintenance()).fixes.map((f) => [f.id, f.outcome])).toEqual([["browser-use", "failed"]]);
    // Later passes report it as the human's to look at, without downloading again.
    for (let i = 0; i < 3; i++) expect((await runMaintenance()).fixes.map((f) => [f.id, f.outcome])).toEqual([["browser-use", "manual"]]);
    expect(tools.calls()).toHaveLength(1);

    // The human asks: tried again, and once it works the pass has nothing left to do.
    tools.set("browser-use-broken", null);
    expect((await fixAll()).results.map((r) => [r.id, r.outcome])).toEqual([["browser-use", "fixed"]]);
    expect(tools.calls()).toHaveLength(2);
    expect((await runMaintenance()).fixes).toEqual([]);
  });

  test("updates that had to wait are picked up without asking the release feeds again", async () => {
    latest.uv = "0.9.3";
    tools.set("uv-target", "0.9.3");
    busy = true;
    expect((await runMaintenance()).postponed).toContain("Agents are working");

    // Still busy: looking again costs nothing — no feed, no updater.
    fetched = [];
    for (let i = 0; i < 3; i++) expect((await retryPostponedUpdates()).postponed).toContain("Agents are working");
    expect(fetched).toEqual([]);
    expect(tools.calls()).toEqual([]);

    busy = false;
    const done = await retryPostponedUpdates();
    expect(done.postponed).toBeNull();
    expect(done.updates.map((u) => [u.id, u.ok, u.version])).toEqual([["uv", true, "0.9.3"]]);
    // Nothing is waiting anymore.
    expect((await retryPostponedUpdates()).updates).toHaveLength(1);
    expect(tools.calls()).toEqual(["uv self update"]);
  });

  test("an update someone else installed in the meantime is not reported as done by the upkeep", async () => {
    latest.uv = "0.9.3";
    tools.set("uv-target", "0.9.3");
    busy = true;
    expect((await runMaintenance()).postponed).toContain("Agents are working");
    // The human doesn't wait and clicks Update.
    expect((await installUpdates("uv")).map((u) => [u.ok, u.upToDate])).toEqual([[true, false]]);

    busy = false;
    const after = await retryPostponedUpdates();
    expect(after.postponed).toBeNull();
    expect(after.updates).toEqual([]);
    expect(tools.calls()).toEqual(["uv self update"]);
  });

  test("an update that waited keeps waiting while the release feeds can't be reached", async () => {
    latest.uv = "0.9.3";
    tools.set("uv-target", "0.9.3");
    busy = true;
    expect((await runMaintenance()).postponed).toContain("Agents are working");
    busy = false;

    // Much later, and offline: what the feed said is forgotten, and it doesn't answer.
    __resetUpdatesForTests();
    const feeds = globalThis.fetch;
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    try {
      const offline = await retryPostponedUpdates();
      expect(offline.postponed).toContain("couldn't be reached");
      expect(offline.updates).toEqual([]);
    } finally {
      globalThis.fetch = feeds;
    }
    // Online again: installed by the next look, with no grudge held.
    expect((await retryPostponedUpdates()).updates.map((u) => [u.id, u.ok, u.version])).toEqual([["uv", true, "0.9.3"]]);
    expect(tools.calls()).toEqual(["uv self update"]);
  });

  test("a tool that is in use waits for that, while the others are updated", async () => {
    setVmSupportForTests(true);
    const tart = managedTartPath();
    mkdirSync(dirname(tart), { recursive: true });
    writeFileSync(tart, `#!/bin/sh\ncase "$1" in\n  --version) echo "2.0.0" ;;\n  list) cat "$(dirname "$0")/vms.json" ;;\nesac\n`);
    chmodSync(tart, 0o755);
    writeFileSync(join(dirname(tart), "vms.json"), JSON.stringify([{ Name: "vm-1", Source: "local", State: "running" }]));
    updateSettings({ vm: { tartPath: "" } });
    latest.uv = "0.9.3";
    tools.set("uv-target", "0.9.3");

    const status = await runMaintenance();
    expect(status.updates.map((u) => [u.id, u.ok])).toEqual([["uv", true]]);
    expect(status.postponed).toContain("virtual machine is running");
    expect((await retryPostponedUpdates()).postponed).toContain("virtual machine is running");

    // The VM is stopped: now Tart's turn comes. (The download itself is refused by the test's fetch.)
    writeFileSync(join(dirname(tart), "vms.json"), "[]");
    const done = await retryPostponedUpdates();
    expect(done.postponed).toBeNull();
    expect(done.updates.map((u) => [u.id, u.ok])).toEqual([
      ["uv", true],
      ["tart", false],
    ]);
    expect(done.updates[1]!.output).toContain("Download failed");
  });

  test("Claude Code isn't updated unasked when its own auto-updater is turned off", async () => {
    mkdirSync(join(dataDir, "claude-config"), { recursive: true });
    writeFileSync(join(dataDir, "claude-config", "settings.json"), JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }));
    latest = { claude: "2.1.283", uv: "0.9.3" };
    tools.set("claude-target", "2.1.283");
    tools.set("uv-target", "0.9.3");

    expect((await runMaintenance()).updates.map((u) => u.id)).toEqual(["uv"]);
    expect(tools.calls()).toEqual(["uv self update"]);
    expect((await installUpdates("claude")).map((u) => [u.ok, u.version])).toEqual([[true, "2.1.283"]]);
  });

  test("two requests for the same update run the updater once", async () => {
    latest.uv = "0.9.3";
    tools.set("uv-target", "0.9.3");
    const [first, second] = await Promise.all([installUpdates("uv"), installUpdates("uv")]);
    expect(first[0]).toMatchObject({ ok: true, previous: "0.9.0", version: "0.9.3" });
    expect(second[0]).toMatchObject({ ok: true, upToDate: true, output: "Already up to date." });
    expect(tools.calls()).toEqual(["uv self update"]);
  });

  test("runs on its own: after start, when updates had to wait, and when it is switched on", async () => {
    const until = async (what: () => boolean) => {
      for (let i = 0; i < 200 && !what(); i++) await Bun.sleep(25);
      expect(what()).toBe(true);
    };
    latest.uv = "0.9.3";
    tools.set("uv-target", "0.9.3");
    busy = true;
    __resetMaintenanceForTests({ busy: () => busy, delays: { firstPass: 20, retry: 30, settingChanged: 20 } });

    startMaintenance();
    expect(maintenanceStatus().nextRunAt).not.toBeNull();
    await until(() => !!maintenanceStatus().postponed);
    expect(tools.calls()).toEqual([]);

    // Agents are done: the waiting update is installed by the next look, long before the next full pass.
    busy = false;
    await until(() => maintenanceStatus().updates.some((u) => u.id === "uv" && u.ok));
    expect(maintenanceStatus().postponed).toBeNull();

    // Switched off and on again in the settings: a pass follows shortly, not in six hours.
    const before = maintenanceStatus().lastRunAt;
    applyRuntimeSettings(updateSettings({ maintenance: { autoFix: false, autoUpdate: false } }));
    latest.uv = "0.9.4";
    tools.set("uv-target", "0.9.4");
    applyRuntimeSettings(updateSettings({ maintenance: { autoUpdate: true } }));
    await until(() => maintenanceStatus().lastRunAt !== before);
    expect(maintenanceStatus().updates.map((u) => [u.id, u.version])).toEqual([["uv", "0.9.4"]]);

    stopMaintenance();
    const stopped = maintenanceStatus().lastRunAt;
    await Bun.sleep(120);
    expect(maintenanceStatus().lastRunAt).toBe(stopped);
  });
});

suite("system routes", () => {
  const app = createApp();

  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { authorization: `Bearer ${getAccessToken()}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as T };
  }

  test("need the access token", async () => {
    for (const path of ["/api/doctor/permissions", "/api/doctor/updates", "/api/doctor/maintenance"]) {
      expect((await app.request(path, { method: "GET" })).status).toBe(401);
    }
    expect((await app.request("/api/doctor/fix", { method: "POST" })).status).toBe(401);
  });

  test("permissions: report and repair", async () => {
    const report = await call<PermissionReport>("GET", "/api/doctor/permissions");
    expect(report.status).toBe(200);
    expect(report.data.ok).toBe(true);
    expect(report.data.permissions.map((p) => p.id)).toContain("data-private");

    chmodSync(dataDir, 0o750);
    expect((await call<PermissionReport>("GET", "/api/doctor/permissions")).data.ok).toBe(false);
    const fixed = await call<{ outcome: string }>("POST", "/api/doctor/permissions/fix", { id: "data-private" });
    expect(fixed.data.outcome).toBe("fixed");
    expect((await call("POST", "/api/doctor/permissions/fix", {})).status).toBe(400);
    expect((await call("POST", "/api/doctor/permissions/fix", { id: "bogus" })).status).toBe(400);
  });

  test("fix all, updates and the upkeep status", async () => {
    tools.set("browser-use-ready", null);
    const fix = await call<FixReport>("POST", "/api/doctor/fix");
    expect(fix.data.results.map((r) => [r.id, r.outcome])).toEqual([["browser-use", "fixed"]]);

    latest.uv = "0.9.3";
    tools.set("uv-target", "0.9.3");
    const updates = await call<UpdateReport>("GET", "/api/doctor/updates?refresh=1");
    expect(updates.data.tools.find((t) => t.id === "uv")).toMatchObject({ updateAvailable: true, latest: "0.9.3" });
    expect((await call<ToolUpdateResult[]>("POST", "/api/doctor/updates", { id: "git" })).data.map((r) => r.ok)).toEqual([false]);
    // An empty or unknown id never means "everything".
    for (const id of ["", "nope", "__proto__"]) expect((await call("POST", "/api/doctor/updates", { id })).status).toBe(400);
    expect(tools.calls()).toEqual([`uvx browser-use==${BROWSER_USE_VERSION}`]);
    expect((await call<ToolUpdateResult[]>("POST", "/api/doctor/updates", {})).data.map((r) => [r.id, r.ok])).toEqual([["uv", true]]);
    expect((await call<ToolUpdateResult[]>("POST", "/api/doctor/updates", {})).data).toEqual([]);

    const status = await call<MaintenanceStatus>("GET", "/api/doctor/maintenance");
    expect(status.data).toMatchObject({ running: false, lastRunAt: null });
  });

  test("the upkeep settings take true or false", async () => {
    expect(getSettings().maintenance).toEqual({ autoFix: true, autoUpdate: true, autoCleanup: false });
    expect((await call("PUT", "/api/settings", { maintenance: { autoUpdate: "yes" } })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { maintenance: [] })).status).toBe(400);
    const saved = await call<Settings>("PUT", "/api/settings", { maintenance: { autoUpdate: false } });
    expect(saved.status).toBe(200);
    expect(saved.data.maintenance).toEqual({ autoFix: true, autoUpdate: false, autoCleanup: false });
    resetSettingsCache();
    expect(getSettings().maintenance).toEqual({ autoFix: true, autoUpdate: false, autoCleanup: false });
  });
});
