import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
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
import { CUA_DRIVER_SPEC, CUA_DRIVER_VERSION, __resetCuaDriverForTests, cuaDriverInstalled, cuaDriverRunning, cuaLastError, getCuaDriver, installCuaDriver, pinnedBuildMissing, resolveCuaDriver, stopCuaDriver } from "../src/computer/cua";
import { CLAUDE_RELEASES_URL } from "../src/services/claudeUpdate";
import { __setUvxForTests, installDependency, resolveClaudeBinary, resolveUvx, runDoctor } from "../src/services/doctor";
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

async function until(fn: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await Bun.sleep(25);
  return fn();
}

/**
 * A cua-driver program: says `version` to --version (noting each time in `versions.log` next to it; it fails while
 * `fail-version` is there, and hangs while `hang-version` is), and is the fake MCP driver otherwise.
 */
function fakeCuaDriver(state: string, version = "0.0.0"): string {
  mkdirSync(state, { recursive: true });
  const fixture = join(import.meta.dir, "fixtures", "fake-cua-driver.ts");
  return [
    "#!/bin/sh",
    'DIR="$(dirname "$0")"',
    'if [ "$1" = --version ]; then',
    '  echo asked >> "$DIR/versions.log"',
    '  if [ -f "$DIR/fail-version" ]; then exit 1; fi',
    '  if [ -f "$DIR/hang-version" ]; then exec sleep 30; fi',
    `  echo "cua-driver ${version}"; exit 0`,
    "fi",
    `exec '${process.execPath}' '${fixture}' '${state}'`,
    "",
  ].join("\n");
}

/** A cua-driver of the human's own (the official installer's), at `version`. */
function standaloneCuaDriver(version: string): string {
  const path = join(dataDir, `standalone-${version}`, "cua-driver");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, fakeCuaDriver(join(dataDir, "cua-driver-calls"), version));
  chmodSync(path, 0o755);
  return path;
}

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
  // The pinned Cua Driver the fake uvx "downloads": the fake MCP driver.
  writeFileSync(join(tools.dir, "cua-driver-bin"), fakeCuaDriver(join(dataDir, "cua-driver-calls")));
  chmodSync(join(tools.dir, "cua-driver-bin"), 0o755);
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
  __resetCuaDriverForTests();
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
  for (const name of ["claude-target", "uv-target", "uv-offline", "browser-use-ready", "cua-driver-ready", "cua-driver-broken", "cua-driver-slow", "cua-driver-release", "calls.log", "probes.log"]) tools.set(name, null);
  rmSync(join(dataDir, "tools.json"), { force: true });
  rmSync(join(tools.dir, "uv-cache"), { recursive: true, force: true });
  rmSync(join(dataDir, "cua-driver"), { recursive: true, force: true });
  // No cua-driver of the machine's own.
  __resetCuaDriverForTests({ standalone: null });
  rmSync(join(dataDir, "plugins"), { recursive: true, force: true });
  rmSync(join(dataDir, "claude-config"), { recursive: true, force: true });
  __setUvxForTests(tools.uvx);
  __setChromeDetectionForTests(undefined);
  setVmSupportForTests(false);
  // Its own browser and no native helper: nothing here depends on what the machine running the tests has installed.
  updateSettings({ runner: { claudePath: tools.claude }, browser: { chromePath: tools.browser, browserUseCommand: "" }, computer: { enabled: false, useCuaDriver: true, cuaDriverCommand: "" } });
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

  describe("Cua Driver", () => {
    const wait = { download: "wait" } as const;
    const detail = async () => (await runDoctor(true)).dependencies.find((d) => d.id === "cua-driver")!.detail;
    /** Let a slow download finish, and wait for it. */
    const release = async () => {
      tools.set("cua-driver-release", "");
      await installCuaDriver();
    };

    afterEach(async () => {
      await stopCuaDriver();
      setSystemTime();
      tools.set("cua-driver-release", "");
    });

    test("not downloaded yet: looking doesn't download it, the first use does — once", async () => {
      expect(await cuaDriverInstalled()).toMatchObject({ installed: false, fetchable: true, downloading: false });
      expect(await detail()).toContain(`Godmode downloads ${CUA_DRIVER_SPEC} with uv when an agent needs it`);
      expect(await tool("cua-driver")).toMatchObject({ installed: false, updateAvailable: false });
      // Listings and the status don't download it either.
      await expect(getCuaDriver({ download: "never" })).rejects.toMatchObject({ code: "unavailable" });
      expect(tools.calls()).toEqual([]);

      // A window share and the Install button at the same moment: one download, then the driver runs.
      const [client] = await Promise.all([getCuaDriver(wait), getCuaDriver(wait), installCuaDriver()]);
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`]);
      expect(client.version).toBe("fake");
      expect(cuaDriverRunning()).toBe(client);
      expect(await tool("cua-driver")).toMatchObject({ installed: true, current: CUA_DRIVER_VERSION, updateAvailable: false });
    });

    test("a slow download holds up neither listings and the status, nor what can do without the driver", async () => {
      tools.set("cua-driver-slow", "");
      const started = Date.now();
      await expect(getCuaDriver({ download: "background" })).rejects.toMatchObject({ code: "downloading", message: `Cua Driver ${CUA_DRIVER_VERSION} is being downloaded (first use)…` });
      const lookups = tools.cuaLookups().length;
      await expect(getCuaDriver({ download: "never" })).rejects.toMatchObject({ code: "downloading" });
      // What the computer status shows.
      expect(cuaLastError()).toBe(`Cua Driver ${CUA_DRIVER_VERSION} is being downloaded (first use)…`);
      expect(await cuaDriverInstalled()).toMatchObject({ installed: false, downloading: true });
      expect(await detail()).toBe(`Not installed — optional; downloading ${CUA_DRIVER_SPEC} in the background`);
      // While the download writes into uv's cache, nobody looks into it (that look could wait on the download's lock).
      expect(tools.cuaLookups()).toHaveLength(lookups);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await until(() => tools.calls().length > 0)).toBe(true);
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`]);

      await release();
      expect((await getCuaDriver({ download: "never" })).version).toBe("fake");
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`]);
    });

    test("with nothing to fall back on, an action waits for the download a little — then asks to try again", async () => {
      __resetCuaDriverForTests({ standalone: null, waitMs: 400 });
      tools.set("cua-driver-slow", "");
      const inTime = getCuaDriver(wait);
      await Bun.sleep(100);
      tools.set("cua-driver-release", "");
      expect((await inTime).version).toBe("fake");
      await stopCuaDriver();

      __resetCuaDriverForTests({ standalone: null, waitMs: 400 });
      tools.set("cua-driver-ready", null);
      tools.set("cua-driver-release", null);
      const started = Date.now();
      await expect(getCuaDriver(wait)).rejects.toMatchObject({ code: "downloading", message: `Cua Driver ${CUA_DRIVER_VERSION} is still being downloaded (first use). Try again in a moment.` });
      expect(Date.now() - started).toBeLessThan(3000);
      // The download goes on; once it is there, the next action gets the driver.
      await release();
      expect((await getCuaDriver(wait)).version).toBe("fake");
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`, `uvx ${CUA_DRIVER_SPEC}`]);
    });

    test("turned off, or another driver chosen, while it downloads: the downloaded driver isn't started", async () => {
      rmSync(join(dataDir, "cua-driver-calls", "started"), { force: true });
      for (const change of [{ useCuaDriver: false }, { cuaDriverCommand: "my-cua-driver" }]) {
        __resetCuaDriverForTests({ standalone: null });
        updateSettings({ computer: { useCuaDriver: true, cuaDriverCommand: "" } });
        tools.set("cua-driver-ready", null);
        tools.set("cua-driver-release", null);
        tools.set("cua-driver-slow", "");
        const asked = getCuaDriver(wait);
        await Bun.sleep(50);
        updateSettings({ computer: change });
        tools.set("cua-driver-release", "");
        await expect(asked).rejects.toMatchObject({ code: "unavailable" });
        expect(cuaDriverRunning()).toBeNull();
        // The download itself was finished.
        expect(await installCuaDriver()).toMatchObject({ ok: true });
      }
      expect(existsSync(join(dataDir, "cua-driver-calls", "started"))).toBe(false);
    });

    test("a download that failed is shown and isn't retried unasked for a while; asked, it is", async () => {
      tools.set("cua-driver-broken", "");
      await expect(getCuaDriver(wait)).rejects.toThrow(`Cua Driver ${CUA_DRIVER_VERSION} couldn't be downloaded: error: Failed to fetch ${CUA_DRIVER_SPEC}`);
      await expect(getCuaDriver(wait)).rejects.toThrow("couldn't be downloaded");
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`]);
      // The real error, not "downloaded when needed".
      expect(await cuaDriverInstalled()).toMatchObject({ installed: false, fetchable: false });
      expect(cuaLastError()).toBe(`Cua Driver ${CUA_DRIVER_VERSION} couldn't be downloaded: error: Failed to fetch ${CUA_DRIVER_SPEC}`);
      expect(await detail()).toContain("failed (error: Failed to fetch");

      // Once the wait is over, the old error is gone and the next use tries again.
      setSystemTime(new Date(Date.now() + 11 * 60_000));
      expect(cuaLastError()).toBeNull();
      expect(await cuaDriverInstalled()).toMatchObject({ fetchable: true });
      setSystemTime();

      tools.set("cua-driver-broken", null);
      expect((await installCuaDriver()).ok).toBe(true);
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`, `uvx ${CUA_DRIVER_SPEC}`]);
      expect((await getCuaDriver(wait)).version).toBe("fake");
    });

    test("where PyPI has no build, nothing is downloaded and it says why", async () => {
      __resetCuaDriverForTests({ standalone: null, unsupported: "it needs macOS 13 or newer" });
      mkdirSync(join(dataDir, "cua-driver"));
      expect(await cuaDriverInstalled()).toMatchObject({ installed: false, fetchable: false });
      await expect(getCuaDriver(wait)).rejects.toThrow("Cua Driver can't be downloaded for this computer: it needs macOS 13 or newer.");
      expect(await detail()).toBe(`Not installed — optional; PyPI has no ${CUA_DRIVER_SPEC} for this computer: it needs macOS 13 or newer`);
      expect(await tool("cua-driver")).toMatchObject({ updateAvailable: false, updatable: false });
      expect(tools.calls()).toEqual([]);

      const host = (platform: string, arch: string, osRelease: string, glibc: string | null = null) => pinnedBuildMissing({ platform, arch, osRelease, glibc });
      expect(host("darwin", "arm64", "22.1.0")).toBeNull();
      expect(host("darwin", "x64", "21.6.0")).toBe("it needs macOS 13 or newer");
      expect(host("win32", "x64", "10.0.22631")).toBeNull();
      expect(host("win32", "ia32", "10.0.19045")).toBe("there is none for Windows on ia32");
      expect(host("linux", "x64", "6.8.0", "2.39")).toBeNull();
      expect(host("linux", "arm64", "5.10.0", "2.28")).toBe("it needs glibc 2.31 or newer (this system has 2.28)");
      // musl, or glibc unknown: tried, and a failed download says why.
      expect(host("linux", "x64", "6.6.0", null)).toBeNull();
      expect(host("linux", "arm", "6.1.0", "2.36")).toBe("there is none for Linux on arm");
      expect(host("freebsd", "x64", "14.0")).toBe("there is none for freebsd");
    });

    test("a driver that doesn't start says why, and the test reset forgets it", async () => {
      updateSettings({ computer: { cuaDriverCommand: `'${process.execPath}' -e 'process.exit(3)'` } });
      try {
        await expect(getCuaDriver()).rejects.toMatchObject({ code: "unavailable" });
        expect(cuaLastError()).toStartWith("Cua Driver could not start");
        __resetCuaDriverForTests({ standalone: null });
        expect(cuaLastError()).toBeNull();
      } finally {
        updateSettings({ computer: { cuaDriverCommand: "" } });
      }
    });

    test("used before Godmode noted it: the pinned version is an update — a newer one in the cache is not", async () => {
      // No trace of it: never installed, nothing to update. A newer cua-driver in uv's cache is no earlier pin.
      const cached = (v: string) => mkdirSync(join(tools.dir, "uv-cache", "wheels-v6", "pypi", "cua-driver", `${v}-py3-none-macosx_13_0_universal2`), { recursive: true });
      cached("0.34.0");
      expect(await tool("cua-driver")).toMatchObject({ installed: false, updateAvailable: false });

      // The driver's state folder: it ran, version unknown.
      mkdirSync(join(dataDir, "cua-driver"));
      expect(await tool("cua-driver")).toMatchObject({ installed: true, current: null, latest: CUA_DRIVER_VERSION, updateAvailable: true, updatable: true });

      // What an older pin left in uv's cache names the version.
      for (const v of ["0.29.1", "0.30.4", CUA_DRIVER_VERSION]) cached(v);
      const status = (await tool("cua-driver"))!;
      expect(status).toMatchObject({ installed: true, current: "0.30.4", updateAvailable: true });
      expect(dueUpdates(await checkUpdates(true)).map((t) => t.id)).toEqual(["cua-driver"]);

      expect(await updateTool("cua-driver")).toMatchObject({ ok: true, previous: "0.30.4", version: CUA_DRIVER_VERSION });
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`]);
      expect(ledger()["cua-driver"]).toBe(CUA_DRIVER_VERSION);
    });

    test("an older cua-driver of the human's own works on while the pinned build downloads, then gives way to it", async () => {
      const own = standaloneCuaDriver("0.22.2");
      __resetCuaDriverForTests({ standalone: own });
      expect(await cuaDriverInstalled()).toMatchObject({ installed: true, source: "installed", path: own, version: "0.22.2", outdated: true, fetchable: true });
      expect(await detail()).toBe(`cua-driver 0.22.2 is older than the tested ${CUA_DRIVER_VERSION} — Godmode downloads ${CUA_DRIVER_SPEC} with uv when an agent needs it`);
      expect(await tool("cua-driver")).toMatchObject({ installed: true, current: "0.22.2", latest: CUA_DRIVER_VERSION, updateAvailable: true, updatable: true });
      expect(tools.calls()).toEqual([]);

      // Needed: the older one runs right away, the pinned build downloads meanwhile…
      tools.set("cua-driver-slow", "");
      const older = await getCuaDriver(wait);
      expect(older.command).toBe(own);
      expect(await until(() => tools.calls().length > 0)).toBe(true);
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`]);
      expect(await detail()).toBe(`cua-driver 0.22.2 is older than the tested ${CUA_DRIVER_VERSION} — downloading ${CUA_DRIVER_SPEC} in the background`);
      // …and takes over once it is there.
      await release();
      const pinnedOne = await getCuaDriver(wait);
      expect(pinnedOne.command).toBe(join(tools.dir, "cua-driver-bin"));
      expect(await until(() => !older.alive)).toBe(true);
      expect(await tool("cua-driver")).toMatchObject({ installed: true, current: CUA_DRIVER_VERSION, updateAvailable: false });
    });

    test("one --version for whoever asks at the same moment, and no answer isn't remembered", async () => {
      const own = standaloneCuaDriver("0.21.0");
      const asked = () => (existsSync(join(dirname(own), "versions.log")) ? readFileSync(join(dirname(own), "versions.log"), "utf8").trim().split("\n").length : 0);
      writeFileSync(join(dirname(own), "fail-version"), "");
      __resetCuaDriverForTests({ standalone: own });
      // Without uv nothing else is looked at first: the three ask at the same moment.
      __setUvxForTests(null);
      expect((await Promise.all([resolveCuaDriver(), resolveCuaDriver(), resolveCuaDriver()])).map((c) => c?.version)).toEqual([null, null, null]);
      expect(asked()).toBe(1);
      rmSync(join(dirname(own), "fail-version"));
      expect(await resolveCuaDriver()).toMatchObject({ version: "0.21.0" });
      expect(await resolveCuaDriver()).toMatchObject({ version: "0.21.0" });
      expect(asked()).toBe(2);
    });

    test("a --version that hangs is given up on, and not asked again for a while", async () => {
      const own = standaloneCuaDriver("0.20.0");
      const asked = () => (existsSync(join(dirname(own), "versions.log")) ? readFileSync(join(dirname(own), "versions.log"), "utf8").trim().split("\n").length : 0);
      writeFileSync(join(dirname(own), "hang-version"), "");
      __resetCuaDriverForTests({ standalone: own, versionTimeoutMs: 300 });
      __setUvxForTests(null);
      const started = Date.now();
      expect(await resolveCuaDriver()).toMatchObject({ version: null });
      expect(Date.now() - started).toBeLessThan(5000);
      // Every status would wait for it again: the next ones don't ask.
      const again = Date.now();
      expect(await resolveCuaDriver()).toMatchObject({ version: null });
      expect(await resolveCuaDriver()).toMatchObject({ version: null });
      expect(Date.now() - again).toBeLessThan(200);
      expect(asked()).toBe(1);
      // A while later it is asked again, and its answer counts.
      rmSync(join(dirname(own), "hang-version"));
      setSystemTime(new Date(Date.now() + 11 * 60_000));
      expect(await resolveCuaDriver()).toMatchObject({ version: "0.20.0" });
      expect(asked()).toBe(2);
    });

    test("the Install button with the driver already downloaded: nothing is downloaded, and it never looks missing", async () => {
      expect((await installCuaDriver()).ok).toBe(true);
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`]);
      __resetCuaDriverForTests({ standalone: null });
      // A fresh start knows nothing yet: it finds the build in uv's cache instead of downloading it again.
      tools.set("cua-driver-slow", "");
      expect(await installCuaDriver()).toMatchObject({ ok: true });
      expect(await cuaDriverInstalled()).toMatchObject({ installed: true, downloading: false });
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`]);
    });

    test("an older cua-driver of the human's own without uv: used, and flagged", async () => {
      const own = standaloneCuaDriver("0.22.2");
      __resetCuaDriverForTests({ standalone: own });
      __setUvxForTests(null);
      expect(await resolveCuaDriver()).toEqual({ command: own, args: [], source: "installed", version: "0.22.2" });
      expect((await getCuaDriver(wait)).command).toBe(own);
      expect(await detail()).toBe(`cua-driver 0.22.2 is older than the tested ${CUA_DRIVER_VERSION} — update it with \`cua-driver update --apply\`, or install uv so Godmode can download ${CUA_DRIVER_VERSION}`);
      const status = (await tool("cua-driver"))!;
      expect(status).toMatchObject({ installed: true, current: "0.22.2", latest: CUA_DRIVER_VERSION, updateAvailable: true, updatable: false, track: "pinned" });
      expect(status.detail).toContain("cua-driver update --apply");
      // An update only the human can take: the upkeep leaves it alone.
      expect(dueUpdates(await checkUpdates(true))).toEqual([]);
    });

    test("a cua-driver of the human's own at or above the pinned version, and a custom command, stay as they are", async () => {
      __resetCuaDriverForTests({ standalone: standaloneCuaDriver("9.0.0") });
      expect(await resolveCuaDriver()).toMatchObject({ source: "installed", version: "9.0.0" });
      expect((await getCuaDriver(wait)).command).toContain("standalone-9.0.0");
      expect(await tool("cua-driver")).toMatchObject({ installed: true, current: "9.0.0", updateAvailable: false, track: "external" });

      updateSettings({ computer: { cuaDriverCommand: "my-cua-driver --flag" } });
      expect(await resolveCuaDriver()).toMatchObject({ source: "custom", args: ["--flag"] });
      expect(await tool("cua-driver")).toMatchObject({ updateAvailable: false, track: "external" });
      expect(tools.calls()).toEqual([]);
    });
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
