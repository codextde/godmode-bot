/**
 * otpauth:// and otpauth-migration:// links read for a preview: what an import would add, before anything is sent. The
 * core does the real import. No browser APIs here: the desktop's webview and the phone's Hermes run the same code.
 */

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

export type OtpProblem = "migration_no_data" | "migration_unreadable" | "not_two_factor";

export type ParsedOtpLink = { kind: "otpauth"; uri: string; preview: OtpPreview } | { kind: "migration"; uri: string; preview: MigrationPreview };

export type ParsedOtp = ParsedOtpLink | { kind: "invalid"; uri: string; problem: OtpProblem };

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
    const label = safeDecode(m[2]!);
    const q = parseQuery(m[3] ?? "");
    const [labelIssuer, ...rest] = label.includes(":") ? label.split(":") : ["", label];
    const account = (rest.length ? rest.join(":") : label).trim();
    const secret = q.get("secret") ?? "";
    return {
      kind: "otpauth",
      uri,
      preview: {
        type: m[1]!.toLowerCase() as "totp" | "hotp",
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
    const data = parseQuery(mm[1]!).get("data");
    if (!data) return { kind: "invalid", uri, problem: "migration_no_data" };
    try {
      return { kind: "migration", uri, preview: decodeMigrationPayload(data.replace(/ /g, "+")) };
    } catch {
      return { kind: "invalid", uri, problem: "migration_unreadable" };
    }
  }
  return { kind: "invalid", uri, problem: "not_two_factor" };
}

export interface OtpReview {
  /** Everything readable, in the order given; unreadable links are left out. */
  parsed: ParsedOtpLink[];
  accountCount: number;
  /** Google Authenticator exports split over several QR codes with some still missing. */
  incomplete: { size: number; missing: number }[];
}

/** What a list of links would import, for the review before it does. */
export function reviewOtpUris(uris: string[]): OtpReview {
  const parsed: ParsedOtpLink[] = [];
  for (const uri of uris) {
    const p = parseOtpUri(uri);
    if (p.kind !== "invalid") parsed.push(p);
  }
  const accountCount = parsed.reduce((n, p) => n + (p.kind === "otpauth" ? 1 : p.preview.accounts.length), 0);
  const batches = new Map<number, { size: number; indexes: Set<number> }>();
  for (const p of parsed) {
    if (p.kind !== "migration" || p.preview.batchSize <= 1) continue;
    const b = batches.get(p.preview.batchId) ?? { size: p.preview.batchSize, indexes: new Set<number>() };
    b.indexes.add(p.preview.batchIndex);
    batches.set(p.preview.batchId, b);
  }
  const incomplete = [...batches.values()].filter((b) => b.indexes.size < b.size).map((b) => ({ size: b.size, missing: b.size - b.indexes.size }));
  return { parsed, accountCount, incomplete };
}

/* Minimal protobuf reader for Google Authenticator's MigrationPayload */

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard or URL-safe base64, with or without padding. */
function base64Bytes(b64: string): Uint8Array {
  const text = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let buffer = 0;
  let length = 0;
  for (const ch of text) {
    const value = BASE64.indexOf(ch);
    if (value === -1) throw new Error("not base64");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length++] = (buffer >> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  return out.subarray(0, length);
}

/** UTF-8 text; what isn't valid UTF-8 becomes U+FFFD. Hermes has no TextDecoder. */
function utf8Text(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++]!;
    const extra = b < 0x80 ? 0 : b >= 0xc2 && b < 0xe0 ? 1 : b >= 0xe0 && b < 0xf0 ? 2 : b >= 0xf0 && b < 0xf5 ? 3 : -1;
    if (extra === -1) {
      out += "�";
      continue;
    }
    let code = extra === 0 ? b : b & (0x3f >> extra);
    let n = 0;
    while (n < extra && ((bytes[i] ?? 0) & 0xc0) === 0x80) {
      code = (code << 6) | (bytes[i++]! & 0x3f);
      n++;
    }
    out += n === extra && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
  }
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
      const b = this.buf[this.pos++]!;
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

const ALGORITHMS = ["SHA1", "SHA1", "SHA256", "SHA512", "MD5"];

function decodeMigrationPayload(b64: string): MigrationPreview {
  const r = new PbReader(base64Bytes(b64));
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
        if (f === 2 && w === 2) name = utf8Text(p.bytes());
        else if (f === 3 && w === 2) issuer = utf8Text(p.bytes());
        else if (f === 4 && w === 0) algorithm = ALGORITHMS[p.varint()] ?? "SHA1";
        else if (f === 5 && w === 0) digits = p.varint() === 2 ? 8 : 6;
        else if (f === 6 && w === 0) {
          const v = p.varint();
          type = v === 1 ? "hotp" : v === 2 ? "totp" : "unknown";
        } else p.skip(w);
      }
      let account = name;
      if (!issuer && name.includes(":")) [issuer, account] = [name.split(":")[0]!, name.split(":").slice(1).join(":")];
      else if (issuer && name.startsWith(`${issuer}:`)) account = name.slice(issuer.length + 1);
      out.accounts.push({ issuer: issuer.trim() || "Unknown", account: account.trim(), type, algorithm, digits });
    } else if (field === 3 && wire === 0) out.batchSize = r.varint();
    else if (field === 4 && wire === 0) out.batchIndex = r.varint();
    else if (field === 5 && wire === 0) out.batchId = r.varint();
    else r.skip(wire);
  }
  return out;
}
