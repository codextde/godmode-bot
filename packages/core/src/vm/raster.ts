/**
 * Pixels for VM screenshots: the VNC framebuffer (32-bit BGRX) cropped, scaled down (area averaging, so small text
 * stays legible) and encoded as PNG — without native image libraries.
 */
import { deflateSync } from "node:zlib";

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8Array;
}

/** BGRX framebuffer region → RGBA raster. */
export function fromBgrx(fb: Uint8Array, fbWidth: number, region: { x: number; y: number; width: number; height: number }): Raster {
  const { x, y, width, height } = region;
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    let si = ((y + row) * fbWidth + x) * 4;
    let di = row * width * 4;
    for (let col = 0; col < width; col++, si += 4, di += 4) {
      out[di] = fb[si + 2]!;
      out[di + 1] = fb[si + 1]!;
      out[di + 2] = fb[si]!;
      out[di + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** Scale down to `width × height` by averaging the source pixels each target pixel covers. */
export function scaleDown(src: Raster, width: number, height: number): Raster {
  if (width >= src.width && height >= src.height) return src;
  const out = new Uint8Array(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let ty = 0; ty < height; ty++) {
    const y0 = Math.floor(ty * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((ty + 1) * sy)));
    for (let tx = 0; tx < width; tx++) {
      const x0 = Math.floor(tx * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((tx + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += src.data[i]!;
          g += src.data[i + 1]!;
          b += src.data[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (ty * width + tx) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGB PNG (alpha dropped: screens are opaque). `level` trades size for speed (live view uses 1). */
export function encodePng(r: Raster, level = 6): Buffer {
  const stride = r.width * 3 + 1;
  const raw = Buffer.alloc(stride * r.height);
  for (let y = 0; y < r.height; y++) {
    // Filter "Up" (2) compresses screens well: most rows repeat the one above.
    const filter = y === 0 ? 0 : 2;
    raw[y * stride] = filter;
    let si = y * r.width * 4;
    let di = y * stride + 1;
    const prev = (y - 1) * r.width * 4;
    for (let x = 0; x < r.width; x++, si += 4, di += 3) {
      if (filter === 0) {
        raw[di] = r.data[si]!;
        raw[di + 1] = r.data[si + 1]!;
        raw[di + 2] = r.data[si + 2]!;
      } else {
        const pi = prev + x * 4;
        raw[di] = (r.data[si]! - r.data[pi]!) & 0xff;
        raw[di + 1] = (r.data[si + 1]! - r.data[pi + 1]!) & 0xff;
        raw[di + 2] = (r.data[si + 2]! - r.data[pi + 2]!) & 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.width, 0);
  ihdr.writeUInt32BE(r.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
