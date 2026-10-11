/**
 * A phone's screen over adb: pictures (`screencap` raw RGBA, gzipped on the phone when it can, scaled down and encoded
 * here), touches and swipes (`input`), keys, typed text and the tree of what is on screen (`uiautomator dump`).
 * Coordinates are always the phone's own pixels in its current orientation; tools and the live view scale them.
 */
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { AndroidKey } from "@godmode/shared";
import { fitSize, MAX_MODEL_PIXELS } from "../computer/geometry";
import { encodePng, scaleDown, type Raster } from "../vm/raster";
import { AdbError, adb, deviceError, shellText, shq } from "./adb";

export interface Size {
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ */
/* Screen size                                                          */
/* ------------------------------------------------------------------ */

const sizes = new Map<string, { size: Size; at: number }>();

/** The screen as it is turned right now (cached briefly: rotating takes a moment anyway). */
export async function screenSize(serial: string, maxAgeMs = 2000): Promise<Size> {
  const cached = sizes.get(serial);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.size;
  const { out } = await shellText(serial, `dumpsys window displays 2>/dev/null | grep -m1 -o 'cur=[0-9]*x[0-9]*'; wm size`, { timeoutMs: 10_000 });
  const size = parseScreenSize(out);
  if (!size) throw new AdbError("Couldn't read the phone's screen size");
  sizes.set(serial, { size, at: Date.now() });
  return size;
}

export function parseScreenSize(out: string): Size | null {
  const cur = out.match(/cur=(\d+)x(\d+)/);
  if (cur) return { width: Number(cur[1]), height: Number(cur[2]) };
  const override = out.match(/Override size:\s*(\d+)x(\d+)/);
  const physical = out.match(/Physical size:\s*(\d+)x(\d+)/);
  const m = override ?? physical;
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * A point on a picture of the screen → the phone's pixel. The picture may be letterboxed (screenrecord keeps the
 * screen's proportions inside a video rounded to multiples of 16); points on the bars land on the nearest edge.
 */
export function frameToScreen(screen: Size, frame: Size, x: number, y: number): { x: number; y: number } {
  const scale = Math.min(frame.width / screen.width, frame.height / screen.height);
  const offX = (frame.width - screen.width * scale) / 2;
  const offY = (frame.height - screen.height * scale) / 2;
  const clamp = (v: number, max: number) => Math.min(max - 1, Math.max(0, v));
  return { x: clamp((x - offX) / scale, screen.width), y: clamp((y - offY) / scale, screen.height) };
}

export function rememberSize(serial: string, size: Size): void {
  sizes.set(serial, { size, at: Date.now() });
}

export function forgetSize(serial: string): void {
  sizes.delete(serial);
}

/** Pictures for the model: the long edge capped (settings), the area capped by what the model sees unscaled. */
export function modelSize(screen: Size, maxEdge: number): Size {
  return fitSize(screen.width, screen.height, maxEdge, MAX_MODEL_PIXELS);
}

/* ------------------------------------------------------------------ */
/* Screenshots                                                          */
/* ------------------------------------------------------------------ */

const gzipWorks = new Map<string, boolean>();

/** The raw framebuffer: `screencap` without -p is RGBA after a 12- or 16-byte header. */
export function parseRawScreencap(buf: Buffer): Raster {
  if (buf.length < 12) throw new AdbError("The phone sent no picture");
  const width = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  const format = buf.readUInt32LE(8);
  const pixels = width * height * 4;
  if (!width || !height || width > 10_000 || height > 10_000) throw new AdbError("The phone sent a picture Godmode can't read");
  const header = buf.length - pixels;
  if (header !== 12 && header !== 16) throw new AdbError(`The phone sent an incomplete picture (${buf.length} bytes for ${width}×${height})`);
  const data = new Uint8Array(buf.buffer, buf.byteOffset + header, pixels);
  // 1 = RGBA_8888, 2 = RGBX_8888, 5 = BGRA_8888.
  if (format === 5) {
    const swapped = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i += 4) {
      swapped[i] = data[i + 2]!;
      swapped[i + 1] = data[i + 1]!;
      swapped[i + 2] = data[i]!;
      swapped[i + 3] = 255;
    }
    return { width, height, data: swapped };
  }
  if (format !== 1 && format !== 2) throw new AdbError(`The phone's screen uses a pixel format Godmode doesn't know (${format})`);
  return { width, height, data };
}

/** What `screencap | gzip` sent: cut short when the phone or its cable went away meanwhile. */
export function unpackScreencap(buf: Buffer): Buffer {
  try {
    return gunzipSync(buf);
  } catch {
    throw new AdbError(`The phone sent an incomplete picture (${buf.length} bytes)`);
  }
}

export async function captureRaw(serial: string, signal?: AbortSignal): Promise<Raster> {
  const gzip = gzipWorks.get(serial) !== false;
  const res = await adb(["exec-out", gzip ? "screencap | gzip -1" : "screencap"], { serial, timeoutMs: 20_000, signal });
  if (res.code !== 0 || !res.stdout.length) {
    if (gzip && res.code !== null && !res.timedOut) {
      gzipWorks.set(serial, false);
      return captureRaw(serial, signal);
    }
    throw deviceError(res, "Taking a screenshot");
  }
  let buf = res.stdout;
  if (gzip) {
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      gzipWorks.set(serial, true);
      buf = unpackScreencap(buf);
    } else {
      gzipWorks.set(serial, false);
    }
  }
  const raster = parseRawScreencap(buf);
  rememberSize(serial, { width: raster.width, height: raster.height });
  return raster;
}

export interface PhoneShot {
  /** base64 PNG */
  data: string;
  width: number;
  height: number;
  /** The phone's screen in its own pixels. */
  screen: Size;
}

export async function screenshot(serial: string, maxEdge: number, opts: { level?: number; signal?: AbortSignal } = {}): Promise<PhoneShot> {
  const raw = await captureRaw(serial, opts.signal);
  const screen = { width: raw.width, height: raw.height };
  const size = modelSize(screen, maxEdge);
  const scaled = scaleDown(raw, size.width, size.height);
  return { data: encodePng(scaled, opts.level ?? 6).toString("base64"), width: scaled.width, height: scaled.height, screen };
}

/* ------------------------------------------------------------------ */
/* Input                                                                */
/* ------------------------------------------------------------------ */

async function input(serial: string, command: string, what: string, signal?: AbortSignal): Promise<void> {
  const res = await adb(["shell", command], { serial, timeoutMs: 20_000, signal });
  if (res.code !== 0) throw deviceError(res, what);
}

const px = (n: number) => Math.max(0, Math.round(n));

export function tap(serial: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
  return input(serial, `input tap ${px(x)} ${px(y)}`, "Tapping", signal);
}

export function longPress(serial: string, x: number, y: number, durationMs = 800, signal?: AbortSignal): Promise<void> {
  return input(serial, `input swipe ${px(x)} ${px(y)} ${px(x)} ${px(y)} ${Math.round(durationMs)}`, "Pressing", signal);
}

export function swipe(serial: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs = 300, signal?: AbortSignal): Promise<void> {
  return input(serial, `input swipe ${px(from.x)} ${px(from.y)} ${px(to.x)} ${px(to.y)} ${Math.max(10, Math.round(durationMs))}`, "Swiping", signal);
}

/** Keycodes (android.view.KeyEvent) of the keys the tools and the live view offer. */
const KEYCODES: Record<Exclude<AndroidKey, "notifications" | "quick_settings" | "select_all">, number> = {
  home: 3,
  back: 4,
  recents: 187,
  power: 26,
  wake: 224,
  sleep: 223,
  volume_up: 24,
  volume_down: 25,
  mute: 164,
  enter: 66,
  delete: 67,
  tab: 61,
  escape: 111,
  space: 62,
  menu: 82,
  search: 84,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  paste: 279,
  copy: 278,
  camera: 27,
  play_pause: 85,
};

export function keyCommand(key: AndroidKey | string): string | null {
  if (key === "notifications") return "cmd statusbar expand-notifications";
  if (key === "quick_settings") return "cmd statusbar expand-settings";
  if (key === "select_all") return "input keycombination 113 29";
  if (Object.hasOwn(KEYCODES, key)) return `input keyevent ${KEYCODES[key as keyof typeof KEYCODES]}`;
  if (/^KEYCODE_[A-Z0-9_]{1,40}$/.test(key)) return `input keyevent ${key}`;
  if (/^\d{1,3}$/.test(key)) return `input keyevent ${key}`;
  return null;
}

export async function pressKey(serial: string, key: AndroidKey | string, opts: { longpress?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const command = keyCommand(key);
  if (!command) throw new AdbError(`Unknown key "${key}"`);
  await input(serial, opts.longpress && command.startsWith("input keyevent ") ? command.replace("keyevent ", "keyevent --longpress ") : command, `Pressing ${key}`, opts.signal);
}

/** Characters `input text` can type (the phone's virtual keyboard map has no others). */
export const TYPABLE = /^[\x20-\x7e\n\t]*$/;

export function untypable(text: string): string[] {
  return [...new Set([...text].filter((c) => !/[\x20-\x7e\n\t]/.test(c)))];
}

/**
 * The shell commands that type `text`: `input text` per piece (it turns "%s" into a space, so a literal "%s" is typed
 * in two commands), Enter and Tab as keys.
 */
export function typeCommands(text: string, chunk = 400): string[] {
  const out: string[] = [];
  const pushText = (s: string) => {
    // Split between "%" and "s": no piece contains "%s", and no slice of a piece can.
    const parts = s.split("%s");
    const pieces = parts.map((p, i) => `${i > 0 ? "s" : ""}${p}${i < parts.length - 1 ? "%" : ""}`);
    for (const piece of pieces) {
      for (let i = 0; i < piece.length; i += chunk) out.push(`input text ${shq(piece.slice(i, i + chunk))}`);
    }
  };
  let buf = "";
  for (const ch of text) {
    if (ch === "\n" || ch === "\t") {
      if (buf) pushText(buf);
      buf = "";
      out.push(`input keyevent ${ch === "\n" ? 66 : 61}`);
    } else buf += ch;
  }
  if (buf) pushText(buf);
  return out;
}

/**
 * Type a saved secret: the commands go to the phone's shell on stdin, so the value isn't in any process's arguments on
 * this computer (on the phone, `input` still gets it as an argument — the shell user can see that, see tools.ts).
 */
export async function typeSecretText(serial: string, text: string, signal?: AbortSignal): Promise<void> {
  if (untypable(text).length || /[\n\t]/.test(text)) throw new AdbError("The value has characters adb can't type");
  const res = await adb(["shell"], { serial, stdin: `${typeCommands(text).join(" && ")} && exit 0 || exit 1\n`, timeoutMs: 30_000, signal });
  if (res.code !== 0) throw deviceError(res, "Typing");
}

export async function typeText(serial: string, text: string, signal?: AbortSignal): Promise<void> {
  const bad = untypable(text);
  if (bad.length) {
    throw new AdbError(
      `adb can only type plain ASCII; these characters can't be typed: ${bad.slice(0, 10).join(" ")}. Type the rest, and pick the others on the phone's keyboard with taps, or use text without them.`,
    );
  }
  // Several commands per shell call: one round trip, typed in order.
  const commands = typeCommands(text);
  for (let i = 0; i < commands.length; i += 8) {
    await input(serial, commands.slice(i, i + 8).join(" && "), "Typing", signal);
  }
}

/* ------------------------------------------------------------------ */
/* What is on screen                                                    */
/* ------------------------------------------------------------------ */

export interface UiNode {
  text: string;
  desc: string;
  id: string;
  cls: string;
  pkg: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  checkable: boolean;
  checked: boolean;
  enabled: boolean;
  focused: boolean;
  focusable: boolean;
  password: boolean;
  selected: boolean;
}

function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e === "amp") return "&";
    const code = e.startsWith("#x") || e.startsWith("#X") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
}

export function parseUiXml(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const m of xml.matchAll(/<node\s([^>]*?)\/?>/g)) {
    const attrs = new Map<string, string>();
    for (const a of m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs.set(a[1]!, decodeXml(a[2]!));
    const b = attrs.get("bounds")?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!b) continue;
    const flag = (k: string) => attrs.get(k) === "true";
    nodes.push({
      text: attrs.get("text") ?? "",
      desc: attrs.get("content-desc") ?? "",
      id: attrs.get("resource-id") ?? "",
      cls: attrs.get("class") ?? "",
      pkg: attrs.get("package") ?? "",
      bounds: { x1: Number(b[1]), y1: Number(b[2]), x2: Number(b[3]), y2: Number(b[4]) },
      clickable: flag("clickable"),
      longClickable: flag("long-clickable"),
      scrollable: flag("scrollable"),
      checkable: flag("checkable"),
      checked: flag("checked"),
      enabled: flag("enabled"),
      focused: flag("focused"),
      focusable: flag("focusable"),
      password: flag("password"),
      selected: flag("selected"),
    });
  }
  return nodes;
}

export async function uiNodes(serial: string, signal?: AbortSignal): Promise<UiNode[]> {
  // A fresh name each time: nothing else on the phone can prepare the file that is read back.
  const dump = `/data/local/tmp/godmode-ui-${randomBytes(6).toString("hex")}.xml`;
  const res = await adb(["shell", `uiautomator dump ${dump} >/dev/null 2>&1; cat ${dump} 2>/dev/null; rm -f ${dump}`], { serial, timeoutMs: 30_000, signal });
  const xml = res.stdout.toString("utf8");
  if (!xml.includes("<hierarchy")) {
    if (res.code !== 0 && !xml) throw deviceError(res, "Reading the screen");
    throw new AdbError("The phone couldn't describe its screen right now (it may still be animating). Take a screenshot instead, or try again in a moment.");
  }
  return parseUiXml(xml);
}

/** The node that has the keyboard focus (an input field), if any. */
export function focusedField(nodes: UiNode[]): UiNode | null {
  return nodes.filter((n) => n.focused).at(-1) ?? null;
}

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

export interface PhoneState {
  awake: boolean | null;
  battery: { level: number; charging: boolean } | null;
}

export function parseState(out: string): PhoneState {
  const wake = out.match(/mWakefulness=(\w+)/)?.[1] ?? out.match(/Display Power: state=(\w+)/)?.[1];
  const level = Number(out.match(/^\s*level:\s*(\d+)/m)?.[1]);
  const status = Number(out.match(/^\s*status:\s*(\d+)/m)?.[1]);
  const powered = /(AC|USB|Wireless|Dock) powered: true/.test(out);
  return {
    awake: wake ? wake === "Awake" || wake === "ON" : null,
    // BatteryManager: 2 = charging, 5 = full.
    battery: Number.isFinite(level) ? { level: Math.max(0, Math.min(100, level)), charging: status === 2 || (status === 5 && powered) } : null,
  };
}

export async function readState(serial: string): Promise<PhoneState> {
  const { out } = await shellText(serial, "dumpsys power | grep -m1 mWakefulness=; dumpsys battery | grep -E '^ *(level|status|AC powered|USB powered|Wireless powered|Dock powered):'", {
    timeoutMs: 10_000,
  });
  return parseState(out);
}
