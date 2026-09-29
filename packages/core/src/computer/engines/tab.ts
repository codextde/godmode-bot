/**
 * Tab shares: one tab of a Godmode-managed browser, controlled over CDP. Works in the background — the tab doesn't
 * need to be the visible one and the browser never takes focus. Frame space is the tab's viewport in CSS pixels.
 */
import type { ComputerTarget } from "@godmode/shared";
import { computerTargetLabel } from "@godmode/shared";
import { attachToPage, listPages, type CdpClient, type PageSession } from "../../browser/cdp";
import { getRunning, touchBrowser } from "../../browser/state";
import { sleep } from "../../util";
import { fitSize, type Point, type Rect } from "../geometry";
import { imageSize } from "../image";
import { isGodmodeTab } from "../self";
import type { KeyCombo, Modifier } from "../keys";
import {
  EngineError,
  errorMessage,
  sleepFor,
  type Capture,
  type CaptureOptions,
  type ComputerEngine,
  type Outcome,
  type PointerOptions,
  type ViewInfo,
} from "../engine";

type TabTarget = Extract<ComputerTarget, { kind: "tab" }>;

const WHEEL_PX_PER_NOTCH = 100;

interface CdpKey {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: Record<string, CdpKey> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  kpenter: { key: "Enter", code: "NumpadEnter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
  capslock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
};
for (let i = 1; i <= 20; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

/** Canonical key (keys.ts) → CDP key event fields. */
export function cdpKey(key: string, shift: boolean): CdpKey {
  const named = NAMED[key];
  if (named) return named;
  const ch = shift && /^[a-z]$/.test(key) ? key.toUpperCase() : key;
  if (/^[a-z]$/i.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), text: ch };
  return { key: ch, code: "", keyCode: 0, text: ch };
}

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function cdpModifiers(mods: Modifier[]): number {
  let m = 0;
  if (mods.includes("alt")) m |= 1;
  if (mods.includes("ctrl")) m |= 2;
  if (mods.includes("cmd")) m |= 4;
  if (mods.includes("shift")) m |= 8;
  return m;
}

/** Editing commands Chrome needs for shortcuts sent over CDP (cmd on macOS, ctrl elsewhere). */
export function cdpCommands(combo: KeyCombo, platform = process.platform): string[] {
  const primary = platform === "darwin" ? "cmd" : "ctrl";
  if (!combo.modifiers.includes(primary)) return [];
  const shift = combo.modifiers.includes("shift");
  switch (combo.key.toLowerCase()) {
    case "a":
      return ["selectAll"];
    case "c":
      return ["copy"];
    case "x":
      return ["cut"];
    case "v":
      return ["paste"];
    case "z":
      return [shift ? "redo" : "undo"];
    case "y":
      return ["redo"];
    default:
      return [];
  }
}

const BUTTON_MASK = { left: 1, right: 2, middle: 4 } as const;

export class TabEngine implements ComputerEngine {
  readonly name = "cdp";
  private session: PageSession | null = null;
  private client: CdpClient | null = null;

  constructor(readonly target: TabTarget) {}

  private gone(why = "was closed"): EngineError {
    return new EngineError(`The shared browser tab (${computerTargetLabel(this.target)}) ${why}. Ask the human to share it again.`, "gone");
  }

  private async page(): Promise<PageSession> {
    const rb = getRunning(this.target.profileId);
    if (!rb) throw this.gone("isn't open anymore (its browser stopped)");
    touchBrowser(this.target.profileId);
    // The tab may have navigated since it was shared: Godmode's own dashboard stays off limits.
    const info = await rb.client
      .send<{ targetInfo: { url: string } }>("Target.getTargetInfo", { targetId: this.target.targetId })
      .catch(() => null);
    if (info && isGodmodeTab(info.targetInfo.url)) throw new EngineError("The shared tab now shows Godmode itself, which is off limits.", "refused");
    if (this.session && this.client === rb.client && !rb.client.closed) return this.session;
    const pages = await listPages(rb.client, rb.port).catch(() => []);
    if (!pages.some((p) => p.targetId === this.target.targetId)) throw this.gone();
    try {
      this.session = await attachToPage(rb.client, this.target.targetId);
    } catch {
      throw this.gone();
    }
    this.client = rb.client;
    // Let a background tab behave as focused (inputs accept focus, :focus styles apply).
    await this.session.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    return this.session;
  }

  /**
   * Run CDP calls on the tab. When the session died (e.g. the renderer was swapped), `retry` re-attaches and runs `fn`
   * once more — only for reads: input is never replayed (a half-sent click or typed text must not happen twice).
   */
  private async withPage<T>(fn: (s: PageSession) => Promise<T>, retry = true): Promise<T> {
    let s = await this.page();
    try {
      return await fn(s);
    } catch (err) {
      this.session = null;
      const gone = /session|target closed|detached|not attached/i.test(errorMessage(err));
      if (!retry || !gone) throw err instanceof EngineError ? err : new EngineError(`The browser tab didn't respond: ${errorMessage(err)}`, "failed");
      s = await this.page();
      try {
        return await fn(s);
      } catch (again) {
        throw new EngineError(`The browser tab didn't respond: ${errorMessage(again)}`, "failed");
      }
    }
  }

  private async metrics(s: PageSession): Promise<{ width: number; height: number; pageX: number; pageY: number; dpr: number }> {
    const m = await s.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number } }>("Page.getLayoutMetrics");
    const dpr = await s.evaluate<number>("window.devicePixelRatio", { timeoutMs: 3000 }).catch(() => 1);
    const v = m.cssVisualViewport;
    return { width: v.clientWidth, height: v.clientHeight, pageX: v.pageX, pageY: v.pageY, dpr: dpr > 0 ? dpr : 1 };
  }

  private async title(): Promise<string> {
    const rb = getRunning(this.target.profileId);
    if (!rb) return computerTargetLabel(this.target);
    try {
      const { targetInfo } = await rb.client.send<{ targetInfo: { title: string; url: string } }>("Target.getTargetInfo", { targetId: this.target.targetId });
      return targetInfo.title || targetInfo.url || computerTargetLabel(this.target);
    } catch {
      return computerTargetLabel(this.target);
    }
  }

  async views(): Promise<ViewInfo[]> {
    const m = await this.withPage((s) => this.metrics(s));
    return [
      {
        view: `tab:${this.target.profileId}:${this.target.targetId}`,
        label: await this.title(),
        frame: { x: 0, y: 0, width: m.width, height: m.height },
      },
    ];
  }

  async capture(_view: string, opts: CaptureOptions): Promise<Capture> {
    return this.withPage(async (s) => {
      const m = await this.metrics(s);
      const area: Rect = opts.region ?? { x: 0, y: 0, width: m.width, height: m.height };
      const fit = fitSize(area.width * m.dpr, area.height * m.dpr, opts.maxEdge);
      const scale = fit.width / (area.width * m.dpr);
      const format = opts.format ?? "jpeg";
      const { data } = await s.send<{ data: string }>(
        "Page.captureScreenshot",
        {
          format,
          ...(format === "jpeg" ? { quality: Math.round((opts.quality ?? 0.75) * 100) } : {}),
          clip: { x: m.pageX + area.x, y: m.pageY + area.y, width: area.width, height: area.height, scale },
          captureBeyondViewport: false,
        },
        15_000,
      );
      const size = imageSize(data);
      if (!size) throw new EngineError("The browser returned an unreadable screenshot.", "failed");
      return { data, mime: size.mime, width: size.width, height: size.height, frame: area, label: await this.title() };
    });
  }

  private mouse(s: PageSession, type: string, p: Point, extra: Record<string, unknown> = {}) {
    return s.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, ...extra });
  }

  async click(_view: string, p: Point, opts: PointerOptions): Promise<Outcome> {
    await this.withPage(async (s) => {
      const modifiers = cdpModifiers(opts.modifiers);
      await this.mouse(s, "mouseMoved", p, { button: "none", buttons: 0, modifiers });
      for (let i = 1; i <= opts.count; i++) {
        await this.mouse(s, "mousePressed", p, { button: opts.button, buttons: BUTTON_MASK[opts.button], clickCount: i, modifiers });
        await this.mouse(s, "mouseReleased", p, { button: opts.button, buttons: 0, clickCount: i, modifiers });
      }
    }, false);
    return { detail: opts.count === 2 ? "Double-clicked" : opts.count === 3 ? "Triple-clicked" : opts.button === "right" ? "Right-clicked" : "Clicked" };
  }

  async move(_view: string, p: Point): Promise<Outcome> {
    await this.withPage((s) => this.mouse(s, "mouseMoved", p, { button: "none", buttons: 0 }), false);
    return { detail: "Moved the pointer (hover)" };
  }

  async drag(_view: string, from: Point, to: Point, opts: PointerOptions): Promise<Outcome> {
    await this.withPage(async (s) => {
      const modifiers = cdpModifiers(opts.modifiers);
      const buttons = BUTTON_MASK[opts.button];
      await this.mouse(s, "mouseMoved", from, { button: "none", buttons: 0, modifiers });
      await this.mouse(s, "mousePressed", from, { button: opts.button, buttons, clickCount: 1, modifiers });
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const q = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
        await this.mouse(s, "mouseMoved", q, { button: opts.button, buttons, modifiers });
        await sleep(12);
      }
      await this.mouse(s, "mouseReleased", to, { button: opts.button, buttons: 0, clickCount: 1, modifiers });
    }, false);
    return { detail: "Dragged" };
  }

  async scroll(_view: string, p: Point | null, dx: number, dy: number): Promise<Outcome> {
    await this.withPage(async (s) => {
      let at: Point;
      if (p) at = p;
      else {
        const m = await this.metrics(s);
        at = { x: m.width / 2, y: m.height / 2 };
      }
      await this.mouse(s, "mouseWheel", at, { deltaX: dx * WHEEL_PX_PER_NOTCH, deltaY: dy * WHEEL_PX_PER_NOTCH });
    }, false);
    return { detail: "Scrolled" };
  }

  private async press(s: PageSession, combo: KeyCombo, phase: "press" | "down" | "up" = "press") {
    const shift = combo.modifiers.includes("shift");
    const def = cdpKey(combo.key, shift);
    const modifiers = cdpModifiers(combo.modifiers);
    const typing = !combo.modifiers.some((m) => m === "ctrl" || m === "cmd" || m === "alt");
    const commands = cdpCommands(combo);
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers };
    if (phase !== "up") {
      await s.send("Input.dispatchKeyEvent", {
        ...base,
        type: typing && def.text ? "keyDown" : "rawKeyDown",
        ...(typing && def.text ? { text: def.text, unmodifiedText: def.text } : {}),
        ...(commands.length ? { commands } : {}),
      });
    }
    if (phase !== "down") await s.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  async keys(_view: string, combos: KeyCombo[]): Promise<Outcome> {
    await this.withPage(async (s) => {
      for (const c of combos) {
        await this.press(s, c);
        if (combos.length > 1) await sleep(30);
      }
    }, false);
    return { detail: "Pressed" };
  }

  async holdKeys(_view: string, combo: KeyCombo, ms: number, signal?: AbortSignal): Promise<Outcome> {
    await this.withPage(async (s) => {
      await this.press(s, combo, "down");
      try {
        await sleepFor(ms, signal);
      } finally {
        await this.press(s, combo, "up").catch(() => {});
      }
    }, false);
    return { detail: "Held" };
  }

  async type(_view: string, text: string): Promise<Outcome> {
    await this.withPage(async (s) => {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) await s.send("Input.insertText", { text: lines[i] });
        if (i < lines.length - 1) await this.press(s, { key: "enter", modifiers: [] });
      }
    }, false);
    return { detail: `Typed ${[...text].length} characters` };
  }

  async dispose(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.client = null;
    await s?.detach();
  }
}
