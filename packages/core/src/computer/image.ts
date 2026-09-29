/** Pixel size of a base64 PNG or JPEG, read from its header. null when unrecognized. */
export function imageSize(base64: string): { width: number; height: number; mime: "image/png" | "image/jpeg" } | null {
  const head = Buffer.from(base64.slice(0, 64), "base64");
  if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20), mime: "image/png" };
  }
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  // JPEG: walk the segments to the first start-of-frame marker.
  const bytes = Buffer.from(base64, "base64");
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7), mime: "image/jpeg" };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = bytes.readUInt16BE(i + 2);
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}
