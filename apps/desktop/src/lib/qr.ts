/**
 * QR code decoding for 2FA imports (jsQR) + otpauth:// / otpauth-migration:// parsing for previews.
 *
 * Screenshots are messy: huge retina captures, tiny crops, dark mode (inverted) codes, several codes in one
 * image. `decodeQrCodes` therefore tries several scales and a contrast-normalized pass, and after every hit
 * masks the found code and scans again so multiple codes in a single image are all returned.
 * Nothing here ever leaves the device — decoding runs locally in the webview.
 */
import jsQR from "jsqr";

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
      throw new Error("This file could not be read as an image.", { cause: e });
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
  if (!ctx) throw new Error("Canvas is not available.");
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
/* otpauth parsing (preview only — the core does the real import)      */
/* ------------------------------------------------------------------ */

export function isOtpUri(s: string): boolean {
  return /^otpauth(-migration)?:\/\//i.test(s.trim());
}

export interface OtpPreview {
  type: "totp" | "hotp";
  issuer: string;
  account: string;
  algorithm: string;
  digits: number;
  period: number;
  validSecret: boolean;
}

export interface MigrationPreview {
  accounts: { issuer: string; account: string; type: "totp" | "hotp" | "unknown"; algorithm: string; digits: number }[];
  batchIndex: number;
  batchSize: number;
  batchId: number;
}

export type ParsedOtp =
  | { kind: "otpauth"; uri: string; preview: OtpPreview }
  | { kind: "migration"; uri: string; preview: MigrationPreview }
  | { kind: "invalid"; uri: string; error: string };

export function normalizeBase32(secret: string): string {
  return secret.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
}

export function isValidBase32(secret: string): boolean {
  const s = normalizeBase32(secret);
  return s.length >= 16 && /^[A-Z2-7]+$/.test(s);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseQuery(q: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of q.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = safeDecode(eq === -1 ? part : part.slice(0, eq)).toLowerCase();
    // Keep "+" literal (base64 in migration payloads); only decode percent escapes.
    const v = eq === -1 ? "" : safeDecode(part.slice(eq + 1));
    map.set(k, v);
  }
  return map;
}

export function parseOtpUri(raw: string): ParsedOtp {
  const uri = raw.trim();
  const m = /^otpauth:\/\/(totp|hotp)\/([^?]*)(?:\?(.*))?$/i.exec(uri);
  if (m) {
    const label = safeDecode(m[2]);
    const q = parseQuery(m[3] ?? "");
    const [labelIssuer, ...rest] = label.includes(":") ? label.split(":") : ["", label];
    const account = (rest.length ? rest.join(":") : label).trim();
    const secret = q.get("secret") ?? "";
    return {
      kind: "otpauth",
      uri,
      preview: {
        type: m[1].toLowerCase() as "totp" | "hotp",
        issuer: (q.get("issuer") || labelIssuer || "").trim() || account.split("@")[1] || "Unknown",
        account,
        algorithm: (q.get("algorithm") || "SHA1").toUpperCase(),
        digits: Number(q.get("digits") || 6),
        period: Number(q.get("period") || 30),
        validSecret: isValidBase32(secret) || normalizeBase32(secret).length >= 8,
      },
    };
  }
  const mm = /^otpauth-migration:\/\/[^?]*\?(.*)$/i.exec(uri);
  if (mm) {
    const data = parseQuery(mm[1]).get("data");
    if (!data) return { kind: "invalid", uri, error: "Migration code has no data" };
    try {
      return { kind: "migration", uri, preview: decodeMigrationPayload(data.replace(/ /g, "+")) };
    } catch {
      return { kind: "invalid", uri, error: "Migration code could not be read" };
    }
  }
  return { kind: "invalid", uri, error: "Not a 2FA QR code" };
}

/* Minimal protobuf reader for Google Authenticator's MigrationPayload */

function b64ToBytes(b64: string): Uint8Array {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "===".slice((std.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class PbReader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  get done() {
    return this.pos >= this.buf.length;
  }
  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new Error("truncated varint");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      if (!(b & 0x80)) return result;
      mul *= 128;
    }
    throw new Error("varint too long");
  }
  bytes(): Uint8Array {
    const len = this.varint();
    if (this.pos + len > this.buf.length) throw new Error("truncated field");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

const utf8 = new TextDecoder();
const ALGORITHMS = ["SHA1", "SHA1", "SHA256", "SHA512", "MD5"];

function decodeMigrationPayload(b64: string): MigrationPreview {
  const r = new PbReader(b64ToBytes(b64));
  const out: MigrationPreview = { accounts: [], batchIndex: 0, batchSize: 1, batchId: 0 };
  while (!r.done) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      const p = new PbReader(r.bytes());
      let name = "";
      let issuer = "";
      let algorithm = "SHA1";
      let digits = 6;
      let type: "totp" | "hotp" | "unknown" = "totp";
      while (!p.done) {
        const t = p.varint();
        const f = Math.floor(t / 8);
        const w = t & 7;
        if (f === 2 && w === 2) name = utf8.decode(p.bytes());
        else if (f === 3 && w === 2) issuer = utf8.decode(p.bytes());
        else if (f === 4 && w === 0) algorithm = ALGORITHMS[p.varint()] ?? "SHA1";
        else if (f === 5 && w === 0) digits = p.varint() === 2 ? 8 : 6;
        else if (f === 6 && w === 0) {
          const v = p.varint();
          type = v === 1 ? "hotp" : v === 2 ? "totp" : "unknown";
        } else p.skip(w);
      }
      let account = name;
      if (!issuer && name.includes(":")) [issuer, account] = [name.split(":")[0], name.split(":").slice(1).join(":")];
      else if (issuer && name.startsWith(`${issuer}:`)) account = name.slice(issuer.length + 1);
      out.accounts.push({ issuer: issuer.trim() || "Unknown", account: account.trim(), type, algorithm, digits });
    } else if (field === 3 && wire === 0) out.batchSize = r.varint();
    else if (field === 4 && wire === 0) out.batchIndex = r.varint();
    else if (field === 5 && wire === 0) out.batchId = r.varint();
    else r.skip(wire);
  }
  return out;
}
