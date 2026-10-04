/**
 * The `vm` MCP server (POST /mcp/vm, per-run bearer token): shell, file and screen tools that act inside the macOS VM
 * the run works in (see vm/service.ts `attachVm`). Commands run through `tart exec` as the guest user in a fresh login
 * shell; files are read and written through the same channel, so nothing on the host is reachable except the VM's
 * shared folder. `screen` sees and controls the VM's display over VNC with the computer-use action vocabulary;
 * `fill_login` / `fill_totp` type vault secrets into it without the model seeing them (when settings.vm.vaultFill);
 * `permissions` sets the macOS privacy permissions of the software in the VM (see ./permissions.ts).
 */
import { z } from "zod";
import { getAgent } from "../agents/service";
import { imageToFrame, inImage, regionToFrame, type Point, type Shot } from "../computer/geometry";
import { KeyError, normalizeModifier } from "../computer/keys";
import { logger } from "../log";
import { audit } from "../services/audit";
import { getSettings } from "../services/settings";
import type { RunContext } from "../types";
import { HttpError, sleep } from "../util";
import { credentialsForAgent, getCredential, markCredentialUsed, revealForAgent } from "../vault/credentials";
import { codeForAgent, totpForAgent } from "../vault/totp";
import { PERMISSION_NAMES, PermissionError, deniedRequests, grantPermissions, listPermissions, revokePermissions, type GuestExec } from "./permissions";
import { GUEST_SHARED_DIR, GUEST_USER, execInVm, getVm, guestPathWord, runSignal, vmOfRun } from "./service";
import { TYPABLE_SECRET, captureScreen, click, drag, eraseTyped, move, pressKeys, scroll, secureInputOwner, typeSecret, typeText, type Button } from "./screen";
import { VncError } from "./vnc";

const log = logger("vm");

export interface VmToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

const MAX_OUTPUT = 30_000;
const MAX_READ_BYTES = 2_000_000;
const DEFAULT_READ_LINES = 2000;

export const VM_INSTRUCTIONS =
  "Tools for the macOS virtual machine this task runs in: run shell commands, read, write and edit files, see and control its screen, give its software the macOS permissions it needs, and type saved logins and 2FA codes into it. " +
  "Each shell call is a fresh login shell (zsh) as the guest user; pass cwd instead of relying on an earlier cd.";

function text(t: string, isError = false): VmToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

/** Keep the start and the (usually more telling) end of long output. */
function clip(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = Math.floor(max / 3);
  return `${s.slice(0, head)}\n\n… [${(s.length - max).toLocaleString("en-US")} characters omitted] …\n\n${s.slice(-(max - head))}`;
}

export { guestPathWord };

/* ------------------------------------------------------------------ */
/* Tools                                                                */
/* ------------------------------------------------------------------ */

interface ToolEnv {
  vmId: string;
  runId: string;
  agentId: string;
  /** Aborts when the run ends. */
  signal?: AbortSignal;
}

interface VmTool {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (vmId: string, args: never, env: ToolEnv) => Promise<VmToolResult>;
}

function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  run: (vmId: string, args: z.infer<S>, env: ToolEnv) => Promise<VmToolResult>;
}): VmTool {
  return def as unknown as VmTool;
}

/* ------------------------------------------------------------------ */
/* Screen                                                               */
/* ------------------------------------------------------------------ */

const SCREEN_ACTIONS = [
  "screenshot",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
  "zoom",
] as const;

const coordinate = z.tuple([z.number(), z.number()]);

const screenSchema = z.object({
  action: z.enum(SCREEN_ACTIONS),
  coordinate: coordinate.optional().describe("[x, y] in pixels of your latest screenshot (clicks, mouse_move, scroll position, drag end)"),
  start_coordinate: coordinate.optional().describe("left_click_drag: where the drag starts"),
  text: z
    .string()
    .max(20_000)
    .optional()
    .describe('type: the text to type. key / hold_key: keys like "Return", "cmd+s", "cmd+shift+t" (several separated by spaces)'),
  modifiers: z.string().max(40).optional().describe('Keys held during a click or drag, e.g. "shift" or "cmd+shift"'),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
  scroll_amount: z.number().int().min(1).max(30).optional().describe("Wheel notches (default 3)"),
  duration: z.number().min(0).max(30).optional().describe("Seconds, for wait and hold_key"),
  region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("zoom: [x1, y1, x2, y2] of your latest screenshot"),
  screenshot: z.boolean().optional().describe("Return a new screenshot after the action (default true)"),
});

/** The latest full screenshot each run saw: its coordinates map back to the VM's screen. */
const shots = new Map<string, Shot>();

function maxEdge(): number {
  return getSettings().computer.screenshotMaxSize || 1280;
}

async function screenshotResult(env: ToolEnv, note?: string): Promise<VmToolResult> {
  const shot = await captureScreen(env.vmId, { maxEdge: maxEdge() });
  shots.set(env.runId, { width: shot.width, height: shot.height, frame: shot.frame });
  return {
    content: [
      { type: "text", text: `${note ? `${note}. ` : ""}Screenshot ${shot.width}×${shot.height} of the VM's screen.` },
      { type: "image", data: shot.data, mimeType: "image/png" },
    ],
  };
}

function toScreen(env: ToolEnv, c: [number, number] | undefined, what: string): Point {
  const shot = shots.get(env.runId);
  if (!shot) throw new VncError('Take a screenshot first ({action: "screenshot"}) — coordinates are pixels of your latest screenshot.');
  if (!c) throw new VncError(`${what} needs coordinate [x, y]`);
  if (!inImage(shot, c[0], c[1])) throw new VncError(`[${c[0]}, ${c[1]}] is outside your latest screenshot (${shot.width}×${shot.height}).`);
  return imageToFrame(shot, c[0], c[1]);
}

function modifierList(s: string | undefined): string[] {
  if (!s?.trim()) return [];
  return s.split("+").map((m) => {
    const mod = normalizeModifier(m);
    if (!mod) throw new KeyError(`Unknown modifier "${m}"`);
    return mod;
  });
}

async function screenAction(env: ToolEnv, a: z.infer<typeof screenSchema>): Promise<VmToolResult> {
  const clickLike: Partial<Record<(typeof SCREEN_ACTIONS)[number], { button: Button; count: number }>> = {
    left_click: { button: "left", count: 1 },
    right_click: { button: "right", count: 1 },
    middle_click: { button: "middle", count: 1 },
    double_click: { button: "left", count: 2 },
    triple_click: { button: "left", count: 3 },
  };
  let note: string;
  switch (a.action) {
    case "screenshot":
      return screenshotResult(env);
    case "zoom": {
      const shot = shots.get(env.runId);
      if (!shot) throw new VncError('Take a screenshot first ({action: "screenshot"}).');
      if (!a.region) throw new VncError("zoom needs region [x1, y1, x2, y2]");
      const zoomed = await captureScreen(env.vmId, { maxEdge: maxEdge(), region: regionToFrame(shot, a.region) });
      return {
        content: [
          { type: "text", text: `Zoomed view of [${a.region.join(", ")}] (${zoomed.width}×${zoomed.height}). Keep using the coordinates of your full screenshot for actions.` },
          { type: "image", data: zoomed.data, mimeType: "image/png" },
        ],
      };
    }
    case "mouse_move": {
      const p = toScreen(env, a.coordinate, "mouse_move");
      await move(env.vmId, p.x, p.y);
      note = `Moved the pointer to [${a.coordinate!.join(", ")}]`;
      break;
    }
    case "left_click_drag": {
      const from = toScreen(env, a.start_coordinate, "left_click_drag start_coordinate");
      const to = toScreen(env, a.coordinate, "left_click_drag");
      await drag(env.vmId, from, to, modifierList(a.modifiers));
      note = `Dragged from [${a.start_coordinate!.join(", ")}] to [${a.coordinate!.join(", ")}]`;
      break;
    }
    case "scroll": {
      const p = toScreen(env, a.coordinate, "scroll");
      const n = a.scroll_amount ?? 3;
      const dir = a.scroll_direction ?? "down";
      await scroll(env.vmId, p.x, p.y, dir === "left" ? -n : dir === "right" ? n : 0, dir === "up" ? -n : dir === "down" ? n : 0);
      note = `Scrolled ${dir} ${n}×`;
      break;
    }
    case "type": {
      if (!a.text) throw new VncError("type needs text");
      const how = await typeText(env.vmId, a.text);
      note = `${how === "pasted" ? "Pasted" : "Typed"} ${a.text.length} character${a.text.length === 1 ? "" : "s"}`;
      break;
    }
    case "key":
    case "hold_key":
      if (!a.text) throw new VncError(`${a.action} needs text, e.g. "Return" or "cmd+s"`);
      await pressKeys(env.vmId, a.text, a.action === "hold_key" ? Math.round((a.duration ?? 1) * 1000) : 0);
      note = `Pressed ${a.text}`;
      break;
    case "wait":
      await sleep(Math.round((a.duration ?? 1) * 1000));
      note = `Waited ${a.duration ?? 1} s`;
      break;
    default: {
      const how = clickLike[a.action]!;
      const p = toScreen(env, a.coordinate, a.action);
      await click(env.vmId, p.x, p.y, { ...how, modifiers: modifierList(a.modifiers) });
      note = `${a.action.replace("_", " ")} at [${a.coordinate!.join(", ")}]`;
    }
  }
  if (a.screenshot === false) return text(`${note}.`);
  // Let the UI react before looking again.
  await sleep(a.action === "wait" ? 0 : 400);
  return screenshotResult(env, note);
}

async function readRaw(vmId: string, path: string, signal?: AbortSignal): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const word = guestPathWord(path);
  const script = `f=${word}; if [ -d "$f" ]; then echo "Is a directory: $f" >&2; exit 21; fi; [ -f "$f" ] || { echo "No such file: $f" >&2; exit 2; }; s=$(wc -c < "$f" | tr -d ' '); if [ "$s" -gt ${MAX_READ_BYTES} ]; then echo "File is too large to read ($s bytes). Look at parts of it with shell (head, tail, grep, sed -n)." >&2; exit 27; fi; cat -- "$f"`;
  const res = await execInVm(vmId, script, { timeoutMs: 60_000, signal });
  if (res.exitCode !== 0) return { ok: false, error: res.stderr.trim() || `Could not read ${path} (exit ${res.exitCode})` };
  return { ok: true, content: res.stdout };
}

async function writeRaw(vmId: string, path: string, content: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  const word = guestPathWord(path);
  const script = `f=${word}; mkdir -p "$(dirname "$f")" && cat > "$f"`;
  const res = await execInVm(vmId, script, { timeoutMs: 60_000, stdin: content, signal });
  if (res.exitCode !== 0) return { ok: false, error: res.stderr.trim() || `Could not write ${path} (exit ${res.exitCode})` };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Logins and 2FA                                                       */
/* ------------------------------------------------------------------ */

const VAULT_FILL_OFF =
  'Typing saved logins and 2FA codes into the VM is turned off. Ask the human to turn on "Logins and 2FA codes" in Settings → Virtual machines, then try again.';

const fillFields = {
  coordinate: coordinate.optional().describe("Click this point of your latest screenshot first to focus the field"),
  submit: z.boolean().optional().describe("Press Return after typing"),
  screenshot: z.boolean().optional().describe("Return a new screenshot afterwards (default true)"),
};

/** Apps whose "Secure Keyboard Entry" turns on secure input for everything typed into them. */
const TERMINALS = new Set(["Terminal", "iTerm", "iTerm2", "Warp", "Alacritty", "kitty", "WezTerm", "Ghostty", "Hyper", "Tabby"]);

function passwordFieldRefusal(app: string | null): string | null {
  if (!app) return "The focused field in the VM isn't a password field, so the password wasn't typed. Click into the password field (or pass its coordinate) and try again.";
  if (TERMINALS.has(app)) return `${app} has secure keyboard entry on — that's a terminal, not a password field. Godmode doesn't type passwords into terminals.`;
  return null;
}

async function focusField(env: ToolEnv, c: [number, number] | undefined): Promise<void> {
  if (!c) return;
  const p = toScreen(env, c, "coordinate");
  await click(env.vmId, p.x, p.y);
  // Let the field take focus (a password field turns secure input on).
  await sleep(300);
}

async function afterFill(env: ToolEnv, note: string, a: { submit?: boolean; screenshot?: boolean }): Promise<VmToolResult> {
  if (a.submit) await pressKeys(env.vmId, "Return");
  const done = `${note}${a.submit ? " and pressed Return" : ""}`;
  if (a.screenshot === false) return text(`${done}.`);
  await sleep(a.submit ? 1000 : 400);
  return screenshotResult(env, done);
}

const TOOLS: VmTool[] = [
  defineTool({
    name: "shell",
    description:
      `Run a shell command in the macOS VM (zsh login shell as user "${GUEST_USER}", passwordless sudo, Homebrew on PATH). ` +
      "Returns the exit code, stdout and stderr. Each call starts a fresh shell: pass cwd (default: the home folder) instead of relying on an earlier cd. " +
      "The call returns when the command's output closes — start servers and other long-running processes in the background with nohup and redirect their output to a file " +
      "(e.g. `nohup npm run dev > /tmp/dev.log 2>&1 &`). Commands must not wait for interactive input — one that controls another app (osascript, Apple events) waits for " +
      'a macOS dialog unless you granted it first: permissions {action: "grant", app: "shell", permissions: ["automation"], target: "<the app>"}.',
    schema: z.object({
      command: z.string().min(1).max(100_000).describe("Shell command(s) to run"),
      cwd: z.string().max(4096).optional().describe("Directory to run in (absolute, ~/… or relative to the home folder)"),
      timeout_seconds: z.number().int().min(1).max(3600).optional().describe("Kill the command after this many seconds (default 120, max 3600)"),
    }),
    run: async (vmId, args, env) => {
      const res = await execInVm(vmId, args.command, { cwd: args.cwd, timeoutMs: (args.timeout_seconds ?? 120) * 1000, signal: env.signal });
      const parts = [res.timedOut ? `Timed out after ${args.timeout_seconds ?? 120} s (the command was killed).` : `Exit code: ${res.exitCode}`];
      if (res.stdout) parts.push(clip(res.stdout.replace(/\s+$/, "")));
      if (res.stderr.trim()) parts.push(`[stderr]\n${clip(res.stderr.replace(/\s+$/, ""), MAX_OUTPUT / 2)}`);
      if (!res.stdout && !res.stderr.trim()) parts.push("(no output)");
      return text(parts.join("\n"), res.timedOut || res.exitCode !== 0);
    },
  }),
  defineTool({
    name: "read_file",
    description: "Read a text file in the VM. Returns numbered lines (like cat -n). Use offset/limit for long files.",
    schema: z.object({
      path: z.string().min(1).max(4096).describe("File path in the VM (absolute, ~/… or relative to the home folder)"),
      offset: z.number().int().min(1).optional().describe("First line to return (1-based)"),
      limit: z.number().int().min(1).max(20_000).optional().describe(`Number of lines (default ${DEFAULT_READ_LINES})`),
    }),
    run: async (vmId, args, env) => {
      const res = await readRaw(vmId, args.path, env.signal);
      if (!res.ok) return text(res.error, true);
      if (res.content.includes("\u0000")) return text(`${args.path} is a binary file. Inspect it with shell (file, xxd, …) or copy it to ${GUEST_SHARED_DIR} to hand it over.`, true);
      if (!res.content) return text(`${args.path} is empty.`);
      const lines = res.content.replace(/\n$/, "").split("\n");
      const start = (args.offset ?? 1) - 1;
      const count = args.limit ?? DEFAULT_READ_LINES;
      const slice = lines.slice(start, start + count);
      const width = String(start + slice.length).length;
      const body = slice.map((l, i) => `${String(start + i + 1).padStart(width, " ")}\t${l.length > 2000 ? `${l.slice(0, 2000)}…` : l}`).join("\n");
      const more = start + slice.length < lines.length ? `\n… ${lines.length - start - slice.length} more lines (use offset ${start + slice.length + 1})` : "";
      return text(clip(body + more, 200_000));
    },
  }),
  defineTool({
    name: "write_file",
    description: "Create or overwrite a file in the VM (parent folders are created).",
    schema: z.object({
      path: z.string().min(1).max(4096).describe("File path in the VM"),
      content: z.string().max(5_000_000).describe("The complete new file content"),
    }),
    run: async (vmId, args, env) => {
      const res = await writeRaw(vmId, args.path, args.content, env.signal);
      if (!res.ok) return text(res.error, true);
      return text(`Wrote ${Buffer.byteLength(args.content, "utf8").toLocaleString("en-US")} bytes to ${args.path}.`);
    },
  }),
  defineTool({
    name: "edit_file",
    description:
      "Replace text in a file in the VM. old_string must match the file exactly (including whitespace) and be unique unless replace_all is true. " +
      "Read the file first.",
    schema: z.object({
      path: z.string().min(1).max(4096),
      old_string: z.string().min(1).max(1_000_000),
      new_string: z.string().max(1_000_000),
      replace_all: z.boolean().optional(),
    }),
    run: async (vmId, args, env) => {
      if (args.old_string === args.new_string) return text("old_string and new_string are the same — nothing to change.", true);
      const res = await readRaw(vmId, args.path, env.signal);
      if (!res.ok) return text(res.error, true);
      // Not UTF-8 text (binary, Latin-1, …): writing it back would corrupt it.
      if (res.content.includes("\u0000") || res.content.includes("\ufffd")) {
        return text(`${args.path} isn't UTF-8 text; edit it with shell tools (sed, perl, …) instead.`, true);
      }
      const count = res.content.split(args.old_string).length - 1;
      if (count === 0) return text(`old_string was not found in ${args.path}. Read the file and copy the text exactly.`, true);
      if (count > 1 && !args.replace_all) return text(`old_string occurs ${count} times in ${args.path}. Add surrounding context to make it unique, or set replace_all.`, true);
      const next = args.replace_all ? res.content.split(args.old_string).join(args.new_string) : res.content.replace(args.old_string, () => args.new_string);
      const written = await writeRaw(vmId, args.path, next, env.signal);
      if (!written.ok) return text(written.error, true);
      return text(`Edited ${args.path} (${args.replace_all ? `${count} replacement${count === 1 ? "" : "s"}` : "1 replacement"}).`);
    },
  }),
  defineTool({
    name: "info",
    description: "About the VM: name, macOS version, resources, IP address and the shared folder that connects it to the host.",
    schema: z.object({}),
    run: async (vmId, _args, env) => {
      const vm = await getVm(vmId);
      const res = await execInVm(vmId, "sw_vers -productVersion; sysctl -n hw.ncpu; df -h / | tail -1 | awk '{print $4\" free of \"$2}'", { timeoutMs: 30_000, signal: env.signal });
      const [version, ncpu, disk] = res.stdout.trim().split("\n");
      return text(
        JSON.stringify(
          {
            name: vm.name,
            macOS: version ?? null,
            image: vm.image,
            state: vm.state,
            ip: vm.ip,
            cpus: Number(ncpu) || vm.cpu,
            memoryMb: vm.memoryMb,
            disk: disk ?? `${vm.diskGb} GB`,
            user: vm.guestUser,
            sharedFolder: { inVm: vm.guestSharedDir, onHost: vm.sharedDir },
          },
          null,
          2,
        ),
      );
    },
  }),
  defineTool({
    name: "permissions",
    description: [
      "macOS privacy permissions of the software in the VM (the switches under System Settings → Privacy & Security), set directly — nobody has to answer a dialog. In the VM these are yours to decide.",
      'grant / revoke: app + permissions. app is the app\'s name ("Google Chrome"), its bundle id ("com.google.Chrome") or a path (an app, or a bare program like /opt/homebrew/bin/node); "shell" stands for the commands you run with the shell tool. ' +
        "The automation permission (controlling another app with AppleScript or Apple events) also takes target: the app that is controlled.",
      "list: the permissions of app — of every app when app is left out. denied: what macOS refused lately; look there when an app can't see the screen, click, type or reach files.",
      "Grant before you start an app or a script that needs a permission. An app that already runs may need to be quit and reopened.",
    ].join("\n"),
    schema: z.object({
      action: z.enum(["grant", "revoke", "list", "denied"]),
      app: z.string().max(1024).optional().describe('App name, bundle id or path; "shell" = the commands you run with the shell tool. Needed for grant and revoke'),
      permissions: z.array(z.enum(PERMISSION_NAMES)).min(1).max(PERMISSION_NAMES.length).optional().describe("grant / revoke: the permissions"),
      target: z.string().max(1024).optional().describe('automation: the app that is controlled (name, bundle id or path), e.g. "System Events"'),
      minutes: z.number().int().min(1).max(120).optional().describe("denied: how many minutes to look back (default 10)"),
    }),
    run: async (vmId, args, env) => {
      const exec: GuestExec = (script, opts) => execInVm(vmId, script, { ...opts, signal: env.signal });
      if (args.action === "list") return text(await listPermissions(exec, args.app));
      if (args.action === "denied") return text(await deniedRequests(exec, args.minutes ?? 10));
      if (!args.app?.trim()) return text(`${args.action} needs app: the app's name, bundle id or path, or "shell" for the commands you run with the shell tool.`, true);
      if (!args.permissions?.length) return text(`${args.action} needs permissions, e.g. ["accessibility", "screen_recording"].`, true);
      const change = { app: args.app, permissions: [...new Set(args.permissions)], target: args.target };
      const record = (details: Record<string, unknown>) => audit(`agent:${env.agentId}`, `vm.permission.${args.action}`, vmId, { runId: env.runId, permissions: change.permissions, ...details });
      try {
        const done = args.action === "grant" ? await grantPermissions(exec, change) : await revokePermissions(exec, change);
        record({ ok: true, client: done.client.client, ...(done.target ? { target: done.target.client } : {}) });
        return text(done.text);
      } catch (err) {
        // Also when it failed: the system's database may have been changed before the user's refused.
        record({ ok: false, app: args.app, ...(args.target ? { target: args.target } : {}), error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
  }),
  defineTool({
    name: "screen",
    description: [
      "See and control the VM's screen (macOS desktop) with the mouse and keyboard — for apps and anything without a command line.",
      'Start with {action:"screenshot"}. Coordinates are pixels of your latest screenshot; after every action you get a fresh screenshot (pass screenshot:false to skip it).',
      'Actions: screenshot, left_click, right_click, middle_click, double_click, triple_click (coordinate; hold keys with modifiers:"cmd"), mouse_move, left_click_drag (start_coordinate → coordinate), scroll (coordinate, scroll_direction, scroll_amount), type (text), key (text like "Return" or "cmd+space"), hold_key (text, duration), wait (duration), zoom (region — a sharper look; keep using full-screenshot coordinates).',
      "Prefer the shell for anything a command can do; use the screen for GUI apps. It is a US keyboard layout. Never type passwords or 2FA codes with it — use fill_login / fill_totp.",
    ].join("\n"),
    schema: screenSchema,
    run: (_vmId, args, env) => screenAction(env, args),
  }),
  defineTool({
    name: "fill_login",
    description:
      "Type the username or password of a saved login (id from vault_list_logins) into the focused field on the VM's screen — Godmode types it, you never see it. " +
      "Click the field first or pass its coordinate. Passwords only go into password fields. Godmode can't tell which website or app a field in the VM belongs to: only fill a login on its own site or app.",
    schema: z.object({
      credentialId: z.string().describe("Login id from vault_list_logins"),
      field: z.enum(["username", "password"]),
      ...fillFields,
    }),
    run: async (vmId, args, env) => {
      if (!getSettings().vm.vaultFill) return text(VAULT_FILL_OFF, true);
      const agent = getAgent(env.agentId);
      const secret = revealForAgent(agent, args.credentialId);
      const value = args.field === "username" ? secret.username : secret.password;
      if (!value) return text(`This login has no ${args.field} saved. Call report_missing_login (kind "invalid_credential") so the human can complete it.`, true);
      if (!TYPABLE_SECRET.test(value)) return text(`The ${args.field} has characters Godmode can't type into the VM (it only types plain ASCII). Ask the human to sign in there themselves.`, true);
      const login = getCredential(args.credentialId);
      const record = (ok: boolean, more: Record<string, unknown> = {}) =>
        audit(`agent:${agent.id}`, "credential.fill", args.credentialId, { field: args.field, runId: env.runId, vmId, ok, ...more });
      await focusField(env, args.coordinate);
      let app: string | null = null;
      try {
        if (args.field === "password") {
          app = await secureInputOwner(vmId, env.signal);
          const refusal = passwordFieldRefusal(app);
          if (refusal) {
            record(false, app ? { app } : {});
            return text(refusal, true);
          }
        }
        await typeSecret(vmId, value, env.signal);
        // Focus may have moved while the password was typed: take it back out of whatever field got it.
        if (app && (await secureInputOwner(vmId, env.signal)) !== app) {
          await eraseTyped(vmId, value.length);
          record(false, { app, error: "focus_moved" });
          return text("The focus left the password field while Godmode was typing, so what was typed was erased again. Click into the password field and try again.", true);
        }
      } catch (err) {
        record(false, { ...(app ? { app } : {}), error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      record(true, app ? { app } : {});
      markCredentialUsed(args.credentialId);
      return afterFill(env, `Typed the ${args.field} of "${login.name}" into ${app ? `a password field of ${app}` : "the focused field"}`, args);
    },
  }),
  defineTool({
    name: "fill_totp",
    description:
      "Type the current 2FA (authenticator) code into the focused field on the VM's screen — Godmode types it, you never see it. " +
      "Pass the login's credentialId (its linked 2FA is used) or a totpId. Click the code field first or pass its coordinate.",
    schema: z.object({
      credentialId: z.string().optional().describe("Login id whose linked 2FA should be used"),
      totpId: z.string().optional().describe("2FA entry id (alternative to credentialId)"),
      ...fillFields,
    }),
    run: async (vmId, args, env) => {
      if (!getSettings().vm.vaultFill) return text(VAULT_FILL_OFF, true);
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
      await focusField(env, args.coordinate);
      let code = codeForAgent(agent, id);
      if (code.remaining < 3) {
        // Too close to rollover — wait for the next period so the code isn't rejected as stale.
        await sleep(code.remaining * 1000 + 300);
        code = codeForAgent(agent, id);
      }
      const meta = { field: "totp", runId: env.runId, vmId, credentialId: args.credentialId ?? null };
      try {
        await typeSecret(vmId, code.code, env.signal);
      } catch (err) {
        audit(`agent:${agent.id}`, "totp.fill", id, { ...meta, ok: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      audit(`agent:${agent.id}`, "totp.fill", id, { ...meta, ok: true });
      return afterFill(env, `Typed the current 2FA code of "${entry.issuer || entry.accountName}" into the focused field`, args);
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

export function listVmTools(ctx: RunContext): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  if (!vmOfRun(ctx.runId)) return [];
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t.name, t.schema) }));
}

export class UnknownVmToolError extends Error {}

const audited = new Set<string>();

export async function callVmTool(ctx: RunContext, name: string, args: unknown): Promise<VmToolResult> {
  const vmId = vmOfRun(ctx.runId);
  if (!vmId) return text("This run has no virtual machine.", true);
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new UnknownVmToolError(`Unknown tool: ${name}`);
  if (!getSettings().vm.enabled) return text("Virtual machines were turned off by the human.", true);
  try {
    const parsed = tool.schema.parse(args ?? {});
    if (!audited.has(ctx.runId)) {
      audited.add(ctx.runId);
      setTimeout(() => audited.delete(ctx.runId), 6 * 3600_000).unref?.();
      audit(`agent:${ctx.agentId}`, "vm.use", vmId, { runId: ctx.runId });
    }
    // Screenshots of finished runs are no longer needed.
    for (const runId of shots.keys()) if (!vmOfRun(runId)) shots.delete(runId);
    return await tool.run(vmId, parsed as never, { vmId, runId: ctx.runId, agentId: ctx.agentId, signal: runSignal(ctx.runId) });
  } catch (err) {
    if (err instanceof z.ZodError) return text(`Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, true);
    if (err instanceof VncError || err instanceof KeyError || err instanceof PermissionError) return text(err.message, true);
    if (err instanceof HttpError) return text(err.status === 423 ? "The vault is locked; ask the human to unlock Godmode." : err.message, true);
    log.warn(`vm tool ${name} failed`, err);
    return text(`The VM tool failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}
