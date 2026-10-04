/**
 * Desktop and display shares: the agent uses the real mouse and keyboard, like a person at the computer.
 *
 * Godmode's native helper covers every display on every platform (per-display screenshots, global coordinates across
 * monitors): the Swift helper on macOS, a PowerShell/.NET host on Windows, xrandr + ImageMagick + xdotool on X11.
 * Without it (e.g. Wayland without XWayland, missing tools) Cua Driver's desktop target covers the primary display.
 */
import type { ComputerTarget } from "@godmode/shared";
import { computerTargetLabel } from "@godmode/shared";
import { sleep } from "../../util";
import { fitSize, type Point, type Rect } from "../geometry";
import { getHelper, HelperError, type ComputerHelper, type HelperDisplay } from "../helper";
import { CuaError, cuaKeyName, cuaModifier, getCuaDriver, type CuaDriverClient } from "../cua";
import type { KeyCombo } from "../keys";
import {
  EngineError,
  SCROLL_PX_PER_NOTCH,
  sleepFor,
  type Capture,
  type CaptureOptions,
  type ComputerEngine,
  type Outcome,
  type PointerOptions,
  type ViewInfo,
  type WindowSummary,
} from "../engine";

type DesktopTarget = Extract<ComputerTarget, { kind: "desktop" | "display" }>;

/** Helper/driver errors → EngineError with a code the tools can explain. */
export function engineErrorFrom(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  if (err instanceof HelperError) {
    const code = err.code.startsWith("permission") ? "permission" : err.code === "window_gone" || err.code === "display_gone" ? "gone" : err.code;
    return new EngineError(err.message, code);
  }
  if (err instanceof CuaError) {
    const gone = /window_id_not_found|window_target_not_found|not_found/.test(err.code);
    const refused = /refused|background_|off_space|ax_unresolved|occluded|ambiguous/.test(err.code) || err.result?.structured.effect === "refused";
    return new EngineError(err.message, gone ? "gone" : err.code === "unavailable" ? "unsupported" : refused ? "refused" : "failed");
  }
  return new EngineError(err instanceof Error ? err.message : String(err), "failed");
}

async function cuaCall(tool: string, args: Record<string, unknown>) {
  try {
    const cua = await getCuaDriver();
    return await cua.exclusive(() => cua.call(tool, args));
  } catch (err) {
    throw engineErrorFrom(err);
  }
}

/* ------------------------------------------------------------------ */
/* Native helper (every display)                                        */
/* ------------------------------------------------------------------ */

export class HelperDesktopEngine implements ComputerEngine {
  readonly name = "native";
  private displayCache: { at: number; displays: HelperDisplay[] } | null = null;

  constructor(readonly target: DesktopTarget) {}

  private async helper(): Promise<ComputerHelper> {
    try {
      return await getHelper();
    } catch (err) {
      throw engineErrorFrom(err);
    }
  }

  private async displays(fresh = false): Promise<HelperDisplay[]> {
    if (!fresh && this.displayCache && Date.now() - this.displayCache.at < 3000) return this.displayCache.displays;
    const displays = await (await this.helper()).displays().catch((e) => {
      throw engineErrorFrom(e);
    });
    this.displayCache = { at: Date.now(), displays };
    return displays;
  }

  /** "display:<id>" / "display:primary" → the display (restricted to the shared one for display shares). */
  private async display(view: string): Promise<HelperDisplay> {
    const displays = await this.displays();
    const wanted = view.startsWith("display:") ? view.slice(8) : view;
    const target = this.target;
    if (target.kind === "display") {
      const d = displays.find((x) => String(x.id) === target.displayId);
      if (!d) throw new EngineError(`The shared display (${computerTargetLabel(target)}) is not connected anymore.`, "gone");
      if (wanted && wanted !== "primary" && wanted !== String(d.id)) {
        throw new EngineError(`Only ${d.name} is shared with you — other displays are off limits.`, "bad_request");
      }
      return d;
    }
    const d = wanted === "primary" || !wanted ? displays.find((x) => x.primary) ?? displays[0] : displays.find((x) => String(x.id) === wanted);
    if (!d) {
      throw new EngineError(`No display "${wanted}". Displays: ${displays.map((x) => `${x.id} (${x.name})`).join(", ")}`, "bad_request");
    }
    return d;
  }

  async views(): Promise<ViewInfo[]> {
    const displays = await this.displays(true);
    const target = this.target;
    const shared = target.kind === "display" ? displays.filter((d) => String(d.id) === target.displayId) : displays;
    if (!shared.length) throw new EngineError(`The shared display (${computerTargetLabel(this.target)}) is not connected anymore.`, "gone");
    return shared.map((d) => ({
      view: `display:${d.id}`,
      label: d.name,
      frame: { x: d.x, y: d.y, width: d.width, height: d.height },
      displayId: String(d.id),
      primary: d.primary,
    }));
  }

  async capture(view: string, opts: CaptureOptions): Promise<Capture> {
    const d = await this.display(view);
    const area: Rect = opts.region ?? { x: d.x, y: d.y, width: d.width, height: d.height };
    const size = fitSize(area.width * d.scale, area.height * d.scale, opts.maxEdge);
    try {
      const r = await (await this.helper()).capture({
        display: d.id,
        maxWidth: size.width,
        maxHeight: size.height,
        format: opts.format ?? "jpeg",
        quality: opts.quality ?? 0.75,
        cursor: opts.purpose === "live",
        ...(opts.region ? { region: opts.region } : {}),
      });
      return {
        data: r.data,
        mime: r.format === "png" ? "image/png" : "image/jpeg",
        width: r.width,
        height: r.height,
        frame: { x: r.x, y: r.y, width: r.pointWidth, height: r.pointHeight },
        label: d.name,
      };
    } catch (err) {
      throw engineErrorFrom(err);
    }
  }

  /** Keep pointer actions of a display share on that display. */
  private async guard(p: Point) {
    if (this.target.kind !== "display") return;
    const d = await this.display(`display:${this.target.displayId}`);
    if (p.x < d.x || p.y < d.y || p.x >= d.x + d.width || p.y >= d.y + d.height) {
      throw new EngineError(`That point is outside the shared display (${d.name}).`, "bad_request");
    }
  }

  private async pointer(params: Record<string, unknown>): Promise<string> {
    try {
      const r = await (await this.helper()).call<{ method: string }>("pointer", params);
      return r.method;
    } catch (err) {
      throw engineErrorFrom(err);
    }
  }

  async click(_view: string, p: Point, opts: PointerOptions): Promise<Outcome> {
    await this.guard(p);
    await this.pointer({ action: "click", x: p.x, y: p.y, button: opts.button, count: opts.count, modifiers: opts.modifiers });
    return { detail: `${opts.count === 2 ? "Double-clicked" : opts.count === 3 ? "Triple-clicked" : opts.button === "right" ? "Right-clicked" : "Clicked"}` };
  }

  async move(_view: string, p: Point): Promise<Outcome> {
    await this.guard(p);
    await this.pointer({ action: "move", x: p.x, y: p.y });
    return { detail: "Moved the pointer" };
  }

  async drag(_view: string, from: Point, to: Point, opts: PointerOptions): Promise<Outcome> {
    await this.guard(from);
    await this.guard(to);
    await this.pointer({ action: "drag", x: from.x, y: from.y, toX: to.x, toY: to.y, button: opts.button, modifiers: opts.modifiers });
    return { detail: "Dragged" };
  }

  async scroll(view: string, p: Point | null, dx: number, dy: number): Promise<Outcome> {
    let at = p;
    if (!at) {
      const c = await this.cursor();
      at = c;
    }
    await this.guard(at);
    await this.pointer({ action: "scroll", x: at.x, y: at.y, dx: dx * SCROLL_PX_PER_NOTCH, dy: dy * SCROLL_PX_PER_NOTCH });
    void view;
    return { detail: "Scrolled" };
  }

  async keys(_view: string, combos: KeyCombo[]): Promise<Outcome> {
    const helper = await this.helper();
    try {
      for (const c of combos) {
        await helper.call("key", { key: c.key, modifiers: c.modifiers });
        if (combos.length > 1) await sleep(40);
      }
    } catch (err) {
      throw engineErrorFrom(err);
    }
    return { detail: "Pressed" };
  }

  async holdKeys(_view: string, combo: KeyCombo, ms: number, signal?: AbortSignal): Promise<Outcome> {
    const helper = await this.helper();
    try {
      await helper.call("key", { key: combo.key, modifiers: combo.modifiers, action: "down" });
      await sleepFor(ms, signal);
    } finally {
      await helper.call("key", { key: combo.key, modifiers: combo.modifiers, action: "up" }).catch(() => {});
    }
    return { detail: "Held" };
  }

  async type(_view: string, text: string): Promise<Outcome> {
    try {
      await (await this.helper()).call("type", { text }, 30_000 + text.length * 20);
    } catch (err) {
      throw engineErrorFrom(err);
    }
    return { detail: `Typed ${[...text].length} characters` };
  }

  async cursor(): Promise<Point> {
    try {
      return await (await this.helper()).call<Point>("cursor");
    } catch (err) {
      throw engineErrorFrom(err);
    }
  }

  async openApp(name: string): Promise<Outcome> {
    try {
      const r = await (await this.helper()).call<{ pid: number | null; path: string }>("openApp", { name, activate: true }, 30_000);
      return { detail: `Opened ${r.path.split(/[\\/]/).pop()?.replace(/\.app$/, "") ?? name}` };
    } catch (err) {
      if (!(err instanceof HelperError && err.code === "unsupported")) throw engineErrorFrom(err);
      // Linux: apps are launched through Cua Driver.
      await cuaCall("launch_app", { name });
      return { detail: `Opened ${name}` };
    }
  }

  async windows(): Promise<WindowSummary[]> {
    let list;
    try {
      list = await (await this.helper()).windows();
    } catch (err) {
      if (!(err instanceof HelperError && err.code === "unsupported")) throw engineErrorFrom(err);
      // Windows / Linux: windows come from Cua Driver.
      const cua = await getCuaDriver().catch((e) => {
        throw engineErrorFrom(e);
      });
      return (await cua.listWindows().catch((e) => { throw engineErrorFrom(e); }))
        .filter((w) => w.bounds.width >= 60 && w.bounds.height >= 40)
        .map((w) => ({ id: w.window_id, pid: w.pid, app: w.app_name, title: w.title, frame: { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height }, onScreen: w.is_on_screen, frontmost: false }));
    }
    return list.map((w) => ({
      id: w.id,
      pid: w.pid,
      app: w.app,
      title: w.title,
      frame: { x: w.x, y: w.y, width: w.width, height: w.height },
      onScreen: w.onScreen,
      frontmost: w.frontmost,
    }));
  }

  async focusWindow(id: number): Promise<Outcome> {
    const helper = await this.helper();
    if (process.platform !== "darwin") {
      const w = (await this.windows()).find((x) => x.id === id);
      if (!w) throw new EngineError(`There is no window ${id}. Use computer_windows to list them.`, "bad_request");
      await this.guard({ x: w.frame.x + w.frame.width / 2, y: w.frame.y + w.frame.height / 2 });
      await cuaCall("bring_to_front", { pid: w.pid, window_id: id });
      return { detail: `Brought ${w.app} to the front` };
    }
    const w = await helper.window(id).catch(() => null);
    if (!w) throw new EngineError(`There is no window ${id}. Use computer_windows to list them.`, "bad_request");
    await this.guard({ x: w.x + w.width / 2, y: w.y + w.height / 2 });
    try {
      await helper.call("activate", { pid: w.pid, window: id });
    } catch (err) {
      throw engineErrorFrom(err);
    }
    return { detail: `Brought ${w.app} to the front` };
  }

  async dispose(): Promise<void> {}
}

/* ------------------------------------------------------------------ */
/* Windows / Linux: Cua Driver (primary display)                        */
/* ------------------------------------------------------------------ */

const DESKTOP = { kind: "desktop", display_id: "primary" } as const;

/** Frame space = native pixels of the primary display (what Cua Driver's desktop target expects). */
export class CuaDesktopEngine implements ComputerEngine {
  readonly name = "cua";
  private size: { width: number; height: number } | null = null;

  constructor(readonly target: DesktopTarget) {}

  private async driver(): Promise<CuaDriverClient> {
    try {
      return await getCuaDriver();
    } catch (err) {
      throw engineErrorFrom(err);
    }
  }

  private async screen(): Promise<{ width: number; height: number }> {
    if (this.size) return this.size;
    const cua = await this.driver();
    const r = await cua.call("get_desktop_state", { max_image_dimension: 64 }).catch((e) => {
      throw engineErrorFrom(e);
    });
    const w = Number(r.structured.screenshot_original_width);
    const h = Number(r.structured.screenshot_original_height);
    if (!(w > 0 && h > 0)) throw new EngineError("Could not read the screen size.", "failed");
    this.size = { width: w, height: h };
    return this.size;
  }

  async views(): Promise<ViewInfo[]> {
    const s = await this.screen();
    return [{ view: "display:primary", label: "Primary display", frame: { x: 0, y: 0, width: s.width, height: s.height }, displayId: "primary", primary: true }];
  }

  async capture(_view: string, opts: CaptureOptions): Promise<Capture> {
    const s = await this.screen();
    const fit = fitSize(s.width, s.height, opts.maxEdge);
    const r = await (await this.driver()).call("get_desktop_state", { max_image_dimension: Math.max(fit.width, fit.height) }).catch((e) => {
      throw engineErrorFrom(e);
    });
    const image = r.content.find((c) => c.type === "image" && c.data);
    const width = Number(r.structured.screenshot_width);
    const height = Number(r.structured.screenshot_height);
    if (!image || !(width > 0 && height > 0)) throw new EngineError("Cua Driver returned no screenshot.", "failed");
    const ow = Number(r.structured.screenshot_original_width) || s.width;
    const oh = Number(r.structured.screenshot_original_height) || s.height;
    this.size = { width: ow, height: oh };
    return {
      data: image.data!,
      mime: image.mimeType === "image/jpeg" ? "image/jpeg" : "image/png",
      width,
      height,
      frame: { x: 0, y: 0, width: ow, height: oh },
      label: "Primary display",
    };
  }

  private async act(tool: string, args: Record<string, unknown>): Promise<void> {
    await (await this.driver()).exclusive(() => this.driverCall(tool, args));
  }

  private async driverCall(tool: string, args: Record<string, unknown>) {
    try {
      return await (await this.driver()).call(tool, args);
    } catch (err) {
      throw engineErrorFrom(err);
    }
  }

  async click(_view: string, p: Point, opts: PointerOptions): Promise<Outcome> {
    // Double and right clicks are `click` with a count / button: double_click and right_click take no `target`.
    await this.act("click", {
      target: DESKTOP,
      x: p.x,
      y: p.y,
      ...(opts.button !== "left" ? { button: opts.button } : {}),
      ...(opts.count > 1 ? { count: opts.count } : {}),
      ...(opts.modifiers.length ? { modifier: opts.modifiers.map(cuaModifier) } : {}),
    });
    return { detail: "Clicked" };
  }

  async move(_view: string, p: Point): Promise<Outcome> {
    await this.act("move_cursor", { target: DESKTOP, x: p.x, y: p.y });
    return { detail: "Moved the pointer" };
  }

  async drag(_view: string, from: Point, to: Point, opts: PointerOptions): Promise<Outcome> {
    await this.act("drag", {
      scope: "desktop",
      from_x: from.x,
      from_y: from.y,
      to_x: to.x,
      to_y: to.y,
      ...(opts.button !== "left" ? { button: opts.button } : {}),
      ...(opts.modifiers.length ? { modifier: opts.modifiers.map(cuaModifier) } : {}),
    });
    return { detail: "Dragged" };
  }

  async scroll(_view: string, p: Point | null, dx: number, dy: number): Promise<Outcome> {
    const steps: [string, number][] = [];
    if (dy) steps.push([dy > 0 ? "down" : "up", Math.abs(dy)]);
    if (dx) steps.push([dx > 0 ? "right" : "left", Math.abs(dx)]);
    for (const [direction, amount] of steps) {
      await this.act("scroll", { scope: "desktop", direction, amount: Math.max(1, Math.round(amount)), ...(p ? { x: p.x, y: p.y } : {}) });
    }
    return { detail: "Scrolled" };
  }

  async keys(_view: string, combos: KeyCombo[]): Promise<Outcome> {
    for (const c of combos) {
      const key = cuaKeyName(c.key);
      if (!key) {
        if (!c.modifiers.length && [...c.key].length === 1) {
          await this.act("type_text", { scope: "desktop", text: c.key });
          continue;
        }
        throw new EngineError(`The key "${c.key}" can't be sent on this platform.`, "bad_request");
      }
      if (c.modifiers.length) await this.act("hotkey", { scope: "desktop", keys: [...c.modifiers.map(cuaModifier), key] });
      else await this.act("press_key", { scope: "desktop", key });
    }
    return { detail: "Pressed" };
  }

  async type(_view: string, text: string): Promise<Outcome> {
    await this.act("type_text", { scope: "desktop", text });
    return { detail: `Typed ${[...text].length} characters` };
  }

  async cursor(): Promise<Point> {
    const r = await this.driverCall("get_cursor_position", {});
    return { x: Number(r.structured.x) || 0, y: Number(r.structured.y) || 0 };
  }

  async openApp(name: string): Promise<Outcome> {
    await this.act("launch_app", { name });
    return { detail: `Opened ${name}` };
  }

  async dispose(): Promise<void> {}
}

/* ------------------------------------------------------------------ */
/* Choice                                                               */
/* ------------------------------------------------------------------ */

/**
 * Windows / Linux: the native helper when it can run here (PowerShell host, or the X11 tools), else Cua Driver's
 * primary display. Decided on first use.
 */
class AutoDesktopEngine implements ComputerEngine {
  readonly name = "desktop";
  private inner: Promise<ComputerEngine> | null = null;

  constructor(readonly target: DesktopTarget) {}

  private engine(): Promise<ComputerEngine> {
    this.inner ??= getHelper().then(
      () => new HelperDesktopEngine(this.target) as ComputerEngine,
      () => new CuaDesktopEngine(this.target) as ComputerEngine,
    );
    return this.inner;
  }

  private async optional<K extends "cursor" | "openApp" | "windows" | "focusWindow" | "holdKeys">(name: K): Promise<NonNullable<ComputerEngine[K]>> {
    const e = await this.engine();
    const fn = e[name];
    if (!fn) throw new EngineError("That isn't available on this system.", "unsupported");
    return (fn as (...args: unknown[]) => unknown).bind(e) as NonNullable<ComputerEngine[K]>;
  }

  views() {
    return this.engine().then((e) => e.views());
  }
  capture(view: string, opts: CaptureOptions) {
    return this.engine().then((e) => e.capture(view, opts));
  }
  click(view: string, p: Point, opts: PointerOptions) {
    return this.engine().then((e) => e.click(view, p, opts));
  }
  move(view: string, p: Point) {
    return this.engine().then((e) => e.move(view, p));
  }
  drag(view: string, from: Point, to: Point, opts: PointerOptions) {
    return this.engine().then((e) => e.drag(view, from, to, opts));
  }
  scroll(view: string, p: Point | null, dx: number, dy: number, opts: { foreground?: boolean }) {
    return this.engine().then((e) => e.scroll(view, p, dx, dy, opts));
  }
  keys(view: string, combos: KeyCombo[], opts: { foreground?: boolean }) {
    return this.engine().then((e) => e.keys(view, combos, opts));
  }
  type(view: string, text: string, opts: { foreground?: boolean }) {
    return this.engine().then((e) => e.type(view, text, opts));
  }
  async holdKeys(view: string, combo: KeyCombo, ms: number, signal?: AbortSignal) {
    return (await this.optional("holdKeys"))(view, combo, ms, signal);
  }
  async cursor() {
    return (await this.optional("cursor"))();
  }
  async openApp(name: string) {
    return (await this.optional("openApp"))(name);
  }
  async windows() {
    return (await this.optional("windows"))();
  }
  async focusWindow(id: number) {
    return (await this.optional("focusWindow"))(id);
  }
  async dispose() {
    if (this.inner) await (await this.inner).dispose();
  }
}

export function desktopEngine(target: DesktopTarget): ComputerEngine {
  return process.platform === "darwin" ? new HelperDesktopEngine(target) : new AutoDesktopEngine(target);
}
