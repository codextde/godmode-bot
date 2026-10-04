import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ComputerTarget, ServerEvent } from "@godmode/shared";
import { computerTargetLabel, computerView, sameComputerTarget } from "@godmode/shared";
import { argValue, captureEvents, invocations, makeAgent, setupEnv, until, type TestEnv } from "./fixtures/runner-harness";
import { KeyError, parseKeyCombo, parseKeySequence } from "../src/computer/keys";
import { fitSize, frameToImage, imageToFrame, inImage, regionToFrame, unionRect } from "../src/computer/geometry";
import { imageSize } from "../src/computer/image";
import { normalizeAgentComputer, parseComputerTarget } from "../src/computer/targets";
import { attachComputer, computerLockKey, detachAgentComputer, detachComputer, isGodmodeTab, isGodmodeWindow, runComputer, targetForView } from "../src/computer/service";
import { config } from "../src/config";
import { isGodmodeAppName } from "../src/computer/self";
import { callTool } from "../src/mcp/tools";
import { cuaDriverRunning, cuaKeyName, cuaModifier, getCuaDriver, scrubSummary, stopCuaDriver } from "../src/computer/cua";
import { CuaDesktopEngine } from "../src/computer/engines/desktop";
import { cdpCommands, cdpKey, cdpModifiers } from "../src/computer/engines/tab";
import { keysym, parseMonitors, pointerArgs } from "../src/computer/helpers/x11Helper";
import { WINDOWS_HELPER_CS, WINDOWS_HELPER_PS1 } from "../src/computer/helpers/windowsHelper";
import type { Capture, CaptureOptions, ComputerEngine, Outcome, PointerOptions, UiElement, ViewInfo } from "../src/computer/engine";
import type { KeyCombo } from "../src/computer/keys";
import type { Point } from "../src/computer/geometry";
import { issueRunToken } from "../src/mcp/tokens";
import { createConversation, getConversationSummary, sendMessage, updateConversation } from "../src/services/conversations";
import { getRun, waitForRun, cancelRun, activeRunForConversation } from "../src/runner/runner";
import { getAgent, updateAgent } from "../src/agents/service";
import { getSettings, updateSettings } from "../src/services/settings";
import { listAudit } from "../src/services/audit";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** SOI, APP0 (JFIF), SOF0 with the given size, EOI — enough for the header parser. */
function tinyJpeg(width: number, height: number): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]).toString("base64");
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                         */
/* ------------------------------------------------------------------ */

describe("key combos", () => {
  test("xdotool, browser and Mac spellings", () => {
    expect(parseKeyCombo("ctrl+s")).toEqual({ key: "s", modifiers: ["ctrl"] });
    expect(parseKeyCombo("Return")).toEqual({ key: "enter", modifiers: [] });
    expect(parseKeyCombo("cmd+shift+T")).toEqual({ key: "T", modifiers: ["cmd", "shift"] });
    expect(parseKeyCombo("super+Page_Down")).toEqual({ key: "pagedown", modifiers: ["cmd"] });
    expect(parseKeyCombo("ArrowLeft")).toEqual({ key: "left", modifiers: [] });
    expect(parseKeyCombo("option+KP_Enter")).toEqual({ key: "kpenter", modifiers: ["alt"] });
    expect(parseKeyCombo("cmd++")).toEqual({ key: "+", modifiers: ["cmd"] });
    expect(parseKeyCombo("ctrl+plus")).toEqual({ key: "+", modifiers: ["ctrl"] });
    expect(parseKeyCombo("shift")).toEqual({ key: "shift", modifiers: [] });
    expect(parseKeyCombo("F12")).toEqual({ key: "f12", modifiers: [] });
    expect(parseKeyCombo("KeyA")).toEqual({ key: "a", modifiers: [] });
  });

  test("sequences and errors", () => {
    expect(parseKeySequence("ctrl+a Delete")).toEqual([
      { key: "a", modifiers: ["ctrl"] },
      { key: "delete", modifiers: [] },
    ]);
    expect(() => parseKeyCombo("ctrl+a+b")).toThrow(KeyError);
    expect(() => parseKeyCombo("Hyperdrive")).toThrow(KeyError);
    expect(() => parseKeySequence("   ")).toThrow(KeyError);
  });
});

describe("screenshot geometry", () => {
  test("fits the model's limits without upscaling", () => {
    expect(fitSize(3024, 1964, 1280)).toEqual({ width: 1280, height: 831 });
    expect(fitSize(5120, 2880, 1280)).toEqual({ width: 1280, height: 720 });
    expect(fitSize(800, 600, 1280)).toEqual({ width: 800, height: 600 });
    const big = fitSize(4000, 4000, 1568);
    expect(big.width * big.height).toBeLessThanOrEqual(1_150_000);
  });

  test("maps image pixels to screen points and back (negative display origins)", () => {
    const shot = { width: 1280, height: 720, frame: { x: -508, y: -1440, width: 2560, height: 1440 } };
    expect(imageToFrame(shot, 640, 360)).toEqual({ x: 772, y: -720 });
    expect(frameToImage(shot, 772, -720)).toEqual({ x: 640, y: 360 });
    expect(inImage(shot, 1280, 720)).toBe(true);
    expect(inImage(shot, 1281, 10)).toBe(false);
    expect(regionToFrame(shot, [100, 100, 0, 0])).toEqual({ x: -508, y: -1440, width: 200, height: 200 });
    expect(unionRect([shot.frame, { x: 0, y: 0, width: 1512, height: 982 }])).toEqual({ x: -508, y: -1440, width: 2560, height: 2422 });
  });

  test("reads PNG and JPEG sizes", () => {
    expect(imageSize(PNG_1X1)).toEqual({ width: 1, height: 1, mime: "image/png" });
    expect(imageSize(tinyJpeg(1280, 831))).toEqual({ width: 1280, height: 831, mime: "image/jpeg" });
    expect(imageSize(Buffer.from("not an image").toString("base64"))).toBeNull();
  });
});

describe("targets", () => {
  test("parse and reject", () => {
    expect(parseComputerTarget({ kind: "desktop", extra: 1 })).toEqual({ kind: "desktop" });
    expect(parseComputerTarget({ kind: "window", windowId: 12, pid: 34, app: "Safari", title: "Apple" })).toEqual({
      kind: "window",
      windowId: 12,
      pid: 34,
      app: "Safari",
      title: "Apple",
      bundleId: null,
    });
    expect(parseComputerTarget({ kind: "window", windowId: 12, pid: 0 })).toBeNull();
    expect(parseComputerTarget({ kind: "tab", profileId: "bpr_1" })).toBeNull();
    expect(parseComputerTarget({ kind: "screen" })).toBeNull();
    expect(parseComputerTarget(null)).toBeNull();
  });

  test("agent defaults only keep the desktop or a display", () => {
    expect(normalizeAgentComputer({ enabled: true, target: { kind: "display", displayId: "5" } })).toEqual({ enabled: true, target: { kind: "display", displayId: "5" } });
    expect(normalizeAgentComputer({ enabled: true, target: { kind: "window", windowId: 1, pid: 2 } })).toEqual({ enabled: true, target: null });
    expect(normalizeAgentComputer({ enabled: "yes" })).toEqual({ enabled: false, target: null });
  });

  test("views, labels, locks", () => {
    const win: ComputerTarget = { kind: "window", windowId: 4711, pid: 812, app: "Notes", title: "Groceries" };
    expect(computerView(win)).toBe("window:812:4711");
    expect(computerView({ kind: "desktop" }, "5")).toBe("display:5");
    expect(computerTargetLabel(win)).toBe("Notes — Groceries");
    expect(sameComputerTarget(win, { ...win, title: "Renamed" })).toBe(true);
    expect(sameComputerTarget(win, { kind: "desktop" })).toBe(false);
    expect(sameComputerTarget(null, null)).toBe(true);
    expect(computerLockKey({ kind: "display", displayId: "1" })).toBe(computerLockKey({ kind: "desktop" }));
    expect(computerLockKey(win)).toBe("window:812:4711");
    expect(targetForView("window:812:4711")).toMatchObject({ kind: "window", pid: 812, windowId: 4711 });
    expect(targetForView("display:primary")).toEqual({ kind: "desktop" });
    expect(targetForView("tab:bpr_1:ABC:DEF")).toMatchObject({ kind: "tab", profileId: "bpr_1", targetId: "ABC:DEF" });
    expect(() => targetForView("screen:1")).toThrow();
  });

  test("engine key mappings", () => {
    // The names each platform's Cua Driver takes (0.33.1: platform-macos input/keyboard.rs key_name_to_code,
    // platform-windows input/keyboard.rs key_name_to_vk, platform-linux input/mod.rs key_name_to_keysym).
    const keys = ["enter", "kpenter", "backspace", "delete", "insert", "escape", "tab", "space", "left", "up", "home", "pagedown", "f1", "f12", "f13", "capslock", "volumeup", "a", "A", "7", "€", "/"];
    const table = (platform: NodeJS.Platform) => Object.fromEntries(keys.map((k) => [k, cuaKeyName(k, platform)]));
    const shared = { enter: "return", kpenter: "return", escape: "escape", tab: "tab", space: "space", left: "left", up: "up", home: "home", pagedown: "pagedown", f1: "f1", f12: "f12", f13: null, capslock: null, volumeup: null, a: "a", A: "a", "7": "7", "€": null, "/": null };
    expect(table("darwin")).toEqual({ ...shared, backspace: "delete", delete: "forward_delete", insert: null });
    for (const platform of ["win32", "linux"] as const) expect(table(platform)).toEqual({ ...shared, backspace: "backspace", delete: "delete", insert: "insert" });
    expect(["cmd", "ctrl", "alt", "shift"].map((m) => cuaModifier(m, "darwin"))).toEqual(["cmd", "ctrl", "option", "shift"]);
    expect(["cmd", "ctrl", "alt", "shift"].map((m) => cuaModifier(m, "win32"))).toEqual(["cmd", "ctrl", "alt", "shift"]);
    expect(["cmd", "ctrl", "alt", "shift"].map((m) => cuaModifier(m, "linux"))).toEqual(["super", "ctrl", "alt", "shift"]);
    expect(cdpKey("a", true)).toEqual({ key: "A", code: "KeyA", keyCode: 65, text: "A" });
    expect(cdpKey("enter", false).key).toBe("Enter");
    expect(cdpModifiers(["cmd", "shift"])).toBe(12);
    expect(cdpCommands({ key: "a", modifiers: ["cmd"] }, "darwin")).toEqual(["selectAll"]);
    expect(cdpCommands({ key: "z", modifiers: ["ctrl", "shift"] }, "linux")).toEqual(["redo"]);
    expect(cdpCommands({ key: "a", modifiers: ["ctrl"] }, "darwin")).toEqual([]);
    expect(scrubSummary('✅ Clicked.\n\n🪟 Action opened new window(s): Mail ("Inbox")')).toBe("✅ Clicked.");
  });
});

describe("desktop helpers for Windows and Linux", () => {
  test("xrandr monitors, including negative positions and the primary flag", () => {
    const out = "Monitors: 3\n 0: +*DP-1 2560/597x1440/336+0+0  DP-1\n 1: +HDMI-1 1920/527x1080/296+2560+180  HDMI-1\n 2: +eDP-1 1920/344x1200/215+-1920+0  eDP-1\n";
    expect(parseMonitors(out)).toEqual([
      { id: "DP-1", name: "DP-1", width: 2560, height: 1440, x: 0, y: 0, scale: 1, primary: true },
      { id: "HDMI-1", name: "HDMI-1", width: 1920, height: 1080, x: 2560, y: 180, scale: 1, primary: false },
      { id: "eDP-1", name: "eDP-1", width: 1920, height: 1200, x: -1920, y: 0, scale: 1, primary: false },
    ]);
    expect(parseMonitors("Monitors: 1\n 0: +VGA-0 1024/0x768/0+0+0  VGA-0")[0]!.primary).toBe(true);
  });

  test("xdotool commands", () => {
    expect(pointerArgs({ action: "click", x: 2600.4, y: 200, count: 2, modifiers: ["cmd", "shift"] })).toEqual([
      "keydown",
      "super+shift",
      "mousemove",
      "--sync",
      "2600",
      "200",
      "click",
      "--repeat",
      "2",
      "--delay",
      "80",
      "1",
      "keyup",
      "super+shift",
    ]);
    expect(pointerArgs({ action: "click", x: 1, y: 2, button: "right" }).slice(-1)).toEqual(["3"]);
    expect(pointerArgs({ action: "scroll", x: 5, y: 6, dy: 180, dx: -60 })).toEqual(["mousemove", "--sync", "5", "6", "click", "--repeat", "3", "--delay", "30", "5", "click", "--repeat", "1", "--delay", "30", "6"]);
    const drag = pointerArgs({ action: "drag", x: 0, y: 0, toX: 80, toY: 40 });
    expect(drag.slice(0, 7)).toEqual(["mousemove", "--sync", "0", "0", "mousedown", "1", "sleep"]);
    expect(drag.slice(-2)).toEqual(["mouseup", "1"]);
    expect(keysym("enter")).toBe("Return");
    expect(keysym("pagedown")).toBe("Next");
    expect(keysym("+")).toBe("plus");
    expect(keysym("f11")).toBe("F11");
    expect(keysym("€")).toBeNull();
  });

  test("the Windows host compiles one class and answers JSON lines", () => {
    expect(WINDOWS_HELPER_PS1).toContain("Add-Type -TypeDefinition $source");
    expect(WINDOWS_HELPER_PS1).toContain("[GodmodeComputer]::Handle($line)");
    expect(WINDOWS_HELPER_CS).toContain("public static string Handle(string line)");
    for (const cmd of ["displays", "capture", "pointer", "key", "type", "cursor", "permissions"]) expect(WINDOWS_HELPER_CS).toContain(`case "${cmd}"`);
    // Add-Type in Windows PowerShell 5.1 compiles C# 5: no string interpolation or null-conditional operators.
    expect(WINDOWS_HELPER_CS).not.toMatch(/\$"|\?\./);
  });
});

/* ------------------------------------------------------------------ */
/* MCP tools + runner (fake engines, no native dependencies)            */
/* ------------------------------------------------------------------ */

class FakeEngine implements ComputerEngine {
  readonly name = "fake";
  calls: { op: string; view?: string; p?: Point; to?: Point; opts?: unknown; text?: string; combos?: KeyCombo[] }[] = [];
  constructor(
    readonly target: ComputerTarget,
    private list: ViewInfo[],
  ) {}
  async views() {
    return this.list;
  }
  async capture(view: string, opts: CaptureOptions): Promise<Capture> {
    const v = this.list.find((x) => x.view === view) ?? this.list[0]!;
    const area = opts.region ?? v.frame;
    this.calls.push({ op: "capture", view, opts });
    return { data: PNG_1X1, mime: "image/png", width: Math.round(area.width / 2), height: Math.round(area.height / 2), frame: area, label: v.label };
  }
  async click(view: string, p: Point, opts: PointerOptions): Promise<Outcome> {
    this.calls.push({ op: "click", view, p, opts });
    return { detail: "Clicked" };
  }
  async move(view: string, p: Point): Promise<Outcome> {
    this.calls.push({ op: "move", view, p });
    return { detail: "Moved" };
  }
  async drag(view: string, from: Point, to: Point): Promise<Outcome> {
    this.calls.push({ op: "drag", view, p: from, to });
    return { detail: "Dragged" };
  }
  async scroll(view: string, p: Point | null, dx: number, dy: number): Promise<Outcome> {
    this.calls.push({ op: "scroll", view, p: p ?? undefined, opts: { dx, dy } });
    return { detail: "Scrolled" };
  }
  async keys(view: string, combos: KeyCombo[]): Promise<Outcome> {
    this.calls.push({ op: "keys", view, combos });
    return { detail: "Pressed" };
  }
  async type(view: string, text: string): Promise<Outcome> {
    this.calls.push({ op: "type", view, text });
    return { detail: `Typed ${text.length} characters` };
  }
  async elements(): Promise<{ elements: UiElement[]; note: string | null }> {
    return {
      elements: [{ token: "s1:2", role: "AXButton", label: "Save", value: null, actions: ["AXPress"], frame: { x: 150, y: 90, width: 100, height: 20 }, depth: 1 }],
      note: null,
    };
  }
  async clickElement(token: string, opts: PointerOptions): Promise<Outcome> {
    this.calls.push({ op: "clickElement", text: token, opts });
    return { detail: "Pressed Save" };
  }
  async dispose() {}
}

interface ToolResult {
  content: { type: string; text?: string; data?: string }[];
  isError?: boolean;
}

let env: TestEnv;
let agent: Agent;
let n = 0;

beforeAll(async () => {
  env = await setupEnv("godmode-computer-unit-");
  agent = await makeAgent({ name: "Computer Unit" });
});

afterAll(async () => {
  await env.close();
});

function share(target: ComputerTarget, views: ViewInfo[]) {
  const runId = `run_computer_unit_${++n}`;
  const rc = attachComputer(runId, agent.id, "cnv_computer_unit", target);
  const engine = new FakeEngine(target, views);
  rc.engine = engine;
  const token = issueRunToken({ runId, agentId: agent.id, conversationId: "cnv_computer_unit", workspaceId: null, depth: 0 });
  return { runId, token, engine };
}

async function rpc(token: string, method: string, params?: unknown) {
  const res = await fetch(`${env.baseUrl}/mcp/computer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } };
}

async function call(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await rpc(token, "tools/call", { name, arguments: args })).result as unknown as ToolResult;
}

const textOf = (r: ToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const toolNames = async (token: string) => ((await rpc(token, "tools/list")).result!.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[]);

const DISPLAYS: ViewInfo[] = [
  { view: "display:1", label: "Built-in Retina Display", frame: { x: 0, y: 0, width: 1512, height: 982 }, displayId: "1", primary: true },
  { view: "display:5", label: "Studio Display", frame: { x: -508, y: -1440, width: 2560, height: 1440 }, displayId: "5" },
];

const FAKE_CUA_DRIVER = join(import.meta.dir, "fixtures", "fake-cua-driver.ts");

describe("Cua Driver calls", () => {
  let state: string;
  const calls = () =>
    readFileSync(join(state, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((c) => c.name !== "set_agent_cursor_enabled");
  const win = { pid: 70, windowId: 7 };
  const target = { kind: "window", pid: 70, window_id: 7 };

  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), "godmode-fake-cua-"));
    updateSettings({ computer: { cuaDriverCommand: `'${process.execPath}' '${FAKE_CUA_DRIVER}' '${state}'` } });
  });

  afterEach(async () => {
    await stopCuaDriver();
    updateSettings({ computer: { cuaDriverCommand: "" } });
    rmSync(state, { recursive: true, force: true });
  });

  test("double and right clicks are click with a count / button; pixels follow the driver's last screenshot", async () => {
    const cua = await getCuaDriver();
    await cua.pointer("click", win, { x: 100, y: 50 }, { button: "left", count: 2, maxDimension: 1280 });
    await cua.pointer("click", win, { x: 100, y: 50 }, { button: "right", count: 1, maxDimension: 1280 });
    expect(calls()).toEqual([
      { name: "get_window_state", pid: 70, window_id: 7, include_accessibility_tree: false, max_image_dimension: 1280 },
      { name: "click", target, x: 200, y: 100, count: 2 },
      { name: "click", target, x: 200, y: 100, button: "right" },
    ]);

    // Reading the elements replaces the driver's snapshot of the window: pixels need a new screenshot first.
    await cua.windowState(70, 7, { screenshot: false, maxDimension: 0 });
    await cua.pointer("click", win, { x: 10, y: 10 }, { maxDimension: 1280 });
    expect(calls().slice(3)).toMatchObject([
      { name: "get_window_state", include_screenshot: false },
      { name: "get_window_state", include_accessibility_tree: false },
      { name: "click", target, x: 20, y: 20 },
    ]);

    const desktop = new CuaDesktopEngine({ kind: "desktop" });
    await desktop.click("display:primary", { x: 5, y: 6 }, { button: "left", count: 2, modifiers: [] });
    await desktop.click("display:primary", { x: 5, y: 6 }, { button: "right", count: 1, modifiers: [] });
    expect(calls().slice(-2)).toEqual([
      { name: "click", target: { kind: "desktop", display_id: "primary" }, x: 5, y: 6, count: 2, effective: { x: 5, y: 6 } },
      { name: "click", target: { kind: "desktop", display_id: "primary" }, x: 5, y: 6, button: "right", effective: { x: 5, y: 6 } },
    ]);
  });

  test("desktop actions land on the native pixel they aim at, whichever capture the driver took last", async () => {
    const desktop = new CuaDesktopEngine({ kind: "desktop" });
    const view = "display:primary";
    const pointer = { button: "left" as const, count: 1, modifiers: [] };

    // The model's screenshot: 1920×1080 downsized to 1280×720. Its frame is the native display.
    const shot = await desktop.capture(view, { maxEdge: 1280, purpose: "model" });
    expect([shot.width, shot.height, shot.frame]).toEqual([1280, 720, { x: 0, y: 0, width: 1920, height: 1080 }]);
    await desktop.click(view, { x: 960, y: 540 }, pointer);
    // The live view captured at another size in between.
    await desktop.capture(view, { maxEdge: 640, purpose: "live" });
    await desktop.move(view, { x: 100, y: 200 });
    await desktop.drag(view, { x: 10, y: 20 }, { x: 1910, y: 1070 }, pointer);
    await desktop.scroll(view, { x: 1500, y: 300 }, 0, 2);
    // A capture at full size: the driver scales nothing any more.
    await (await getCuaDriver()).desktopState(1920);
    await desktop.click(view, { x: 1919, y: 1079 }, pointer);

    // The driver's own 64 px look at the display size (a factor of 30), then clicks: whole pixels, none 1 px short
    // (123 ÷ 30 × 30 is 122.99999999999999, which Windows truncates to 122).
    const fresh = new CuaDesktopEngine({ kind: "desktop" });
    await fresh.views();
    await fresh.click(view, { x: 123, y: 245 }, pointer);
    await fresh.drag(view, { x: 246, y: 247 }, { x: 490, y: 492 }, pointer);

    const actions = calls().filter((c) => c.effective);
    expect(actions.map((c) => [c.name, c.effective])).toEqual([
      ["click", { x: 960, y: 540 }],
      ["move_cursor", { x: 100, y: 200 }],
      ["drag", { from_x: 10, from_y: 20, to_x: 1910, to_y: 1070 }],
      ["scroll", { x: 1500, y: 300 }],
      ["click", { x: 1919, y: 1079 }],
      ["click", { x: 123, y: 245 }],
      ["drag", { from_x: 246, from_y: 247, to_x: 490, to_y: 492 }],
    ]);
  });

  test("turned off while it starts: the driver that started is stopped, not used", async () => {
    writeFileSync(join(state, "init-delay-ms"), "300");
    const asked = getCuaDriver();
    await until(() => existsSync(join(state, "started")));
    updateSettings({ computer: { useCuaDriver: false } });
    try {
      await expect(asked).rejects.toMatchObject({ code: "unavailable", message: "Cua Driver is turned off in Settings → Computer." });
      expect(cuaDriverRunning()).toBeNull();
      const pid = Number(readFileSync(join(state, "started"), "utf8").trim());
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 5000, "the driver to exit");
    } finally {
      updateSettings({ computer: { useCuaDriver: true } });
    }
  });

  test("pixels the driver refuses for lack of a screenshot are sent once more, after a new screenshot", async () => {
    const cua = await getCuaDriver();
    await cua.windowShot(70, 7, 1280);
    /** The driver drops its screenshot of the window: it refuses the next `n` actions at pixels. */
    const refuse = (n: number) => writeFileSync(join(state, "refuse-pixels"), String(n));
    let seen = calls().length;
    const sent = () => {
      const names = calls().slice(seen).map((c) => c.name);
      seen += names.length;
      return names;
    };

    refuse(1);
    await cua.pointer("click", win, { x: 100, y: 50 }, { maxDimension: 1280 });
    expect(sent()).toEqual(["click", "get_window_state", "click"]);
    refuse(1);
    await cua.scroll(win, { x: 100, y: 50 }, "down", 3, { maxDimension: 1280 });
    expect(sent()).toEqual(["scroll", "get_window_state", "scroll"]);
    refuse(1);
    await cua.drag(win, { x: 10, y: 10 }, { x: 20, y: 20 }, { maxDimension: 1280 });
    expect(sent()).toEqual(["drag", "get_window_state", "drag"]);

    // Refused again after the new screenshot: the refusal is passed on, the action isn't sent a third time.
    refuse(2);
    await expect(cua.pointer("click", win, { x: 100, y: 50 }, { maxDimension: 1280 })).rejects.toMatchObject({ code: "screenshot_context_missing" });
    expect(sent()).toEqual(["click", "get_window_state", "click"]);
    expect(readFileSync(join(state, "refuse-pixels"), "utf8")).toBe("0");
  });
});

describe("computer MCP server", () => {
  test("rejects runs without a share and bad tokens", async () => {
    const res = await fetch(`${env.baseUrl}/mcp/computer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const token = issueRunToken({ runId: "run_nothing_shared", agentId: agent.id, conversationId: "c", workspaceId: null, depth: 0 });
    expect((await toolNames(token)).length).toBe(0);
    const r = await call(token, "computer", { action: "screenshot" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Nothing is shared");
    expect((await fetch(`${env.baseUrl}/mcp/computer`)).status).toBe(405);
  });

  test("tools depend on what is shared", async () => {
    const desktop = share({ kind: "desktop" }, DISPLAYS);
    const d = await toolNames(desktop.token);
    expect(d.map((t) => t.name)).toEqual(["computer", "computer_info", "computer_windows", "computer_open_app"]);
    expect(Object.keys(d[0]!.inputSchema.properties)).toContain("display");
    expect(Object.keys(d[0]!.inputSchema.properties)).not.toContain("element");

    const win = share({ kind: "window", windowId: 7, pid: 70, app: "Notes", title: "" }, [{ view: "window:70:7", label: "Notes", frame: { x: 100, y: 50, width: 1000, height: 500 } }]);
    const w = await toolNames(win.token);
    expect(w.map((t) => t.name)).toEqual(["computer", "computer_info", "computer_ui"]);
    expect(Object.keys(w[0]!.inputSchema.properties)).toContain("element");
    expect(Object.keys(w[0]!.inputSchema.properties)).not.toContain("foreground");

    const tab = share({ kind: "tab", profileId: "bpr_x", targetId: "T1", title: "Docs", url: "https://example.com" }, [
      { view: "tab:bpr_x:T1", label: "Docs", frame: { x: 0, y: 0, width: 1200, height: 800 } },
    ]);
    expect((await toolNames(tab.token)).map((t) => t.name)).toEqual(["computer", "computer_info"]);
    for (const s of [desktop, win, tab]) await detachComputer(s.runId);
  });

  test("desktop: per-display screenshots, coordinate mapping, action events", async () => {
    const { token, engine, runId } = share({ kind: "desktop" }, DISPLAYS);
    const early = await call(token, "computer", { action: "left_click", coordinate: [10, 10] });
    expect(early.isError).toBe(true);
    expect(textOf(early)).toContain("Take a screenshot first");

    const shot = await call(token, "computer", { action: "screenshot", display: "5" });
    expect(shot.isError).toBeFalsy();
    expect(shot.content[0]!.type).toBe("image");
    expect(textOf(shot)).toContain("Studio Display (1280×720 px)");

    const { events, stop } = captureEvents();
    const click = await call(token, "computer", { action: "double_click", coordinate: [640, 360], modifiers: "shift", screenshot: false });
    stop();
    expect(click.isError).toBeFalsy();
    const c = engine.calls.find((x) => x.op === "click")!;
    expect(c.view).toBe("display:5");
    expect(c.p).toEqual({ x: 772, y: -720 });
    expect(c.opts).toMatchObject({ button: "left", count: 2, modifiers: ["shift"] });
    const action = events.find((e): e is Extract<ServerEvent, { type: "computer.action" }> => e.type === "computer.action");
    expect(action).toMatchObject({ view: "display:5", action: "double_click", x: 0.5, y: 0.5 });

    // The next action without `display` stays on the display of the latest screenshot and returns a new one.
    const typed = await call(token, "computer", { action: "type", text: "hello" });
    expect(typed.content[0]!.type).toBe("image");
    expect(engine.calls.find((x) => x.op === "type")).toMatchObject({ view: "display:5", text: "hello" });

    const keys = await call(token, "computer", { action: "key", text: "cmd+shift+t Return", screenshot: false });
    expect(keys.isError).toBeFalsy();
    expect(engine.calls.find((x) => x.op === "keys")!.combos).toEqual([
      { key: "t", modifiers: ["cmd", "shift"] },
      { key: "enter", modifiers: [] },
    ]);

    const scroll = await call(token, "computer", { action: "scroll", coordinate: [0, 0], scroll_direction: "up", scroll_amount: 4, screenshot: false });
    expect(scroll.isError).toBeFalsy();
    expect(engine.calls.find((x) => x.op === "scroll")).toMatchObject({ p: { x: -508, y: -1440 }, opts: { dx: 0, dy: -4 } });

    const drag = await call(token, "computer", { action: "left_click_drag", start_coordinate: [0, 0], coordinate: [100, 50], screenshot: false });
    expect(drag.isError).toBeFalsy();
    expect(engine.calls.find((x) => x.op === "drag")).toMatchObject({ p: { x: -508, y: -1440 }, to: { x: -308, y: -1340 } });

    const zoom = await call(token, "computer", { action: "zoom", region: [0, 0, 320, 180] });
    expect(zoom.isError).toBeFalsy();
    const zoomCapture = engine.calls.filter((x) => x.op === "capture").pop()!;
    expect((zoomCapture.opts as CaptureOptions).region).toEqual({ x: -508, y: -1440, width: 640, height: 360 });

    expect(textOf(await call(token, "computer", { action: "left_click", coordinate: [5000, 5] }))).toContain("outside the screenshot");
    expect(textOf(await call(token, "computer", { action: "screenshot", display: "9" }))).toContain('No display "9"');
    expect(textOf(await call(token, "computer", { action: "key", text: "ctrl+warp" }))).toContain("Unknown key");
    expect(textOf(await call(token, "computer", { action: "left_click", element: "s1:2" }))).toContain("coordinate [x, y] is required");

    const info = textOf(await call(token, "computer_info", {}));
    expect(info).toContain("display 1: Built-in Retina Display, 1512×982 at (0, 0), primary");
    expect(info).toContain("display 5: Studio Display, 2560×1440 at (-508, -1440) ← your latest screenshot");
    await detachComputer(runId);
  });

  test("window: elements and element clicks", async () => {
    const { token, engine, runId } = share({ kind: "window", windowId: 7, pid: 70, app: "Notes", title: "" }, [
      { view: "window:70:7", label: "Notes", frame: { x: 100, y: 50, width: 1000, height: 500 } },
    ]);
    const ui = textOf(await call(token, "computer_ui", {}));
    // Frame center (200, 100) in points → (50, 25) in the 500×250 screenshot taken automatically.
    expect(ui).toContain('[s1:2] AXButton "Save" @(50, 25)');
    const press = await call(token, "computer", { action: "left_click", element: "s1:2", screenshot: false });
    expect(press.isError).toBeFalsy();
    expect(textOf(press)).toContain("Pressed Save");
    expect(engine.calls.find((x) => x.op === "clickElement")!.text).toBe("s1:2");
    await detachComputer(runId);
    const gone = await call(token, "computer", { action: "screenshot" });
    expect(textOf(gone)).toContain("Nothing is shared");
  });
});

describe("revoking access", () => {
  test("stopping a share ends waits and refuses queued actions", async () => {
    const { token, runId, engine } = share({ kind: "desktop" }, DISPLAYS);
    await call(token, "computer", { action: "screenshot" });
    const waiting = call(token, "computer", { action: "wait", duration: 20 });
    const queued = call(token, "computer", { action: "left_click", coordinate: [10, 10], screenshot: false });
    await Bun.sleep(150);
    const started = Date.now();
    await detachComputer(runId);
    const [w, q] = await Promise.all([waiting, queued]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(textOf(w)).toContain("stopped sharing");
    expect(q.isError).toBe(true);
    expect(engine.calls.some((c) => c.op === "click")).toBe(false);
  });

  test("turning an agent's unattended access off detaches only its agent-sourced runs", async () => {
    const a = attachComputer("run_agent_src", agent.id, "c1", { kind: "desktop" }, "agent");
    const b = attachComputer("run_share_src", agent.id, "c2", { kind: "desktop" }, "share");
    await detachAgentComputer(agent.id);
    expect(runComputer("run_agent_src")).toBeNull();
    expect(a.revoked).toBe(true);
    expect(runComputer("run_share_src")).toBe(b);
    await detachComputer("run_share_src");
  });

  test("Godmode's own windows and dashboard tabs are never shared", () => {
    expect(isGodmodeWindow({ pid: process.pid })).toBe(true);
    expect(isGodmodeWindow({ pid: process.ppid })).toBe(true);
    expect(isGodmodeWindow({ pid: 1, bundleId: "dev.codext.godmode" })).toBe(true);
    expect(isGodmodeWindow({ pid: 1, bundleId: "com.apple.Safari" })).toBe(false);
    expect(isGodmodeTab(`http://127.0.0.1:${config().port}/chat/x`)).toBe(true);
    expect(isGodmodeTab(`http://localhost:${config().port}/`)).toBe(true);
    expect(isGodmodeTab("https://example.com/")).toBe(false);
    expect(isGodmodeAppName("Godmode Bot")).toBe(true);
    expect(isGodmodeAppName("godmode.app")).toBe(true);
    expect(isGodmodeAppName("Safari")).toBe(false);
  });

  test("the agent can't open Godmode itself on a shared desktop", async () => {
    const { token, runId } = share({ kind: "desktop" }, DISPLAYS);
    const res = await call(token, "computer_open_app", { name: "Godmode Bot" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("off limits");
    await detachComputer(runId);
  });

  test("agents without computer access can't hand work to an agent that has it", async () => {
    const operator = await makeAgent({ name: "Desktop Operator" });
    await updateAgent(operator.id, { computer: { enabled: true, target: null } });
    const caller = await makeAgent({ name: "Plain Caller" });
    const ctx = { runId: "run_delegate_check", agentId: caller.id, conversationId: "c", workspaceId: null, depth: 0 };
    const res = await callTool(ctx, "agent_delegate", { agentId: operator.id, task: "click around", wait: false });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("can control this computer on its own");
  });
});

describe("runner integration", () => {
  test("a shared tab adds the computer server with the run's token", async () => {
    const conv = createConversation({ agentId: agent.id });
    updateConversation(conv.id, { computerTarget: { kind: "tab", profileId: "bpr_nope", targetId: "T9", title: "Docs", url: "https://example.com" } });
    expect(getConversationSummary(conv.id).computerTarget).toMatchObject({ kind: "tab", targetId: "T9" });
    const { run } = await sendMessage(conv.id, { content: "CALL_COMPUTER" });
    const done = await waitForRun(run.id, 20_000);
    expect(done.status).toBe("succeeded");
    const summary = JSON.parse(done.result!.replace(/^COMPUTER /, ""));
    expect(summary.server).toBe("computer");
    expect(summary.url).toEndWith("/mcp/computer");
    expect(summary.sameToken).toBe(true);
    expect(summary.tools).toEqual(["computer", "computer_info"]);
    expect(summary.info).toContain("isn't open anymore");
    const inv = invocations(env).filter((i) => i.prompt.includes("CALL_COMPUTER")).pop()!;
    expect(argValue(inv, "--append-system-prompt")).toContain("### Computer");
  });

  test("nothing shared, computer off → no computer server", async () => {
    const conv = createConversation({ agentId: agent.id });
    const r1 = await waitForRun((await sendMessage(conv.id, { content: "CALL_COMPUTER" })).run.id, 20_000);
    expect(r1.result).toBe("no computer server");

    updateConversation(conv.id, { computerTarget: { kind: "desktop" } });
    updateSettings({ computer: { enabled: false } });
    try {
      const r2 = await waitForRun((await sendMessage(conv.id, { content: "CALL_COMPUTER" })).run.id, 20_000);
      expect(r2.result).toBe("no computer server");
    } finally {
      updateSettings({ computer: { enabled: true } });
    }
  });

  test("agents allowed to use the computer get the desktop; desktop runs take turns", async () => {
    const worker = await makeAgent({ name: "Desktop Worker" });
    await updateAgent(worker.id, { computer: { enabled: true, target: null } });
    expect(getAgent(worker.id).computer).toEqual({ enabled: true, target: null });

    const a = createConversation({ agentId: worker.id });
    const b = createConversation({ agentId: worker.id });
    const first = await sendMessage(a.id, { content: "SLEEP" });
    await until(() => getRun(first.run.id).status === "running", 10_000, "first run to start");
    const second = await sendMessage(b.id, { content: "CALL_COMPUTER" });
    await Bun.sleep(500);
    expect(getRun(second.run.id).status).toBe("queued");
    await cancelRun(first.run.id);
    const done = await waitForRun(second.run.id, 20_000);
    expect(done.status).toBe("succeeded");
    const summary = JSON.parse(done.result!.replace(/^COMPUTER /, ""));
    expect(summary.tools).toEqual(["computer", "computer_info", "computer_windows", "computer_open_app"]);
    expect(activeRunForConversation(a.id)).toBeNull();
  });

  test("agents can't grant themselves computer access", async () => {
    const other = await makeAgent({ name: "Sneaky" });
    await updateAgent(other.id, { computer: { enabled: true } }, `agent:${agent.id}`);
    expect(getAgent(other.id).computer.enabled).toBe(false);
  });
});

describe("sharing through the API", () => {
  async function api(path: string, init: RequestInit = {}) {
    const token = (await import("../src/config")).config().token;
    return fetch(`${env.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    });
  }

  test("a missing tab can't be shared; stopping is audited", async () => {
    const conv = createConversation({ agentId: agent.id });
    const bad = await api(`/api/conversations/${conv.id}`, {
      method: "PATCH",
      body: JSON.stringify({ computerTarget: { kind: "tab", profileId: "bpr_missing", targetId: "X", title: "", url: "" } }),
    });
    expect([401, 404]).toContain(bad.status);
    if (bad.status === 401) return; // test env without an API token
    updateConversation(conv.id, { computerTarget: { kind: "desktop" } });
    const stop = await api(`/api/conversations/${conv.id}`, { method: "PATCH", body: JSON.stringify({ computerTarget: null }) });
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as { computerTarget: unknown }).computerTarget).toBeNull();
    expect(listAudit(20, "computer.unshare").some((a) => (a.details as { conversationId?: string }).conversationId === conv.id)).toBe(true);
  });

  test("settings have computer defaults", () => {
    expect(getSettings().computer).toMatchObject({ enabled: true, useCuaDriver: true, allowForeground: false, liveView: true, screenshotMaxSize: 1280 });
  });
});
