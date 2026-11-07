/**
 * QR code decoding for 2FA imports (jsQR) + otpauth:// / otpauth-migration:// parsing for previews.
 *
 * Screenshots are messy: huge retina captures, tiny crops, dark mode (inverted) codes, several codes in one
 * image. `decodeQrCodes` therefore tries several scales and a contrast-normalized pass, and after every hit
 * masks the found code and scans again so multiple codes in a single image are all returned.
 * Nothing here ever leaves the device — decoding runs locally in the webview.
 */
import jsQR from "jsqr";
import { parseOtpUri as parseOtp, type OtpProblem, type ParsedOtpLink } from "@godmode/shared";
import { t } from "@/i18n";

export { isOtpUri, isValidBase32, normalizeBase32 } from "@godmode/shared";

type Drawable = ImageBitmap | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement;
export type QrSource = Blob | Drawable;

const MAX_CODES_PER_IMAGE = 12;

async function toDrawable(src: QrSource): Promise<{ img: Drawable; width: number; height: number; release: () => void }> {
  if (src instanceof Blob) {
    if (typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(src);
        return { img: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
      } catch {
        /* fall back to <img> (e.g. SVG or older WebKit) */
      }
    }
    const url = URL.createObjectURL(src);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode();
      return { img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw new Error(t("system:qr.notAnImage"), { cause: e });
    }
  }
  if (src instanceof HTMLImageElement) return { img: src, width: src.naturalWidth, height: src.naturalHeight, release: () => {} };
  if (src instanceof HTMLVideoElement) return { img: src, width: src.videoWidth, height: src.videoHeight, release: () => {} };
  return { img: src, width: src.width, height: src.height, release: () => {} };
}

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error(t("system:qr.noCanvas"));
  return { canvas, ctx };
}

/** Grayscale + min/max contrast stretch (helps with low-contrast photos of screens). */
function normalizeContrast(data: ImageData): ImageData {
  const px = data.data;
  let min = 255;
  let max = 0;
  const gray = new Uint8ClampedArray(px.length / 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    gray[j] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  const out = new ImageData(data.width, data.height);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = ((gray[j] - min) * 255) / range;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}

/** Paint over a found code (bounding box + padding) so the next pass can find the others. */
function maskRegion(data: ImageData, pts: { x: number; y: number }[]) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const pad = Math.max(8, (Math.max(...xs) - Math.min(...xs)) * 0.08);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const x1 = Math.min(data.width, Math.ceil(Math.max(...xs) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const y1 = Math.min(data.height, Math.ceil(Math.max(...ys) + pad));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * data.width + x) * 4;
      data.data[i] = data.data[i + 1] = data.data[i + 2] = 255;
    }
  }
}

/** Scan an ImageData for every QR code in it (mutates `data` by masking found codes). */
function scanAll(data: ImageData, found: Set<string>): number {
  let hits = 0;
  for (let n = 0; n < MAX_CODES_PER_IMAGE; n++) {
    const code = jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
    if (!code) break;
    const l = code.location;
    maskRegion(data, [l.topLeftCorner, l.topRightCorner, l.bottomLeftCorner, l.bottomRightCorner]);
    if (code.data) {
      hits++;
      found.add(code.data.trim());
    }
  }
  return hits;
}

/** Decode every QR code found in an image. Returns raw payload strings (deduplicated). */
export async function decodeQrCodes(src: QrSource): Promise<string[]> {
  const { img, width, height, release } = await toDrawable(src);
  try {
    if (!width || !height) return [];
    const maxDim = Math.max(width, height);
    const scales = new Set<number>();
    scales.add(maxDim > 1800 ? 1800 / maxDim : 1);
    if (maxDim > 1000) scales.add(1000 / maxDim);
    if (maxDim > 640) scales.add(640 / maxDim);
    if (maxDim < 480) scales.add(Math.min(4, 960 / maxDim));

    const found = new Set<string>();
    for (const scale of scales) {
      const { ctx } = makeCanvas(width * scale, height * scale);
      // Nearest-neighbor when upscaling keeps module edges crisp.
      ctx.imageSmoothingEnabled = scale < 1;
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height);
      const original = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
      const contrast = normalizeContrast(original);
      let hits = scanAll(original, found);
      hits += scanAll(contrast, found);
      if (hits > 0) break;
    }
    return [...found];
  } finally {
    release();
  }
}

/** Single fast decode of a video frame (camera scanning loop). Reuses the given canvas. */
export function scanVideoFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): string | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, 900 / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(data.data, data.width, data.height, { inversionAttempts: "attemptBoth" });
  return code?.data?.trim() || null;
}

/* ------------------------------------------------------------------ */
/* otpauth parsing lives in @godmode/shared, the phone reads links too   */
/* ------------------------------------------------------------------ */

const OTP_PROBLEMS: Record<OtpProblem, () => string> = {
  migration_no_data: () => t("system:qr.migrationNoData"),
  migration_unreadable: () => t("system:qr.migrationUnreadable"),
  not_two_factor: () => t("system:qr.notTwoFactor"),
};

export type ParsedOtp = ParsedOtpLink | { kind: "invalid"; uri: string; error: string };

export function parseOtpUri(raw: string): ParsedOtp {
  const parsed = parseOtp(raw);
  return parsed.kind === "invalid" ? { kind: "invalid", uri: parsed.uri, error: OTP_PROBLEMS[parsed.problem]() } : parsed;
}
