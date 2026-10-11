/**
 * The `android` MCP server (POST /mcp/android, per-run bearer token): see and control the Android phones a run may use
 * — its chat's and its agent's, re-read on every call so a phone taken away stops working at once. Screenshots, taps,
 * swipes, keys, typed text, the list of what is on screen, apps, `adb shell`, files, and (when the human allowed it)
 * saved logins and 2FA codes typed by Godmode. Coordinates are pixels of the run's latest screenshot of that phone.
 */
import { basename, dirname, join, posix } from "node:path";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ANDROID_KEYS } from "@godmode/shared";
import { getAgent } from "../agents/service";
import { chatFillOnly } from "../services/conversations";
import { bus } from "../events/bus";
import { logger } from "../log";
import { audit } from "../services/audit";
import { getSettings } from "../services/settings";
import type { RunContext } from "../types";
import { HttpError, sleep } from "../util";
import { credentialsForAgent, getCredential, markCredentialUsed, revealForAgent } from "../vault/credentials";
import { codeForAgent, totpForAgent } from "../vault/totp";
import { RemoteFileError } from "../ssh/client";
import { localPath } from "../ssh/tools";
import { AdbError, adb, adbErrorText, shq } from "./adb";
import { runAndroidDeviceIds } from "./assignments";
import { androidRun, ensureConnected, noticeFailure, promptDevices, type PromptAndroidDevice } from "./service";
import { focusedField, longPress, modelSize, pressKey, screenSize, screenshot, swipe, tap, typeSecretText, typeText, uiNodes, untypable, type Size, type UiNode } from "./screen";

const log = logger("android");

export interface AndroidToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

const MAX_OUTPUT = 30_000;
const SETTLE_MS = 700;

export const ANDROID_INSTRUCTIONS =
  "Tools for the Android phones this task may use: screenshots, taps, swipes, keys and typing, the list of what is on screen, apps, adb shell commands and files. " +
  "Coordinates are pixels of your latest screenshot of that phone. Pass `device` (its name or id) when more than one phone is available.";

const VAULT_FILL_OFF =
  'Typing saved logins and 2FA codes into phones is turned off. Ask the human to turn on "Logins and 2FA codes" in Settings → Android phones, then try again.';
const FILL_NEEDS_REVEAL =
  "Godmode only types saved logins into a phone for agents that may see passwords: the phone's shell can read what is typed. Ask the human to sign in on the phone (they can do it in the live view).";

/**
 * Typing a secret on a phone is as good as showing it: `input` gets it as an argument, which the phone's shell user —
 * the one the `shell` tool runs as — can read. So only runs that may reveal secrets get the fills.
 */
function mayFill(ctx: { agentId: string; conversationId: string | null }): boolean {
  if (!getSettings().android.vaultFill) return false;
  const agent = getAgent(ctx.agentId);
  return agent.permissions.secretAccess === "reveal" && !(ctx.conversationId && chatFillOnly(ctx.conversationId));
}

function text(t: string, isError = false): AndroidToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function clip(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = Math.floor(max / 3);
  return `${s.slice(0, head)}\n\n… [${(s.length - max).toLocaleString("en-US")} characters omitted] …\n\n${s.slice(-(max - head))}`;
}

/* ------------------------------------------------------------------ */
/* Per-run state                                                        */
/* ------------------------------------------------------------------ */

/** The latest screenshot each run took of each phone: coordinates map back through it. */
const shots = new Map<string, { width: number; height: number; screen: Size }>();
/** Secrets Godmode typed in a run: masked in everything the run's phone tools return. */
const typedSecrets = new Map<string, Set<string>>();

const shotKey = (runId: string, deviceId: string) => `${runId}:${deviceId}`;

function maxEdge(): number {
  return getSettings().computer.screenshotMaxSize || 1280;
}

function mask(runId: string, s: string): string {
  const secrets = typedSecrets.get(runId);
  if (!secrets) return s;
  let out = s;
  for (const secret of secrets) if (secret.length >= 4 && out.includes(secret)) out = out.split(secret).join("••••••••");
  return out;
}

function remember(runId: string, secret: string) {
  const set = typedSecrets.get(runId) ?? new Set<string>();
  set.add(secret);
  typedSecrets.set(runId, set);
}

export function forgetAndroidRun(runId: string): void {
  typedSecrets.delete(runId);
  for (const key of [...shots.keys()]) if (key.startsWith(`${runId}:`)) shots.delete(key);
}

/* ------------------------------------------------------------------ */
/* Tools                                                                */
/* ------------------------------------------------------------------ */

interface ToolEnv {
  device: PromptAndroidDevice;
  serial: string;
  runId: string;
  agentId: string;
  conversationId: string | null;
  folders: string[];
  signal?: AbortSignal;
}

interface AndroidTool {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (args: never, env: ToolEnv) => Promise<AndroidToolResult>;
}

function defineTool<S extends z.ZodType>(def: { name: string; description: string; schema: S; run: (args: z.infer<S>, env: ToolEnv) => Promise<AndroidToolResult> }): AndroidTool {
  return def as unknown as AndroidTool;
}

const deviceArg = z.string().max(200).optional().describe("Phone name or id (optional when only one phone is available)");
const coordinate = z.tuple([z.number(), z.number()]);
const afterArg = z.boolean().optional().describe("Return a new screenshot after the action (default true)");

async function takeShot(env: ToolEnv, note?: string): Promise<AndroidToolResult> {
  const shot = await screenshot(env.serial, maxEdge(), { signal: env.signal });
  shots.set(shotKey(env.runId, env.device.id), { width: shot.width, height: shot.height, screen: shot.screen });
  return {
    content: [
      { type: "text", text: `${note ? `${note}. ` : ""}Screenshot ${shot.width}×${shot.height} of ${env.device.name} (screen ${shot.screen.width}×${shot.screen.height} px).` },
      { type: "image", data: shot.data, mimeType: "image/png" },
    ],
  };
}

async function after(env: ToolEnv, note: string, want: boolean | undefined): Promise<AndroidToolResult> {
  if (want === false) return text(note);
  await sleep(SETTLE_MS);
  return takeShot(env, note);
}

/** Screenshot pixels → the phone's own pixels. Without a screenshot yet, the size one would have. */
async function toScreen(env: ToolEnv, c: [number, number], what: string): Promise<{ x: number; y: number; screen: Size }> {
  const screen = await screenSize(env.serial);
  let shot = shots.get(shotKey(env.runId, env.device.id));
  const portrait = (s: Size) => s.height >= s.width;
  if (shot && portrait(shot.screen) !== portrait(screen)) {
    throw new AdbError(`The phone turned since your last screenshot (now ${screen.width}×${screen.height}). Take a new screenshot and use its coordinates.`);
  }
  shot ??= { ...modelSize(screen, maxEdge()), screen };
  const [x, y] = c;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= shot.width || y >= shot.height) {
    throw new AdbError(`${what} [${x}, ${y}] is outside the screenshot (${shot.width}×${shot.height}).`);
  }
  return { x: (x * screen.width) / shot.width, y: (y * screen.height) / shot.height, screen };
}

function ripple(env: ToolEnv, action: string, p?: { x: number; y: number; screen: Size }, to?: { x: number; y: number }) {
  bus.emit({
    type: "android.action",
    deviceId: env.device.id,
    runId: env.runId,
    action,
    ...(p ? { x: p.x / p.screen.width, y: p.y / p.screen.height } : {}),
    ...(p && to ? { toX: to.x / p.screen.width, toY: to.y / p.screen.height } : {}),
  });
}

function shortClass(cls: string): string {
  return cls.split(".").at(-1) ?? cls;
}

/** What on screen is worth naming: text, a description, an id, or something to tap, type into or scroll. */
function describeNodes(nodes: UiNode[], toShot: (x: number, y: number) => [number, number], filter?: string): string {
  const want = filter?.trim().toLowerCase();
  const lines: string[] = [];
  let i = 0;
  for (const n of nodes) {
    const editable = /EditText|AutoCompleteTextView/.test(n.cls);
    const interesting = n.text || n.desc || n.clickable || n.scrollable || n.checkable || editable || n.focused;
    if (!interesting) continue;
    const { x1, y1, x2, y2 } = n.bounds;
    if (x2 <= x1 || y2 <= y1) continue;
    const label = [n.text && JSON.stringify(n.text.slice(0, 120)), n.desc && n.desc !== n.text && `desc=${JSON.stringify(n.desc.slice(0, 120))}`, n.id && `id=${n.id.replace(/^[\w.]+:id\//, "")}`]
      .filter(Boolean)
      .join(" ");
    if (want && !`${label} ${n.cls}`.toLowerCase().includes(want)) continue;
    const flags = [
      n.clickable && "tap",
      n.longClickable && "long-press",
      editable && "input",
      n.scrollable && "scroll",
      n.checkable && (n.checked ? "checked" : "unchecked"),
      n.selected && "selected",
      n.focused && "focused",
      n.password && "password",
      !n.enabled && "disabled",
    ].filter(Boolean);
    const [cx, cy] = toShot((x1 + x2) / 2, (y1 + y2) / 2);
    lines.push(`${++i}. ${shortClass(n.cls)} ${label || "(no text)"} at [${cx}, ${cy}]${flags.length ? ` (${flags.join(", ")})` : ""}`);
    if (lines.length >= 250) {
      lines.push("… more elements; pass `filter` to narrow down.");
      break;
    }
  }
  return lines.join("\n");
}

const LIST_TOOL = {
  name: "list_devices",
  description: "The Android phones this task may use: name, id, model, Android version, whether it is connected, and what it is for.",
  schema: z.object({}),
};

const TOOLS: AndroidTool[] = [
  defineTool({
    name: "screenshot",
    description: "See a phone's screen. Coordinates in the other tools are pixels of the latest screenshot. Take one first, and again whenever the screen may have changed.",
    schema: z.object({ device: deviceArg }),
    run: (_args, env) => takeShot(env),
  }),
  defineTool({
    name: "tap",
    description: "Tap a point on the phone's screen ([x, y] in pixels of your latest screenshot). Returns a new screenshot.",
    schema: z.object({ device: deviceArg, coordinate: coordinate.describe("[x, y] in pixels of your latest screenshot"), screenshot: afterArg }),
    run: async (args, env) => {
      const p = await toScreen(env, args.coordinate, "The point");
      ripple(env, "tap", p);
      await tap(env.serial, p.x, p.y, env.signal);
      return after(env, `Tapped [${args.coordinate.join(", ")}]`, args.screenshot);
    },
  }),
  defineTool({
    name: "long_press",
    description: "Touch and hold a point (context menus, dragging icons, selecting text).",
    schema: z.object({
      device: deviceArg,
      coordinate: coordinate.describe("[x, y] in pixels of your latest screenshot"),
      duration_ms: z.number().int().min(300).max(10_000).optional().describe("How long to hold (default 800)"),
      screenshot: afterArg,
    }),
    run: async (args, env) => {
      const p = await toScreen(env, args.coordinate, "The point");
      ripple(env, "long_press", p);
      await longPress(env.serial, p.x, p.y, args.duration_ms ?? 800, env.signal);
      return after(env, `Pressed [${args.coordinate.join(", ")}] for ${args.duration_ms ?? 800} ms`, args.screenshot);
    },
  }),
  defineTool({
    name: "swipe",
    description: "Swipe from one point to another (drag, pull down, swipe between pages). For scrolling a list, `scroll` is simpler.",
    schema: z.object({
      device: deviceArg,
      start_coordinate: coordinate.describe("Where the finger goes down"),
      coordinate: coordinate.describe("Where it lifts"),
      duration_ms: z.number().int().min(10).max(10_000).optional().describe("Default 300; longer = slower drag"),
      screenshot: afterArg,
    }),
    run: async (args, env) => {
      const from = await toScreen(env, args.start_coordinate, "The start");
      const to = await toScreen(env, args.coordinate, "The end");
      ripple(env, "swipe", from, to);
      await swipe(env.serial, from, to, args.duration_ms ?? 300, env.signal);
      return after(env, `Swiped from [${args.start_coordinate.join(", ")}] to [${args.coordinate.join(", ")}]`, args.screenshot);
    },
  }),
  defineTool({
    name: "scroll",
    description: "Scroll the screen (or the list under `coordinate`): direction is where the content moves into view, e.g. down = see what is below.",
    schema: z.object({
      device: deviceArg,
      direction: z.enum(["up", "down", "left", "right"]),
      coordinate: coordinate.optional().describe("A point inside the list to scroll (default: the middle of the screen)"),
      amount: z.number().min(0.1).max(1).optional().describe("Fraction of the screen to scroll (default 0.6)"),
      screenshot: afterArg,
    }),
    run: async (args, env) => {
      const screen = await screenSize(env.serial);
      const center = args.coordinate ? await toScreen(env, args.coordinate, "The point") : { x: screen.width / 2, y: screen.height / 2, screen };
      const amount = args.amount ?? 0.6;
      const dx = args.direction === "left" ? 1 : args.direction === "right" ? -1 : 0;
      const dy = args.direction === "up" ? 1 : args.direction === "down" ? -1 : 0;
      const half = { x: (screen.width * amount) / 2, y: (screen.height * amount) / 2 };
      // Swipes that start or end at an edge are system gestures (home, back, notifications): stay clear of them.
      const clampX = (v: number) => Math.min(screen.width * 0.9, Math.max(screen.width * 0.1, v));
      const clampY = (v: number) => Math.min(screen.height * 0.88, Math.max(screen.height * 0.12, v));
      const from = { x: clampX(center.x - dx * half.x), y: clampY(center.y - dy * half.y), screen };
      const to = { x: clampX(center.x + dx * half.x), y: clampY(center.y + dy * half.y) };
      ripple(env, "swipe", from, to);
      await swipe(env.serial, from, to, 350, env.signal);
      return after(env, `Scrolled ${args.direction}`, args.screenshot);
    },
  }),
  defineTool({
    name: "type_text",
    description:
      "Type text into the focused field (tap it first). Plain ASCII only — adb can't type other characters (ä, é, emoji); pick those on the phone's keyboard. " +
      "submit: true presses Enter afterwards. Never type passwords or 2FA codes with it — use fill_login / fill_totp.",
    schema: z.object({ device: deviceArg, text: z.string().min(1).max(10_000), submit: z.boolean().optional(), screenshot: afterArg }),
    run: async (args, env) => {
      const bad = untypable(args.text);
      if (bad.length) return text(`adb can only type plain ASCII; these characters can't be typed: ${bad.slice(0, 12).join(" ")}. Type the rest, and tap the others on the phone's keyboard.`, true);
      ripple(env, "type");
      await typeText(env.serial, args.text, env.signal);
      if (args.submit) await pressKey(env.serial, "enter", { signal: env.signal });
      return after(env, `Typed ${args.text.length} character${args.text.length === 1 ? "" : "s"}${args.submit ? " and pressed Enter" : ""}`, args.screenshot);
    },
  }),
  defineTool({
    name: "press_key",
    description: `Press a key or button: ${ANDROID_KEYS.join(", ")} — or any KEYCODE_… name. long: true holds it (e.g. power for the power menu).`,
    schema: z.object({
      device: deviceArg,
      key: z.string().min(1).max(60).describe('e.g. "back", "home", "enter", "recents", "wake", "notifications", "KEYCODE_MEDIA_NEXT"'),
      long: z.boolean().optional(),
      screenshot: afterArg,
    }),
    run: async (args, env) => {
      const key = args.key.trim().toLowerCase().replace(/[\s-]+/g, "_");
      const name = /^keycode_/.test(key) ? key.toUpperCase() : key;
      ripple(env, "key");
      await pressKey(env.serial, name, { longpress: args.long, signal: env.signal });
      return after(env, `Pressed ${args.key}${args.long ? " (held)" : ""}`, args.screenshot);
    },
  }),
  defineTool({
    name: "ui_elements",
    description:
      "List what is on the phone's screen right now — texts, buttons, input fields, lists — with the [x, y] to tap each, in pixels of a screenshot. " +
      "Faster to act on than guessing from a picture; filter narrows the list by text, id or type. Some apps (games, video, maps) show little here: use screenshots there.",
    schema: z.object({ device: deviceArg, filter: z.string().max(200).optional() }),
    run: async (args, env) => {
      const nodes = await uiNodes(env.serial, env.signal);
      const screen = await screenSize(env.serial, 0);
      const shot = shots.get(shotKey(env.runId, env.device.id));
      const size = shot && shot.screen.width === screen.width && shot.screen.height === screen.height ? shot : modelSize(screen, maxEdge());
      if (!shot || shot.width !== size.width) shots.set(shotKey(env.runId, env.device.id), { width: size.width, height: size.height, screen });
      const toShot = (x: number, y: number): [number, number] => [Math.round((x * size.width) / screen.width), Math.round((y * size.height) / screen.height)];
      const listing = describeNodes(nodes, toShot, args.filter);
      const app = nodes.find((n) => n.pkg)?.pkg;
      return text(`${app ? `App: ${app}. ` : ""}Coordinates are pixels of a ${size.width}×${size.height} screenshot.\n${listing || (args.filter ? `Nothing matches "${args.filter}".` : "Nothing to list — take a screenshot.")}`);
    },
  }),
  defineTool({
    name: "open_app",
    description: "Start an app by its package name (from list_apps), or open a link / deep link (a web URL opens in the phone's browser, an app link in its app).",
    schema: z.object({
      device: deviceArg,
      package: z.string().max(200).optional().describe('e.g. "com.android.settings"'),
      url: z.string().max(4000).optional().describe('e.g. "https://example.com" or "myapp://screen"'),
      screenshot: afterArg,
    }),
    run: async (args, env) => {
      if (!args.package === !args.url) return text("Pass either package or url.", true);
      if (args.url) {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(args.url)) return text("url must start with a scheme, e.g. https:// or myapp://", true);
        const res = await adb(["shell", `am start -a android.intent.action.VIEW -d ${shq(args.url)}`], { serial: env.serial, timeoutMs: 30_000, signal: env.signal });
        const out = `${res.stdout.toString("utf8")}\n${res.stderr}`;
        if (res.code !== 0 || /^Error|unable to resolve/im.test(out)) return text(`Couldn't open the link: ${adbErrorText(res)}`, true);
      } else {
        const pkg = args.package!;
        if (!/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(pkg)) return text(`"${pkg}" isn't a package name (like com.example.app).`, true);
        // The app's launcher activity, started like a tap on its icon (monkey aborts on phones without hardware keys).
        const resolved = await adb(["shell", `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${pkg}`], {
          serial: env.serial,
          timeoutMs: 20_000,
          signal: env.signal,
        });
        const component = resolved.stdout.toString("utf8").trim().split(/\r?\n/).at(-1)?.trim() ?? "";
        const res = /^[\w.]+\/[\w.$]+$/.test(component)
          ? await adb(["shell", `am start -n ${shq(component)} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER`], { serial: env.serial, timeoutMs: 30_000, signal: env.signal })
          : await adb(["shell", `monkey --pct-syskeys 0 -p ${pkg} -c android.intent.category.LAUNCHER 1`], { serial: env.serial, timeoutMs: 30_000, signal: env.signal });
        const out = `${res.stdout.toString("utf8")}\n${res.stderr}`;
        if (res.code !== 0 || /No activities found|^Error|does not exist/im.test(out)) {
          return text(`Couldn't start ${pkg}: is it installed? Check with list_apps.${component === "No activity found" ? " It has no launcher icon." : ""}`, true);
        }
      }
      await sleep(800);
      return after(env, args.package ? `Started ${args.package}` : `Opened ${args.url}`, args.screenshot);
    },
  }),
  defineTool({
    name: "list_apps",
    description: "Installed apps (package names). By default the ones the user installed; include_system lists all.",
    schema: z.object({ device: deviceArg, filter: z.string().max(100).optional(), include_system: z.boolean().optional() }),
    run: async (args, env) => {
      const res = await adb(["shell", `pm list packages${args.include_system ? "" : " -3"}`], { serial: env.serial, timeoutMs: 30_000, signal: env.signal });
      if (res.code !== 0) return text(`Couldn't list apps: ${adbErrorText(res)}`, true);
      const want = args.filter?.toLowerCase();
      const names = res.stdout
        .toString("utf8")
        .split(/\r?\n/)
        .map((l) => l.replace(/^package:/, "").trim())
        .filter((p) => p && (!want || p.toLowerCase().includes(want)))
        .sort();
      return text(names.length ? `${names.length} app${names.length === 1 ? "" : "s"}:\n${names.join("\n")}` : "No apps match.");
    },
  }),
  defineTool({
    name: "shell",
    description:
      "Run a command in the phone's shell (adb shell, as the shell user — no root). Useful: am / pm / cmd / settings / dumpsys / input / getprop, files under /sdcard. " +
      "Commands must not wait for input. Returns the exit code and output.",
    schema: z.object({
      device: deviceArg,
      command: z.string().min(1).max(100_000),
      timeout_seconds: z.number().int().min(1).max(600).optional().describe("Default 60"),
    }),
    run: async (args, env) => {
      const res = await adb(["shell", args.command], { serial: env.serial, timeoutMs: (args.timeout_seconds ?? 60) * 1000, signal: env.signal, maxOutput: 2_000_000 });
      const stdout = res.stdout.toString("utf8");
      const status = res.timedOut ? `Timed out after ${args.timeout_seconds ?? 60} s.` : res.cancelled ? "Cancelled." : `Exit code: ${res.code}`;
      const parts = [status];
      if (stdout.trim()) parts.push(clip(stdout.replace(/\s+$/, "")));
      if (res.stderr.trim()) parts.push(`[stderr]\n${clip(res.stderr.replace(/\s+$/, ""), MAX_OUTPUT / 2)}`);
      if (!stdout.trim() && !res.stderr.trim()) parts.push("(no output)");
      return text(parts.join("\n"), res.timedOut || res.cancelled || res.code !== 0);
    },
  }),
  defineTool({
    name: "install_apk",
    description: "Install (or update) an app from an .apk file on this computer. local_path must be in your working directory, your repository or the other folders of this run.",
    schema: z.object({ device: deviceArg, local_path: z.string().min(1).max(4096) }),
    run: async (args, env) => {
      const local = localPath(args.local_path, env.folders, "read");
      if (!statSync(local).isFile() || !/\.apk$/i.test(local)) return text(`${args.local_path} isn't an .apk file.`, true);
      audit(`agent:${env.agentId}`, "android.install", env.device.id, { runId: env.runId, file: basename(local) });
      const res = await adb(["install", "-r", local], { serial: env.serial, timeoutMs: 10 * 60_000, signal: env.signal });
      const out = res.stdout.toString("utf8");
      if (res.code !== 0 || !/Success/.test(out)) return text(`Install failed: ${adbErrorText(res) || out.trim()}`, true);
      return text(`Installed ${basename(local)} on ${env.device.name}.`);
    },
  }),
  defineTool({
    name: "push_file",
    description: "Copy a file from this computer to the phone (e.g. a photo or video into /sdcard/DCIM or /sdcard/Download). Media copied to /sdcard shows up in the gallery after a moment.",
    schema: z.object({
      device: deviceArg,
      local_path: z.string().min(1).max(4096).describe("File on this computer (relative to your working directory, or absolute)"),
      remote_path: z.string().max(4096).optional().describe("Where on the phone (default /sdcard/Download/<name>)"),
    }),
    run: async (args, env) => {
      const local = localPath(args.local_path, env.folders, "read");
      if (!statSync(local).isFile()) return text(`${args.local_path} isn't a file.`, true);
      let remote = args.remote_path?.trim() || `/sdcard/Download/${basename(local)}`;
      if (remote.endsWith("/")) remote = posix.join(remote, basename(local));
      const res = await adb(["push", local, remote], { serial: env.serial, timeoutMs: 10 * 60_000, signal: env.signal });
      if (res.code !== 0) return text(`Copying failed: ${adbErrorText(res)}`, true);
      // Let the gallery see new media right away.
      if (/^\/(sdcard|storage)\//.test(remote)) {
        await adb(["shell", `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shq(`file://${remote}`)} >/dev/null 2>&1`], { serial: env.serial, timeoutMs: 15_000 }).catch(() => undefined);
      }
      return text(`Copied ${basename(local)} to ${remote} on ${env.device.name}.`);
    },
  }),
  defineTool({
    name: "pull_file",
    description: "Copy a file from the phone to this computer. local_path defaults to workspace/downloads/<name> in your repository.",
    schema: z.object({
      device: deviceArg,
      remote_path: z.string().min(1).max(4096).describe("File on the phone, e.g. /sdcard/DCIM/Camera/IMG_1.jpg"),
      local_path: z.string().max(4096).optional(),
    }),
    run: async (args, env) => {
      const kind = await adb(["shell", `if [ -d ${shq(args.remote_path)} ]; then echo dir; elif [ -e ${shq(args.remote_path)} ]; then echo file; else echo none; fi`], {
        serial: env.serial,
        timeoutMs: 15_000,
        signal: env.signal,
      });
      const what = kind.stdout.toString("utf8").trim();
      if (what === "dir") return text(`${args.remote_path} is a folder. Copy files one at a time (pack a folder with tar on the phone first).`, true);
      if (what === "none") return text(`No such file on ${env.device.name}: ${args.remote_path}`, true);
      const name = posix.basename(args.remote_path.replace(/\/+$/, "")) || "download";
      const target = args.local_path?.trim() || join(getAgent(env.agentId).repoPath, "workspace", "downloads", name);
      let local = localPath(target, env.folders, "write");
      if (existsSync(local) && statSync(local).isDirectory()) local = localPath(join(local, name), env.folders, "write");
      mkdirSync(dirname(local), { recursive: true });
      const partial = join(dirname(local), `.${basename(local)}.${randomBytes(4).toString("hex")}.part`);
      try {
        const res = await adb(["pull", args.remote_path, partial], { serial: env.serial, timeoutMs: 10 * 60_000, signal: env.signal });
        if (res.code !== 0) return text(`Copying failed: ${adbErrorText(res)}`, true);
        renameSync(partial, local);
      } finally {
        rmSync(partial, { force: true, recursive: true });
      }
      return text(`Copied ${args.remote_path} from ${env.device.name} to ${local}.`);
    },
  }),
  defineTool({
    name: "fill_login",
    description:
      "Type the username or password of a saved login (id from vault_list_logins) into the focused field on the phone — Godmode types it, you never see it. " +
      "Tap the field first or pass its coordinate. Passwords only go into password fields. Godmode can't tell which app a field belongs to: only fill a login in its own app or site.",
    schema: z.object({
      device: deviceArg,
      credentialId: z.string().describe("Login id from vault_list_logins"),
      field: z.enum(["username", "password"]),
      coordinate: coordinate.optional().describe("Tap this field first"),
      submit: z.boolean().optional().describe("Press Enter afterwards"),
    }),
    run: async (args, env) => {
      if (!getSettings().android.vaultFill) return text(VAULT_FILL_OFF, true);
      if (!mayFill(env)) return text(FILL_NEEDS_REVEAL, true);
      const agent = getAgent(env.agentId);
      const secret = revealForAgent(agent, args.credentialId);
      const value = args.field === "username" ? secret.username : secret.password;
      if (!value) return text(`This login has no ${args.field} saved. Call report_missing_login (kind "invalid_credential") so the human can complete it.`, true);
      if (untypable(value).length || /[\n\t]/.test(value)) return text(`The ${args.field} has characters adb can't type (only plain ASCII). Ask the human to sign in on the phone themselves.`, true);
      const login = getCredential(args.credentialId);
      const record = (ok: boolean, more: Record<string, unknown> = {}) =>
        audit(`agent:${agent.id}`, "credential.fill", args.credentialId, { field: args.field, runId: env.runId, deviceId: env.device.id, ok, ...more });
      if (args.coordinate) {
        const p = await toScreen(env, args.coordinate, "The field");
        await tap(env.serial, p.x, p.y, env.signal);
        await sleep(500);
      }
      const field = focusedField(await uiNodes(env.serial, env.signal));
      if (!field) {
        record(false, { error: "no_field" });
        return text("No input field has the focus. Tap the field (or pass its coordinate) and try again.", true);
      }
      if (args.field === "password" && !field.password) {
        record(false, { error: "not_password", pkg: field.pkg });
        return text("The focused field isn't a password field, so Godmode didn't type the password there. Tap the password field and try again.", true);
      }
      remember(env.runId, value);
      ripple(env, "type");
      try {
        await typeSecretText(env.serial, value, env.signal);
        if (args.field === "password") {
          // Focus may have moved while typing: take the password back out of whatever field got it.
          const now = focusedField(await uiNodes(env.serial, env.signal).catch(() => []));
          if (!now?.password) {
            await adb(["shell", `input keyevent ${Array.from({ length: value.length }, () => "67").join(" ")}`], { serial: env.serial, timeoutMs: 30_000 }).catch(() => undefined);
            record(false, { error: "focus_moved", pkg: field.pkg });
            return text("The focus left the password field while Godmode was typing, so what was typed was erased again. Tap the password field and try again.", true);
          }
        }
        if (args.submit) await pressKey(env.serial, "enter", { signal: env.signal });
      } catch (err) {
        record(false, { error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      record(true, { pkg: field.pkg });
      markCredentialUsed(args.credentialId);
      return after(env, `Typed the ${args.field} of "${login.name}" into ${args.field === "password" ? "the password field" : "the focused field"} of ${field.pkg || "the app"}${args.submit ? " and pressed Enter" : ""}`, true);
    },
  }),
  defineTool({
    name: "fill_totp",
    description:
      "Type the current 2FA (authenticator) code into the focused field on the phone — Godmode types it, you never see it. Pass the login's credentialId (its linked 2FA is used) or a totpId. Tap the code field first or pass its coordinate.",
    schema: z.object({
      device: deviceArg,
      credentialId: z.string().optional(),
      totpId: z.string().optional(),
      coordinate: coordinate.optional(),
      submit: z.boolean().optional(),
    }),
    run: async (args, env) => {
      if (!getSettings().android.vaultFill) return text(VAULT_FILL_OFF, true);
      if (!mayFill(env)) return text(FILL_NEEDS_REVEAL, true);
      const agent = getAgent(env.agentId);
      let id = args.totpId ?? null;
      if (args.credentialId) {
        const login = credentialsForAgent(agent).find((c) => c.id === args.credentialId);
        if (!login) return text(`Login ${args.credentialId} is not available to you.`, true);
        id ??= login.totpId ?? totpForAgent(agent).find((t) => t.credentialId === login.id)?.id ?? null;
        if (!id) return text(`No 2FA code is linked to "${login.name}". Call report_missing_login with kind "missing_totp" so the human can add it, then continue with other work.`, true);
      }
      if (!id) return text("Pass credentialId or totpId.", true);
      const entry = totpForAgent(agent).find((t) => t.id === id);
      if (!entry) return text(`2FA entry ${id} is not available to you.`, true);
      if (args.coordinate) {
        const p = await toScreen(env, args.coordinate, "The field");
        await tap(env.serial, p.x, p.y, env.signal);
        await sleep(500);
      }
      let code = codeForAgent(agent, id);
      if (code.remaining < 3) {
        await sleep(code.remaining * 1000 + 300);
        code = codeForAgent(agent, id);
      }
      const meta = { field: "totp", runId: env.runId, deviceId: env.device.id, credentialId: args.credentialId ?? null };
      remember(env.runId, code.code);
      try {
        await typeSecretText(env.serial, code.code, env.signal);
        if (args.submit) await pressKey(env.serial, "enter", { signal: env.signal });
      } catch (err) {
        audit(`agent:${agent.id}`, "totp.fill", id, { ...meta, ok: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      audit(`agent:${agent.id}`, "totp.fill", id, { ...meta, ok: true });
      return after(env, `Typed the current 2FA code of "${entry.issuer || entry.accountName}"${args.submit ? " and pressed Enter" : ""}`, true);
    },
  }),
];

/* ------------------------------------------------------------------ */
/* Server                                                               */
/* ------------------------------------------------------------------ */

const schemaCache = new Map<string, Record<string, unknown>>();

function jsonSchema(name: string, schema: z.ZodType): Record<string, unknown> {
  let s = schemaCache.get(name);
  if (!s) {
    s = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete s.$schema;
    schemaCache.set(name, s);
  }
  return s;
}

function devicesOf(ctx: RunContext): PromptAndroidDevice[] {
  return promptDevices(runAndroidDeviceIds(ctx.conversationId, ctx.agentId));
}

export function listAndroidTools(ctx: RunContext): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  if (!androidRun(ctx.runId)) return [];
  const fill = mayFill(ctx);
  return [LIST_TOOL, ...TOOLS.filter((t) => fill || !t.name.startsWith("fill_"))].map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t.name, t.schema) }));
}

export class UnknownAndroidToolError extends Error {}

function pickDevice(devices: PromptAndroidDevice[], wanted: string | undefined): PromptAndroidDevice | string {
  const names = devices.map((d) => `"${d.name}"`).join(", ");
  if (!devices.length) return "No Android phones are available to this task anymore — the human removed them.";
  const key = wanted?.trim();
  if (!key) return devices.length === 1 ? devices[0]! : `Several phones are available (${names}): pass device.`;
  const byId = devices.find((d) => d.id === key);
  if (byId) return byId;
  const k = key.toLowerCase();
  for (const matches of [(d: PromptAndroidDevice) => d.name.toLowerCase() === k, (d: PromptAndroidDevice) => d.name.toLowerCase().startsWith(k) || d.summary.toLowerCase().includes(k)]) {
    const found = devices.filter(matches);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) return `"${key}" matches several phones (${found.map((d) => `"${d.name}" = ${d.id}`).join(", ")}): pass the id.`;
  }
  return `No phone "${key}" is available to this task. Available: ${names}.`;
}

function describeDevices(devices: PromptAndroidDevice[]): string {
  return JSON.stringify(
    devices.map((d) => ({ name: d.name, id: d.id, phone: d.summary, connected: d.connected, description: d.description || null })),
    null,
    2,
  );
}

const audited = new Set<string>();

export async function callAndroidTool(ctx: RunContext, name: string, args: unknown): Promise<AndroidToolResult> {
  const run = androidRun(ctx.runId);
  if (!run) return text("This run has no Android phones.", true);
  const devices = devicesOf(ctx);
  if (name === LIST_TOOL.name) return devices.length ? text(describeDevices(devices)) : text("No Android phones are available to this task anymore.", true);
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new UnknownAndroidToolError(`Unknown tool: ${name}`);
  let label = name;
  try {
    const parsed = tool.schema.parse(args ?? {}) as { device?: string };
    const device = pickDevice(devices, parsed.device);
    if (typeof device === "string") return text(device, true);
    label = `${name} on ${device.name}`;
    let serial: string;
    try {
      serial = await ensureConnected(device.id);
    } catch (err) {
      return text(`${err instanceof Error ? err.message : String(err)} Ask the human to connect it, then try again.`, true);
    }
    const key = `${ctx.runId}:${device.id}`;
    if (!audited.has(key)) {
      audited.add(key);
      setTimeout(() => audited.delete(key), 6 * 3600_000).unref?.();
      audit(`agent:${ctx.agentId}`, "android.use", device.id, { runId: ctx.runId });
    }
    const result = await tool.run(parsed as never, { device, serial, runId: ctx.runId, agentId: ctx.agentId, conversationId: ctx.conversationId, folders: run.folders, signal: run.signal });
    return { ...result, content: result.content.map((c) => (c.type === "text" ? { ...c, text: mask(ctx.runId, c.text) } : c)) };
  } catch (err) {
    if (err instanceof z.ZodError) return text(`Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, true);
    if (err instanceof AdbError) {
      noticeFailure(err);
      return text(mask(ctx.runId, err.message), true);
    }
    if (err instanceof RemoteFileError) return text(err.message, true);
    if (err instanceof HttpError) return text(err.status === 423 ? "The vault is locked; ask the human to unlock Godmode." : err.message, true);
    log.warn(`android tool ${label} failed`, err);
    return text(`The phone tool failed: ${mask(ctx.runId, err instanceof Error ? err.message : String(err))}`, true);
  }
}
