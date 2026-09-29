/**
 * A VM's screen for agents and the human: screenshots and mouse/keyboard input over the guest's Screen Sharing (see
 * ./vnc.ts). One shared connection per VM; screenshots are scaled for the model and remember the screen area they
 * show, so coordinates read off an image map back to the framebuffer (see computer/geometry.ts).
 */
import { fitSize, type Rect, type Shot } from "../computer/geometry";
import { parseKeySequence, type KeyCombo } from "../computer/keys";
import { logger } from "../log";
import { sleep } from "../util";
import { fromBgrx, encodePng, scaleDown } from "./raster";
import { ensureVmRunning, execInVm, execProgramInVm, onVmStopped, screenEndpoint } from "./service";
import { MODIFIER_KEYSYMS, VncClient, VncError, keysymFor, needsShift } from "./vnc";

const log = logger("vm");

/** Longer text (or text a US keyboard can't type) is pasted through the guest's clipboard instead of typed. */
const TYPE_DIRECTLY_MAX = 200;
const TYPE_MAX = 20_000;

const clients = new Map<string, Promise<VncClient>>();

/** The VM's screen connection, (re)connected on demand. Boots the VM when it isn't running (unless `boot` is false). */
function client(vmId: string, boot = true): Promise<VncClient> {
  const existing = clients.get(vmId);
  const p = (async () => {
    const c = existing ? await existing.catch(() => null) : null;
    if (c?.alive) return c;
    if (boot) await ensureVmRunning(vmId);
    const ep = await screenEndpoint(vmId);
    if (!ep) throw new VncError("The VM's screen is not available — is the VM running?");
    try {
      const fresh = await VncClient.connect(ep);
      log.debug(`connected to the screen of VM ${vmId} (${fresh.width}×${fresh.height})`);
      return fresh;
    } catch (err) {
      throw new VncError(
        `Could not reach the VM's screen (macOS Screen Sharing in the VM): ${err instanceof Error ? err.message : String(err)}. ` +
          "If Screen Sharing was turned off in the VM, restart the VM so Godmode sets it up again.",
      );
    }
  })();
  // Concurrent callers share one connection attempt.
  clients.set(vmId, p);
  p.catch(() => {
    if (clients.get(vmId) === p) clients.delete(vmId);
  });
  return p;
}

export function closeScreen(vmId: string): void {
  const p = clients.get(vmId);
  clients.delete(vmId);
  void p?.then((c) => c.close()).catch(() => undefined);
}

// A stopped VM's connection is dead: the next use connects afresh.
onVmStopped(closeScreen);

export interface ScreenShot extends Shot {
  /** base64 PNG */
  data: string;
}

/** The whole screen (or `region`, in framebuffer pixels) as a PNG no larger than `maxEdge`. */
export async function captureScreen(vmId: string, opts: { maxEdge: number; region?: Rect; fast?: boolean; boot?: boolean }): Promise<ScreenShot> {
  const c = await client(vmId, opts.boot ?? true);
  await c.refresh();
  const full = { x: 0, y: 0, width: c.width, height: c.height };
  const r = opts.region ? clampRect(opts.region, full) : full;
  const raster = fromBgrx(c.framebuffer, c.width, r);
  const size = fitSize(r.width, r.height, opts.maxEdge);
  const scaled = scaleDown(raster, size.width, size.height);
  const png = encodePng(scaled, opts.fast ? 1 : 6);
  return { data: png.toString("base64"), width: scaled.width, height: scaled.height, frame: r };
}

function clampRect(r: Rect, bounds: Rect): Rect {
  const x = Math.max(bounds.x, Math.min(Math.round(r.x), bounds.x + bounds.width - 1));
  const y = Math.max(bounds.y, Math.min(Math.round(r.y), bounds.y + bounds.height - 1));
  const width = Math.max(1, Math.min(Math.round(r.width), bounds.x + bounds.width - x));
  const height = Math.max(1, Math.min(Math.round(r.height), bounds.y + bounds.height - y));
  return { x, y, width, height };
}

export type Button = "left" | "right" | "middle";
const BUTTON_BITS: Record<Button, number> = { left: 1, middle: 2, right: 4 };

function holdModifiers(c: VncClient, modifiers: string[], down: boolean) {
  const list = down ? modifiers : [...modifiers].reverse();
  for (const m of list) {
    const sym = MODIFIER_KEYSYMS[m];
    if (sym) c.key(sym, down);
  }
}

export async function click(vmId: string, x: number, y: number, opts: { button?: Button; count?: number; modifiers?: string[] } = {}): Promise<void> {
  const c = await client(vmId);
  const bit = BUTTON_BITS[opts.button ?? "left"];
  const mods = opts.modifiers ?? [];
  c.pointer(x, y, 0);
  await sleep(30);
  holdModifiers(c, mods, true);
  for (let i = 0; i < (opts.count ?? 1); i++) {
    c.pointer(x, y, bit);
    await sleep(40);
    c.pointer(x, y, 0);
    await sleep(60);
  }
  holdModifiers(c, mods, false);
}

export async function move(vmId: string, x: number, y: number): Promise<void> {
  (await client(vmId)).pointer(x, y, 0);
}

export async function drag(vmId: string, from: { x: number; y: number }, to: { x: number; y: number }, modifiers: string[] = []): Promise<void> {
  const c = await client(vmId);
  c.pointer(from.x, from.y, 0);
  await sleep(40);
  holdModifiers(c, modifiers, true);
  c.pointer(from.x, from.y, 1);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await sleep(20);
    c.pointer(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 1);
  }
  await sleep(40);
  c.pointer(to.x, to.y, 0);
  holdModifiers(c, modifiers, false);
}

/** Wheel notches at (x, y): positive dy scrolls down, positive dx right. */
export async function scroll(vmId: string, x: number, y: number, dx: number, dy: number): Promise<void> {
  const c = await client(vmId);
  c.pointer(x, y, 0);
  const wheel = (bit: number, n: number) => {
    for (let i = 0; i < n; i++) {
      c.pointer(x, y, bit);
      c.pointer(x, y, 0);
    }
  };
  if (dy) wheel(dy > 0 ? 16 : 8, Math.abs(Math.round(dy)));
  if (dx) wheel(dx > 0 ? 64 : 32, Math.abs(Math.round(dx)));
}

async function pressCombo(c: VncClient, combo: KeyCombo, holdMs = 0) {
  const sym = keysymFor(combo.key);
  if (sym === null) throw new VncError(`Can't press "${combo.key}" in the VM`);
  const shift = !combo.modifiers.includes("shift") && [...combo.key].length === 1 && needsShift(combo.key);
  const mods = shift ? [...combo.modifiers, "shift"] : combo.modifiers;
  holdModifiers(c, mods, true);
  c.key(sym, true);
  await sleep(holdMs || 15);
  c.key(sym, false);
  holdModifiers(c, mods, false);
  await sleep(15);
}

/** "cmd+c", "Return", "ctrl+a Delete" (space-separated sequences). */
export async function pressKeys(vmId: string, keys: string, holdMs = 0): Promise<void> {
  const c = await client(vmId);
  for (const combo of parseKeySequence(keys)) await pressCombo(c, combo, holdMs);
}

/** Characters a US keyboard types directly (the rest is pasted). */
const TYPABLE = /^[\x20-\x7e\n\t]*$/;

async function typeChars(c: VncClient, text: string): Promise<void> {
  for (const ch of text.replace(/\r/g, "")) {
    await pressCombo(c, { key: ch === "\n" ? "enter" : ch === "\t" ? "tab" : ch === " " ? "space" : ch, modifiers: [] });
  }
}

/** Type text into the focused field: short US-keyboard text key by key, anything else pasted from the clipboard. */
export async function typeText(vmId: string, text: string): Promise<"typed" | "pasted"> {
  if (text.length > TYPE_MAX) throw new VncError(`That's too much text to type (${text.length} characters, at most ${TYPE_MAX}) — write it to a file with the shell instead.`);
  const c = await client(vmId);
  if (text.length > TYPE_DIRECTLY_MAX || !TYPABLE.test(text)) {
    const res = await execInVm(vmId, "pbcopy", { stdin: text, timeoutMs: 30_000 });
    if (res.exitCode === 0) {
      await pressCombo(c, { key: "v", modifiers: ["cmd"] });
      return "pasted";
    }
    if (!TYPABLE.test(text)) throw new VncError(`Could not paste the text: ${res.stderr.trim() || `pbcopy exited with ${res.exitCode}`}`);
  }
  await typeChars(c, text);
  return "typed";
}

/** Secrets are only ever typed key by key: pasting would leave them on the guest's clipboard. */
export const TYPABLE_SECRET = /^[\x20-\x7e]+$/;

/** Type a secret into the focused field, replacing what it holds. */
export async function typeSecret(vmId: string, secret: string, signal?: AbortSignal): Promise<void> {
  if (!TYPABLE_SECRET.test(secret)) throw new VncError("Only plain ASCII can be typed into the VM.");
  const c = await client(vmId);
  if (signal?.aborted) throw new VncError("The run ended before anything was typed.");
  await pressCombo(c, { key: "a", modifiers: ["cmd"] });
  await typeChars(c, secret);
}

/** Take back up to `count` just-typed characters from whatever has focus now. */
export async function eraseTyped(vmId: string, count: number): Promise<void> {
  const c = await client(vmId);
  for (let i = 0; i < count; i++) await pressCombo(c, { key: "backspace", modifiers: [] });
}

/**
 * The app that turned on macOS secure keyboard input — what a focused password field does (browsers, native password
 * fields) — or null when none did. Both programs run without a shell, so the guest user's shell setup can't fake them.
 */
export async function secureInputOwner(vmId: string, signal?: AbortSignal): Promise<string | null> {
  const reg = await execProgramInVm(vmId, ["/usr/sbin/ioreg", "-l", "-w", "0", "-d", "1"], { signal });
  const pid = reg.exitCode === 0 ? /"kCGSSessionSecureInputPID"=(\d+)/.exec(reg.stdout)?.[1] : undefined;
  if (!pid) return null;
  const ps = await execProgramInVm(vmId, ["/bin/ps", "-o", "comm=", "-p", pid], { signal });
  const path = ps.exitCode === 0 ? ps.stdout.trim() : "";
  if (!path) return null;
  return /([^/]+)\.app\//.exec(path)?.[1] ?? path.split("/").pop()!;
}
