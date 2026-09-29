/**
 * Computer live view: while a UI watches a view (a display, a shared window or tab), it is captured a few times per
 * second and streamed as `computer.frame` events to the sockets subscribed to it. The human can take over through
 * the same view (clicks, scrolling, keys, text) — e.g. to log in, confirm a dialog or show the agent something.
 */
import type { ComputerInputEvent } from "@godmode/shared";
import { bus } from "../events/bus";
import { logger } from "../log";
import { getSettings } from "../services/settings";
import { onSettingsApplied } from "../services/runtime";
import { setComputerSubscriptionHandler, subscribedComputerViews } from "../server/ws";
import { badRequest, conflict, sleep } from "../util";
import { EngineError, SCROLL_PX_PER_NOTCH, errorMessage, type ComputerEngine } from "./engine";
import { imageToFrame, inImage, type Shot } from "./geometry";
import { KeyError, normalizeModifier, parseKeyCombo, type Modifier } from "./keys";
import { createEngine, targetForView, toHttp } from "./service";

const log = logger("computer");

const LIVE_MAX_EDGE = 1280;
const MAX_TEXT = 10_000;

class ComputerLiveView {
  readonly engine: ComputerEngine;
  /** Size/area of the last frame sent — takeover input uses its coordinates. */
  shot: Shot | null = null;
  label = "";
  private stopped = false;
  private lastError: { message: string; at: number } | null = null;
  private loop: Promise<void> | null = null;

  constructor(readonly view: string) {
    this.engine = createEngine(targetForView(view));
  }

  start() {
    this.loop ??= this.run();
  }

  private interval(): number {
    const s = getSettings().computer;
    const fps = Math.min(10, Math.max(1, s.liveViewFps || 4));
    // Without the native helper, frames come from Cua Driver as PNG — keep it light.
    const cheap = process.platform === "darwin" || this.view.startsWith("tab:");
    return 1000 / (cheap ? fps : Math.min(fps, 2));
  }

  private emitError(message: string) {
    // Repeat an unchanged error at most every 5 s.
    if (this.lastError && this.lastError.message === message && Date.now() - this.lastError.at < 5000) return;
    this.lastError = { message, at: Date.now() };
    bus.emit({ type: "computer.frame", view: this.view, data: "", mime: "image/jpeg", width: 0, height: 0, label: this.label, error: message });
  }

  private async run() {
    while (!this.stopped) {
      const started = Date.now();
      let wait = this.interval();
      if (!getSettings().computer.liveView) {
        this.emitError("Live view is turned off in Settings → Computer.");
        wait = 3000;
      } else {
        try {
          const cap = await this.engine.capture(this.view, { maxEdge: LIVE_MAX_EDGE, purpose: "live", quality: 0.6 });
          if (this.stopped) break;
          this.shot = { width: cap.width, height: cap.height, frame: cap.frame };
          this.label = cap.label;
          this.lastError = null;
          bus.emit({ type: "computer.frame", view: this.view, data: cap.data, mime: cap.mime, width: cap.width, height: cap.height, label: cap.label });
        } catch (err) {
          if (this.stopped) break;
          this.emitError(errorMessage(err));
          // Missing permissions or a closed window won't fix themselves within a frame.
          wait = err instanceof EngineError && (err.code === "gone" || err.code === "permission" || err.code === "unsupported") ? 3000 : 1000;
        }
      }
      await sleep(Math.max(40, wait - (Date.now() - started)));
    }
  }

  async stop() {
    this.stopped = true;
    await this.loop?.catch(() => {});
    await this.engine.dispose().catch(() => {});
  }
}

const views = new Map<string, ComputerLiveView>();
let initialized = false;

/** Wire live views to WebSocket subscriptions (idempotent). */
export function initComputerLiveView() {
  if (initialized) return;
  initialized = true;
  setComputerSubscriptionHandler((view, subscribed) => {
    if (subscribed) startComputerView(view);
    else void stopComputerView(view);
  });
  onSettingsApplied((s) => {
    if (!s.computer.enabled) void stopAllComputerViews();
    // Turned back on: resume what people are still watching.
    else for (const view of subscribedComputerViews()) startComputerView(view);
  });
}

export function startComputerView(view: string) {
  if (views.has(view)) return;
  if (!getSettings().computer.enabled) {
    bus.emit({ type: "computer.frame", view, data: "", mime: "image/jpeg", width: 0, height: 0, label: "", error: "Computer use is turned off in Settings → Computer." });
    return;
  }
  let lv: ComputerLiveView;
  try {
    lv = new ComputerLiveView(view);
  } catch (err) {
    log.debug(`bad live view ${view}`, err);
    return;
  }
  views.set(view, lv);
  lv.start();
}

export async function stopComputerView(view: string) {
  const lv = views.get(view);
  if (!lv) return;
  views.delete(view);
  await lv.stop();
}

export async function stopAllComputerViews() {
  await Promise.all([...views.keys()].map(stopComputerView));
}

function modifiers(list: string[] | undefined): Modifier[] {
  const out: Modifier[] = [];
  for (const name of list ?? []) {
    const m = normalizeModifier(name);
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * Human takeover: forward an input event to a watched view. Coordinates are in the frame the human saw
 * (`frameSize`); they are scaled when a newer frame of another size has arrived since.
 */
export async function dispatchComputerInput(view: string, event: ComputerInputEvent, frameSize?: { width: number; height: number }): Promise<void> {
  if (!getSettings().computer.enabled) throw conflict("Computer use is turned off in Settings → Computer.");
  const lv = views.get(view);
  if (!lv) throw conflict("Open the live view first — input goes to what you see there.");
  const shot = lv.shot;
  const point = (x: number, y: number) => {
    if (!shot) throw conflict("No picture yet — wait for the live view.");
    const sx = frameSize?.width ? shot.width / frameSize.width : 1;
    const sy = frameSize?.height ? shot.height / frameSize.height : 1;
    const px = x * sx;
    const py = y * sy;
    if (!inImage(shot, px, py)) throw badRequest("That point is outside the picture.");
    return imageToFrame(shot, px, py);
  };
  const engine = lv.engine;
  try {
    switch (event.type) {
      case "click":
        await engine.click(view, point(event.x, event.y), {
          button: event.button ?? "left",
          count: Math.min(3, Math.max(1, event.count ?? 1)),
          modifiers: [],
        });
        break;
      case "move":
        await engine.move(view, point(event.x, event.y));
        break;
      case "drag":
        await engine.drag(view, point(event.x, event.y), point(event.toX, event.toY), { button: "left", count: 1, modifiers: [] });
        break;
      case "scroll": {
        // Wheel pixels from the browser → notches (fractions are fine for pixel-based engines).
        const toNotches = (d: number) => (d ? Math.sign(d) * Math.max(0.25, Math.abs(d) / SCROLL_PX_PER_NOTCH) : 0);
        await engine.scroll(view, point(event.x, event.y), toNotches(event.deltaX ?? 0), toNotches(event.deltaY), {});
        break;
      }
      case "key": {
        const combo = parseKeyCombo(event.key);
        await engine.keys(view, [{ key: combo.key, modifiers: [...new Set([...combo.modifiers, ...modifiers(event.modifiers)])] }], {});
        break;
      }
      case "text":
        if (event.text.length > MAX_TEXT) throw badRequest(`Text is too long (max ${MAX_TEXT} characters)`);
        if (event.text) await engine.type(view, event.text, {});
        break;
    }
  } catch (err) {
    if (err instanceof KeyError) throw badRequest(err.message);
    throw toHttp(err);
  }
}
