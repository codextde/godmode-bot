import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolId } from "@godmode/shared";
import { BROWSER_USE_VERSION } from "../src/browser/browserUse";
import { playwrightChromiumCandidates } from "../src/browser/chrome";
import { loadConfig } from "../src/config";
import { closeDb, openDb } from "../src/db";
import { setLogLevel } from "../src/log";
import { CLAUDE_MEM_VERSION } from "../src/memory/claudeMem";
import { CLAUDE_RELEASES_URL } from "../src/services/claudeUpdate";
import { __setUvxForTests, installDependency, resolveClaudeBinary, resolveUvx } from "../src/services/doctor";
import { resetSettingsCache, updateSettings } from "../src/services/settings";
import { UV_RELEASE_URL, __resetUpdatesForTests, __setChromeDetectionForTests, checkUpdates, dueUpdates, leftToHuman, parsePlaywrightDryRun, updateAll, updateTool } from "../src/services/updates";
import { TART_VERSION, managedTartPath, setVmSupportForTests } from "../src/vm/tart";
import { fakeTools, type FakeTools } from "./fixtures/fake-tools";

const suite = process.platform === "win32" ? describe.skip : describe;

let dataDir: string;
let tools: FakeTools;
let latest: { claude: string; uv: string };
const realFetch = globalThis.fetch;
/** The release feeds as the tests see them. */
let feeds: typeof fetch;
const realEnv = { claude: process.env.CLAUDE_CONFIG_DIR, playwright: process.env.PLAYWRIGHT_BROWSERS_PATH };

const tool = async (id: ToolId, refresh = true) => (await checkUpdates(refresh)).tools.find((t) => t.id === id);
const ledger = () => JSON.parse(readFileSync(join(dataDir, "tools.json"), "utf8")) as Record<string, string>;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  setLogLevel("error");
  dataDir = mkdtempSync(join(tmpdir(), "godmode-updates-"));
  process.env.CLAUDE_CONFIG_DIR = join(dataDir, "claude-config");
  loadConfig({ dataDir });
  openDb(join(dataDir, "test.db"));
  resetSettingsCache();
  tools = fakeTools(join(dataDir, "fake-bin"));
  feeds = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === UV_RELEASE_URL) return Response.json({ info: { version: latest.uv } });
    if (url.startsWith(`${CLAUDE_RELEASES_URL}/`)) return new Response(`${latest.claude}\n`);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  globalThis.fetch = feeds;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  __setUvxForTests(undefined);
  __setChromeDetectionForTests(undefined);
  setVmSupportForTests(null);
  restoreEnv("CLAUDE_CONFIG_DIR", realEnv.claude);
  restoreEnv("PLAYWRIGHT_BROWSERS_PATH", realEnv.playwright);
  closeDb();
  resetSettingsCache();
  __resetUpdatesForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  latest = { claude: "2.1.274", uv: "0.9.0" };
  tools.set("claude-version", "2.1.274");
  tools.set("uv-version", "0.9.0");
  for (const name of ["claude-target", "uv-target", "uv-offline", "browser-use-ready", "calls.log", "probes.log"]) tools.set(name, null);
  rmSync(join(dataDir, "tools.json"), { force: true });
  rmSync(join(dataDir, "plugins"), { recursive: true, force: true });
  rmSync(join(dataDir, "claude-config"), { recursive: true, force: true });
  __setUvxForTests(tools.uvx);
  __setChromeDetectionForTests(undefined);
  setVmSupportForTests(false);
  // Its own browser and no native helper: nothing here depends on what the machine running the tests has installed.
  updateSettings({ runner: { claudePath: tools.claude }, browser: { chromePath: tools.browser, browserUseCommand: "" }, computer: { enabled: false } });
  __resetUpdatesForTests();
  // Updates run the tools' own updaters: make sure those are the fakes before any test gets to run one.
  expect(resolveClaudeBinary()).toBe(tools.claude);
  expect(resolveUvx()).toBe(tools.uvx);
});

describe("parsePlaywrightDryRun", () => {
  const output = [
    "browser: chromium version 141.0.7390.37",
    "  Install location:    /home/me/.cache/ms-playwright/chromium-1194",
    "  Download url:        https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1194/chromium-linux.zip",
    "",
    "browser: ffmpeg",
    "  Install location:    /home/me/.cache/ms-playwright/ffmpeg-1011",
    "",
  ].join("\n");

  test("reads the Chromium build and where it goes", () => {
    expect(parsePlaywrightDryRun(output)).toEqual({ version: "141.0.7390.37", location: "/home/me/.cache/ms-playwright/chromium-1194" });
  });

  test("the headless shell is not the browser", () => {
    const shell = "browser: chromium-headless-shell version 141.0.7390.37\n  Install location:    /x/chromium_headless_shell-1194\n";
    expect(parsePlaywrightDryRun(shell)).toBeNull();
    expect(parsePlaywrightDryRun(shell + output)?.location).toBe("/home/me/.cache/ms-playwright/chromium-1194");
    expect(parsePlaywrightDryRun("error: something else")).toBeNull();
  });
});

suite("tool updates", () => {
  test("installed tools are listed with how they are kept current", async () => {
    const report = await checkUpdates(true);
    const byId = Object.fromEntries(report.tools.map((t) => [t.id, t]));
    expect(byId.claude).toMatchObject({ installed: true, current: "2.1.274", latest: "2.1.274", updateAvailable: false, updatable: true, track: "release" });
    expect(byId.uv).toMatchObject({ installed: true, current: "0.9.0", latest: "0.9.0", updateAvailable: false, updatable: true, track: "release" });
    expect(byId.chrome).toMatchObject({ installed: true, updatable: false, track: "external", detail: "Your own browser (Settings → Browser)" });
    expect(byId["browser-use"]).toMatchObject({ installed: false, latest: BROWSER_USE_VERSION, updateAvailable: false, track: "pinned" });
    expect(byId["claude-mem"]).toMatchObject({ installed: false, latest: CLAUDE_MEM_VERSION, track: "pinned" });
    // git comes from the machine; whatever it is, Godmode never updates it.
    expect(byId.git).toMatchObject({ updatable: false, updateAvailable: false, track: "external" });
    // VMs aren't supported here (see beforeEach), so Tart isn't a tool Godmode relies on.
    expect(byId.tart).toBeUndefined();
    expect(dueUpdates(report)).toEqual([]);
    // Cached until someone asks again.
    expect(await checkUpdates()).toBe(report);
    expect(await checkUpdates(true)).not.toBe(report);
  });

  test("uv: a newer release is found and installed with `uv self update`", async () => {
    latest.uv = "0.9.3";
    expect(await tool("uv")).toMatchObject({ current: "0.9.0", latest: "0.9.3", updateAvailable: true });

    tools.set("uv-target", "0.9.3");
    const result = await updateTool("uv");
    expect(result).toMatchObject({ id: "uv", name: "uv", ok: true, previous: "0.9.0", version: "0.9.3" });
    expect(result.output).toContain("Updated uv to 0.9.3");
    expect(tools.calls()).toEqual(["uv self update"]);
    // The cached report already knows.
    expect(await tool("uv", false)).toMatchObject({ current: "0.9.3", updateAvailable: false });
  });

  test("an up-to-date tool is left alone, also when two ask at once", async () => {
    expect(await updateTool("uv")).toMatchObject({ ok: true, upToDate: true, previous: "0.9.0", version: "0.9.0", output: "Already up to date." });
    expect(tools.calls()).toEqual([]);

    latest.uv = "0.9.3";
    tools.set("uv-target", "0.9.3");
    await checkUpdates(true);
    const [first, second] = [await updateTool("uv"), await updateTool("uv")];
    expect(first).toMatchObject({ ok: true, upToDate: false, previous: "0.9.0", version: "0.9.3" });
    expect(second).toMatchObject({ ok: true, upToDate: true, previous: "0.9.3", version: "0.9.3", output: "Already up to date." });
    expect(tools.calls()).toEqual(["uv self update"]);
  });

  test("uv: an updater that failed can be tried again", async () => {
    latest.uv = "0.9.3";
    tools.set("uv-offline", "");
    const result = await updateTool("uv");
    expect(result).toMatchObject({ ok: false, previous: "0.9.0", version: "0.9.0" });
    expect(result.output).toContain("could not reach");
    expect(await tool("uv")).toMatchObject({ updateAvailable: true, updatable: true, track: "release" });
  });

  test("uv that refuses to update itself is its package manager's from then on", async () => {
    latest.uv = "0.9.3";
    // No `uv-target`: the fake answers like a uv from pip or cargo.
    const result = await updateTool("uv");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("standalone installation scripts");
    expect(ledger()["uv-self-update"]).toBe(`${tools.uv} 0.9.0`);
    expect(await tool("uv")).toMatchObject({ installed: true, current: "0.9.0", updateAvailable: false, updatable: false, track: "external" });
    // Not asked again, not even by hand.
    expect((await updateTool("uv")).ok).toBe(false);
    expect(tools.calls()).toEqual(["uv self update"]);

    // Another uv in the same place (installed anew, this time with uv's own installer) is asked again.
    tools.set("uv-version", "0.9.1");
    tools.set("uv-target", "0.9.3");
    expect(await tool("uv")).toMatchObject({ current: "0.9.1", updateAvailable: true, updatable: true, track: "release" });
    expect(await updateTool("uv")).toMatchObject({ ok: true, version: "0.9.3" });
  });

  test("without an answer from the release feed nothing is called up to date", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    try {
      expect(await tool("uv")).toMatchObject({ installed: true, latest: null, updateAvailable: false });
      const result = await updateTool("uv");
      expect(result).toMatchObject({ ok: false, upToDate: false });
      expect(result.output).toContain("Couldn't find out");
      expect(tools.calls()).toEqual([]);
    } finally {
      globalThis.fetch = feeds;
    }
  });

  test("uv from a package manager is left to that package manager", async () => {
    const cellar = fakeTools(join(dataDir, "Cellar", "uv", "0.9.0", "bin"));
    const brew = join(dataDir, "brew-bin");
    mkdirSync(brew, { recursive: true });
    rmSync(join(brew, "uvx"), { force: true });
    symlinkSync(cellar.uvx, join(brew, "uvx"));
    writeFileSync(join(brew, "uv-version"), "0.9.0");
    __setUvxForTests(join(brew, "uvx"));
    latest.uv = "0.9.3";

    expect(await tool("uv")).toMatchObject({ installed: true, current: "0.9.0", updateAvailable: false, updatable: false, track: "external" });
    const result = await updateTool("uv");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("package manager");
    expect(cellar.calls()).toEqual([]);
  });

  test("Claude Code is updated by its own updater", async () => {
    latest.claude = "2.1.283";
    expect(await tool("claude")).toMatchObject({ current: "2.1.274", latest: "2.1.283", updateAvailable: true });
    tools.set("claude-target", "2.1.283");
    expect(await updateTool("claude")).toMatchObject({ ok: true, previous: "2.1.274", version: "2.1.283" });
    expect(await tool("claude", false)).toMatchObject({ current: "2.1.283", updateAvailable: false });
  });

  test("Claude Code with its own auto-updater turned off is only updated on request", async () => {
    expect(leftToHuman("claude")).toBeNull();
    mkdirSync(join(dataDir, "claude-config"), { recursive: true });
    writeFileSync(join(dataDir, "claude-config", "settings.json"), JSON.stringify({ env: { DISABLE_AUTOUPDATER: "1" } }));
    expect(leftToHuman("claude")).toContain("auto-updater is turned off");
    expect(leftToHuman("uv")).toBeNull();
    latest.claude = "2.1.283";
    tools.set("claude-target", "2.1.283");
    const status = (await tool("claude"))!;
    expect(status).toMatchObject({ updateAvailable: true, updatable: true });
    expect(status.detail).toContain("only updates it when you ask");
    expect((await updateTool("claude")).ok).toBe(true);
  });

  test("an install from elsewhere (the system check's Install button) shows up without asking again", async () => {
    const before = await checkUpdates(true);
    expect(before.tools.find((t) => t.id === "browser-use")).toMatchObject({ installed: false });
    expect((await installDependency("browser-use")).ok).toBe(true);
    const after = await checkUpdates();
    expect(after).not.toBe(before);
    expect(after.tools.find((t) => t.id === "browser-use")).toMatchObject({ installed: true, current: BROWSER_USE_VERSION });
  });

  test("browser-use: a Godmode release with a newer pinned version makes it an update", async () => {
    // Never installed: that is the system check's business, not an update.
    expect(await tool("browser-use")).toMatchObject({ installed: false, updateAvailable: false });
    expect((await updateTool("browser-use")).ok).toBe(false);
    expect(tools.calls()).toEqual([]);

    // Seen working: Godmode notes the version it used.
    tools.set("browser-use-ready", "");
    expect(await tool("browser-use")).toMatchObject({ installed: true, current: BROWSER_USE_VERSION, updateAvailable: false, detail: "The version this Godmode release was tested with" });
    expect(ledger()["browser-use"]).toBe(BROWSER_USE_VERSION);

    // An older Godmode used 0.1.0; this one pins a version that isn't downloaded yet.
    writeFileSync(join(dataDir, "tools.json"), JSON.stringify({ "browser-use": "0.1.0" }));
    tools.set("browser-use-ready", null);
    expect(await tool("browser-use")).toMatchObject({ installed: true, current: "0.1.0", latest: BROWSER_USE_VERSION, updateAvailable: true, updatable: true });

    const result = await updateTool("browser-use");
    expect(result).toMatchObject({ ok: true, previous: "0.1.0", version: BROWSER_USE_VERSION });
    expect(tools.calls()).toEqual([`uvx browser-use==${BROWSER_USE_VERSION}`]);
    expect(ledger()["browser-use"]).toBe(BROWSER_USE_VERSION);
  });

  test("browser-use: without uv there is nothing Godmode can download", async () => {
    writeFileSync(join(dataDir, "tools.json"), JSON.stringify({ "browser-use": "0.1.0" }));
    __setUvxForTests(null);
    expect(await tool("browser-use")).toMatchObject({ installed: true, updateAvailable: false, updatable: false });
    expect(await tool("uv")).toMatchObject({ installed: false });
  });

  test("browser-use started with a custom command is not Godmode's to update", async () => {
    updateSettings({ browser: { browserUseCommand: "my-browser-use --mcp" } });
    expect(await tool("browser-use")).toMatchObject({ installed: true, updatable: false, track: "external" });
  });

  test("claude-mem: a copy of an older version is an update to the pinned one", async () => {
    const old = join(dataDir, "plugins", "claude-mem", "1.0.0", "plugin", ".claude-plugin");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "plugin.json"), "{}");
    const status = (await tool("claude-mem"))!;
    expect(status).toMatchObject({ installed: true, current: "1.0.0", latest: CLAUDE_MEM_VERSION, track: "pinned" });
    // Installing it needs Node.js, which this machine may or may not have.
    expect(status.updateAvailable).toBe(status.updatable);
  });

  test("Playwright's Chromium follows the newest Playwright", async () => {
    // Look for browsers only in the test's own folders — as on a Windows machine, where every place is configurable.
    const root = join(dataDir, "ms-playwright");
    const detection = { platform: "win32" as const, home: join(dataDir, "home"), env: { ProgramFiles: join(dataDir, "pf"), "ProgramFiles(x86)": join(dataDir, "pf86"), LOCALAPPDATA: join(dataDir, "local"), PLAYWRIGHT_BROWSERS_PATH: root } };
    mkdirSync(join(root, "chromium-1200"), { recursive: true });
    const binary = playwrightChromiumCandidates(detection)[0]!.path;
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, "#!/bin/sh\necho 'Chromium 141.0.0.0'\n");
    chmodSync(binary, 0o755);
    __setChromeDetectionForTests(detection);
    updateSettings({ browser: { chromePath: "" } });

    const next = join(root, "chromium-1300");
    tools.set("playwright-location", next);
    tools.set("playwright-dry-run", `browser: chromium version 150.0.1.2\n  Install location:    ${next}\n`);

    // Opening the page doesn't run the newest Playwright; only asking for a fresh check does.
    expect(await tool("chrome", false)).toMatchObject({ installed: true, latest: null, updateAvailable: false, updatable: true, track: "release" });
    expect(tools.probes()).toEqual([]);
    expect(await tool("chrome")).toMatchObject({ latest: "150.0.1.2", updateAvailable: true });
    expect(tools.probes()).toHaveLength(1);

    // A download that broke off left a folder, but not Playwright's mark: still to be installed.
    mkdirSync(next);
    expect(await tool("chrome")).toMatchObject({ updateAvailable: true });

    // The update had to wait (a browser was open) until what the probe found is no longer remembered — or a new
    // process (`godmode update`) never knew it. Then it asks again instead of calling the old build up to date.
    __resetUpdatesForTests();
    expect(await updateAll()).toMatchObject([{ id: "chrome", ok: true, upToDate: false }]);
    expect(tools.calls()).toEqual(["uvx playwright install"]);
    expect(existsSync(join(next, "INSTALLATION_COMPLETE"))).toBe(true);
    expect(await tool("chrome")).toMatchObject({ updateAvailable: false });

    __resetUpdatesForTests();
    expect(await updateTool("chrome")).toMatchObject({ ok: true, upToDate: true });
    expect(tools.calls()).toEqual(["uvx playwright install"]);

    // The same build picked by hand in the settings is the human's browser: Godmode keeps starting exactly that one.
    updateSettings({ browser: { chromePath: binary } });
    expect(await tool("chrome")).toMatchObject({ updatable: false, track: "external", detail: "Your own browser (Settings → Browser)" });
  });

  test("Tart: Godmode's own copy follows the pinned version, and waits for VMs that run or sleep", async () => {
    setVmSupportForTests(true);
    const tart = managedTartPath();
    const vms = join(dirname(tart), "vms.json");
    mkdirSync(dirname(tart), { recursive: true });
    writeFileSync(tart, `#!/bin/sh\ncase "$1" in\n  --version) echo "2.0.0" ;;\n  list) cat "$(dirname "$0")/vms.json" ;;\nesac\n`);
    chmodSync(tart, 0o755);
    updateSettings({ vm: { tartPath: "" } });

    expect(await tool("tart")).toMatchObject({ installed: true, current: "2.0.0", latest: TART_VERSION, updateAvailable: true, track: "pinned" });
    for (const state of ["running", "suspended"]) {
      writeFileSync(vms, JSON.stringify([{ Name: "vm-1", Source: "local", State: state }]));
      const result = await updateTool("tart");
      expect(result.ok).toBe(false);
      expect(result.output).toContain("running or suspended");
    }
    expect(readFileSync(tart, "utf8")).toContain("2.0.0");
    rmSync(join(dataDir, "vm"), { recursive: true, force: true });
  });

  test("updateAll installs what is due and nothing else", async () => {
    expect(await updateAll()).toEqual([]);

    latest = { claude: "2.1.283", uv: "0.9.3" };
    tools.set("claude-target", "2.1.283");
    tools.set("uv-target", "0.9.3");
    writeFileSync(join(dataDir, "tools.json"), JSON.stringify({ "browser-use": "0.1.0" }));
    const results = await updateAll();
    expect(results.map((r) => [r.id, r.ok])).toEqual([
      ["claude", true],
      ["uv", true],
      ["browser-use", true],
    ]);
    expect(tools.calls()).toEqual(["claude update", "uv self update", `uvx browser-use==${BROWSER_USE_VERSION}`]);
    expect(dueUpdates(await checkUpdates(true))).toEqual([]);
  });

  test("what Godmode doesn't update is refused, not attempted", async () => {
    const git = await updateTool("git");
    expect(git.ok).toBe(false);
    expect((await updateTool("chrome")).ok).toBe(false);
    expect((await updateTool("nope" as ToolId)).ok).toBe(false);
    expect(tools.calls()).toEqual([]);
  });
});
