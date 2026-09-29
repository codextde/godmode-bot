/**
 * Linux (X11 / XWayland) desktop helper with the same calls as the macOS helper, built on standard tools:
 * `xrandr --listmonitors` (every monitor), ImageMagick `import` (screenshots of the root window, cropped per monitor)
 * and `xdotool` (global mouse and keyboard). Coordinates are pixels of the X screen, which spans every monitor.
 * Single app windows are Cua Driver's job.
 */
import { which } from "../../util";
import { imageSize } from "../image";
import type { HelperCapture, HelperDisplay } from "../helper";
import { HelperError } from "../helperError";

export interface X11Tools {
  xdotool: string;
  importBin: string;
  xrandr: string;
}

/** The tools, or why they can't be used. */
export function x11Tools(): X11Tools | { missing: string } {
  if (!process.env.DISPLAY) return { missing: "No X display (DISPLAY is not set). On Wayland, sessions without XWayland need Cua Driver." };
  const xdotool = which("xdotool");
  const importBin = which("import");
  const xrandr = which("xrandr");
  const missing = [!xdotool && "xdotool", !importBin && "imagemagick", !xrandr && "x11-xserver-utils (xrandr)"].filter(Boolean);
  if (missing.length || !xdotool || !importBin || !xrandr) return { missing: `Install ${missing.join(", ")} to share the whole desktop (e.g. sudo apt install ${missing.join(" ")}).` };
  return { xdotool, importBin, xrandr };
}

/**
 * `xrandr --listmonitors` →
 *   Monitors: 2
 *    0: +*DP-1 2560/597x1440/336+0+0  DP-1
 *    1: +HDMI-1 1920/527x1080/296+2560+0  HDMI-1
 */
export function parseMonitors(output: string): HelperDisplay[] {
  const out: HelperDisplay[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+):\s+\+?(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/.exec(line);
    if (!m) continue;
    out.push({
      id: m[3]!.replace(/^\*/, ""),
      name: m[3]!.replace(/^\*/, ""),
      width: Number(m[4]),
      height: Number(m[5]),
      x: Number(m[6]),
      y: Number(m[7]),
      scale: 1,
      primary: m[2] === "*" || line.includes("+*"),
    });
  }
  if (out.length && !out.some((d) => d.primary)) out[0]!.primary = true;
  return out;
}

/** Canonical key (keys.ts) → X keysym. */
const KEYSYMS: Record<string, string> = {
  enter: "Return",
  kpenter: "KP_Enter",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  escape: "Escape",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  insert: "Insert",
  capslock: "Caps_Lock",
  volumeup: "XF86AudioRaiseVolume",
  volumedown: "XF86AudioLowerVolume",
  mute: "XF86AudioMute",
  cmd: "super",
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
  fn: "super",
  "+": "plus",
  "-": "minus",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  ";": "semicolon",
  ":": "colon",
  "'": "apostrophe",
  '"': "quotedbl",
  "`": "grave",
  "[": "bracketleft",
  "]": "bracketright",
  "{": "braceleft",
  "}": "braceright",
  "(": "parenleft",
  ")": "parenright",
  "=": "equal",
  _: "underscore",
  "*": "asterisk",
  "&": "ampersand",
  "@": "at",
  "#": "numbersign",
  $: "dollar",
  "%": "percent",
  "!": "exclam",
  "?": "question",
  "<": "less",
  ">": "greater",
  "|": "bar",
  "~": "asciitilde",
  "^": "asciicircum",
  " ": "space",
};
for (let i = 1; i <= 20; i++) KEYSYMS[`f${i}`] = `F${i}`;

export function keysym(key: string): string | null {
  if (KEYSYMS[key]) return KEYSYMS[key]!;
  if (/^[a-zA-Z0-9]$/.test(key)) return key;
  return null;
}

const BUTTONS: Record<string, string> = { left: "1", middle: "2", right: "3" };

/** xdotool arguments for a pointer action (global coordinates). Exported for tests. */
export function pointerArgs(p: {
  action: string;
  x: number;
  y: number;
  toX?: number;
  toY?: number;
  button?: string;
  count?: number;
  dx?: number;
  dy?: number;
  modifiers?: string[];
}): string[] {
  const x = String(Math.round(p.x));
  const y = String(Math.round(p.y));
  const btn = BUTTONS[p.button ?? "left"] ?? "1";
  const mods = (p.modifiers ?? []).map((m) => KEYSYMS[m] ?? m);
  const hold = mods.length ? ["keydown", mods.join("+")] : [];
  const release = mods.length ? ["keyup", mods.join("+")] : [];
  switch (p.action) {
    case "move":
      return ["mousemove", "--sync", x, y];
    case "down":
      return ["mousemove", x, y, "mousedown", btn];
    case "up":
      return ["mousemove", x, y, "mouseup", btn];
    case "click":
      return [...hold, "mousemove", "--sync", x, y, "click", "--repeat", String(Math.max(1, Math.min(3, p.count ?? 1))), "--delay", "80", btn, ...release];
    case "drag": {
      const steps: string[] = [];
      const tx = p.toX ?? p.x;
      const ty = p.toY ?? p.y;
      for (let i = 1; i <= 8; i++) steps.push("mousemove", String(Math.round(p.x + ((tx - p.x) * i) / 8)), String(Math.round(p.y + ((ty - p.y) * i) / 8)), "sleep", "0.02");
      return [...hold, "mousemove", "--sync", x, y, "mousedown", btn, "sleep", "0.05", ...steps, "mouseup", btn, ...release];
    }
    case "scroll": {
      // X buttons 4/5 = wheel up/down, 6/7 = left/right; one click ≈ one notch (60 px of our scroll unit).
      const args = ["mousemove", "--sync", x, y];
      const dy = p.dy ?? 0;
      const dx = p.dx ?? 0;
      if (dy) args.push("click", "--repeat", String(Math.max(1, Math.round(Math.abs(dy) / 60))), "--delay", "30", dy > 0 ? "5" : "4");
      if (dx) args.push("click", "--repeat", String(Math.max(1, Math.round(Math.abs(dx) / 60))), "--delay", "30", dx > 0 ? "7" : "6");
      return args;
    }
    default:
      throw new X11Error(`Unknown pointer action "${p.action}"`, "bad_request");
  }
}

export class X11Error extends HelperError {}

async function run(argv: string[], opts: { binary?: boolean; timeoutMs?: number } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
  const timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 15_000);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new X11Error(`${argv[0]!.split("/").pop()} failed: ${err.trim().slice(-300) || `exit ${code}`}`, "failed");
    return { stdout: Buffer.from(out), stderr: err };
  } finally {
    clearTimeout(timer);
  }
}

/** Same surface as NativeHelper (desktop subset). */
export class X11Helper {
  readonly path: string;
  readonly alive = true;

  constructor(private tools: X11Tools) {
    this.path = tools.xdotool;
  }

  async call<T>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
    switch (cmd) {
      case "permissions":
        return { accessibility: true, screenRecording: true } as T;
      case "displays":
        return (await this.displays()) as T;
      case "cursor": {
        const { stdout } = await run([this.tools.xdotool, "getmouselocation", "--shell"]);
        const text = stdout.toString();
        return { x: Number(/X=(-?\d+)/.exec(text)?.[1] ?? 0), y: Number(/Y=(-?\d+)/.exec(text)?.[1] ?? 0) } as T;
      }
      case "pointer": {
        if (params.pid !== undefined) throw new X11Error("Background input on Linux goes through Cua Driver", "unsupported");
        await run([this.tools.xdotool, ...pointerArgs(params as unknown as Parameters<typeof pointerArgs>[0])]);
        return { method: "event" } as T;
      }
      case "key": {
        if (params.pid !== undefined) throw new X11Error("Background input on Linux goes through Cua Driver", "unsupported");
        const key = String(params.key ?? "");
        const mods = ((params.modifiers as string[] | undefined) ?? []).map((m) => KEYSYMS[m] ?? m);
        const sym = keysym(key);
        if (!sym) {
          if (!mods.length && [...key].length === 1) {
            await run([this.tools.xdotool, "type", "--", key]);
            return { ok: true } as T;
          }
          throw new X11Error(`Unknown key "${key}"`, "bad_request");
        }
        const combo = [...mods, sym].join("+");
        const action = params.action === "down" ? "keydown" : params.action === "up" ? "keyup" : "key";
        await run([this.tools.xdotool, action, "--clearmodifiers", combo]);
        return { ok: true } as T;
      }
      case "type": {
        if (params.pid !== undefined) throw new X11Error("Background input on Linux goes through Cua Driver", "unsupported");
        const text = String(params.text ?? "");
        await run([this.tools.xdotool, "type", "--delay", "8", "--", text], { timeoutMs: 30_000 + text.length * 20 });
        return { ok: true } as T;
      }
      case "capture":
        return (await this.capture(params as Parameters<X11Helper["capture"]>[0])) as T;
      default:
        throw new X11Error(`"${cmd}" is not available on Linux`, cmd === "windows" || cmd === "window" || cmd === "activate" || cmd === "openApp" ? "unsupported" : "bad_request");
    }
  }

  permissions() {
    return this.call<{ accessibility: boolean; screenRecording: boolean }>("permissions");
  }

  async displays(): Promise<HelperDisplay[]> {
    const { stdout } = await run([this.tools.xrandr, "--listmonitors"]);
    const list = parseMonitors(stdout.toString());
    if (list.length) return list;
    const { stdout: q } = await run([this.tools.xrandr, "-q"]);
    const m = /current (\d+) x (\d+)/.exec(q.toString());
    return m ? [{ id: "screen", name: "Screen", x: 0, y: 0, width: Number(m[1]), height: Number(m[2]), scale: 1, primary: true }] : [];
  }

  windows(): Promise<never> {
    return Promise.reject(new X11Error("Listing windows on Linux goes through Cua Driver", "unsupported"));
  }

  window(): Promise<null> {
    return Promise.resolve(null);
  }

  async capture(params: {
    display?: number | string;
    window?: number;
    maxWidth: number;
    maxHeight: number;
    format?: "jpeg" | "png";
    quality?: number;
    region?: { x: number; y: number; width: number; height: number };
  }): Promise<HelperCapture> {
    if (params.window !== undefined) throw new X11Error("Window capture on Linux goes through Cua Driver", "unsupported");
    const displays = await this.displays();
    const id = String(params.display ?? "primary");
    const d = id === "primary" ? (displays.find((x) => x.primary) ?? displays[0]) : displays.find((x) => String(x.id) === id);
    if (!d) throw new X11Error(`Display ${id} is not connected.`, "display_gone");
    let area = { x: d.x, y: d.y, width: d.width, height: d.height };
    if (params.region) {
      const r = params.region;
      const x1 = Math.max(area.x, r.x);
      const y1 = Math.max(area.y, r.y);
      const x2 = Math.min(area.x + area.width, r.x + r.width);
      const y2 = Math.min(area.y + area.height, r.y + r.height);
      if (x2 - x1 < 1 || y2 - y1 < 1) throw new X11Error("The zoom region is outside the shared area.", "bad_request");
      area = { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
    }
    const format = params.format === "png" ? "png" : "jpeg";
    const scale = Math.min(1, params.maxWidth / area.width, params.maxHeight / area.height);
    const w = Math.max(1, Math.round(area.width * scale));
    const h = Math.max(1, Math.round(area.height * scale));
    const { stdout } = await run(
      [
        this.tools.importBin,
        "-silent",
        "-window",
        "root",
        "-crop",
        `${area.width}x${area.height}+${area.x}+${area.y}`,
        "+repage",
        "-resize",
        `${w}x${h}!`,
        ...(format === "jpeg" ? ["-quality", String(Math.round((params.quality ?? 0.75) * 100))] : []),
        `${format}:-`,
      ],
      { timeoutMs: 20_000 },
    );
    const data = stdout.toString("base64");
    const size = imageSize(data);
    return {
      data,
      format,
      width: size?.width ?? w,
      height: size?.height ?? h,
      x: area.x,
      y: area.y,
      pointWidth: area.width,
      pointHeight: area.height,
    };
  }

  async close() {}
}
