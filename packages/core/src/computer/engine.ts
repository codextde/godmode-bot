/**
 * One interface over the ways Godmode controls a computer:
 *  - desktop / display: the real mouse and keyboard (macOS: Godmode's native helper, every display;
 *    Windows/Linux: Cua Driver, primary display),
 *  - window: one app window in the background (Cua Driver, with the native helper as fallback on macOS),
 *  - tab: one tab of a Godmode browser (CDP).
 *
 * Coordinates are in the engine's "frame space": global points for desktops and windows (top-left origin),
 * CSS pixels for tabs, native pixels for Cua Driver's desktop. `Capture.frame` says which area an image shows.
 */
import type { ComputerTarget } from "@godmode/shared";
import type { KeyCombo, Modifier } from "./keys";
import type { Point, Rect } from "./geometry";

export interface ViewInfo {
  view: string;
  label: string;
  frame: Rect;
  displayId?: string;
  primary?: boolean;
}

export interface Capture {
  data: string;
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
  /** Screen area the image shows, in frame space. */
  frame: Rect;
  label: string;
}

export interface CaptureOptions {
  maxEdge: number;
  /** "model" images must map pixel-exactly to the frame; "live"/"thumbnail" may be cheaper. */
  purpose: "model" | "live" | "thumbnail";
  format?: "jpeg" | "png";
  quality?: number;
  /** Capture only this area (frame space) at full resolution — zoom. */
  region?: Rect;
}

export type MouseButton = "left" | "right" | "middle";

export interface PointerOptions {
  button: MouseButton;
  count: number;
  modifiers: Modifier[];
  /** Window share: bring the window to the front briefly when the background route fails (if allowed). */
  foreground?: boolean;
}

/** Short, model-facing description of what happened. */
export interface Outcome {
  detail: string;
}

export interface UiElement {
  token: string;
  role: string;
  label: string;
  value: string | null;
  actions: string[];
  /** Frame space. */
  frame: Rect | null;
  depth: number;
}

export interface WindowSummary {
  id: number;
  pid: number;
  app: string;
  title: string;
  frame: Rect;
  onScreen: boolean;
  frontmost: boolean;
}

export class EngineError extends Error {
  constructor(
    message: string,
    /** "permission" | "gone" | "unsupported" | "refused" | "failed" | "not_running" | "bad_request" */
    public code: string,
  ) {
    super(message);
  }
}

export interface ComputerEngine {
  readonly target: ComputerTarget;
  /** Engine name for logs/UI ("native", "cua", "cdp"). */
  readonly name: string;
  /** Views of the target — one per display for a shared desktop. */
  views(): Promise<ViewInfo[]>;
  capture(view: string, opts: CaptureOptions): Promise<Capture>;
  click(view: string, p: Point, opts: PointerOptions): Promise<Outcome>;
  move(view: string, p: Point): Promise<Outcome>;
  drag(view: string, from: Point, to: Point, opts: PointerOptions): Promise<Outcome>;
  /** dx/dy in wheel notches (positive = right/down). `p` null = where the pointer is / the focused area. */
  scroll(view: string, p: Point | null, dx: number, dy: number, opts: { foreground?: boolean }): Promise<Outcome>;
  keys(view: string, combos: KeyCombo[], opts: { foreground?: boolean }): Promise<Outcome>;
  holdKeys?(view: string, combo: KeyCombo, ms: number, signal?: AbortSignal): Promise<Outcome>;
  type(view: string, text: string, opts: { foreground?: boolean }): Promise<Outcome>;
  /** Pointer position in frame space (desktop only). */
  cursor?(): Promise<Point>;
  /** Accessibility elements (window shares). */
  elements?(query?: string): Promise<{ elements: UiElement[]; note: string | null }>;
  clickElement?(token: string, opts: PointerOptions): Promise<Outcome>;
  typeInto?(token: string, text: string, opts: { foreground?: boolean }): Promise<Outcome>;
  /** Desktop shares: apps and windows. */
  openApp?(name: string): Promise<Outcome>;
  windows?(): Promise<WindowSummary[]>;
  focusWindow?(id: number): Promise<Outcome>;
  dispose(): Promise<void>;
}

/** Wheel notch → pixels for engines that scroll by pixels. */
export const SCROLL_PX_PER_NOTCH = 60;

/** Sleep that ends early when `signal` aborts. */
export function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal!.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
