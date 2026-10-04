/**
 * Window shares — like sharing a single window with ChatGPT: the agent sees and controls one app window in the
 * background. Its input goes to that window's process; the human's cursor and focus stay where they are.
 *
 * Cua Driver does the work (accessibility-first: element tokens, AX text insertion, background pointer events).
 * On macOS Godmode's native helper backs it up: it captures windows quickly for the live view, and it delivers
 * pointer/keyboard events to the window's process (CGEventPostToPid + AXPress) when the driver refuses a background
 * action — the driver refuses whenever it can't match the window in the accessibility tree, which the helper
 * doesn't need. Without Cua Driver (turned off or not installed) the helper handles everything on macOS.
 *
 * Frame space is window-local points (origin = the window's top-left), so an action still lands on the same spot of
 * the window when the human moved it after the screenshot. The helper gets global points at the time of the action.
 *
 * The agent's pointer input never moves the human's cursor, so on macOS the helper draws an agent cursor over the
 * window (like ChatGPT's): it glides to each point before the input lands there. Cua Driver's own cursor stays off.
 *
 * Background clicks go to the helper first on macOS: posted mouse and key events don't reach the web content of a
 * background Chromium-family window (Chrome, Edge, Arc, Slack, VS Code…) on current macOS — Cua Driver's either — so
 * the helper presses the element under the point through accessibility and types into the web field it focused.
 */
import type { ComputerTarget } from "@godmode/shared";
import { computerTargetLabel } from "@godmode/shared";
import { logger } from "../../log";
import { getSettings } from "../../services/settings";
import { sleep } from "../../util";
import { fitSize, type Point, type Rect } from "../geometry";
import { getHelper, NativeHelper } from "../helper";
import { CuaError, cuaKeyName, cuaModifier, getCuaDriver, scrubSummary, type CuaDriverClient, type CuaResult, type Delivery } from "../cua";
import type { KeyCombo } from "../keys";
import {
  EngineError,
  SCROLL_PX_PER_NOTCH,
  errorMessage,
  type Capture,
  type CaptureOptions,
  type ComputerEngine,
  type Outcome,
  type PointerOptions,
  type UiElement,
  type ViewInfo,
} from "../engine";
import { engineErrorFrom } from "./desktop";

const log = logger("computer");

type WindowTarget = Extract<ComputerTarget, { kind: "window" }>;

/** Driver refusals worth retrying through the native helper (not "the window is gone"). */
function fallbackWorthy(err: unknown): boolean {
  if (!(err instanceof CuaError)) return false;
  if (/window_id_not_found|window_target_not_found|window_owner_pid_mismatch/.test(err.code)) return false;
  return true;
}

/** "✅ Performed AXPress on [2] AXButton "Press me"." → a short, scrubbed line for the model. */
/** Chromium web pages in the background take no key events: what the model can do instead. */
function webKeysNote(allowForeground: boolean): string {
  return `key events usually don't reach the web page of a background Chrome/Electron window. Click the text field first (then type — Godmode types into the field it focused), type into it by its computer_ui element, and press the page's own button instead of Return${allowForeground ? ", or retry with foreground: true" : ""}.`;
}

function describe(r: CuaResult, fallback: string): string {
  const summary = typeof r.structured.summary === "string" ? r.structured.summary : r.text;
  const line = scrubSummary(summary).split("\n")[0]?.replace(/^✅\s*/, "").trim();
  const effect = typeof r.structured.effect === "string" ? r.structured.effect : null;
  const base = line || fallback;
  return effect === "unverifiable" || effect === "suspected_noop" ? `${base} (not verified — check the next screenshot)` : base;
}

export class WindowEngine implements ComputerEngine {
  readonly name: string;
  private lastBounds: { at: number; rect: Rect } | null = null;
  /** App and title as last seen (view keys only carry ids). */
  private seen: { app: string; title: string } | null = null;
  /** Visible on the current Space (not minimized, hidden or on another desktop). */
  private onScreen = true;
  /** Elements handed to the model, so a token made stale by a newer driver snapshot can be found again. */
  private known = new Map<string, { role: string; label: string; frame: Rect | null }>();
  private cuaDisabledReason: string | null = null;
  private cursorShown = false;

  constructor(
    readonly target: WindowTarget,
    private opts: { useCua: boolean; allowForeground: boolean; agentCursor?: boolean },
  ) {
    this.name = opts.useCua ? "cua" : "native";
    if (!opts.useCua) this.cuaDisabledReason = "Cua Driver is turned off in Settings → Computer.";
  }

  private get ref() {
    return { pid: this.target.pid, windowId: this.target.windowId };
  }

  private async cua(): Promise<CuaDriverClient | null> {
    if (this.cuaDisabledReason) return null;
    try {
      return await getCuaDriver();
    } catch (err) {
      this.cuaDisabledReason = errorMessage(err);
      log.info(`window share without Cua Driver: ${this.cuaDisabledReason}`);
      return null;
    }
  }

  /** Background window input and capture: the macOS helper only (Cua Driver elsewhere). */
  private async helper(): Promise<NativeHelper | null> {
    if (process.platform !== "darwin") return null;
    try {
      const h = await getHelper();
      return h instanceof NativeHelper ? h : null;
    } catch {
      return null;
    }
  }

  private label(): string {
    const app = this.target.app || this.seen?.app || "Window";
    const title = this.seen?.title || this.target.title;
    return title ? `${app} — ${title}` : app;
  }

  private gone(): EngineError {
    return new EngineError(`The shared window (${computerTargetLabel(this.target)}) was closed. Ask the human to share it again.`, "gone");
  }

  private delivery(foreground?: boolean): Delivery | undefined {
    return foreground && this.opts.allowForeground ? "foreground" : undefined;
  }

  /** Current window bounds (global points). */
  async bounds(fresh = false): Promise<Rect> {
    if (!fresh && this.lastBounds && Date.now() - this.lastBounds.at < 1500) return this.lastBounds.rect;
    const helper = await this.helper();
    let rect: Rect | null = null;
    if (helper) {
      const w = await helper.window(this.target.windowId).catch(() => null);
      if (!w || w.pid !== this.target.pid) throw this.gone();
      rect = { x: w.x, y: w.y, width: w.width, height: w.height };
      this.seen = { app: w.app, title: w.title };
      this.onScreen = w.onScreen;
    } else {
      const cua = await this.cua();
      if (!cua) throw new EngineError(this.cuaDisabledReason ?? "Cua Driver is not available.", "unsupported");
      const list = await cua.listWindows(this.target.pid).catch((e) => {
        throw engineErrorFrom(e);
      });
      const w = list.find((x) => x.window_id === this.target.windowId);
      if (!w) throw this.gone();
      rect = { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height };
      this.seen = { app: w.app_name, title: w.title };
      this.onScreen = w.is_on_screen;
    }
    this.lastBounds = { at: Date.now(), rect };
    return rect;
  }

  /** Window-local point → global point, with the window where it is now. */
  private async global(p: Point): Promise<Point> {
    const b = await this.bounds(true);
    return { x: b.x + p.x, y: b.y + p.y };
  }

  private async size(): Promise<{ width: number; height: number }> {
    const b = await this.bounds();
    return { width: b.width, height: b.height };
  }

  /**
   * Keys posted to an app reach its key window. On macOS make the shared window the app's key window first (within
   * the app, without activating it) — and refuse rather than type into another of its windows.
   */
  private async ensureKeyWindow(foreground?: boolean): Promise<void> {
    if (foreground && this.opts.allowForeground) return;
    const helper = await this.helper();
    if (!helper) return;
    try {
      // "unknown" (not resolvable through accessibility, e.g. on another Space): Cua Driver may still deliver.
      await helper.call<{ state: string }>("ensureKeyWindow", { pid: this.target.pid, window: this.target.windowId });
    } catch (err) {
      const e = engineErrorFrom(err);
      if (e.code === "gone") throw this.gone();
      throw new EngineError(`${e.message} Typing into a field by its accessibility element still works.`, "refused");
    }
  }

  async views(): Promise<ViewInfo[]> {
    const b = await this.bounds(true);
    return [{ view: `window:${this.target.pid}:${this.target.windowId}`, label: this.label(), frame: { x: 0, y: 0, width: b.width, height: b.height } }];
  }

  async capture(_view: string, opts: CaptureOptions): Promise<Capture> {
    const helper = await this.helper();
    // The helper captures in ~40 ms as JPEG, without touching the driver's per-window coordinate state.
    if (helper) {
      const b = await this.bounds(true);
      const region = opts.region ? { x: b.x + opts.region.x, y: b.y + opts.region.y, width: opts.region.width, height: opts.region.height } : null;
      const area = region ?? b;
      const size = fitSize(area.width * 2, area.height * 2, opts.maxEdge);
      try {
        const r = await helper.capture({
          window: this.target.windowId,
          maxWidth: size.width,
          maxHeight: size.height,
          format: opts.format ?? "jpeg",
          quality: opts.quality ?? 0.75,
          ...(region ? { region } : {}),
        });
        return {
          data: r.data,
          mime: r.format === "png" ? "image/png" : "image/jpeg",
          width: r.width,
          height: r.height,
          frame: { x: r.x - b.x, y: r.y - b.y, width: r.pointWidth, height: r.pointHeight },
          label: this.label(),
        };
      } catch (err) {
        const e = engineErrorFrom(err);
        if (e.code === "gone" || e.code === "permission") throw e.code === "gone" ? this.gone() : e;
        if (!(await this.cua())) throw e;
      }
    }
    const cua = await this.cua();
    if (!cua) throw new EngineError(this.cuaDisabledReason ?? "Window capture is not available on this computer.", "unsupported");
    if (opts.region) throw new EngineError("Zooming into a window needs Godmode's native helper (macOS).", "unsupported");
    try {
      const s = await cua.windowShot(this.target.pid, this.target.windowId, opts.maxEdge);
      if (!s.image || !s.bounds) throw new EngineError(s.degradedReason ?? "Cua Driver returned no screenshot of the window.", "failed");
      this.lastBounds = { at: Date.now(), rect: s.bounds };
      if (s.app || s.title) this.seen = { app: s.app, title: s.title };
      return {
        data: s.image.data,
        mime: s.image.mime,
        width: s.image.width,
        height: s.image.height,
        frame: { x: 0, y: 0, width: s.bounds.width, height: s.bounds.height },
        label: this.label(),
      };
    } catch (err) {
      const e = engineErrorFrom(err);
      throw e.code === "gone" ? this.gone() : e;
    }
  }

  /** Try Cua Driver, then the native helper (macOS), then explain. */
  private async route(action: string, viaCua: ((cua: CuaDriverClient) => Promise<string>) | null, viaHelper: ((h: NativeHelper) => Promise<string>) | null): Promise<Outcome> {
    let refusal: string | null = null;
    const cua = viaCua ? await this.cua() : null;
    if (cua && viaCua) {
      try {
        return { detail: await viaCua(cua) };
      } catch (err) {
        const e = engineErrorFrom(err);
        if (e.code === "gone") throw this.gone();
        if (!fallbackWorthy(err)) throw e;
        refusal = e.message;
        log.debug(`cua ${action} refused (${(err as CuaError).code}); trying the native helper`);
      }
    }
    const helper = viaHelper ? await this.helper() : null;
    if (helper && viaHelper) {
      try {
        const detail = await viaHelper(helper);
        await this.bounds(true).catch(() => null);
        return {
          detail: this.onScreen
            ? detail
            : `${detail} — but the window is not visible (minimized, hidden or on another desktop/Space), so the input probably didn't arrive. Ask the human to bring the window back on screen.`,
        };
      } catch (err) {
        const e = engineErrorFrom(err);
        throw e.code === "gone" ? this.gone() : e;
      }
    }
    if (refusal) {
      throw new EngineError(
        `${refusal}${this.opts.allowForeground ? " You may retry with foreground: true (briefly brings the window to the front)." : " Try clicking an element from computer_ui instead."}`,
        "refused",
      );
    }
    throw new EngineError(this.cuaDisabledReason ?? `Can't ${action} in a background window on this computer.`, "unsupported");
  }

  private helperPointer(h: NativeHelper, params: Record<string, unknown>) {
    if (this.opts.agentCursor) this.cursorShown = true;
    return h.call<{ method: string; chromium?: boolean; cameToFront?: boolean }>("pointer", { pid: this.target.pid, window: this.target.windowId, cursor: !!this.opts.agentCursor, ...params });
  }

  /**
   * Before Cua Driver acts at a window-local point: glide the agent cursor there (and ring on a click). Best effort —
   * the helper draws the cursor for its own input.
   */
  private async pointAt(p: Point, click: boolean): Promise<void> {
    if (!this.opts.agentCursor) return;
    const helper = await this.helper();
    if (!helper) return;
    try {
      const g = await this.global(p);
      this.cursorShown = true;
      await helper.call("agentCursor", { window: this.target.windowId, x: g.x, y: g.y, click }, 3000);
    } catch (err) {
      log.debug(`agent cursor: ${errorMessage(err)}`);
    }
  }

  /**
   * Text and editing keys for the web field a background click focused (Chromium-family apps, macOS): the helper
   * applies them through accessibility. `chromium` tells whether the app is one whose pages ignore key events.
   */
  private async webInput(cmd: "type" | "key", params: Record<string, unknown>, foreground?: boolean): Promise<{ handled: boolean; chromium: boolean }> {
    if (foreground && this.opts.allowForeground) return { handled: false, chromium: false };
    const helper = await this.helper();
    if (!helper) return { handled: false, chromium: false };
    const r = await helper.call<{ method: string | null; chromium?: boolean }>(cmd, { ...params, pid: this.target.pid, webOnly: true }).catch(() => null);
    return { handled: !!r?.method, chromium: !!r?.chromium };
  }

  async click(_view: string, p: Point, opts: PointerOptions): Promise<Outcome> {
    const maxDimension = getSettings().computer.screenshotMaxSize;
    const verb = opts.count === 2 ? "Double-clicked" : opts.count === 3 ? "Triple-clicked" : opts.button === "right" ? "Right-clicked" : "Clicked";
    const viaHelper = async (h: NativeHelper) => {
      const g = await this.global(p);
      const r = await this.helperPointer(h, { action: "click", x: g.x, y: g.y, button: opts.button, count: opts.count, modifiers: opts.modifiers });
      if (r.method === "ax") return `${verb} (pressed the element via accessibility)`;
      if (r.method === "ax-focus") return `${verb} (focused the text field — type now)`;
      const front = r.cameToFront ? " The app came to the front — the human may notice." : "";
      return r.chromium
        ? `${verb} (sent as background mouse events — the web page of a background Chrome/Electron window often ignores those; check the next screenshot and click by computer_ui element if nothing changed)${front}`
        : `${verb} (background)${front}`;
    };
    const viaCua = async (cua: CuaDriverClient) => {
      await this.pointAt(p, true);
      const r = await cua.pointer("click", this.ref, p, {
        button: opts.button,
        count: opts.count,
        modifiers: opts.modifiers.map(cuaModifier),
        delivery: this.delivery(opts.foreground),
        maxDimension,
        size: await this.size(),
      });
      return describe(r, verb);
    };
    // The helper first on macOS: accessibility for web content, Cua Driver's event recipe otherwise — and Cua Driver
    // when the helper fails. Foreground delivery is Cua Driver's.
    if (!(opts.foreground && this.opts.allowForeground) && (await this.helper())) {
      try {
        return await this.route("click", null, viaHelper);
      } catch (err) {
        if (!(err instanceof EngineError) || err.code === "gone" || !(await this.cua())) throw err;
        log.debug(`helper click failed (${err.message}); trying Cua Driver`);
        return this.route("click", viaCua, null);
      }
    }
    return this.route("click", viaCua, viaHelper);
  }

  async move(_view: string, p: Point): Promise<Outcome> {
    return this.route("move the pointer", null, async (h) => {
      const g = await this.global(p);
      await this.helperPointer(h, { action: "move", x: g.x, y: g.y });
      return "Moved the pointer (hover)";
    });
  }

  async drag(_view: string, from: Point, to: Point, opts: PointerOptions): Promise<Outcome> {
    const maxDimension = getSettings().computer.screenshotMaxSize;
    return this.route(
      "drag",
      async (cua) => {
        await this.pointAt(from, false);
        const r = await cua.drag(this.ref, from, to, {
          button: opts.button,
          modifiers: opts.modifiers.map(cuaModifier),
          delivery: this.delivery(opts.foreground),
          maxDimension,
          size: await this.size(),
        });
        return describe(r, "Dragged");
      },
      async (h) => {
        const a = await this.global(from);
        const b = await this.global(to);
        await this.helperPointer(h, { action: "drag", x: a.x, y: a.y, toX: b.x, toY: b.y, button: opts.button, modifiers: opts.modifiers });
        return "Dragged (background)";
      },
    );
  }

  async scroll(_view: string, p: Point | null, dx: number, dy: number, opts: { foreground?: boolean }): Promise<Outcome> {
    const maxDimension = getSettings().computer.screenshotMaxSize;
    const viaHelper = async (h: NativeHelper) => {
      const b = await this.bounds(true);
      const at = p ? { x: b.x + p.x, y: b.y + p.y } : { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      const r = await this.helperPointer(h, { action: "scroll", x: at.x, y: at.y, dx: dx * SCROLL_PX_PER_NOTCH, dy: dy * SCROLL_PX_PER_NOTCH });
      return r.method === "ax"
        ? "Scrolled (background)"
        : "Sent a scroll wheel event (background, not verified — if nothing moved, click into the area and press PageDown / PageUp instead)";
    };
    // Cua Driver's background wheel lands where the human's pointer is, not at the point; the helper places the
    // event at the point, so it goes first when it is available (macOS). Foreground delivery is Cua Driver's.
    if (!opts.foreground && (await this.helper())) {
      return this.route("scroll", null, viaHelper);
    }
    return this.route(
      "scroll",
      async (cua) => {
        const local = p;
        if (local) await this.pointAt(local, false);
        const size = await this.size();
        const steps: ["up" | "down" | "left" | "right", number][] = [];
        if (dy) steps.push([dy > 0 ? "down" : "up", Math.abs(dy)]);
        if (dx) steps.push([dx > 0 ? "right" : "left", Math.abs(dx)]);
        let last = "Scrolled";
        for (const [direction, amount] of steps) {
          const r = await cua.scroll(this.ref, local, direction, Math.max(1, Math.round(amount)), { delivery: this.delivery(opts.foreground), maxDimension, size });
          last = describe(r, "Scrolled");
        }
        return last;
      },
      viaHelper,
    );
  }

  async keys(_view: string, combos: KeyCombo[], opts: { foreground?: boolean }): Promise<Outcome> {
    const details: string[] = [];
    let keyWindow = false;
    let chromium = false;
    const sent: KeyCombo[] = [];
    for (const c of combos) {
      const web = await this.webInput("key", { key: c.key, modifiers: c.modifiers }, opts.foreground);
      if (web.handled) {
        details.push("Pressed (applied to the focused field via accessibility)");
        continue;
      }
      chromium ||= web.chromium;
      sent.push(c);
      if (!keyWindow) {
        await this.ensureKeyWindow(opts.foreground);
        keyWindow = true;
      }
      const key = cuaKeyName(c.key);
      const outcome = await this.route(
        "press keys",
        key
          ? async (cua) => describe(await cua.pressKeys(this.ref, key, c.modifiers.map(cuaModifier), { delivery: this.delivery(opts.foreground) }), "Pressed")
          : !c.modifiers.length && [...c.key].length === 1
            ? async (cua) => describe(await cua.typeText(this.ref, c.key, { delivery: this.delivery(opts.foreground) }), "Typed")
            : null,
        async (h) => {
          await h.call("key", { key: c.key, modifiers: c.modifiers, pid: this.target.pid });
          return "Pressed (background)";
        },
      );
      details.push(outcome.detail);
      if (combos.length > 1) await sleep(40);
    }
    const note = chromium
      ? ` — but ${webKeysNote(this.opts.allowForeground)}`
      : sent.some((c) => c.modifiers.some((m) => m === "cmd" || m === "ctrl"))
        ? " Shortcuts with cmd/ctrl don't always reach a window in the background — check the result and use menus or elements if nothing happened."
        : "";
    return { detail: `${details[details.length - 1] ?? "Pressed"}${note}` };
  }

  async type(_view: string, text: string, opts: { foreground?: boolean }): Promise<Outcome> {
    const web = await this.webInput("type", { text }, opts.foreground);
    if (web.handled) return { detail: `Typed ${[...text].length} characters into the focused field (via accessibility)` };
    await this.ensureKeyWindow(opts.foreground);
    const out = await this.route(
      "type",
      async (cua) => describe(await cua.typeText(this.ref, text, { delivery: this.delivery(opts.foreground) }), `Typed ${[...text].length} characters`),
      async (h) => {
        await h.call("type", { text, pid: this.target.pid }, 30_000 + text.length * 20);
        return `Typed ${[...text].length} characters (background)`;
      },
    );
    return web.chromium ? { detail: `${out.detail} — but ${webKeysNote(this.opts.allowForeground)}` } : out;
  }

  async elements(query?: string): Promise<{ elements: UiElement[]; note: string | null }> {
    const cua = await this.cua();
    if (!cua) throw new EngineError(`${this.cuaDisabledReason ?? "Cua Driver is not available."} Use screenshots and coordinates instead.`, "unsupported");
    try {
      const s = await cua.windowState(this.target.pid, this.target.windowId, { screenshot: false, maxDimension: 0, query, maxElements: 600 });
      const b = await this.bounds(true);
      const elements: UiElement[] = s.elements
        .filter((e) => e.element_token)
        .map((e) => ({
          token: e.element_token!,
          role: e.role ?? "",
          label: (e.label ?? "").trim(),
          value: e.value ?? null,
          actions: e.actions ?? [],
          frame: e.frame ? { x: e.frame.x - b.x, y: e.frame.y - b.y, width: e.frame.w, height: e.frame.h } : null,
          depth: e.depth ?? 0,
        }));
      if (!query) this.known.clear();
      for (const e of elements) this.known.set(e.token, { role: e.role, label: e.label, frame: e.frame });
      const note = s.degradedReason
        ? `The window's accessibility tree is not available (${s.degradedReason.split(":")[0]}); use screenshots and coordinates.`
        : s.truncated
          ? "The list was truncated — pass a query to narrow it."
          : null;
      return { elements, note };
    } catch (err) {
      const e = engineErrorFrom(err);
      throw e.code === "gone" ? this.gone() : e;
    }
  }

  /**
   * The driver's current token for an element the model got earlier: other driver snapshots (screenshots, pixel
   * actions) supersede tokens, so look the element up again by role, label and position.
   */
  private async refreshToken(cua: CuaDriverClient, token: string): Promise<string | null> {
    const was = this.known.get(token);
    if (!was) return null;
    const s = await cua.windowState(this.target.pid, this.target.windowId, { screenshot: false, maxDimension: 0, maxElements: 2000 });
    const b = await this.bounds(true);
    const center = (f: Rect | null) => (f ? { x: f.x + f.width / 2, y: f.y + f.height / 2 } : null);
    const c0 = center(was.frame);
    let best: { token: string; distance: number } | null = null;
    for (const e of s.elements) {
      if (!e.element_token || (e.role ?? "") !== was.role || (e.label ?? "").trim() !== was.label) continue;
      const c1 = center(e.frame ? { x: e.frame.x - b.x, y: e.frame.y - b.y, width: e.frame.w, height: e.frame.h } : null);
      const distance = c0 && c1 ? Math.hypot(c0.x - c1.x, c0.y - c1.y) : 0;
      if (!best || distance < best.distance) best = { token: e.element_token, distance };
    }
    if (!best || best.distance > 80) return null;
    this.known.set(best.token, was);
    return best.token;
  }

  private async withElement(token: string, fn: (cua: CuaDriverClient, token: string) => Promise<CuaResult>, fallback: string): Promise<Outcome> {
    const cua = await this.cua();
    if (!cua) throw new EngineError(this.cuaDisabledReason ?? "Cua Driver is not available.", "unsupported");
    try {
      return { detail: describe(await fn(cua, token), fallback) };
    } catch (err) {
      const stale = err instanceof CuaError && /stale|snapshot/i.test(`${err.code} ${err.message}`);
      if (stale) {
        const fresh = await this.refreshToken(cua, token).catch(() => null);
        if (fresh) {
          try {
            return { detail: describe(await fn(cua, fresh), fallback) };
          } catch (again) {
            const e = engineErrorFrom(again);
            throw e.code === "gone" ? this.gone() : e;
          }
        }
        throw new EngineError("That element changed since computer_ui — call computer_ui again for fresh tokens.", "bad_request");
      }
      const e = engineErrorFrom(err);
      throw e.code === "gone" ? this.gone() : e;
    }
  }

  async clickElement(token: string, opts: PointerOptions): Promise<Outcome> {
    const frame = this.known.get(token)?.frame;
    if (frame) await this.pointAt({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }, true);
    return this.withElement(
      token,
      (cua, t) => cua.clickElement(this.ref, t, { button: opts.button === "right" ? "right" : "left", count: opts.count, delivery: this.delivery(opts.foreground) }),
      "Clicked the element",
    );
  }

  async typeInto(token: string, text: string, opts: { foreground?: boolean }): Promise<Outcome> {
    const frame = this.known.get(token)?.frame;
    if (frame) await this.pointAt({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }, false);
    return this.withElement(token, (cua, t) => cua.typeText(this.ref, text, { element: t, delivery: this.delivery(opts.foreground) }), `Typed ${[...text].length} characters`);
  }

  async dispose(): Promise<void> {
    if (!this.cursorShown) return;
    this.cursorShown = false;
    const helper = await this.helper();
    await helper?.call("agentCursor", { hide: true, window: this.target.windowId }, 3000).catch(() => {});
  }
}

/** `agent`: the run's engine — its pointer input shows the agent cursor (when turned on in Settings). */
export function windowEngine(target: WindowTarget, opts: { agent?: boolean } = {}): WindowEngine {
  const s = getSettings().computer;
  return new WindowEngine(target, { useCua: s.useCuaDriver, allowForeground: s.allowForeground, agentCursor: !!opts.agent && s.agentCursor });
}
