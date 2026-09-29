/**
 * Screenshot geometry. Every screenshot the model sees remembers which area of the screen it shows (`frame`, in
 * the engine's input coordinates — points on macOS, CSS pixels in a browser tab) and its own pixel size, so
 * coordinates the model reads off the image map back to the screen exactly, whatever the scaling.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A screenshot as the model saw it: image size (pixels) + the screen area it shows. */
export interface Shot {
  width: number;
  height: number;
  frame: Rect;
}

/** The model sees at most ~1.15 megapixels; bigger images are scaled down server-side (which would skew clicks). */
export const MAX_MODEL_PIXELS = 1_150_000;
/** Hard limit for the long edge of an image the model accepts without rescaling. */
export const MAX_MODEL_EDGE = 1568;

/** Size to scale `width × height` to so it fits `maxEdge` and `maxPixels` (never upscales). */
export function fitSize(width: number, height: number, maxEdge: number, maxPixels = MAX_MODEL_PIXELS): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const edge = Math.min(Math.max(64, maxEdge), MAX_MODEL_EDGE);
  const scale = Math.min(1, edge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** Is (x, y) inside the image? */
export function inImage(shot: Shot, x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= shot.width && y <= shot.height;
}

/** Image pixel → screen point (inside the frame). */
export function imageToFrame(shot: Shot, x: number, y: number): Point {
  const sx = shot.frame.width / shot.width;
  const sy = shot.frame.height / shot.height;
  const px = Math.min(Math.max(x, 0), shot.width - 0.5);
  const py = Math.min(Math.max(y, 0), shot.height - 0.5);
  return { x: shot.frame.x + px * sx, y: shot.frame.y + py * sy };
}

/** Screen point → image pixel (may lie outside the image). */
export function frameToImage(shot: Shot, x: number, y: number): Point {
  return { x: ((x - shot.frame.x) * shot.width) / shot.frame.width, y: ((y - shot.frame.y) * shot.height) / shot.frame.height };
}

/** Image region [x1, y1, x2, y2] → screen rect (normalized, clamped to the frame). */
export function regionToFrame(shot: Shot, region: [number, number, number, number]): Rect {
  const [x1, y1, x2, y2] = region;
  const a = imageToFrame(shot, Math.min(x1, x2), Math.min(y1, y2));
  const b = imageToFrame(shot, Math.max(x1, x2), Math.max(y1, y2));
  return { x: a.x, y: a.y, width: Math.max(1, b.x - a.x), height: Math.max(1, b.y - a.y) };
}

/** Point relative to the frame, 0–1 (for drawing where the agent clicked in the live view). */
export function relativeInFrame(frame: Rect, p: Point): Point {
  return { x: (p.x - frame.x) / frame.width, y: (p.y - frame.y) / frame.height };
}

/** Bounding box of several rects (a desktop spanning every display). */
export function unionRect(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function contains(rect: Rect, p: Point): boolean {
  return p.x >= rect.x && p.y >= rect.y && p.x < rect.x + rect.width && p.y < rect.y + rect.height;
}
