import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Agent } from "@godmode/shared";
import { makeAgent, setupEnv, type TestEnv } from "./fixtures/runner-harness";
import * as vault from "../src/vault/vault";
import { getAgent, updateAgent } from "../src/agents/service";
import { createConversation, getConversationSummary } from "../src/services/conversations";
import { updateSettings } from "../src/services/settings";
import { issueRunToken, revokeRunToken } from "../src/mcp/tokens";
import { createCredential } from "../src/vault/credentials";
import { connectionOf, parseDevices } from "../src/android/adb";
import { runAndroidDeviceIds } from "../src/android/assignments";
import {
  androidStatus,
  assignDevice,
  attachAndroid,
  detachAndroid,
  execForHuman,
  forgetDevice,
  getDevice,
  listDevices,
  refreshDevices,
  serialOf,
  updateDevice,
} from "../src/android/service";
import { frameToScreen, parseRawScreencap, parseScreenSize, parseState, parseUiXml, typeCommands, untypable } from "../src/android/screen";
import { FrameAssembler, avcC, codecString, splitNals, videoSize } from "../src/android/stream";
import { forgetAndroidRun } from "../src/android/tools";
import { buildSystemPrompt } from "../src/runner/prompt";
import { getSettings } from "../src/services/settings";

const FAKE_ADB = resolve(import.meta.dir, "fixtures/fake-adb.ts");

let env: TestEnv;
let agent: Agent;
let dir: string;

const UI = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.shop" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
<node index="0" text="Sign in &amp; save" resource-id="com.example.shop:id/login" class="android.widget.Button" package="com.example.shop" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,2000][980,2200]" />
<node index="1" text="" resource-id="com.example.shop:id/password" class="android.widget.EditText" package="com.example.shop" content-desc="Password" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="FOCUSED" scrollable="false" long-clickable="true" password="PASSWORD" selected="false" bounds="[100,1600][980,1760]" />
</node></hierarchy>`;

function writeState(devices: string, phones: Record<string, unknown>) {
  writeFileSync(join(dir, "state.json"), JSON.stringify({ devices, phones }));
}

function calls(): { serial: string | null; args: string[]; stdin?: string }[] {
  try {
    return readFileSync(join(dir, "calls.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function clearCalls() {
  writeFileSync(join(dir, "calls.jsonl"), "");
}

const shellCalls = () => calls().filter((c) => c.args[0] === "shell").map((c) => c.stdin ?? c.args.slice(1).join(" "));

const PIXEL = { serialno: "R58M12ABCDE", manufacturer: "Google", model: "Pixel 8", release: "15", sdk: 35, width: 1080, height: 2400, ui: UI.replace('focused="FOCUSED"', 'focused="true"').replace('password="PASSWORD"', 'password="true"') };

beforeAll(async () => {
  env = await setupEnv("godmode-android-");
  await vault.setup("correct horse battery staple", false);
  dir = mkdtempSync(join(tmpdir(), "godmode-fake-adb-"));
  process.env.FAKE_ADB_DIR = dir;
  writeState("", {});
  updateSettings({ android: { adbPath: FAKE_ADB } });
  agent = await makeAgent({ name: "Phone Operator" });
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await env.close();
});

beforeEach(() => clearCalls());

describe("parsing", () => {
  test("adb devices -l", () => {
    const list = parseDevices(
      [
        "List of devices attached",
        "R58M12ABCDE            device usb:1-1 product:shiba model:Pixel_8 device:shiba transport_id:3",
        "192.168.1.20:5555      device product:shiba model:Pixel_8 device:shiba transport_id:4",
        "emulator-5554          offline",
        "XYZ                    unauthorized usb:1-2 transport_id:5",
        "ABC                    no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]",
      ].join("\n"),
    );
    expect(list.map((d) => [d.serial, d.state, d.connection])).toEqual([
      ["R58M12ABCDE", "device", "usb"],
      ["192.168.1.20:5555", "device", "wifi"],
      ["emulator-5554", "offline", "emulator"],
      ["XYZ", "unauthorized", "usb"],
      ["ABC", "no-permissions", "usb"],
    ]);
    expect(list[0]!.model).toBe("Pixel 8");
    expect(connectionOf("adb-R58M12ABCDE-AbCdEf._adb-tls-connect._tcp")).toBe("wifi");
  });

  test("screen size, state and the raw framebuffer", () => {
    expect(parseScreenSize("cur=1080x2400\nPhysical size: 1080x2400")).toEqual({ width: 1080, height: 2400 });
    expect(parseScreenSize("Physical size: 1080x2400\nOverride size: 720x1600")).toEqual({ width: 720, height: 1600 });
    expect(parseState("  mWakefulness=Asleep\n  status: 2\n  level: 15\n")).toEqual({ awake: false, battery: { level: 15, charging: true } });

    const raw = Buffer.alloc(16 + 2 * 1 * 4);
    raw.writeUInt32LE(2, 0);
    raw.writeUInt32LE(1, 4);
    raw.writeUInt32LE(5, 8);
    raw.set([10, 20, 30, 255, 1, 2, 3, 255], 16);
    // BGRA becomes RGBA.
    expect([...parseRawScreencap(raw).data]).toEqual([30, 20, 10, 255, 3, 2, 1, 255]);
    expect(() => parseRawScreencap(raw.subarray(0, 18))).toThrow(/incomplete/);
  });

  test("typing: quoting for the phone's shell, %s, Enter and Tab", () => {
    expect(typeCommands("it's 5%s\nok\tgo")).toEqual(["input text 'it'\\''s 5%'", "input text 's'", "input keyevent 66", "input text 'ok'", "input keyevent 61", "input text 'go'"]);
    expect(typeCommands("abcdef", 4)).toEqual(["input text 'abcd'", "input text 'ef'"]);
    expect(untypable("Grüße 👋")).toEqual(["ü", "ß", "👋"]);
  });

  test("the UI tree", () => {
    const nodes = parseUiXml(PIXEL.ui);
    expect(nodes).toHaveLength(3);
    expect(nodes[1]).toMatchObject({ text: "Sign in & save", clickable: true, bounds: { x1: 100, y1: 2000, x2: 980, y2: 2200 } });
    expect(nodes[2]).toMatchObject({ desc: "Password", focused: true, password: true });
  });

  test("H.264: NAL units, avcC and frames", () => {
    const sps = new Uint8Array([0x67, 0x42, 0xc0, 0x29, 0x8d]);
    const pps = new Uint8Array([0x68, 0xce, 0x01]);
    const idr = new Uint8Array([0x65, 0x88, 0x84]);
    const p = new Uint8Array([0x41, 0x9a, 0x02]);
    const stream = new Uint8Array([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 1, ...idr, 0, 0, 0, 1, ...p]);
    const { nals, rest } = splitNals(stream);
    expect(nals.map((n) => n[0])).toEqual([0x67, 0x68, 0x65]);
    expect([...rest]).toEqual([0, 0, 0, 1, ...p]);
    expect(codecString(sps)).toBe("avc1.42c029");
    expect([...avcC(sps, pps)]).toEqual([1, 0x42, 0xc0, 0x29, 0xff, 0xe1, 0, 5, ...sps, 1, 0, 3, ...pps]);

    const configs: string[] = [];
    const frames: { key: boolean; size: number }[] = [];
    const asm = new FrameAssembler(
      (c) => configs.push(c.codec),
      (f) => frames.push({ key: f.key, size: f.data.length }),
    );
    asm.push(p); // before any config or keyframe: dropped
    for (const n of nals) asm.push(n);
    asm.push(p);
    expect(configs).toEqual(["avc1.42c029"]);
    expect(frames).toEqual([
      { key: true, size: 4 + idr.length },
      { key: false, size: 4 + p.length },
    ]);
    expect(videoSize({ width: 1080, height: 2400 })).toEqual({ width: 576, height: 1280 });
  });

  test("points on a letterboxed video map to the phone's pixels", () => {
    // 1080×2340 in a 576×1280 video: 576/1080 scales the height to 1248, so 16 px bars top and bottom.
    const screen = { width: 1080, height: 2340 };
    expect(videoSize(screen)).toEqual({ width: 576, height: 1280 });
    const video = { width: 576, height: 1280 };
    expect(frameToScreen(screen, video, 288, 16)).toEqual({ x: 540, y: 0 });
    expect(frameToScreen(screen, video, 288, 640)).toEqual({ x: 540, y: 1170 });
    expect(frameToScreen(screen, video, 576, 1280)).toEqual({ x: 1079, y: 2339 });
    expect(frameToScreen(screen, screen, 10, 20)).toEqual({ x: 10, y: 20 });
  });
});

describe("phones", () => {
  test("found over adb; one record per phone across USB and Wi-Fi; emulators by AVD", async () => {
    writeState(
      "R58M12ABCDE device usb:1-1 model:Pixel_8\n192.168.1.20:5555 device model:Pixel_8\nemulator-5554 device model:sdk_gphone64_arm64\nXYZ unauthorized usb:1-2\n",
      {
        R58M12ABCDE: PIXEL,
        "192.168.1.20:5555": PIXEL,
        "emulator-5554": { serialno: "EMULATOR37X1X11X0", manufacturer: "Google", model: "sdk_gphone64_arm64", release: "15", sdk: 35, avd: "pixel_api35", width: 1080, height: 2400 },
      },
    );
    await refreshDevices({ startServer: true });
    const devices = listDevices();
    expect(devices.map((d) => [d.name, d.kind, d.state, d.connection, d.adbSerial])).toEqual([
      ["Google Pixel 8", "phone", "connected", "usb", "R58M12ABCDE"],
      ["pixel_api35 (emulator)", "emulator", "connected", "emulator", "emulator-5554"],
    ]);
    expect(devices[0]).toMatchObject({ serial: "R58M12ABCDE", androidVersion: "15", width: 1080, height: 2400, battery: { level: 81, charging: true }, awake: true });
    const status = await androidStatus();
    expect(status.adb).toMatchObject({ installed: true, version: "37.0.1", managed: false });
    expect(status.pending).toEqual([expect.objectContaining({ adbSerial: "XYZ", state: "unauthorized", hint: expect.stringContaining("Allow") })]);
  });

  test("a phone that goes away stays known; only an unplugged one can be forgotten", async () => {
    const pixel = listDevices().find((d) => d.serial === "R58M12ABCDE")!;
    updateDevice(pixel.id, { name: "  Shop phone ", description: "Signed in to the shop's TikTok" });
    expect(() => forgetDevice(pixel.id)).toThrow(/Unplug/);
    // Unplugged from USB: still reachable over Wi-Fi.
    writeState("192.168.1.20:5555 device\n", { "192.168.1.20:5555": PIXEL });
    await refreshDevices({ startServer: true });
    expect(getDevice(pixel.id)).toMatchObject({ name: "Shop phone", state: "connected", connection: "wifi", adbSerial: "192.168.1.20:5555" });
    writeState("", {});
    await refreshDevices({ startServer: true });
    expect(getDevice(pixel.id)).toMatchObject({ state: "disconnected", adbSerial: null, connection: null });
    expect(() => serialOf(pixel.id)).toThrow(/isn't connected/);
  });

  test("assignments: agents and chats, human only", async () => {
    writeState("R58M12ABCDE device\n", { R58M12ABCDE: PIXEL });
    await refreshDevices({ startServer: true });
    const pixel = listDevices().find((d) => d.serial === "R58M12ABCDE")!;
    const conv = createConversation({ agentId: agent.id, androidDeviceIds: [pixel.id, "adr_missing"] });
    expect(getConversationSummary(conv.id).androidDeviceIds).toEqual([pixel.id]);
    await assignDevice(pixel.id, { kind: "agent", id: agent.id, assigned: true });
    expect(getAgent(agent.id).androidDeviceIds).toEqual([pixel.id]);
    expect(runAndroidDeviceIds(conv.id, agent.id)).toEqual([pixel.id]);
    expect(getDevice(pixel.id).assignments.map((a) => a.kind).sort()).toEqual(["agent", "conversation"]);
    // An agent can't hand itself phones.
    const other = await makeAgent({ name: "Sneaky" });
    await updateAgent(other.id, { androidDeviceIds: [pixel.id] }, `agent:${other.id}`);
    expect(getAgent(other.id).androidDeviceIds).toEqual([]);
    await assignDevice(pixel.id, { kind: "agent", id: agent.id, assigned: false });
    expect(getAgent(agent.id).androidDeviceIds).toEqual([]);
  });

  test("the human's command", async () => {
    const pixel = listDevices().find((d) => d.serial === "R58M12ABCDE")!;
    expect(await execForHuman(pixel.id, { command: "echo hello" })).toMatchObject({ exitCode: 0, stdout: "hello\n", timedOut: false });
    expect(await execForHuman(pixel.id, { command: "exit 3" })).toMatchObject({ exitCode: 3 });
  });
});

describe("android MCP tools", () => {
  let pixelId: string;

  async function rpc(token: string, method: string, params?: unknown) {
    const res = await fetch(`${env.baseUrl}/mcp/android`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
    });
    return (await res.json()) as { result: { content: { type: string; text?: string }[]; isError?: boolean; tools?: { name: string }[] } };
  }

  async function call(token: string, name: string, args: Record<string, unknown> = {}) {
    const r = await rpc(token, "tools/call", { name, arguments: args });
    return { text: r.result.content.find((c) => c.type === "text")?.text ?? "", images: r.result.content.filter((c) => c.type === "image").length, isError: !!r.result.isError };
  }

  function runWith(ids: string[], who: Agent = agent) {
    const conv = createConversation({ agentId: who.id, androidDeviceIds: ids });
    const runId = `run_and_${Math.random().toString(36).slice(2)}`;
    attachAndroid(runId, ids, [dir]);
    const token = issueRunToken({ runId, agentId: who.id, conversationId: conv.id, workspaceId: null, depth: 0 });
    return { token, runId, done: () => (revokeRunToken(token), detachAndroid(runId), forgetAndroidRun(runId)) };
  }

  beforeAll(async () => {
    writeState("R58M12ABCDE device\nemulator-5554 device\n", {
      R58M12ABCDE: PIXEL,
      "emulator-5554": { serialno: "EMULATOR37X1X11X0", avd: "pixel_api35", model: "sdk_gphone64_arm64", release: "15", sdk: 35, width: 1080, height: 2400 },
    });
    await refreshDevices({ startServer: true });
    pixelId = listDevices().find((d) => d.serial === "R58M12ABCDE")!.id;
  });

  test("no phones, no tools; fills only when the human allowed them", async () => {
    const none = createConversation({ agentId: agent.id });
    const token = issueRunToken({ runId: "run_and_none", agentId: agent.id, conversationId: none.id, workspaceId: null, depth: 0 });
    expect((await rpc(token, "tools/list")).result.tools).toEqual([]);
    revokeRunToken(token);
    const run = runWith([pixelId]);
    try {
      const names = (await rpc(run.token, "tools/list")).result.tools!.map((t) => t.name);
      expect(names).toContain("tap");
      expect(names).toContain("ui_elements");
      expect(names).not.toContain("fill_login");
    } finally {
      run.done();
    }
  });

  test("screenshots and taps in screenshot pixels", async () => {
    const run = runWith([pixelId]);
    try {
      const shot = await call(run.token, "screenshot");
      expect(shot.images).toBe(1);
      expect(shot.text).toBe("Screenshot 576×1280 of Shop phone (screen 1080×2400 px).");
      clearCalls();
      const tap = await call(run.token, "tap", { coordinate: [288, 640], screenshot: false });
      expect(tap).toMatchObject({ text: "Tapped [288, 640]", isError: false });
      expect(shellCalls()).toContain("input tap 540 1200");
      expect((await call(run.token, "tap", { coordinate: [900, 100], screenshot: false })).text).toContain("outside the screenshot");
      clearCalls();
      await call(run.token, "scroll", { direction: "down", screenshot: false });
      expect(shellCalls().find((c) => c.startsWith("input swipe"))).toBe("input swipe 540 1920 540 480 350");
      clearCalls();
      await call(run.token, "scroll", { direction: "down", amount: 1, screenshot: false });
      expect(shellCalls().find((c) => c.startsWith("input swipe"))).toBe("input swipe 540 2112 540 288 350");
      clearCalls();
      await call(run.token, "press_key", { key: "Back", screenshot: false });
      expect(shellCalls()).toContain("input keyevent 4");
      expect((await call(run.token, "type_text", { text: "Grüße", screenshot: false })).text).toContain("only type plain ASCII");
      expect((await call(run.token, "open_app", { package: "com.x;rm -rf /" })).isError).toBe(true);
      clearCalls();
      expect((await call(run.token, "open_app", { package: "com.example.shop", screenshot: false })).text).toBe("Started com.example.shop");
      expect(shellCalls()).toContain("am start -n 'com.example.shop/.MainActivity$Launcher' -a android.intent.action.MAIN -c android.intent.category.LAUNCHER");
      expect((await call(run.token, "open_app", { package: "com.missing.app", screenshot: false })).text).toContain("Couldn't start com.missing.app");
    } finally {
      run.done();
    }
  });

  test("what is on screen, with coordinates to tap", async () => {
    const run = runWith([pixelId]);
    try {
      const ui = await call(run.token, "ui_elements");
      expect(ui.text).toContain("App: com.example.shop.");
      expect(ui.text).toContain('Button "Sign in & save" id=login at [288, 1120] (tap)');
      expect(ui.text).toContain('EditText desc="Password" id=password at [288, 896] (tap, long-press, input, focused, password)');
      const apps = await call(run.token, "list_apps", { filter: "musically" });
      expect(apps.text).toBe("1 app:\ncom.zhiliaoapp.musically");
    } finally {
      run.done();
    }
  });

  test("two phones: pick one by name", async () => {
    const emulator = listDevices().find((d) => d.kind === "emulator")!;
    const run = runWith([pixelId, emulator.id]);
    try {
      expect((await call(run.token, "screenshot")).text).toContain("Several phones are available");
      expect((await call(run.token, "screenshot", { device: "pixel_api35" })).text).toContain("of pixel_api35 (emulator)");
      expect((await call(run.token, "screenshot", { device: "shop" })).text).toContain("of Shop phone");
    } finally {
      run.done();
    }
  });

  test("saved logins: only for agents that may see them, into password fields only, never in the output", async () => {
    const login = createCredential({ name: "Shop", url: "https://shop.example.com", username: "owner@example.com", password: "s3cret-Pass!" });
    const revealer = await makeAgent({ name: "Revealer", permissions: { secretAccess: "reveal" } });
    const run = runWith([pixelId], revealer);
    const fillOnly = runWith([pixelId]);
    expect((await call(run.token, "fill_login", { credentialId: login.id, field: "password" })).text).toContain("turned off");
    updateSettings({ android: { vaultFill: true } });
    try {
      // The phone's shell can read what is typed: an agent that may only fill doesn't get the tools.
      expect((await rpc(fillOnly.token, "tools/list")).result.tools!.map((t) => t.name)).not.toContain("fill_login");
      expect((await call(fillOnly.token, "fill_login", { credentialId: login.id, field: "password" })).text).toContain("only types saved logins into a phone for agents that may see passwords");
      expect((await rpc(run.token, "tools/list")).result.tools!.map((t) => t.name)).toContain("fill_login");
      clearCalls();
      const filled = await call(run.token, "fill_login", { credentialId: login.id, field: "password" });
      expect(filled.isError).toBe(false);
      expect(filled.text).toContain('Typed the password of "Shop" into the password field of com.example.shop');
      // Typed through stdin: the password isn't in adb's arguments on this computer.
      expect(calls().some((c) => c.stdin?.startsWith("input text 's3cret-Pass!'"))).toBe(true);
      expect(calls().some((c) => c.args.join(" ").includes("s3cret"))).toBe(false);
      // Whatever a command prints afterwards, the password is masked.
      expect((await call(run.token, "shell", { command: "echo s3cret-Pass!" })).text).toBe("Exit code: 0\n••••••••");
      // Not a password field: refused.
      writeState("R58M12ABCDE device\n", { R58M12ABCDE: { ...PIXEL, ui: PIXEL.ui.replace('password="true"', 'password="false"') } });
      const refused = await call(run.token, "fill_login", { credentialId: login.id, field: "password" });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("isn't a password field");
    } finally {
      updateSettings({ android: { vaultFill: false } });
      writeState("R58M12ABCDE device\n", { R58M12ABCDE: PIXEL });
      run.done();
      fillOnly.done();
    }
  });

  test("files from the phone: one at a time, into the run's folders", async () => {
    const run = runWith([pixelId]);
    try {
      expect((await call(run.token, "pull_file", { remote_path: "/sdcard/DCIM" })).text).toContain("is a folder");
      expect((await call(run.token, "pull_file", { remote_path: "/sdcard/missing.jpg" })).text).toContain("No such file");
      const pulled = await call(run.token, "pull_file", { remote_path: "/sdcard/Download/a.txt", local_path: join(dir, "a.txt") });
      expect(pulled.text).toBe(`Copied /sdcard/Download/a.txt from Shop phone to ${realpathSync(dir)}/a.txt.`);
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toStartWith("pulled /sdcard/Download/a.txt");
      expect((await call(run.token, "pull_file", { remote_path: "/sdcard/Download/a.txt", local_path: "/etc/a.txt" })).text).toContain("outside the folders");
    } finally {
      run.done();
    }
  });

  test("a manager gives phones to other agents, never to itself", async () => {
    const boss = await makeAgent({ name: "Boss", permissions: { canManageAgents: true } });
    const conv = createConversation({ agentId: boss.id });
    const token = issueRunToken({ runId: "run_and_boss", agentId: boss.id, conversationId: conv.id, workspaceId: null, depth: 0 });
    const gateway = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${env.baseUrl}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const r = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
      return { text: r.result.content[0]!.text, isError: !!r.result.isError };
    };
    try {
      const self = await gateway("android_assign", { deviceId: pixelId, agentId: boss.id });
      expect(self.isError).toBe(true);
      expect(self.text).toContain("can't give yourself a phone");
      expect(getAgent(boss.id).androidDeviceIds).toEqual([]);
      const worker = await makeAgent({ name: "Phone Worker" });
      expect((await gateway("android_assign", { deviceId: pixelId, agentId: worker.id })).isError).toBe(false);
      expect(getAgent(worker.id).androidDeviceIds).toEqual([pixelId]);
      expect((await gateway("android_devices_list", {})).text).toContain('"name": "Shop phone"');
    } finally {
      revokeRunToken(token);
    }
  });

  test("a phone that is gone is a clear error", async () => {
    const run = runWith([pixelId]);
    try {
      writeState("", {});
      await refreshDevices({ startServer: true });
      const res = await call(run.token, "screenshot");
      expect(res.isError).toBe(true);
      expect(res.text).toContain("isn't connected");
    } finally {
      writeState("R58M12ABCDE device\n", { R58M12ABCDE: PIXEL });
      await refreshDevices({ startServer: true });
      run.done();
    }
  });

  test("the system prompt describes the phones", () => {
    const prompt = buildSystemPrompt({
      agent: getAgent(agent.id),
      settings: getSettings(),
      peers: [],
      browserAvailable: false,
      android: [{ id: pixelId, name: "Shop phone", summary: "Google Pixel 8, Android 15", description: "Signed in to TikTok", connected: true }],
      androidVaultFill: false,
    });
    expect(prompt).toContain("### Android phones");
    expect(prompt).toContain(`**Shop phone** (id \`${pixelId}\`): Google Pixel 8, Android 15 — Signed in to TikTok`);
    expect(prompt).toContain("Godmode doesn't type saved logins or 2FA codes into phones");
  });
});
