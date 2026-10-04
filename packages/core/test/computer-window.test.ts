/**
 * Window shares on macOS against a scripted stand-in for the native helper (GODMODE_COMPUTER_HELPER): how clicks,
 * typing and keys are routed, what the model is told, and when the agent cursor shows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { fakeTools } from "./fixtures/fake-tools";
import { CUA_DRIVER_SPEC, __resetCuaDriverForTests, installCuaDriver, stopCuaDriver } from "../src/computer/cua";
import { __setUvxForTests } from "../src/services/doctor";
import { stopHelper } from "../src/computer/helper";
import { windowEngine } from "../src/computer/engines/window";
import { updateSettings } from "../src/services/settings";

const suite = process.platform === "darwin" ? describe : describe.skip;
const FAKE_CUA_DRIVER = join(import.meta.dir, "fixtures", "fake-cua-driver.ts");

interface Scenario {
  /** What a background click did: "ax", "ax-focus" or "event". */
  pointer: string;
  /** The app is Chromium-family (its pages ignore key events in the background). */
  chromium: boolean;
  /** A web field is focused, so text and editing keys go in through accessibility. */
  webField: boolean;
  /** The click brought the app to the front and it couldn't be sent back. */
  cameToFront?: boolean;
  /** The helper fails pointer actions with this error code. */
  pointerError?: string;
}

const FAKE_HELPER = `
const { appendFileSync, readFileSync } = require("node:fs");
const [scenarioFile, logFile] = process.argv.slice(2);
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\\n");
process.stdout.write(JSON.stringify({ ready: true, version: "2" }) + "\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    appendFileSync(logFile, line + "\\n");
    const s = JSON.parse(readFileSync(scenarioFile, "utf8"));
    switch (msg.cmd) {
      case "window": reply(msg.id, { id: 7, pid: 70, app: "Slack", bundleId: "com.tinyspeck.slackmacgap", title: "Slack", x: 100, y: 50, width: 800, height: 600, layer: 0, onScreen: true, frontmost: false }); break;
      case "pointer":
        if (s.pointerError) process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: "Accessibility permission is missing.", code: s.pointerError }) + "\\n");
        else reply(msg.id, { method: s.pointer, chromium: s.chromium, cameToFront: !!s.cameToFront });
        break;
      case "type": case "key": reply(msg.id, msg.webOnly ? { method: s.webField ? "ax" : null, chromium: s.chromium } : { method: "event", chromium: s.chromium }); break;
      case "ensureKeyWindow": reply(msg.id, { state: "key" }); break;
      default: reply(msg.id, { ok: true });
    }
  }
});
`;

suite("window shares (macOS helper)", () => {
  let env: TestEnv;
  let dir: string;
  let scenarioFile: string;
  let logFile: string;
  const target = { kind: "window" as const, pid: 70, windowId: 7, app: "Slack", title: "Slack" };

  const scenario = (s: Scenario) => writeFileSync(scenarioFile, JSON.stringify(s));
  const calls = (): Record<string, unknown>[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((c) => c.cmd !== "window")
      : [];

  beforeAll(async () => {
    env = await setupEnv("godmode-window-");
    dir = mkdtempSync(join(tmpdir(), "godmode-fake-helper-"));
    scenarioFile = join(dir, "scenario.json");
    logFile = join(dir, "calls.jsonl");
    const script = join(dir, "godmode-computer");
    writeFileSync(script, `#!${process.execPath}\nprocess.argv.push(${JSON.stringify(scenarioFile)}, ${JSON.stringify(logFile)});\n${FAKE_HELPER}`);
    chmodSync(script, 0o755);
    await stopHelper();
    process.env.GODMODE_COMPUTER_HELPER = script;
    updateSettings({ computer: { enabled: true, useCuaDriver: false, agentCursor: true, allowForeground: false } });
  });

  afterAll(async () => {
    await stopHelper();
    delete process.env.GODMODE_COMPUTER_HELPER;
    await env?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(logFile, { force: true });
    scenario({ pointer: "event", chromium: false, webField: false });
  });

  test("an agent's click goes to the helper at the window's global point, with the agent cursor", async () => {
    scenario({ pointer: "ax-focus", chromium: true, webField: false });
    const engine = windowEngine(target, { agent: true });
    const out = await engine.click("window:70:7", { x: 10, y: 20 }, { button: "left", count: 1, modifiers: [] });
    expect(out.detail).toBe("Clicked (focused the text field — type now)");
    const [pointer] = calls();
    expect(pointer).toMatchObject({ cmd: "pointer", action: "click", pid: 70, window: 7, x: 110, y: 70, cursor: true });

    scenario({ pointer: "ax", chromium: true, webField: false });
    expect((await engine.click("window:70:7", { x: 10, y: 20 }, { button: "left", count: 1, modifiers: [] })).detail).toBe("Clicked (pressed the element via accessibility)");
    scenario({ pointer: "event", chromium: true, webField: false });
    expect((await engine.click("window:70:7", { x: 10, y: 20 }, { button: "left", count: 1, modifiers: [] })).detail).toContain("background Chrome/Electron window often ignores");
    scenario({ pointer: "event", chromium: false, webField: false });
    expect((await engine.click("window:70:7", { x: 10, y: 20 }, { button: "right", count: 1, modifiers: [] })).detail).toBe("Right-clicked (background)");

    scenario({ pointer: "event", chromium: false, webField: false, cameToFront: true });
    expect((await engine.click("window:70:7", { x: 10, y: 20 }, { button: "left", count: 1, modifiers: [] })).detail).toBe(
      "Clicked (background) The app came to the front — the human may notice.",
    );

    // The cursor it showed goes away with the share (only if it is still over this window).
    await engine.dispose();
    expect(calls().at(-1)).toMatchObject({ cmd: "agentCursor", hide: true, window: 7 });
  });

  test("a failing helper click reports the error (no Cua Driver to fall back to)", async () => {
    scenario({ pointer: "event", chromium: false, webField: false, pointerError: "permission_accessibility" });
    const engine = windowEngine(target, { agent: true });
    await expect(engine.click("window:70:7", { x: 1, y: 1 }, { button: "left", count: 1, modifiers: [] })).rejects.toThrow("Accessibility permission is missing");
  });

  test("foreground clicks are Cua Driver's: a double or right click is its click with a count / button", async () => {
    const state = mkdtempSync(join(tmpdir(), "godmode-fake-cua-"));
    updateSettings({ computer: { useCuaDriver: true, allowForeground: true, cuaDriverCommand: `'${process.execPath}' '${FAKE_CUA_DRIVER}' '${state}'` } });
    try {
      const engine = windowEngine(target);
      const double = await engine.click("window:70:7", { x: 100, y: 50 }, { button: "left", count: 2, modifiers: [], foreground: true });
      const right = await engine.click("window:70:7", { x: 100, y: 50 }, { button: "right", count: 1, modifiers: [], foreground: true });
      expect([double.detail, right.detail]).toEqual(["Double-clicked", "Right-clicked"]);
      const driverCalls = readFileSync(join(state, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((c) => c.name !== "set_agent_cursor_enabled");
      const window = { kind: "window", pid: 70, window_id: 7 };
      expect(driverCalls).toEqual([
        { name: "get_window_state", pid: 70, window_id: 7, include_accessibility_tree: false, max_image_dimension: 1280 },
        { name: "click", target: window, x: 200, y: 100, delivery_mode: "foreground", count: 2 },
        { name: "click", target: window, x: 200, y: 100, delivery_mode: "foreground", button: "right" },
      ]);
      // The driver did it: nothing went to the helper as a click.
      expect(calls().filter((c) => c.cmd === "pointer")).toEqual([]);
    } finally {
      await stopCuaDriver();
      updateSettings({ computer: { useCuaDriver: false, allowForeground: false, cuaDriverCommand: "" } });
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("while Cua Driver downloads for its first use the helper acts, and the driver takes over once it is there", async () => {
    const tools = fakeTools(join(dir, "fake-bin"));
    const state = join(dir, "cua-state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(tools.dir, "cua-driver-bin"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CUA_DRIVER}' '${state}'\n`);
    chmodSync(join(tools.dir, "cua-driver-bin"), 0o755);
    tools.set("cua-driver-slow", "");
    __setUvxForTests(tools.uvx);
    __resetCuaDriverForTests({ standalone: null });
    updateSettings({ computer: { useCuaDriver: true, cuaDriverCommand: "" } });
    const f5 = [{ key: "f5", modifiers: [] }];
    try {
      const engine = windowEngine(target, { agent: true });
      const started = Date.now();
      expect((await engine.keys("window:70:7", f5, {})).detail).toBe("Pressed (background)");
      expect(Date.now() - started).toBeLessThan(5000);
      // The download started in the background.
      await until(() => tools.calls().length > 0, 5000, "the download to start");
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`]);
      expect(calls().filter((c) => c.cmd === "key" && !c.webOnly)).toHaveLength(1);
      // What only the driver can do says it is on its way — for this action, not for good.
      await expect(engine.elements()).rejects.toMatchObject({ code: "downloading" });

      tools.set("cua-driver-release", "");
      await installCuaDriver();
      rmSync(logFile, { force: true });
      expect((await engine.keys("window:70:7", f5, {})).detail).toBe("Pressed");
      expect(calls().filter((c) => c.cmd === "key" && !c.webOnly)).toEqual([]);
      const driverCalls = readFileSync(join(state, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(driverCalls.filter((c) => c.name === "press_key")).toEqual([{ name: "press_key", pid: 70, window_id: 7, key: "f5" }]);
      expect(tools.calls()).toEqual([`uvx ${CUA_DRIVER_SPEC}`]);
    } finally {
      await stopCuaDriver();
      __setUvxForTests(undefined);
      __resetCuaDriverForTests();
      updateSettings({ computer: { useCuaDriver: false } });
    }
  });

  test("the human's input (takeover) doesn't draw the agent cursor", async () => {
    const engine = windowEngine(target);
    await engine.click("window:70:7", { x: 5, y: 5 }, { button: "left", count: 1, modifiers: [] });
    await engine.dispose();
    const log = calls();
    expect(log.map((c) => c.cmd)).toEqual(["pointer"]);
    expect(log[0]).toMatchObject({ cursor: false });
  });

  test("the agent cursor follows the settings switch", async () => {
    updateSettings({ computer: { agentCursor: false } });
    try {
      const engine = windowEngine(target, { agent: true });
      await engine.click("window:70:7", { x: 5, y: 5 }, { button: "left", count: 1, modifiers: [] });
      await engine.dispose();
      expect(calls()).toEqual([expect.objectContaining({ cmd: "pointer", cursor: false })]);
    } finally {
      updateSettings({ computer: { agentCursor: true } });
    }
  });

  test("text goes into the focused web field through accessibility first", async () => {
    scenario({ pointer: "ax-focus", chromium: true, webField: true });
    const engine = windowEngine(target, { agent: true });
    const out = await engine.type("window:70:7", "hello", {});
    expect(out.detail).toBe("Typed 5 characters into the focused field (via accessibility)");
    expect(calls()).toEqual([expect.objectContaining({ cmd: "type", text: "hello", pid: 70, webOnly: true })]);

    rmSync(logFile, { force: true });
    const keys = await engine.keys("window:70:7", [{ key: "a", modifiers: ["cmd"] }, { key: "backspace", modifiers: [] }], {});
    expect(keys.detail).toBe("Pressed (applied to the focused field via accessibility)");
    expect(calls().map((c) => [c.cmd, c.webOnly])).toEqual([
      ["key", true],
      ["key", true],
    ]);
  });

  test("without a focused web field, typing in a Chromium app is sent as keys and the model hears they may not arrive", async () => {
    scenario({ pointer: "event", chromium: true, webField: false });
    const engine = windowEngine(target, { agent: true });
    const out = await engine.type("window:70:7", "hi", {});
    expect(out.detail).toStartWith("Typed 2 characters (background) — but key events usually don't reach the web page");
    expect(out.detail).not.toContain("foreground: true");
    expect(calls().map((c) => [c.cmd, c.webOnly ?? false])).toEqual([
      ["type", true],
      ["ensureKeyWindow", false],
      ["type", false],
    ]);

    const enter = await engine.keys("window:70:7", [{ key: "return", modifiers: [] }], {});
    expect(enter.detail).toContain("press the page's own button instead of Return.");
  });

  test("the Chromium note offers foreground delivery when it is allowed", async () => {
    updateSettings({ computer: { allowForeground: true } });
    try {
      scenario({ pointer: "event", chromium: true, webField: false });
      const out = await windowEngine(target, { agent: true }).keys("window:70:7", [{ key: "return", modifiers: [] }], {});
      expect(out.detail).toContain("or retry with foreground: true");
    } finally {
      updateSettings({ computer: { allowForeground: false } });
    }
  });

  test("a key sequence mixing field edits and other keys: only the keys sent as events get the note", async () => {
    scenario({ pointer: "ax-focus", chromium: true, webField: true });
    const engine = windowEngine(target, { agent: true });
    // All applied to the field: no "may not arrive" note, even for cmd+a.
    const edits = await engine.keys("window:70:7", [{ key: "a", modifiers: ["cmd"] }], {});
    expect(edits.detail).toBe("Pressed (applied to the focused field via accessibility)");

    scenario({ pointer: "event", chromium: false, webField: false });
    rmSync(logFile, { force: true });
    const shortcut = await engine.keys("window:70:7", [{ key: "z", modifiers: ["cmd"] }], {});
    expect(shortcut.detail).toContain("Shortcuts with cmd/ctrl don't always reach");
    expect(calls().map((c) => [c.cmd, c.webOnly ?? false])).toEqual([
      ["key", true],
      ["ensureKeyWindow", false],
      ["key", false],
    ]);
  });

  test("apps whose pages take key events get plain background keys, without the Chromium note", async () => {
    const engine = windowEngine(target, { agent: true });
    const out = await engine.type("window:70:7", "hi", {});
    expect(out.detail).toBe("Typed 2 characters (background)");
  });
});
