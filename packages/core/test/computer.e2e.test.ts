/**
 * End-to-end computer use on a real Mac: the `computer` MCP server (POST /mcp/computer) driving
 *  - a shared window in the background (a probe app built from fixtures/ProbeWindow.swift) — Cua Driver when it is
 *    installed, Godmode's native helper otherwise — without moving the human's cursor,
 *  - the whole desktop (every display: per-display screenshots, zoom),
 *  - a tab of a Godmode browser over CDP.
 * Needs macOS with Xcode Command Line Tools, Accessibility + Screen Recording for the terminal and Chrome, so it only
 * runs with GODMODE_E2E=1:
 *
 *   GODMODE_E2E=1 bun test test/computer.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerTarget } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import { issueRunToken } from "../src/mcp/tokens";
import { attachComputer, detachComputer } from "../src/computer/service";
import { getHelper, stopHelper } from "../src/computer/helper";
import { stopCuaDriver } from "../src/computer/cua";
import { findChrome } from "../src/browser/chrome";
import { getRunning } from "../src/browser/state";
import { attachToPage } from "../src/browser/cdp";
import * as manager from "../src/browser/manager";

const enabled = process.env.GODMODE_E2E === "1" && process.platform === "darwin" && existsSync("/usr/bin/xcrun");
const suite = enabled ? describe : describe.skip;

interface Probe {
  proc: ReturnType<typeof Bun.spawn>;
  windowId: number;
  pid: number;
  out: string;
}

async function launchProbe(dir: string): Promise<Probe> {
  const bin = join(dir, "probe");
  const build = Bun.spawnSync(["/usr/bin/xcrun", "swiftc", "-O", join(import.meta.dir, "fixtures/ProbeWindow.swift"), "-o", bin], { stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`probe build failed: ${build.stderr.toString()}`);
  const proc = Bun.spawn([bin], { stdout: "pipe", stderr: "ignore" });
  const probe: Probe = { proc, windowId: 0, pid: proc.pid, out: "" };
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) probe.out += dec.decode(chunk);
  })();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !/READY (\d+) (\d+)/.test(probe.out)) await Bun.sleep(50);
  const m = /READY (\d+) (\d+)/.exec(probe.out);
  if (!m) throw new Error("probe did not start");
  probe.windowId = Number(m[1]);
  probe.pid = Number(m[2]);
  return probe;
}

async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await Bun.sleep(50);
  }
  return fn();
}

interface ToolResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
}

suite("computer use (macOS e2e)", () => {
  let env: TestEnv;
  let dir: string;
  let probe: Probe;
  let agentId: string;
  let n = 0;

  beforeAll(async () => {
    env = await setupEnv("godmode-computer-");
    dir = mkdtempSync(join(tmpdir(), "godmode-probe-"));
    agentId = (await makeAgent({ name: "Computer E2E" })).id;
    probe = await launchProbe(dir);
    await Bun.sleep(500);
  }, 120_000);

  afterAll(async () => {
    probe?.proc.kill();
    await stopCuaDriver();
    await stopHelper();
    await env?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function share(target: ComputerTarget): { token: string; runId: string } {
    const runId = `run_computer_e2e_${++n}`;
    attachComputer(runId, agentId, "cnv_computer_e2e", target);
    return { runId, token: issueRunToken({ runId, agentId, conversationId: "cnv_computer_e2e", workspaceId: null, depth: 0 }) };
  }

  async function rpc(token: string, method: string, params?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${env.baseUrl}/mcp/computer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    return JSON.parse(text);
  }

  async function call(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const r = await rpc(token, "tools/call", { name, arguments: args });
    return r.result as ToolResult;
  }

  const textOf = (r: ToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const sizeOf = (r: ToolResult) => {
    const m = /\((\d+)×(\d+) px\)/.exec(textOf(r));
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  };

  test("window share: background clicks and typing, the human's cursor stays put", async () => {
    const { token, runId } = share({ kind: "window", windowId: probe.windowId, pid: probe.pid, app: "probe", title: "Godmode Probe" });
    const tools = ((await rpc(token, "tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["computer", "computer_ui", "computer_info"]));
    expect(tools).not.toContain("computer_windows");

    const helper = await getHelper();
    const cursorBefore = await helper.call<{ x: number; y: number }>("cursor");
    const win = (await helper.window(probe.windowId))!;

    const shot = await call(token, "computer", { action: "screenshot" });
    expect(shot.isError).toBeFalsy();
    expect(shot.content[0]!.type).toBe("image");
    const size = sizeOf(shot)!;
    expect(size.width).toBeGreaterThan(100);
    const toPx = (lx: number, ly: number): [number, number] => [Math.round((lx * size.width) / win.width), Math.round((ly * size.height) / win.height)];

    // Field center in window points: content is 360 high, field at y 290–318 from the bottom → 42–70 from the top.
    const titleBar = win.height - 360;
    const click = await call(token, "computer", { action: "left_click", coordinate: toPx(230, titleBar + 56), screenshot: false });
    expect(click.isError).toBeFalsy();
    const typed = await call(token, "computer", { action: "type", text: "hello bg", screenshot: false });
    expect(typed.isError).toBeFalsy();
    expect(await until(() => probe.out.includes("TEXT hello bg"))).toBe(true);
    const enter = await call(token, "computer", { action: "key", text: "Return", screenshot: false });
    expect(enter.isError).toBeFalsy();
    expect(await until(() => probe.out.includes("ENTER hello bg"))).toBe(true);

    // The button tracks the real mouse: pressed through accessibility (element token or AXPress fallback).
    const ui = await call(token, "computer_ui", {});
    const token_ = /\[(\S+)\] AXButton "Press me"/.exec(textOf(ui))?.[1];
    const press = token_
      ? await call(token, "computer", { action: "left_click", element: token_, screenshot: false })
      : await call(token, "computer", { action: "left_click", coordinate: toPx(110, titleBar + 360 - 246), screenshot: false });
    expect(press.isError).toBeFalsy();
    expect(await until(() => probe.out.includes("BUTTON_PRESSED"))).toBe(true);

    // Scroll the list (bottom 200 pt of the content) at its center.
    const scrolled = await call(token, "computer", { action: "scroll", coordinate: toPx(230, titleBar + 360 - 110), scroll_direction: "down", scroll_amount: 5, screenshot: false });
    expect(scrolled.isError).toBeFalsy();
    expect(await until(() => /SCROLL [1-9]/.test(probe.out))).toBe(true);

    // Tokens survive other actions in between (the engine re-finds the element when the driver's snapshot moved on).
    const field = /\[(\S+)\] AXTextField/.exec(textOf(ui))?.[1];
    if (field) {
      await call(token, "computer", { action: "screenshot" });
      const intoField = await call(token, "computer", { action: "type", element: field, text: " + element", screenshot: false });
      expect(intoField.isError).toBeFalsy();
      expect(await until(() => probe.out.includes("+ element"))).toBe(true);
    }

    // The human may be using the mouse meanwhile; what matters is that our clicks never moved it onto the window.
    const cursorAfter = await helper.call<{ x: number; y: number }>("cursor");
    const inWindow = (p: { x: number; y: number }) => p.x >= win.x && p.y >= win.y && p.x <= win.x + win.width && p.y <= win.y + win.height;
    if (!inWindow(cursorBefore)) expect(inWindow(cursorAfter)).toBe(false);
    await detachComputer(runId);
  }, 120_000);

  test("coordinates outside the screenshot and actions before a screenshot are refused", async () => {
    const { token, runId } = share({ kind: "window", windowId: probe.windowId, pid: probe.pid, app: "probe", title: "" });
    const early = await call(token, "computer", { action: "left_click", coordinate: [10, 10] });
    expect(early.isError).toBe(true);
    expect(textOf(early)).toContain("screenshot first");
    await call(token, "computer", { action: "screenshot" });
    const outside = await call(token, "computer", { action: "left_click", coordinate: [99_999, 5] });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toContain("outside the screenshot");
    await detachComputer(runId);
    const gone = await call(token, "computer", { action: "screenshot" });
    expect(gone.isError).toBe(true);
    expect(textOf(gone)).toContain("Nothing is shared");
  }, 60_000);

  test("desktop share: every display, zoom, windows", async () => {
    const { token, runId } = share({ kind: "desktop" });
    const tools = ((await rpc(token, "tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["computer", "computer_info", "computer_windows", "computer_open_app"]));
    const displays = await (await getHelper()).displays();
    const info = textOf(await call(token, "computer_info", {}));
    for (const d of displays) {
      expect(info).toContain(`display ${d.id}:`);
      const shot = await call(token, "computer", { action: "screenshot", display: String(d.id) });
      expect(shot.isError).toBeFalsy();
      const size = sizeOf(shot)!;
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1280);
      expect(size.width / size.height).toBeCloseTo(d.width / d.height, 1);
      const zoom = await call(token, "computer", { action: "zoom", region: [0, 0, Math.round(size.width / 4), Math.round(size.height / 4)] });
      expect(zoom.isError).toBeFalsy();
      expect(zoom.content[0]!.type).toBe("image");
    }
    const windows = textOf(await call(token, "computer_windows", {}));
    expect(windows).toContain(`${probe.windowId}: probe`);
    await detachComputer(runId);
  }, 120_000);

  test.skipIf(!findChrome())("tab share: a background tab over CDP", async () => {
    const profile = manager.createProfile({ name: "Computer E2E", workspaceId: null });
    await manager.launchBrowser(profile.id, { headless: true });
    const rb = getRunning(profile.id)!;
    const html = "<input id=i style='position:absolute;left:40px;top:60px;width:300px;height:30px'><h1 style='margin-top:120px'>Shared tab</h1>";
    const { targetId } = await rb.client.send<{ targetId: string }>("Target.createTarget", { url: `data:text/html,${encodeURIComponent(html)}` });
    await rb.client.send("Target.createTarget", { url: "about:blank" });
    await Bun.sleep(800);
    const { token, runId } = share({ kind: "tab", profileId: profile.id, targetId, title: "", url: "" });
    const shot = await call(token, "computer", { action: "screenshot" });
    expect(shot.isError).toBeFalsy();
    const size = sizeOf(shot)!;
    const page = await attachToPage(rb.client, targetId);
    const vw = await page.evaluate<number>("innerWidth");
    const px = (css: number) => Math.round((css * size.width) / vw);
    expect((await call(token, "computer", { action: "left_click", coordinate: [px(190), px(75)], screenshot: false })).isError).toBeFalsy();
    expect((await call(token, "computer", { action: "type", text: "typed in a background tab", screenshot: false })).isError).toBeFalsy();
    expect(await page.evaluate<string>("document.getElementById('i').value")).toBe("typed in a background tab");
    expect((await call(token, "computer", { action: "key", text: "cmd+a", screenshot: false })).isError).toBeFalsy();
    expect((await call(token, "computer", { action: "type", text: "replaced", screenshot: false })).isError).toBeFalsy();
    expect(await page.evaluate<string>("document.getElementById('i').value")).toBe("replaced");
    await page.detach();
    await detachComputer(runId);
    await manager.stopBrowser(profile.id);
  }, 120_000);
});
